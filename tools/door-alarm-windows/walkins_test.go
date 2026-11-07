package main

import "testing"

func TestRingsOncePerNewRecentWalkIn(t *testing.T) {
	var s walkInState
	steps := []struct {
		latest *walkIn
		want   bool
	}{
		{&walkIn{ID: 7, AgeSeconds: 2}, false}, // already there when the program started
		{&walkIn{ID: 7, AgeSeconds: 4}, false},
		{&walkIn{ID: 8, AgeSeconds: 1}, true},
		{&walkIn{ID: 8, AgeSeconds: 3}, false},
		{&walkIn{ID: 9, AgeSeconds: 300}, false}, // the PC was asleep: too old to ring
		{nil, false},
		{&walkIn{ID: 10, AgeSeconds: 0}, true},
	}
	for n, step := range steps {
		if got := s.next(step.latest); got != step.want {
			t.Fatalf("step %d: got %v, want %v", n, got, step.want)
		}
	}
}
