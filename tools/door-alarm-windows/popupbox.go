package main

// popupBox is where the curbside popup may sit, in pixels of a 1920x1080 screen (config.json "popup").
// The default is the right-hand column of camera tiles in SmartPSS on the back PC, above the taskbar.
// On another resolution it scales to the same part of the screen.
type popupBox struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
}

var defaultPopupBox = popupBox{X: 1395, Y: 60, Width: 475, Height: 920}

// onScreen scales the box to the real screen and keeps it on it.
func (b popupBox) onScreen(screenW, screenH int) popupBox {
	if b.Width < 100 || b.Height < 100 {
		b = defaultPopupBox
	}
	out := popupBox{X: b.X * screenW / 1920, Y: b.Y * screenH / 1080, Width: b.Width * screenW / 1920, Height: b.Height * screenH / 1080}
	if out.Width > screenW {
		out.Width = screenW
	}
	if out.Height > screenH {
		out.Height = screenH
	}
	if out.X < 0 || out.X+out.Width > screenW {
		out.X = screenW - out.Width
	}
	if out.Y < 0 || out.Y+out.Height > screenH {
		out.Y = screenH - out.Height
	}
	return out
}
