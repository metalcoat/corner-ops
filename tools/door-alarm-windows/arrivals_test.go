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
	at := func(seconds int) time.Time { return start.Add(time.Duration(seconds) * time.Second) }
	red := arrival{ID: 5, Name: "Pat Lee", Car: "Red SUV", OrderNumber: "12"}
	blue := arrival{ID: 6, Name: "Sam Roe", Car: "Blue Car", OrderNumber: "13"}

	// Already waiting when the program starts: still alerts.
	if fresh := s.update([]arrival{red}); !sameIDs(fresh, 5) {
		t.Fatalf("first poll: fresh %v", ids(fresh))
	}
	if !s.bell(at(0)) {
		t.Fatal("no bell for a waiting customer")
	}
	if s.bell(at(2)) || s.bell(at(19)) {
		t.Fatal("bell rang again too soon")
	}
	if !s.bell(at(20)) {
		t.Fatal("no repeat bell after 20 s")
	}
	// A second customer: both on screen, bell right away.
	if fresh := s.update([]arrival{red, blue}); !sameIDs(fresh, 6) || !sameIDs(s.shown, 5, 6) {
		t.Fatalf("second arrival: fresh %v shown %v", ids(fresh), ids(s.shown))
	}
	if !s.bell(at(22)) {
		t.Fatal("no bell for the second customer")
	}
	// Dismissed: gone and stays gone while the server still lists it.
	s.dismiss(5)
	s.update([]arrival{red, blue})
	if !sameIDs(s.shown, 6) {
		t.Fatalf("after dismiss: shown %v", ids(s.shown))
	}
	// Order completed: the server drops it, the popup closes, no more bells.
	if fresh := s.update(nil); len(fresh) != 0 || len(s.shown) != 0 {
		t.Fatalf("after drop: shown %v", ids(s.shown))
	}
	if s.bell(at(60)) {
		t.Fatal("bell with nothing on screen")
	}
	// A test alert stays although the server doesn't list it, until dismissed.
	s.addTest(arrival{ID: -1, Name: "Test"})
	s.update(nil)
	if !sameIDs(s.shown, -1) || !s.bell(at(61)) {
		t.Fatalf("test alert: shown %v", ids(s.shown))
	}
	s.dismiss(-1)
	if len(s.shown) != 0 || s.bell(at(90)) {
		t.Fatal("test alert not dismissed")
	}
}
