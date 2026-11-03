package main

import "time"

// While an alert is on screen and nobody has clicked Dismiss, the bell rings again this often.
const bellEvery = 20 * time.Second

// arrival is one entry of GET /api/pos/greeter/arrivals: a curbside customer waiting outside.
type arrival struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Car         string `json:"car"`
	OrderNumber string `json:"orderNumber"`
}

// arrivalState decides what the curbside popup shows and when the bell rings. Unlike walk-ins,
// customers already waiting when the program starts do alert: they are still outside (the server
// drops them once the order is completed or after 20 minutes). Test alerts have negative ids and
// stay until dismissed, since the server doesn't list them.
type arrivalState struct {
	shown     []arrival // oldest first, as the server lists them
	dismissed map[int64]bool
	unrung    bool // something new appeared since the last bell
	lastBell  time.Time
}

// update takes this poll's list and returns the arrivals that are new to the popup.
func (s *arrivalState) update(list []arrival) []arrival {
	if s.dismissed == nil {
		s.dismissed = map[int64]bool{}
	}
	listed := map[int64]bool{}
	for _, a := range list {
		listed[a.ID] = true
	}
	for id := range s.dismissed {
		if !listed[id] {
			delete(s.dismissed, id)
		}
	}
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
		if s.dismissed[a.ID] {
			continue
		}
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

// addTest puts a pretend arrival on screen (tray menu "Test curbside alert").
func (s *arrivalState) addTest(a arrival) {
	s.shown = append(s.shown, a)
	s.unrung = true
}

func (s *arrivalState) dismiss(id int64) {
	if s.dismissed == nil {
		s.dismissed = map[int64]bool{}
	}
	var next []arrival
	for _, a := range s.shown {
		if a.ID != id {
			next = append(next, a)
		}
	}
	s.shown = next
	if id > 0 {
		s.dismissed[id] = true
	}
}

// bell reports whether to ring now: right away for a new arrival, then every bellEvery while any is on screen.
func (s *arrivalState) bell(now time.Time) bool {
	if len(s.shown) == 0 {
		s.unrung = false
		return false
	}
	if !s.unrung && now.Sub(s.lastBell) < bellEvery {
		return false
	}
	s.unrung = false
	s.lastBell = now
	return true
}
