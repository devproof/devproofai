package controller

import "testing"

// Activity compares desired vs the last SETTLED desired (spec 2026-07-23
// issue 2): a rollout or crashed replica (desired unchanged) shows NO
// phantom scale overlay; real grows/drains/wakes keep their badges.
func TestActivity(t *testing.T) {
	cases := []struct {
		name             string
		phase            string
		provisioned      bool
		desired, settled int32
		want             string
	}{
		{"first deploy pending", "Pending", false, 1, 0, ""},
		{"first deploy deploying", "Deploying", false, 1, 0, ""},
		{"wake from idle (settled 0)", "Deploying", true, 1, 0, "ScalingUp"},
		{"grow under load 1->3", "Ready", true, 3, 1, "ScalingUp"},
		{"shrink 3->2", "Ready", true, 2, 3, "ScalingDown"},
		{"drain to sleep", "Idle", true, 0, 1, "ScalingDown"},
		{"asleep", "Idle", true, 0, 0, ""},
		{"steady", "Ready", true, 2, 2, ""},
		// THE BUG CASES: desired == settled -> no overlay however low ready is.
		{"rollout (ready dipped, desired unchanged)", "Deploying", true, 1, 1, ""},
		{"crashed replica", "Ready", true, 3, 3, ""},
		// Precedence phases still win.
		{"failed wins", "Failed", true, 2, 1, ""},
		{"downloading wins", "Downloading", true, 2, 1, ""},
		{"copying wins", "Copying", true, 2, 1, ""},
		{"pending wins", "Pending", true, 2, 1, ""},
	}
	for _, c := range cases {
		if got := activityFor(c.phase, c.provisioned, c.desired, c.settled); got != c.want {
			t.Errorf("%s: activityFor(%q,%v,%d,%d) = %q, want %q",
				c.name, c.phase, c.provisioned, c.desired, c.settled, got, c.want)
		}
	}
}

// settleNow: settled tracks desired only when ready has fully caught up.
func TestSettleNow(t *testing.T) {
	cases := []struct {
		name                 string
		prev, desired, ready int32
		want                 int32
	}{
		{"caught up settles", 1, 3, 3, 3},
		{"mid-grow carries", 1, 3, 1, 1},
		{"mid-rollout carries", 1, 1, 0, 1},
		{"zero settles (sleep)", 1, 0, 0, 0},
		{"upgrade seed: ready==desired settles immediately", 0, 1, 1, 1},
	}
	for _, c := range cases {
		if got := settleNow(c.prev, c.desired, c.ready); got != c.want {
			t.Errorf("%s: settleNow(%d,%d,%d) = %d, want %d", c.name, c.prev, c.desired, c.ready, got, c.want)
		}
	}
}

// Reconcile-ordering contract: settle FIRST, then compute activity against
// the updated value — overlays clear in the same reconcile ready catches up.
func TestSettleThenActivitySequences(t *testing.T) {
	type tick struct {
		phase          string
		provisioned    bool
		desired, ready int32
		want           string
	}
	seqs := []struct {
		name    string
		settled int32
		seq     []tick
	}{
		{"rollout", 1, []tick{
			{"Deploying", true, 1, 0, ""},
			{"Ready", true, 1, 1, ""},
		}},
		{"wake", 0, []tick{
			{"Deploying", true, 1, 0, "ScalingUp"},
			{"Ready", true, 1, 1, ""},
		}},
		{"grow", 1, []tick{
			{"Ready", true, 3, 1, "ScalingUp"},
			{"Ready", true, 3, 3, ""},
		}},
		{"placement move drain+restore", 2, []tick{
			{"Deploying", true, 0, 2, "ScalingDown"},
			{"Deploying", true, 0, 0, ""},
			{"Deploying", true, 2, 0, "ScalingUp"},
			{"Ready", true, 2, 2, ""},
		}},
	}
	for _, s := range seqs {
		settled := s.settled
		for i, tk := range s.seq {
			settled = settleNow(settled, tk.desired, tk.ready)
			if got := activityFor(tk.phase, tk.provisioned, tk.desired, settled); got != tk.want {
				t.Fatalf("%s tick %d: got %q want %q (settled=%d)", s.name, i, got, tk.want, settled)
			}
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
