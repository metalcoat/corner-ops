package main

import (
	"testing"
	"time"
)

func ids(list []arrival) []int64 {
	var out []int64
	for _, a := range list {
		out = append(out, a.ID)
	}
	return out
}

func sameIDs(got []arrival, want ...int64) bool {
	g := ids(got)
	if len(g) != len(want) {
		return false
	}
	for n := range g {
		if g[n] != want[n] {
			return false
		}
	}
	return true
}

func TestCurbsideBellAndPopup(t *testing.T) {
	var s arrivalState
	start := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	red := arrival{ID: 5, Name: "Pat Lee", Car: "Red SUV", OrderNumber: "12"}
	blue := arrival{ID: 6, Name: "Sam Roe", Car: "Blue Car", OrderNumber: "13"}

	// Already waiting when the program starts: still alerts, once.
	if fresh := s.update([]arrival{red}); !sameIDs(fresh, 5) || !s.bell() {
		t.Fatalf("first poll: fresh %v", ids(fresh))
	}
	for n := 0; n < 30; n++ {
		s.update([]arrival{red})
		if s.bell() {
			t.Fatal("bell rang twice for the same car")
		}
	}
	if !sameIDs(s.shown, 5) {
		t.Fatalf("car left the screen on its own: %v", ids(s.shown))
	}
	// A second customer: both listed, one bell for the new one.
	if fresh := s.update([]arrival{red, blue}); !sameIDs(fresh, 6) || !sameIDs(s.shown, 5, 6) || !s.bell() || s.bell() {
		t.Fatalf("second arrival: fresh %v shown %v", ids(fresh), ids(s.shown))
	}
	// Delivered to car on the POS: the server drops it, its row goes, no bell.
	s.update([]arrival{blue})
	if !sameIDs(s.shown, 6) || s.bell() {
		t.Fatalf("after delivered: shown %v", ids(s.shown))
	}
	s.update(nil)
	if len(s.shown) != 0 {
		t.Fatal("popup not empty after both delivered")
	}
	// A test alert rings once and clears itself after 30 s.
	s.addTest(arrival{ID: -1, Name: "Test"}, start)
	s.update(nil)
	s.expire(start.Add(29 * time.Second))
	if !sameIDs(s.shown, -1) || !s.bell() {
		t.Fatalf("test alert: shown %v", ids(s.shown))
	}
	s.expire(start.Add(30 * time.Second))
	if len(s.shown) != 0 {
		t.Fatal("test alert did not clear")
	}
}
