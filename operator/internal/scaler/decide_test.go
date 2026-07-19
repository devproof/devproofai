package scaler

import "testing"

func TestDesired(t *testing.T) {
	cases := []struct {
		name              string
		inflight          int64
		min, max, reserve int32
		want              int32
	}{
		{"idle stays at min", 0, 1, 5, 0, 1},
		{"demand adds up", 3, 1, 5, 0, 3},
		{"reserve rides on demand", 3, 1, 5, 1, 4},
		{"clamped to max", 9, 1, 5, 2, 5},
		{"min floors at 1", 0, 0, 3, 0, 1},
		{"idle with reserve still >= min", 0, 2, 5, 1, 2},
		{"reserve alone lifts above min", 0, 1, 5, 2, 2},
	}
	for _, c := range cases {
		if got := Desired(c.inflight, c.min, c.max, c.reserve); got != c.want {
			t.Fatalf("%s: Desired(%d,%d,%d,%d) = %d, want %d",
				c.name, c.inflight, c.min, c.max, c.reserve, got, c.want)
		}
	}
}

func TestHistoryScaleUpIsImmediate(t *testing.T) {
	h := &History{}
	if got := h.Next(1, 3); got != 3 {
		t.Fatalf("scale up must be immediate, got %d", got)
	}
}

func TestHistoryScaleDownWaitsFullWindow(t *testing.T) {
	h := &History{}
	for i := 0; i < DownTicks-1; i++ {
		if got := h.Next(5, 2); got != 5 {
			t.Fatalf("tick %d: must hold at 5 during the window, got %d", i, got)
		}
	}
	if got := h.Next(5, 2); got != 2 {
		t.Fatalf("tick %d must scale down, got %d", DownTicks, got)
	}
}

func TestHistoryScaleDownUsesWindowMax(t *testing.T) {
	h := &History{}
	h.Next(5, 2)
	h.Next(5, 4) // a burst mid-window raises the floor
	for i := 2; i < DownTicks-1; i++ {
		h.Next(5, 2)
	}
	if got := h.Next(5, 2); got != 4 {
		t.Fatalf("scale down must go to the window max (4), got %d", got)
	}
}

func TestHistoryUpResetsWindow(t *testing.T) {
	h := &History{}
	for i := 0; i < DownTicks-1; i++ {
		h.Next(5, 2)
	}
	h.Next(5, 5) // demand back — window resets
	for i := 0; i < DownTicks-1; i++ {
		if got := h.Next(5, 2); got != 5 {
			t.Fatalf("window must restart after an up/hold tick, got %d", got)
		}
	}
}

func TestIdleForCountsConsecutiveIdleTicks(t *testing.T) {
	h := &History{}
	if got := h.IdleFor(0); got != 1 {
		t.Fatalf("first idle tick = %d, want 1", got)
	}
	if got := h.IdleFor(0); got != 2 {
		t.Fatalf("second idle tick = %d, want 2", got)
	}
	if got := h.IdleFor(3); got != 0 {
		t.Fatalf("traffic must reset the window, got %d", got)
	}
	if got := h.IdleFor(0); got != 1 {
		t.Fatalf("window restarts after traffic, got %d", got)
	}
}

func TestSleepTicks(t *testing.T) {
	if got := SleepTicks(15); got != 60 {
		t.Fatalf("15 min at 15s ticks = %d, want 60", got)
	}
	if got := SleepTicks(0); got != DefaultIdleMinutes*4 {
		t.Fatalf("unset window must default to %d min, got %d ticks", DefaultIdleMinutes, got)
	}
	if got := SleepTicks(1); got != 4 {
		t.Fatalf("1 min = %d ticks, want 4", got)
	}
}

func TestParseQueueMetrics(t *testing.T) {
	text := "# HELP llamacpp:requests_processing Number of requests processing.\n" +
		"# TYPE llamacpp:requests_processing gauge\n" +
		"llamacpp:requests_processing 2\n" +
		"# TYPE llamacpp:requests_deferred gauge\n" +
		"llamacpp:requests_deferred 3\n"
	n, ok := ParseQueueMetrics(text)
	if !ok || n != 5 {
		t.Fatalf("want 5/true, got %d/%v", n, ok)
	}
	if _, ok := ParseQueueMetrics("unrelated 1\n"); ok {
		t.Fatal("missing metrics must report not-found")
	}
}
