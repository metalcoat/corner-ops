package main

import "testing"

func TestPopupBoxScalesToTheScreen(t *testing.T) {
	if got := defaultPopupBox.onScreen(1920, 1080); got != defaultPopupBox {
		t.Fatalf("1080p: %+v", got)
	}
	if got := defaultPopupBox.onScreen(3840, 2160); got != (popupBox{2790, 120, 950, 1840}) {
		t.Fatalf("4K: %+v", got)
	}
	if got := (popupBox{X: 1800, Y: 0, Width: 400, Height: 500}).onScreen(1920, 1080); got.X+got.Width != 1920 {
		t.Fatalf("off the right edge: %+v", got)
	}
	if got := (popupBox{}).onScreen(1920, 1080); got != defaultPopupBox {
		t.Fatalf("missing box: %+v", got)
	}
}
