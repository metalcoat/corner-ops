//go:build windows

package main

// The curbside popup: a borderless always-on-top window in the middle of the screen that flashes
// red and yellow, one row per waiting customer (car, name, order number) with its own Dismiss
// button that only mutes that car (its row turns grey); a row goes when the POS marks it delivered.
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

	getModuleHandle  = kernel32.NewProc("GetModuleHandleW")
	registerClassEx  = user32.NewProc("RegisterClassExW")
	createWindowEx   = user32.NewProc("CreateWindowExW")
	defWindowProc    = user32.NewProc("DefWindowProcW")
	destroyWindow    = user32.NewProc("DestroyWindow")
	getMessage       = user32.NewProc("GetMessageW")
	translateMessage = user32.NewProc("TranslateMessage")
	dispatchMessage  = user32.NewProc("DispatchMessageW")
	postMessage      = user32.NewProc("PostMessageW")
	sendMessage      = user32.NewProc("SendMessageW")
	showWindow       = user32.NewProc("ShowWindow")
	setWindowPos     = user32.NewProc("SetWindowPos")
	setTimer         = user32.NewProc("SetTimer")
	killTimer        = user32.NewProc("KillTimer")
	invalidateRect   = user32.NewProc("InvalidateRect")
	beginPaint       = user32.NewProc("BeginPaint")
	endPaint         = user32.NewProc("EndPaint")
	getClientRect    = user32.NewProc("GetClientRect")
	fillRect         = user32.NewProc("FillRect")
	drawText         = user32.NewProc("DrawTextW")
	getSystemMetrics = user32.NewProc("GetSystemMetrics")
	loadCursor       = user32.NewProc("LoadCursorW")
	flashWindowEx    = user32.NewProc("FlashWindowEx")

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
	wsPopup        = 0x80000000
	wsChild        = 0x40000000
	wsVisible      = 0x10000000
	wsClipChildren = 0x02000000
	wsExTopmost    = 0x00000008
	wsExAppWindow  = 0x00040000

	wmDestroy    = 0x0002
	wmPaint      = 0x000F
	wmClose      = 0x0010
	wmEraseBkgnd = 0x0014
	wmSetFont    = 0x0030
	wmCommand    = 0x0111
	wmTimer      = 0x0113
	wmApp        = 0x8000

	swHide   = 0
	swShowNA = 8

	swpNoSize     = 0x0001
	swpNoMove     = 0x0002
	swpNoActivate = 0x0010
	swpShowWindow = 0x0040

	dtSingleLine  = 0x0020
	dtVCenter     = 0x0004
	dtCenter      = 0x0001
	dtNoPrefix    = 0x0800
	dtEndEllipsis = 0x8000

	flashwStop      = 0
	flashwAll       = 0x3
	flashwTimerNoFG = 0xC

	srcCopy     = 0x00CC0020
	transparent = 1
	idcArrow    = 32512
	smCxScreen  = 0
	smCyScreen  = 1

	flashTimer = 1
	buttonBase = 1000
)

var hwndTopmost = ^uintptr(0) // (HWND)-1

// Layout in pixels.
const (
	popupWidth   = 1100
	headerHeight = 110
	rowHeight    = 200
	popupPadding = 24
	buttonWidth  = 240
	buttonHeight = 110
)

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

type flashInfo struct {
	Size    uint32
	Hwnd    uintptr
	Flags   uint32
	Count   uint32
	Timeout uint32
}

func rgb(r, g, b uint32) uintptr { return uintptr(r | g<<8 | b<<16) }

type popup struct {
	hwnd      uintptr
	onDismiss func(id int64)

	mu   sync.Mutex
	want []popupRow // set by show(), picked up on the window's thread

	// Owned by the window's thread.
	items   []popupRow
	buttons []uintptr
	flash   bool
	fonts   struct{ header, car, name, button uintptr }
	brushes [3]uintptr // red, yellow, muted grey
}

var thePopup *popup

// startPopup creates the (hidden) window. If that fails the bell still rings; the error is logged.
func startPopup(onDismiss func(id int64)) *popup {
	p := &popup{onDismiss: onDismiss}
	thePopup = p
	ready := make(chan struct{})
	go p.run(ready)
	<-ready
	return p
}

// show replaces what the popup lists; an empty list hides it. Safe from any goroutine.
func (p *popup) show(list []popupRow) {
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

func (p *popup) run(ready chan struct{}) {
	runtime.LockOSThread()
	instance, _, _ := getModuleHandle.Call(0)
	className, _ := windows.UTF16PtrFromString("CornerDeliCurbsidePopup")
	title, _ := windows.UTF16PtrFromString("Curbside customer outside")
	cursor, _, _ := loadCursor.Call(0, idcArrow)
	class := wndClassEx{WndProc: windows.NewCallback(popupProc), Instance: instance, Cursor: cursor, ClassName: className}
	class.Size = uint32(unsafe.Sizeof(class))
	if atom, _, err := registerClassEx.Call(uintptr(unsafe.Pointer(&class))); atom == 0 {
		log.Printf("curbside popup unavailable: RegisterClassEx: %v", err)
		close(ready)
		return
	}
	p.fonts.header = font(56, 800)
	p.fonts.car = font(84, 800)
	p.fonts.name = font(50, 600)
	p.fonts.button = font(44, 700)
	p.brushes[0], _, _ = createSolidBrush.Call(rgb(200, 16, 32))
	p.brushes[1], _, _ = createSolidBrush.Call(rgb(255, 204, 0))
	p.brushes[2], _, _ = createSolidBrush.Call(rgb(55, 65, 81))
	hwnd, _, err := createWindowEx.Call(wsExTopmost|wsExAppWindow, uintptr(unsafe.Pointer(className)), uintptr(unsafe.Pointer(title)),
		wsPopup|wsClipChildren, 0, 0, popupWidth, 400, 0, 0, instance, 0)
	if hwnd == 0 {
		log.Printf("curbside popup unavailable: CreateWindowEx: %v", err)
		close(ready)
		return
	}
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
	case wmCommand:
		if n := int(wParam&0xFFFF) - buttonBase; n >= 0 && n < len(p.items) {
			id := p.items[n].ID
			go p.onDismiss(id)
		}
		return 0
	case wmClose:
		// Alt+F4 counts as Dismiss (mute) for every car on screen.
		for _, a := range p.items {
			go p.onDismiss(a.ID)
		}
		return 0
	case wmDestroy:
		return 0
	}
	r, _, _ := defWindowProc.Call(hwnd, message, wParam, lParam)
	return r
}

func (p *popup) flashTaskbar(flags uint32) {
	info := flashInfo{Hwnd: p.hwnd, Flags: flags}
	info.Size = uint32(unsafe.Sizeof(info))
	flashWindowEx.Call(uintptr(unsafe.Pointer(&info)))
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
			p.flashTaskbar(flashwStop)
			p.setButtons(nil)
		}
		p.items = nil
		return
	}
	if !slices.Equal(want, p.items) {
		wasHidden := len(p.items) == 0
		p.setButtons(want)
		p.items = want
		height := headerHeight + len(want)*rowHeight + popupPadding
		screenW, _, _ := getSystemMetrics.Call(smCxScreen)
		screenH, _, _ := getSystemMetrics.Call(smCyScreen)
		x := (int(screenW) - popupWidth) / 2
		y := (int(screenH) - height) / 3
		setWindowPos.Call(p.hwnd, hwndTopmost, uintptr(x), uintptr(y), popupWidth, uintptr(height), swpNoActivate|swpShowWindow)
		showWindow.Call(p.hwnd, swShowNA)
		if wasHidden {
			setTimer.Call(p.hwnd, flashTimer, 500, 0)
		}
		p.flashTaskbar(flashwAll | flashwTimerNoFG)
		invalidateRect.Call(p.hwnd, 0, 0)
		return
	}
	// Every poll: stay above anything else that went topmost since.
	setWindowPos.Call(p.hwnd, hwndTopmost, 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoActivate)
}

func (p *popup) setButtons(list []popupRow) {
	for _, b := range p.buttons {
		destroyWindow.Call(b)
	}
	p.buttons = nil
	class, _ := windows.UTF16PtrFromString("BUTTON")
	label, _ := windows.UTF16PtrFromString("Dismiss")
	for n, row := range list {
		if row.Muted {
			continue
		}
		top := headerHeight + n*rowHeight + (rowHeight-buttonHeight)/2
		b, _, _ := createWindowEx.Call(0, uintptr(unsafe.Pointer(class)), uintptr(unsafe.Pointer(label)), wsChild|wsVisible,
			uintptr(popupWidth-popupPadding-buttonWidth), uintptr(top), buttonWidth, buttonHeight, p.hwnd, uintptr(buttonBase+n), 0, 0)
		sendMessage.Call(b, wmSetFont, p.fonts.button, 1)
		p.buttons = append(p.buttons, b)
	}
}

func (p *popup) text(dc uintptr, s string, f uintptr, r rect, format uintptr) {
	selectObject.Call(dc, f)
	str, _ := windows.UTF16FromString(s)
	drawText.Call(dc, uintptr(unsafe.Pointer(&str[0])), ^uintptr(0), uintptr(unsafe.Pointer(&r)), format|dtSingleLine|dtVCenter|dtNoPrefix|dtEndEllipsis)
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

	// Unmuted parts flash red/yellow; a muted car's row is plain grey.
	flashing := func(r rect) {
		bg, fg := p.brushes[0], rgb(255, 255, 255)
		if p.flash {
			bg, fg = p.brushes[1], rgb(0, 0, 0)
		}
		fillRect.Call(dc, uintptr(unsafe.Pointer(&r)), bg)
		setTextColor.Call(dc, fg)
	}
	grey := func(r rect) {
		fillRect.Call(dc, uintptr(unsafe.Pointer(&r)), p.brushes[2])
		setTextColor.Call(dc, rgb(255, 255, 255))
	}
	setBkMode.Call(dc, transparent)
	allMuted := true
	for _, row := range p.items {
		allMuted = allMuted && row.Muted
	}
	headerRect := rect{0, 0, client.Right, headerHeight}
	if allMuted {
		grey(rect{0, 0, client.Right, client.Bottom})
	} else {
		flashing(rect{0, 0, client.Right, client.Bottom})
	}
	header := "CURBSIDE - CUSTOMER OUTSIDE"
	if len(p.items) > 1 {
		header = "CURBSIDE - " + strconv.Itoa(len(p.items)) + " CUSTOMERS OUTSIDE"
	}
	p.text(dc, header, p.fonts.header, headerRect, dtCenter)
	for n, row := range p.items {
		top := int32(headerHeight + n*rowHeight)
		rowRect := rect{0, top, client.Right, top + rowHeight}
		if row.Muted {
			grey(rowRect)
		} else {
			flashing(rowRect)
		}
		line := rect{popupPadding, top, client.Right - popupPadding, top + 4}
		fillRect.Call(dc, uintptr(unsafe.Pointer(&line)), p.brushes[1-boolIndex(p.flash && !row.Muted)])
		textRight := client.Right - popupPadding*2 - buttonWidth
		if row.Muted {
			textRight = client.Right - popupPadding
		}
		car := row.Car
		if car == "" {
			car = "Car"
		}
		p.text(dc, car, p.fonts.car, rect{popupPadding, top + 10, textRight, top + 115}, 0)
		who := row.Name
		if row.OrderNumber != "" {
			who += "  -  Order #" + row.OrderNumber
		}
		if row.Muted {
			who += "  -  muted, tap DELIVERED TO CAR on the POS"
		}
		p.text(dc, who, p.fonts.name, rect{popupPadding, top + 115, textRight, top + rowHeight - 10}, 0)
	}

	bitBlt.Call(screen, 0, 0, w, h, dc, 0, 0, srcCopy)
	selectObject.Call(dc, old)
	deleteObject.Call(bitmap)
	deleteDC.Call(dc)
}

func boolIndex(b bool) int {
	if b {
		return 1
	}
	return 0
}
