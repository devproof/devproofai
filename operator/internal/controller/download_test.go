package controller

import "testing"

func TestParseHumanBytes(t *testing.T) {
	gib := float64(int64(1) << 30)
	cases := map[string]int64{
		"1.0 GiB": 1 << 30,
		"512 MiB": 512 << 20,
		"1.9 GiB": int64(1.9 * gib),
		"2 GB":    2_000_000_000,
		"":        0,
		"garbage": 0,
	}
	for in, want := range cases {
		if got := parseHumanBytes(in); got != want {
			t.Errorf("parseHumanBytes(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestDownloadPercent(t *testing.T) {
	total := int64(2_000_000_000) // ~1.86 GiB
	// half-downloaded
	if p := downloadPercent("0.93 GiB", total); p < 48 || p > 52 {
		t.Errorf("half download => %d%%, want ~50", p)
	}
	// complete (clamped to 100)
	if p := downloadPercent("1.9 GiB", total); p != 100 {
		t.Errorf("full download => %d%%, want 100", p)
	}
	// unknown total
	if p := downloadPercent("0.5 GiB", 0); p != -1 {
		t.Errorf("unknown total => %d, want -1", p)
	}
	// nothing yet
	if p := downloadPercent("", total); p != 0 {
		t.Errorf("no size => %d, want 0", p)
	}
}
