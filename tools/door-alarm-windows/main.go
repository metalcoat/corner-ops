//go:build windows

// Corner Deli door alarm for the always-on Windows PC up front.
//
// A system tray program that plays a loud ding-dong each time the entrance camera
// records a walk-in. It polls the store server's read-only walk-in endpoint
// (GET /api/pos/greeter: only the newest walk-in's id, kind and age), ignores
// walk-ins from before it started, reconnects by itself and turns its tray icon
// red while it can't reach the server. Settings: config.json next to the .exe.
//
// It also polls GET /api/pos/greeter/arrivals for curbside customers who tapped I'M HERE:
// each one rings the curbside bell and opens a flashing always-on-top popup (car, name,
// order number) that rings again every 20 s until staff click Dismiss or the order is done.
package main

import (
	"bytes"
	_ "embed"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
	"unsafe"

	"github.com/getlantern/systray"
	"golang.org/x/sys/windows"
)

// Shown in the tray menu and the log; bump with each new download.
const version = "1.1.0"

//go:embed chime.wav
var chime []byte

//go:embed curbside.wav
var curbsideBell []byte

const (
	pollEvery = 2 * time.Second
	// No answer from the server for this long: icon goes red.
	staleAfter = 15 * time.Second
	muteFor    = 10 * time.Minute
)

type config struct {
	Server string `json:"server"`
	Repeat int    `json:"repeat"`
}

var (
	winmm     = windows.NewLazySystemDLL("winmm.dll")
	playSound = winmm.NewProc("PlaySoundW")
	soundLock sync.Mutex
)

const (
	sndSync   = 0x0000
	sndMemory = 0x0004
	sndNoDflt = 0x0002
)

func play(sound []byte, times int) {
	soundLock.Lock()
	defer soundLock.Unlock()
	if times < 1 {
		times = 1
	}
	for n := 0; n < times; n++ {
		playSound.Call(uintptr(unsafe.Pointer(&sound[0])), 0, sndMemory|sndSync|sndNoDflt)
	}
}

func ring(times int) { play(chime, times) }

func exeDir() string {
	path, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(path)
}

func loadConfig(dir string) config {
	cfg := config{Server: "http://192.168.1.237:3000", Repeat: 2}
	path := filepath.Join(dir, "config.json")
	data, err := os.ReadFile(path)
	if err != nil {
		out, _ := json.MarshalIndent(cfg, "", "  ")
		_ = os.WriteFile(path, out, 0o644)
		return cfg
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		log.Printf("config.json is not valid JSON (%v); using %s", err, cfg.Server)
	}
	for len(cfg.Server) > 0 && cfg.Server[len(cfg.Server)-1] == '/' {
		cfg.Server = cfg.Server[:len(cfg.Server)-1]
	}
	return cfg
}

// icon draws a filled circle and wraps the PNG in a Windows .ico container.
func icon(fill color.RGBA) []byte {
	const size = 32
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			dx, dy := float64(x)-15.5, float64(y)-15.5
			switch d := dx*dx + dy*dy; {
			case d <= 13*13:
				img.Set(x, y, fill)
			case d <= 15*15:
				img.Set(x, y, color.RGBA{255, 255, 255, 255})
			}
		}
	}
	var pngData bytes.Buffer
	_ = png.Encode(&pngData, img)
	var ico bytes.Buffer
	binary.Write(&ico, binary.LittleEndian, []uint16{0, 1, 1})
	ico.Write([]byte{size, size, 0, 0})
	binary.Write(&ico, binary.LittleEndian, []uint16{1, 32})
	binary.Write(&ico, binary.LittleEndian, []uint32{uint32(pngData.Len()), 22})
	ico.Write(pngData.Bytes())
	return ico.Bytes()
}

var (
	iconOK      = icon(color.RGBA{18, 122, 74, 255})
	iconOffline = icon(color.RGBA{200, 16, 32, 255})
	iconMuted   = icon(color.RGBA{128, 128, 128, 255})
)

type alarm struct {
	cfg        config
	client     *http.Client
	mu         sync.Mutex
	lastOK     time.Time
	seen       walkInState
	lastWalkIn time.Time
	mutedUntil time.Time

	// Curbside: its own lock, so the walk-in chime never waits on it.
	curbMu    sync.Mutex
	curbside  arrivalState
	curbErr   string
	curbTests int64
	popup     *popup

	status, last, mute *systray.MenuItem
}

func (a *alarm) fetchArrivals() ([]arrival, error) {
	response, err := a.client.Get(a.cfg.Server + "/api/pos/greeter/arrivals")
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		io.Copy(io.Discard, response.Body)
		return nil, fmt.Errorf("server answered HTTP %d", response.StatusCode)
	}
	var body struct {
		Arrivals []arrival `json:"arrivals"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		return nil, err
	}
	return body.Arrivals, nil
}

// pollArrivals is one curbside check. While the server can't be reached, what's on screen
// stays there and keeps ringing. The curbside bell ignores "Mute" (that's for walk-ins).
func (a *alarm) pollArrivals() {
	list, err := a.fetchArrivals()
	a.curbMu.Lock()
	var fresh []arrival
	if err != nil {
		if err.Error() != a.curbErr {
			log.Printf("curbside arrivals not reachable: %v", err)
		}
		a.curbErr = err.Error()
	} else {
		if a.curbErr != "" {
			log.Printf("curbside arrivals reachable again")
		}
		a.curbErr = ""
		fresh = a.curbside.update(list)
	}
	a.curbAlert()
	a.curbMu.Unlock()
	for _, c := range fresh {
		log.Printf("curbside: %s, %s, order #%s (arrival %d)", c.Car, c.Name, c.OrderNumber, c.ID)
	}
}

// curbAlert rings if due and refreshes the popup. Call with curbMu held.
func (a *alarm) curbAlert() {
	if a.curbside.bell(time.Now()) {
		go play(curbsideBell, 1)
	}
	a.popup.show(a.curbside.shown)
}

func (a *alarm) dismissArrival(id int64) {
	a.curbMu.Lock()
	a.curbside.dismiss(id)
	a.curbAlert()
	a.curbMu.Unlock()
	log.Printf("curbside: arrival %d dismissed", id)
}

func (a *alarm) testArrival() {
	a.curbMu.Lock()
	a.curbTests++
	a.curbside.addTest(arrival{ID: -a.curbTests, Name: "TEST - nobody is outside", Car: "Silver SUV", OrderNumber: "123"})
	a.curbAlert()
	a.curbMu.Unlock()
}

func (a *alarm) fetch() (*walkIn, error) {
	response, err := a.client.Get(a.cfg.Server + "/api/pos/greeter")
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		io.Copy(io.Discard, response.Body)
		return nil, fmt.Errorf("server answered HTTP %d", response.StatusCode)
	}
	var body struct {
		Latest *walkIn `json:"latest"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		return nil, err
	}
	return body.Latest, nil
}

func (a *alarm) poll() {
	latest, err := a.fetch()
	a.mu.Lock()
	if err != nil {
		a.mu.Unlock()
		log.Printf("server not reachable: %v", err)
		return
	}
	a.lastOK = time.Now()
	greet := a.seen.next(latest)
	muted := time.Now().Before(a.mutedUntil)
	if greet {
		a.lastWalkIn = time.Now().Add(-time.Duration(latest.AgeSeconds) * time.Second)
	}
	a.mu.Unlock()
	if greet {
		log.Printf("walk-in %d (%s)%s", latest.ID, latest.Kind, map[bool]string{true: " - muted", false: ""}[muted])
		if !muted {
			go ring(a.cfg.Repeat)
		}
	}
}

func (a *alarm) refresh() {
	a.mu.Lock()
	connected := !a.lastOK.IsZero() && time.Since(a.lastOK) < staleAfter
	muted := time.Now().Before(a.mutedUntil)
	mutedUntil, lastWalkIn := a.mutedUntil, a.lastWalkIn
	a.mu.Unlock()
	switch {
	case !connected:
		systray.SetIcon(iconOffline)
		systray.SetTooltip("Door alarm: NOT CONNECTED to the store server - walk-ins will not sound")
		a.status.SetTitle("NOT CONNECTED to " + a.cfg.Server)
	case muted:
		systray.SetIcon(iconMuted)
		systray.SetTooltip("Door alarm: walk-in chime muted until " + mutedUntil.Format("3:04 PM"))
		a.status.SetTitle("Walk-in chime muted until " + mutedUntil.Format("3:04 PM"))
	default:
		systray.SetIcon(iconOK)
		systray.SetTooltip("Door alarm: listening for walk-ins")
		a.status.SetTitle("Listening for walk-ins")
	}
	if muted {
		a.mute.SetTitle("Unmute")
	} else {
		a.mute.SetTitle("Mute walk-in chime for 10 minutes")
	}
	if !lastWalkIn.IsZero() {
		a.last.SetTitle("Last walk-in: " + lastWalkIn.Format("3:04:05 PM"))
	}
}

func (a *alarm) onReady() {
	systray.SetIcon(iconOffline)
	systray.SetTitle("Door alarm")
	systray.AddMenuItem("Corner Deli door alarm "+version, "").Disable()
	a.status = systray.AddMenuItem("Connecting...", "")
	a.status.Disable()
	a.last = systray.AddMenuItem("Last walk-in: none yet", "")
	a.last.Disable()
	systray.AddSeparator()
	test := systray.AddMenuItem("Test chime", "Play the walk-in chime now")
	testCurbside := systray.AddMenuItem("Test curbside alert", "Show a pretend curbside popup and ring the bell")
	a.mute = systray.AddMenuItem("Mute walk-in chime for 10 minutes", "")
	dashboard := systray.AddMenuItem("Open walk-ins dashboard", "")
	systray.AddSeparator()
	quit := systray.AddMenuItem("Quit", "Stop the door alarm")

	go func() {
		for {
			select {
			case <-test.ClickedCh:
				go ring(a.cfg.Repeat)
			case <-testCurbside.ClickedCh:
				a.testArrival()
			case <-a.mute.ClickedCh:
				a.mu.Lock()
				if time.Now().Before(a.mutedUntil) {
					a.mutedUntil = time.Time{}
				} else {
					a.mutedUntil = time.Now().Add(muteFor)
				}
				a.mu.Unlock()
				a.refresh()
			case <-dashboard.ClickedCh:
				_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", a.cfg.Server+"/pos/deli/dashboard").Start()
			case <-quit.ClickedCh:
				systray.Quit()
				return
			}
		}
	}()
	go func() {
		for {
			a.poll()
			a.refresh()
			time.Sleep(pollEvery)
		}
	}()
	go func() {
		for {
			a.pollArrivals()
			time.Sleep(pollEvery)
		}
	}()
}

func main() {
	dir := exeDir()
	logPath := filepath.Join(dir, "door-alarm.log")
	if info, err := os.Stat(logPath); err == nil && info.Size() > 1<<20 {
		_ = os.Remove(logPath)
	}
	if file, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644); err == nil {
		log.SetOutput(file)
	}
	// One copy only: a second start (e.g. a double-click) just exits.
	name, _ := windows.UTF16PtrFromString("CornerDeliDoorAlarm")
	if _, err := windows.CreateMutex(nil, false, name); err == windows.ERROR_ALREADY_EXISTS {
		return
	}
	cfg := loadConfig(dir)
	log.Printf("starting version %s; server %s", version, cfg.Server)
	a := &alarm{cfg: cfg, client: &http.Client{Timeout: 5 * time.Second}}
	a.popup = startPopup(a.dismissArrival)
	systray.Run(a.onReady, func() { log.Printf("stopped") })
}
