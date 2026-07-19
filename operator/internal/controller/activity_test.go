package controller

import "testing"

// Activity is the display-only overlay on Phase (spec 2026-07-15 badges).
func TestActivity(t *testing.T) {
	cases := []struct {
		name           string
		phase          string
		provisioned    bool
		desired, ready int32
		want           string
	}{
		// Never served yet: no overlay, so Downloading/Deploying stand.
		{"first deploy pending", "Pending", false, 1, 0, ""},
		{"first deploy downloading", "Downloading", false, 1, 0, ""},
		{"first deploy deploying", "Deploying", false, 1, 0, ""},
		// Provisioned and moving.
		{"wake from idle", "Deploying", true, 1, 0, "ScalingUp"},
		{"grow under load 1->3", "Ready", true, 3, 1, "ScalingUp"},
		{"shrink under load 3->2", "Ready", true, 2, 3, "ScalingDown"},
		{"drain to sleep", "Idle", true, 0, 1, "ScalingDown"},
		{"asleep", "Idle", true, 0, 0, ""},
		{"steady", "Ready", true, 2, 2, ""},
		// Bounds edits: desired comes from DesiredReplicas, which re-clamps to
		// the current spec, so an edit moves desired immediately.
		{"edit min 1->2", "Ready", true, 2, 1, "ScalingUp"},
		{"edit max 2->1", "Ready", true, 1, 2, "ScalingDown"},
		{"edit min 0->2 while idle", "Deploying", true, 2, 0, "ScalingUp"},
		// Precedence: these phases win over any replica delta.
		{"failed wins", "Failed", true, 1, 0, ""},
		{"downloading wins (placement move re-download)", "Downloading", true, 1, 0, ""},
		{"copying wins", "Copying", true, 1, 0, ""},
		{"pending wins", "Pending", true, 1, 0, ""},
	}
	for _, c := range cases {
		if got := activityFor(c.phase, c.provisioned, c.desired, c.ready); got != c.want {
			t.Errorf("%s: activityFor(%q,%v,%d,%d) = %q, want %q",
				c.name, c.phase, c.provisioned, c.desired, c.ready, got, c.want)
		}
	}
}

// Provisioned is sticky: it marks "weights are cached", so later pod starts
// are scale-ups, not deployments.
func TestProvisioned(t *testing.T) {
	cases := []struct {
		name  string
		prev  bool
		phase string
		want  bool
	}{
		{"first deploy not yet", false, "Deploying", false},
		{"downloading not yet", false, "Downloading", false},
		{"pending not yet", false, "Pending", false},
		{"ready seeds it", false, "Ready", true},
		{"idle seeds it (upgrade: already-sleeping deployment)", false, "Idle", true},
		{"sticky through deploying (wake)", true, "Deploying", true},
		{"sticky through failed", true, "Failed", true},
		{"sticky through downloading (placement move)", true, "Downloading", true},
	}
	for _, c := range cases {
		if got := provisionedNow(c.prev, c.phase); got != c.want {
			t.Errorf("%s: provisionedNow(%v,%q) = %v, want %v", c.name, c.prev, c.phase, got, c.want)
		}
	}
}
