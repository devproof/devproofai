package controller

import "testing"

// Scale-to-zero (spec 2026-07-15) makes liveReplicas==0 a steady state, so
// the bounce's phase-2 trigger must be the explicit annotation — inferring it
// from zero replicas deleted a sleeping deployment's cache PVC (verified live
// 2026-07-15: qwen-medium re-downloaded its weights).
func TestBounceAction(t *testing.T) {
	cases := []struct {
		name                   string
		annotated, moved       bool
		liveReplicas           int64
		want                   string
	}{
		{"placement move starts a drain", false, true, 1, "drain"},
		{"re-move mid-bounce re-drains with newest placement", true, true, 0, "drain"},
		{"annotated at zero finishes (delete PVC, clear, restore)", true, false, 0, "finish"},
		{"annotated but pods not drained yet keeps waiting via finish", true, false, 0, "finish"},
		{"IDLE deployment at zero without annotation is untouched", false, false, 0, "none"},
		{"steady state", false, false, 2, "none"},
		{"stale annotation with replicas up finishes cleanup", true, false, 1, "finish"},
	}
	for _, c := range cases {
		if got := bounceAction(c.annotated, c.moved, c.liveReplicas); got != c.want {
			t.Errorf("%s: bounceAction(%v,%v,%d) = %q, want %q", c.name, c.annotated, c.moved, c.liveReplicas, got, c.want)
		}
	}
}
