package controller

import (
	"context"
	"net/http"
	"os"
	"time"

	"sigs.k8s.io/controller-runtime/pkg/log"

	v1alpha1 "github.com/devproof/devproof/operator/api/v1alpha1"
)

// routingChanged reports whether a status transition affects gateway routes
// or the CP's routing-state projection: membership in the routed set (Ready
// or Idle — sleeping deployments STAY routed, spec 2026-07-15), a phase flip
// within the routed set (Ready↔Idle: the CP must update model_routing and
// fire/naturalize warmups promptly), or a routed endpoint move.
func routingChanged(oldStatus, newStatus v1alpha1.ModelDeploymentStatus) bool {
	routed := func(s v1alpha1.ModelDeploymentStatus) bool { return s.Phase == "Ready" || s.Phase == "Idle" }
	if routed(oldStatus) != routed(newStatus) {
		return true
	}
	if routed(newStatus) && oldStatus.Phase != newStatus.Phase {
		return true
	}
	return routed(newStatus) && oldStatus.Endpoint != newStatus.Endpoint
}

func controlPlaneURL() string {
	if v := os.Getenv("DEVPROOF_CONTROL_PLANE_URL"); v != "" {
		return v
	}
	return "http://localhost:7080"
}

// triggerGatewaySync asks the control plane to rebuild the gateway routes
// (concept §5.4: the operator owns gateway registration on deployment
// lifecycle). Best-effort: the sync endpoint is diff-aware, and the console's
// manual "Sync gateway" button remains the fallback.
func triggerGatewaySync(ctx context.Context, reason string) {
	logger := log.FromContext(ctx)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, controlPlaneURL()+"/v1/gateway/sync", nil)
	if err != nil {
		logger.Error(err, "gateway sync: build request", "reason", reason)
		return
	}
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		logger.Error(err, "gateway sync failed", "reason", reason)
		return
	}
	defer resp.Body.Close()
	logger.Info("gateway sync triggered", "reason", reason, "status", resp.StatusCode)
}
