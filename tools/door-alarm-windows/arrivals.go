package main

import "time"

// While a car on screen isn't muted, the bell rings again this often.
const bellEvery = 20 * time.Second

// arrival is one entry of GET /api/pos/greeter/arrivals: a curbside customer waiting outside.
type arrival struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Car         string `json:"car"`
	OrderNumber string `json:"orderNumber"`
}

// popupRow is one car in the popup. A muted row stays listed, without flashing or bell, until
// staff tap DELIVERED TO CAR on the POS and the server stops listing it.
type popupRow struct {
	arrival
	Muted bool
}

// arrivalState decides what the curbside popup shows and when the bell rings. Unlike walk-ins,
// customers already waiting when the program starts do alert: they are still outside (the server
// drops them once delivered to the car, the order is completed, or after 20 minutes). Test alerts
// have negative ids and stay until dismissed, since the server doesn't list them.
type arrivalState struct {
	shown    []arrival // oldest first, as the server lists them
	muted    map[int64]bool
	unrung   bool // something new appeared since the last bell
	lastBell time.Time
}

// update takes this poll's list and returns the arrivals that are new to the popup.
func (s *arrivalState) update(list []arrival) []arrival {
	if s.muted == nil {
		s.muted = map[int64]bool{}
	}
	listed := map[int64]bool{}
	for _, a := range list {
		listed[a.ID] = true
	}
	for id := range s.muted {
		if !listed[id] {
			delete(s.muted, id)
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

// dismiss is the popup's Dismiss button: it only stops the bell for that car. The car stays
// listed until it's marked delivered on the POS. A test alert just goes away.
func (s *arrivalState) dismiss(id int64) {
	if id > 0 {
		if s.muted == nil {
			s.muted = map[int64]bool{}
		}
		s.muted[id] = true
		return
	}
	var next []arrival
	for _, a := range s.shown {
		if a.ID != id {
			next = append(next, a)
		}
	}
	s.shown = next
}

func (s *arrivalState) rows() []popupRow {
	rows := make([]popupRow, 0, len(s.shown))
	for _, a := range s.shown {
		rows = append(rows, popupRow{arrival: a, Muted: s.muted[a.ID]})
	}
	return rows
}

// bell reports whether to ring now: right away for a new arrival, then every bellEvery while any car isn't muted.
func (s *arrivalState) bell(now time.Time) bool {
	ringing := false
	for _, a := range s.shown {
		if !s.muted[a.ID] {
			ringing = true
		}
	}
	if !ringing {
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
