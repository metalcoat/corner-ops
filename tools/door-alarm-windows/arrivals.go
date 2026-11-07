package main

import "time"

// A test alert (tray menu "Test curbside alert") clears itself after this long; real ones only clear from the POS.
const testAlertFor = 30 * time.Second

// arrival is one entry of GET /api/pos/greeter/arrivals: a curbside customer waiting outside.
type arrival struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Car         string `json:"car"`
	OrderNumber string `json:"orderNumber"`
}

// arrivalState decides what the curbside popup shows and when the bell rings: once per new car.
// A car stays on screen until staff tap DELIVERED TO CAR on the POS (or the order is completed, or
// 20 minutes pass) and the server stops listing it. Customers already waiting when the program
// starts do alert: they are still outside. Test alerts have negative ids; the server doesn't list them.
type arrivalState struct {
	shown  []arrival // oldest first, as the server lists them
	tests  map[int64]time.Time
	unrung bool // something new appeared since the last bell
}

// update takes this poll's list and returns the arrivals that are new to the popup.
func (s *arrivalState) update(list []arrival) []arrival {
	had := map[int64]bool{}
	var next []arrival
	for _, a := range s.shown {
		had[a.ID] = true
		if a.ID < 0 {
			next = append(next, a)
		}
	}
	var fresh []arrival
	for _, a := range list {
		next = append(next, a)
		if !had[a.ID] {
			fresh = append(fresh, a)
		}
	}
	s.shown = next
	if len(fresh) > 0 {
		s.unrung = true
	}
	return fresh
}

func (s *arrivalState) addTest(a arrival, now time.Time) {
	if s.tests == nil {
		s.tests = map[int64]time.Time{}
	}
	s.tests[a.ID] = now.Add(testAlertFor)
	s.shown = append(s.shown, a)
	s.unrung = true
}

// expire drops test alerts whose time is up.
func (s *arrivalState) expire(now time.Time) {
	var next []arrival
	for _, a := range s.shown {
		if until, test := s.tests[a.ID]; test && !now.Before(until) {
			delete(s.tests, a.ID)
			continue
		}
		next = append(next, a)
	}
	s.shown = next
}

// bell reports whether to ring now: once for each poll that brought a new car.
func (s *arrivalState) bell() bool {
	ring := s.unrung && len(s.shown) > 0
	s.unrung = false
	return ring
}
