// Package scaler scales ModelDeployments on engine queue depth
// (llamacpp requests processing+deferred) — spec 2026-07-11 §4.
package scaler

import (
	"strconv"
	"strings"
)

// DownTicks is the scale-down hysteresis window: desired must stay below
// current for this many consecutive ticks (12 × 15s = 3 minutes).
const DownTicks = 12

// Desired is the raw target: demand + reserve clamped into [max(min,1), max].
func Desired(inflight int64, min, max, reserve int32) int32 {
	lo := min
	if lo < 1 {
		lo = 1
	}
	if max < lo {
		return lo
	}
	d := inflight + int64(reserve)
	switch {
	case d < int64(lo):
		return lo
	case d > int64(max):
		return max
	default:
		return int32(d)
	}
}

// History carries one deployment's scale-down window between ticks.
// Scale-up (or hold) applies immediately and resets the window; scale-down
// happens only after DownTicks consecutive lower ticks, to the window's max
// desired (a mid-window burst raises the landing point).
type History struct {
	below int
	peak  int32
	idle  int
}

// Next feeds one tick and returns the replica count to write (== current
// means no change).
func (h *History) Next(current, desired int32) int32 {
	if desired >= current {
		h.below, h.peak = 0, 0
		return desired
	}
	h.below++
	if desired > h.peak {
		h.peak = desired
	}
	if h.below < DownTicks {
		return current
	}
	out := h.peak
	h.below, h.peak = 0, 0
	return out
}

// DefaultIdleMinutes is the scale-to-zero window when the spec omits
// idleMinutes (min=0 deployments only) — spec 2026-07-15.
const DefaultIdleMinutes = 15

// SleepTicks converts the idle window into scaler ticks (15s interval).
func SleepTicks(idleMinutes int32) int {
	if idleMinutes < 1 {
		idleMinutes = DefaultIdleMinutes
	}
	return int(idleMinutes) * 4
}

// IdleFor feeds one FULL-scrape tick's inflight sum and returns how many
// consecutive ticks have been fully idle. Callers must not feed partial
// scrapes: not counting them is the never-act-on-partial-sight rule; a reset
// would let one flaky scrape defer sleep indefinitely.
func (h *History) IdleFor(inflight int64) int {
	if inflight > 0 {
		h.idle = 0
		return 0
	}
	h.idle++
	return h.idle
}

// ParseQueueMetrics sums llamacpp:requests_processing and
// llamacpp:requests_deferred from a Prometheus text exposition. ok is false
// when neither metric is present (not a llama.cpp /metrics payload).
func ParseQueueMetrics(text string) (int64, bool) {
	var sum int64
	found := false
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "#") {
			continue
		}
		name, rest, ok := strings.Cut(strings.TrimSpace(line), " ")
		if !ok || (name != "llamacpp:requests_processing" && name != "llamacpp:requests_deferred") {
			continue
		}
		v, err := strconv.ParseFloat(strings.TrimSpace(rest), 64)
		if err != nil {
			continue
		}
		sum += int64(v)
		found = true
	}
	return sum, found
}
