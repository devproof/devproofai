package controller

import (
	"testing"

	v1alpha1 "github.com/devproof/devproof/operator/api/v1alpha1"
)

func TestRoutingChanged(t *testing.T) {
	st := func(phase, endpoint string) v1alpha1.ModelDeploymentStatus {
		return v1alpha1.ModelDeploymentStatus{Phase: phase, Endpoint: endpoint}
	}
	cases := []struct {
		name     string
		old, new v1alpha1.ModelDeploymentStatus
		want     bool
	}{
		{"became ready", st("Deploying", ""), st("Ready", "http://a/v1"), true},
		{"left ready", st("Ready", "http://a/v1"), st("Failed", ""), true},
		{"ready endpoint moved", st("Ready", "http://a/v1"), st("Ready", "http://b/v1"), true},
		{"still ready same endpoint", st("Ready", "http://a/v1"), st("Ready", "http://a/v1"), false},
		{"progress while not ready", st("Pending", ""), st("Downloading", ""), false},
		{"endpoint change while not ready", st("Deploying", "http://a/v1"), st("Deploying", "http://b/v1"), false},
	}
	for _, c := range cases {
		if got := routingChanged(c.old, c.new); got != c.want {
			t.Errorf("%s: routingChanged = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestRoutingChangedIdle(t *testing.T) {
	st := func(phase, ep string) v1alpha1.ModelDeploymentStatus {
		return v1alpha1.ModelDeploymentStatus{Phase: phase, Endpoint: ep}
	}
	cases := []struct {
		name     string
		old, new v1alpha1.ModelDeploymentStatus
		want     bool
	}{
		{"Ready→Idle stays routed but CP projection must update", st("Ready", "e"), st("Idle", "e"), true},
		{"Idle→Ready (wake) must trigger warmup path", st("Idle", "e"), st("Ready", "e"), true},
		{"Idle→Failed leaves the routed set", st("Idle", "e"), st("Failed", "e"), true},
		{"Deploying→Idle enters the routed set", st("Deploying", ""), st("Idle", "e"), true},
		{"Idle steady state is quiet", st("Idle", "e"), st("Idle", "e"), false},
		{"Idle endpoint move re-syncs", st("Idle", "e1"), st("Idle", "e2"), true},
	}
	for _, c := range cases {
		if got := routingChanged(c.old, c.new); got != c.want {
			t.Errorf("%s: routingChanged = %v, want %v", c.name, got, c.want)
		}
	}
}

// Activity is display-only: it must NEVER move the gateway route. If it did,
// a healthy 1->3 autoscale would trip routingChanged -> gateway sync ->
// buildGatewayConfig drops the non-Ready model -> rolling reload. This is the
// property that lets the badges exist without touching routing at all.
func TestRoutingChangedIgnoresActivity(t *testing.T) {
	ready := func(activity string) v1alpha1.ModelDeploymentStatus {
		return v1alpha1.ModelDeploymentStatus{Phase: "Ready", Endpoint: "http://a/v1", Activity: activity}
	}
	if routingChanged(ready(""), ready("ScalingUp")) {
		t.Error("Ready + Activity change must not trigger a gateway sync")
	}
	idle := func(activity string) v1alpha1.ModelDeploymentStatus {
		return v1alpha1.ModelDeploymentStatus{Phase: "Idle", Endpoint: "http://a/v1", Activity: activity}
	}
	if routingChanged(idle("ScalingDown"), idle("")) {
		t.Error("Idle drain finishing must not trigger a gateway sync")
	}
	withProvisioned := func(p bool) v1alpha1.ModelDeploymentStatus {
		return v1alpha1.ModelDeploymentStatus{Phase: "Ready", Endpoint: "http://a/v1", Provisioned: p}
	}
	if routingChanged(withProvisioned(false), withProvisioned(true)) {
		t.Error("Provisioned change must not trigger a gateway sync")
	}
}
