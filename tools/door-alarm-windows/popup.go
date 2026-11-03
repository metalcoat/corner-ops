//go:build windows

package main

// The curbside popup: an always-on-top panel in one column of the screen (config.json "popup",
// by default SmartPSS's right-hand camera column) with a big CURBSIDE header and one card per
// waiting car: car, name, order number. The header and border flash red/yellow; the cards stay
// steady so they're readable. Nobody touches that screen, so the window never takes focus, has no
// taskbar button and lets clicks through to SmartPSS. Cars leave when the POS marks them delivered.
// It lives on its own OS thread with its own message loop, next to the tray icon's.

import (
	"log"
	"runtime"
	"slices"
	"strconv"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32   = windows.NewLazySystemDLL("user32.dll")
	gdi32    = windows.NewLazySystemDLL("gdi32.dll")
	kernel32 = windows.NewLazySystemDLL("kernel32.dll")

	getModuleHandle            = kernel32.NewProc("GetModuleHandleW")
	setProcessDPIAware         = user32.NewProc("SetProcessDPIAware")
	registerClassEx            = user32.NewProc("RegisterClassExW")
	createWindowEx             = user32.NewProc("CreateWindowExW")
	defWindowProc              = user32.NewProc("DefWindowProcW")
	getMessage                 = user32.NewProc("GetMessageW")
	translateMessage           = user32.NewProc("TranslateMessage")
	dispatchMessage            = user32.NewProc("DispatchMessageW")
	postMessage                = user32.NewProc("PostMessageW")
	showWindow                 = user32.NewProc("ShowWindow")
	setWindowPos               = user32.NewProc("SetWindowPos")
	setLayeredWindowAttributes = user32.NewProc("SetLayeredWindowAttributes")
	setTimer                   = user32.NewProc("SetTimer")
	killTimer                  = user32.NewProc("KillTimer")
	invalidateRect             = user32.NewProc("InvalidateRect")
	beginPaint                 = user32.NewProc("BeginPaint")
	endPaint                   = user32.NewProc("EndPaint")
	getClientRect              = user32.NewProc("GetClientRect")
	getDC                      = user32.NewProc("GetDC")
	releaseDC                  = user32.NewProc("ReleaseDC")
	fillRect                   = user32.NewProc("FillRect")
	drawText                   = user32.NewProc("DrawTextW")
	getSystemMetrics           = user32.NewProc("GetSystemMetrics")

	createFont             = gdi32.NewProc("CreateFontW")
	createSolidBrush       = gdi32.NewProc("CreateSolidBrush")
	createCompatibleDC     = gdi32.NewProc("CreateCompatibleDC")
	createCompatibleBitmap = gdi32.NewProc("CreateCompatibleBitmap")
	selectObject           = gdi32.NewProc("SelectObject")
	deleteObject           = gdi32.NewProc("DeleteObject")
	deleteDC               = gdi32.NewProc("DeleteDC")
	bitBlt                 = gdi32.NewProc("BitBlt")
	setBkMode              = gdi32.NewProc("SetBkMode")
	setTextColor           = gdi32.NewProc("SetTextColor")
)

const (
	wsPopup         = 0x80000000
	wsExTopmost     = 0x00000008
	wsExTransparent = 0x00000020
	wsExToolWindow  = 0x00000080
	wsExLayered     = 0x00080000
	wsExNoActivate  = 0x08000000

	wmPaint      = 0x000F
	wmClose      = 0x0010
	wmEraseBkgnd = 0x0014
	wmTimer      = 0x0113
	wmApp        = 0x8000

	swHide   = 0
	swShowNA = 8

	swpNoSize     = 0x0001
	swpNoMove     = 0x0002
	swpNoActivate = 0x0010
	swpShowWindow = 0x0040

	dtCenter      = 0x0001
	dtWordBreak   = 0x0010
	dtCalcRect    = 0x0400
	dtNoPrefix    = 0x0800
	dtEditControl = 0x2000

	lwaAlpha    = 0x2
	srcCopy     = 0x00CC0020
	transparent = 1
	smCxScreen  = 0
	smCyScreen  = 1

	flashTimer = 1
)

var hwndTopmost = ^uintptr(0) // (HWND)-1

type rect struct{ Left, Top, Right, Bottom int32 }

type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   uintptr
	Icon       uintptr
	Cursor     uintptr
	Background uintptr
	MenuName   *uint16
	ClassName  *uint16
	IconSm     uintptr
}

type msg struct {
	Hwnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	X, Y    int32
	Private uint32
}

type paintStruct struct {
	Hdc         uintptr
	Erase       int32
	Paint       rect
	Restore     int32
	IncUpdate   int32
	RgbReserved [32]byte
}

func rgb(r, g, b uint32) uintptr { return uintptr(r | g<<8 | b<<16) }

// Colors.
var (
	colorRed    = rgb(200, 16, 32)
	colorYellow = rgb(255, 204, 0)
	colorPanel  = rgb(11, 15, 25)
	colorCard   = rgb(31, 41, 55)
	colorWhite  = rgb(255, 255, 255)
	colorBlack  = rgb(0, 0, 0)
	colorMuted  = rgb(203, 213, 225)
)

// block is one piece of text in the laid-out popup.
type block struct {
	text   string
	font   uintptr
	color  uintptr // 0: header (follows the flash)
	r      rect
	center bool
}

type fontSet struct{ header, sub, car, name uintptr }

type popup struct {
	hwnd uintptr
	box  popupBox

	mu   sync.Mutex
	want []arrival // set by show(), picked up on the window's thread

	// Owned by the window's thread.
	items   []arrival
	flash   bool
	fonts   map[int]fontSet
	brushes map[uintptr]uintptr
	blocks  []block
	cards   []rect
	header  rect
	border  int32
}

var thePopup *popup

// makeDPIAware: on a screen with Windows display scaling, work in real pixels so the popup
// lands where config.json says and its text is sharp.
func makeDPIAware() { setProcessDPIAware.Call() }

// startPopup creates the (hidden) window. If that fails the bell still rings; the error is logged.
func startPopup(box popupBox) *popup {
	p := &popup{box: box, fonts: map[int]fontSet{}, brushes: map[uintptr]uintptr{}}
	thePopup = p
	ready := make(chan struct{})
	go p.run(ready)
	<-ready
	return p
}

// show replaces what the popup lists; an empty list hides it. Safe from any goroutine.
func (p *popup) show(list []arrival) {
	p.mu.Lock()
	p.want = slices.Clone(list)
	p.mu.Unlock()
	if p.hwnd != 0 {
		postMessage.Call(p.hwnd, wmApp, 0, 0)
	}
}

func font(height int32, weight int32) uintptr {
	face, _ := windows.UTF16PtrFromString("Segoe UI")
	f, _, _ := createFont.Call(uintptr(-height), 0, 0, 0, uintptr(weight), 0, 0, 0, 1, 0, 0, 5, 0, uintptr(unsafe.Pointer(face)))
	return f
}

func (p *popup) brush(color uintptr) uintptr {
	if b, ok := p.brushes[color]; ok {
		return b
	}
	b, _, _ := createSolidBrush.Call(color)
	p.brushes[color] = b
	return b
}

// fontsAt: text sizes for a popup this wide, at this percentage (shrunk to fit more cars).
func (p *popup) fontsAt(width int, percent int) fontSet {
	key := width*1000 + percent
	if f, ok := p.fonts[key]; ok {
		return f
	}
	size := func(base int) int32 { return int32(base * width / 475 * percent / 100) }
	f := fontSet{header: font(size(72), 900), sub: font(size(34), 800), car: font(size(64), 800), name: font(size(42), 600)}
	p.fonts[key] = f
	return f
}

func (p *popup) run(ready chan struct{}) {
	runtime.LockOSThread()
	instance, _, _ := getModuleHandle.Call(0)
	className, _ := windows.UTF16PtrFromString("CornerDeliCurbsidePopup")
	title, _ := windows.UTF16PtrFromString("Curbside customer outside")
	class := wndClassEx{WndProc: windows.NewCallback(popupProc), Instance: instance, ClassName: className}
	class.Size = uint32(unsafe.Sizeof(class))
	if atom, _, err := registerClassEx.Call(uintptr(unsafe.Pointer(&class))); atom == 0 {
		log.Printf("curbside popup unavailable: RegisterClassEx: %v", err)
		close(ready)
		return
	}
	hwnd, _, err := createWindowEx.Call(wsExTopmost|wsExToolWindow|wsExNoActivate|wsExLayered|wsExTransparent,
		uintptr(unsafe.Pointer(className)), uintptr(unsafe.Pointer(title)), wsPopup, 0, 0, 400, 400, 0, 0, instance, 0)
	if hwnd == 0 {
		log.Printf("curbside popup unavailable: CreateWindowEx: %v", err)
		close(ready)
		return
	}
	setLayeredWindowAttributes.Call(hwnd, 0, 255, lwaAlpha) // opaque; layered only so clicks pass through
	p.hwnd = hwnd
	close(ready)
	var m msg
	for {
		r, _, _ := getMessage.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 {
			return
		}
		translateMessage.Call(uintptr(unsafe.Pointer(&m)))
		dispatchMessage.Call(uintptr(unsafe.Pointer(&m)))
	}
}

func popupProc(hwnd, message, wParam, lParam uintptr) uintptr {
	p := thePopup
	switch message {
	case wmApp:
		p.update()
		return 0
	case wmTimer:
		p.flash = !p.flash
		invalidateRect.Call(hwnd, 0, 0)
		return 0
	case wmEraseBkgnd:
		return 1
	case wmPaint:
		p.paint()
		return 0
	case wmClose:
		return 0 // only the POS clears it
	}
	r, _, _ := defWindowProc.Call(hwnd, message, wParam, lParam)
	return r
}

// update runs on the window's thread after show().
func (p *popup) update() {
	p.mu.Lock()
	want := p.want
	p.mu.Unlock()
	if len(want) == 0 {
		if len(p.items) > 0 {
			killTimer.Call(p.hwnd, flashTimer)
			showWindow.Call(p.hwnd, swHide)
		}
		p.items = nil
		return
	}
	if !slices.Equal(want, p.items) {
		wasHidden := len(p.items) == 0
		p.items = want
		screenW, _, _ := getSystemMetrics.Call(smCxScreen)
		screenH, _, _ := getSystemMetrics.Call(smCyScreen)
		box := p.box.onScreen(int(screenW), int(screenH))
		height := p.layout(box)
		setWindowPos.Call(p.hwnd, hwndTopmost, uintptr(box.X), uintptr(box.Y), uintptr(box.Width), uintptr(height), swpNoActivate|swpShowWindow)
		showWindow.Call(p.hwnd, swShowNA)
		if wasHidden {
			setTimer.Call(p.hwnd, flashTimer, 500, 0)
		}
		invalidateRect.Call(p.hwnd, 0, 0)
		return
	}
	// Every poll: stay above anything else that went topmost since.
	setWindowPos.Call(p.hwnd, hwndTopmost, 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoActivate)
}

const textFormat = dtWordBreak | dtEditControl | dtNoPrefix

// measure returns how tall text wraps to in this width.
func measure(dc uintptr, s string, f uintptr, width int32, format uintptr) int32 {
	selectObject.Call(dc, f)
	str, _ := windows.UTF16FromString(s)
	r := rect{0, 0, width, 0}
	drawText.Call(dc, uintptr(unsafe.Pointer(&str[0])), ^uintptr(0), uintptr(unsafe.Pointer(&r)), format|dtCalcRect)
	return r.Bottom
}

// layout wraps every line to the box's width, shrinking the text until all cars fit its height.
// It returns the window height (no taller than needed).
func (p *popup) layout(box popupBox) int {
	dc, _, _ := getDC.Call(p.hwnd)
	defer releaseDC.Call(p.hwnd, dc)
	width := int32(box.Width)
	for _, percent := range []int{100, 90, 80, 70, 62, 55, 48, 42, 36} {
		f := p.fontsAt(box.Width, percent)
		scale := func(v int) int32 { return int32(v * box.Width / 475 * percent / 100) }
		border, pad, gap := int32(box.Width*12/475), scale(16), scale(14)
		left, inner := border+pad, width-2*(border+pad)
		var blocks []block
		var cards []rect
		y := border + scale(8)
		add := func(text string, fnt, color uintptr, center bool, x, w int32) {
			format := uintptr(textFormat)
			if center {
				format |= dtCenter
			}
			h := measure(dc, text, fnt, w, format)
			blocks = append(blocks, block{text: text, font: fnt, color: color, r: rect{x, y, x + w, y + h}, center: center})
			y += h
		}
		add("CURBSIDE", f.header, 0, true, left, inner)
		sub := "CUSTOMER OUTSIDE"
		if len(p.items) > 1 {
			sub = strconv.Itoa(len(p.items)) + " CARS OUTSIDE"
		}
		add(sub, f.sub, 0, true, left, inner)
		y += scale(8)
		header := y
		y += gap
		for _, a := range p.items {
			top := y
			y += pad
			car := a.Car
			if car == "" {
				car = "Car"
			}
			add(car, f.car, colorYellow, false, left+pad, inner-2*pad)
			if a.Name != "" {
				add(a.Name, f.name, colorWhite, false, left+pad, inner-2*pad)
			}
			if a.OrderNumber != "" {
				add("Order #"+a.OrderNumber, f.name, colorMuted, false, left+pad, inner-2*pad)
			}
			y += pad
			cards = append(cards, rect{left, top, left + inner, y})
			y += gap
		}
		total := y + border + pad - gap
		if int(total) <= box.Height || percent == 36 {
			p.blocks, p.cards, p.border = blocks, cards, border
			p.header = rect{0, 0, width, header}
			if int(total) > box.Height {
				total = int32(box.Height)
			}
			return int(total)
		}
	}
	return box.Height
}

func (p *popup) fill(dc uintptr, r rect, color uintptr) {
	fillRect.Call(dc, uintptr(unsafe.Pointer(&r)), p.brush(color))
}

// paint draws into a memory bitmap first so the flashing doesn't flicker.
func (p *popup) paint() {
	var ps paintStruct
	screen, _, _ := beginPaint.Call(p.hwnd, uintptr(unsafe.Pointer(&ps)))
	defer endPaint.Call(p.hwnd, uintptr(unsafe.Pointer(&ps)))
	var client rect
	getClientRect.Call(p.hwnd, uintptr(unsafe.Pointer(&client)))
	w, h := uintptr(client.Right), uintptr(client.Bottom)
	dc, _, _ := createCompatibleDC.Call(screen)
	bitmap, _, _ := createCompatibleBitmap.Call(screen, w, h)
	old, _, _ := selectObject.Call(dc, bitmap)

	flashBg, flashFg := colorRed, colorWhite
	if p.flash {
		flashBg, flashFg = colorYellow, colorBlack
	}
	// Flashing border and header band; steady dark panel and cards.
	p.fill(dc, client, flashBg)
	p.fill(dc, rect{p.border, p.header.Bottom, client.Right - p.border, client.Bottom - p.border}, colorPanel)
	for _, c := range p.cards {
		p.fill(dc, c, colorCard)
	}
	setBkMode.Call(dc, transparent)
	for _, b := range p.blocks {
		color := b.color
		if color == 0 {
			color = flashFg
		}
		setTextColor.Call(dc, color)
		selectObject.Call(dc, b.font)
		str, _ := windows.UTF16FromString(b.text)
		format := uintptr(textFormat)
		if b.center {
			format |= dtCenter
		}
		r := b.r
		drawText.Call(dc, uintptr(unsafe.Pointer(&str[0])), ^uintptr(0), uintptr(unsafe.Pointer(&r)), format)
	}

	bitBlt.Call(screen, 0, 0, w, h, dc, 0, 0, srcCopy)
	selectObject.Call(dc, old)
	deleteObject.Call(bitmap)
	deleteDC.Call(dc)
}
