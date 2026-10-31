package main

// Never ring for a walk-in older than this (the PC was asleep or just started).
const recentSeconds = 20

// walkIn is GET /api/pos/greeter's "latest": the newest walk-in in the last minute.
type walkIn struct {
	ID         int64  `json:"id"`
	Kind       string `json:"kind"`
	AgeSeconds int    `json:"ageSeconds"`
}

type walkInState struct {
	initialized bool
	lastID      int64
}

// next reports whether to ring for this poll's answer. It mirrors greeterNext in
// src/lib/door-chime-policy.ts: the first poll only notes what was already there.
func (s *walkInState) next(latest *walkIn) bool {
	var id int64
	if latest != nil {
		id = latest.ID
	}
	first := !s.initialized
	s.initialized = true
	if id <= s.lastID {
		return false
	}
	s.lastID = id
	return !first && latest != nil && latest.AgeSeconds <= recentSeconds
}
