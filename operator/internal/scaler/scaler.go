package scaler

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/go-logr/logr"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	v1alpha1 "github.com/devproof/devproof/operator/api/v1alpha1"
	"github.com/devproof/devproof/operator/internal/transform"
)

// TargetReplicasAnnotation carries the scaler's requested replica count; the
// MD-reconciler is the single writer of ISVC spec and applies it (clamped).
const TargetReplicasAnnotation = "serving.devproof.ai/target-replicas"

// A scrape must cover at least this fraction of Ready pods to drive scaling;
// below it we're too blind. At or above it, unanswered pods are extrapolated to
// the observed mean so one wedged/slow pod can't freeze scaling for the whole
// deployment.
const scrapeQuorumNum, scrapeQuorumDen = 4, 5 // 80%

// Scaler scrapes each deployment's engine pods and adjusts ISVC replicas.
// Scrapes go through the apiserver pod proxy so the loop works both
// in-cluster and in the out-of-cluster dev topology (pod IPs are not
// routable from the host).
type Scaler struct {
	Client    client.Client
	Clientset kubernetes.Interface
	Interval  time.Duration
	hist      map[string]*History
}

func (s *Scaler) Start(ctx context.Context) error {
	logger := ctrl.Log.WithName("scaler")
	s.hist = map[string]*History{}
	ticker := time.NewTicker(s.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			s.tick(ctx, logger)
		}
	}
}

func (s *Scaler) tick(ctx context.Context, logger logr.Logger) {
	mds := &v1alpha1.ModelDeploymentList{}
	if err := s.Client.List(ctx, mds); err != nil {
		logger.Error(err, "list modeldeployments")
		return
	}
	seen := map[string]bool{}
	for i := range mds.Items {
		md := &mds.Items[i]
		seen[md.Namespace+"/"+md.Name] = true
		s.reconcileOne(ctx, logger, md)
	}
	for k := range s.hist { // drop windows of deleted deployments
		if !seen[k] {
			delete(s.hist, k)
		}
	}
}

func (s *Scaler) reconcileOne(ctx context.Context, logger logr.Logger, md *v1alpha1.ModelDeployment) {
	inflight, answered, ready := s.scrape(ctx, md)

	// Publish queue depth on every tick (fixed-size deployments too) so the
	// console column is live; a partial scrape's sum is still a reasonable
	// UI approximation. -1 = unknown (no pod answered).
	depth := int32(-1)
	if answered > 0 {
		depth = int32(inflight)
	}
	if md.Status.QueueDepth != depth {
		md.Status.QueueDepth = depth
		if err := s.Client.Status().Update(ctx, md); err != nil {
			logger.V(1).Info("queueDepth update failed; next tick retries", "md", md.Name)
		}
	}

	// A partial scrape undercounts inflight (biasing scale-down), so require a
	// QUORUM of Ready pods and extrapolate the unanswered ones to the observed
	// mean — one wedged/slow pod must not freeze scaling for the deployment.
	if md.Spec.Replicas.Max <= md.Spec.Replicas.Min || answered == 0 ||
		answered*scrapeQuorumDen < ready*scrapeQuorumNum {
		return // fixed size, or too blind this tick
	}
	full := answered == ready
	if !full {
		inflight = inflight * int64(ready) / int64(answered) // extrapolate the unanswered pods
	}

	anno, hasAnno := md.Annotations[TargetReplicasAnnotation]
	current := transform.DesiredReplicas(md, anno, hasAnno)

	key := md.Namespace + "/" + md.Name
	h := s.hist[key]
	if h == nil {
		h = &History{}
		s.hist[key] = h
	}
	desired := Desired(inflight, md.Spec.Replicas.Min, md.Spec.Replicas.Max, md.Spec.Replicas.Reserve)
	next := h.Next(current, desired)

	// Scale-to-zero (spec 2026-07-15): min=0 deployments sleep after the idle
	// window — consecutive fully-idle FULL scrapes. The window IS the
	// hysteresis for the last step to zero; Desired never proposes 0. Wake is
	// not the scaler's job: at zero pods it is blind (answered==0 early
	// return) and the CP patches the annotation on demand.
	// Sleep only on a FULL idle scrape: an unanswered pod could still be busy,
	// and extrapolated-0 stays 0, so partial coverage can't prove idle. Only a
	// full scrape advances/resets the idle counter, preserving its meaning.
	if full {
		idleTicks := h.IdleFor(inflight)
		if md.Spec.Replicas.Min == 0 && current > 0 && idleTicks >= SleepTicks(md.Spec.Replicas.IdleMinutes) {
			next = 0
		}
	}
	if next == current {
		return
	}
	patch := []byte(fmt.Sprintf(`{"metadata":{"annotations":{%q:%q}}}`, TargetReplicasAnnotation, strconv.Itoa(int(next))))
	if err := s.Client.Patch(ctx, md, client.RawPatch(types.MergePatchType, patch)); err != nil {
		logger.Error(err, "scale", "md", md.Name, "to", next)
		return
	}
	logger.Info("scaled", "md", md.Name, "from", current, "to", next, "inflight", inflight, "reserve", md.Spec.Replicas.Reserve)
	if next == 0 {
		h.idle = 0
	}
}

// scrape sums queue depth over the deployment's Ready engine pods via the
// apiserver pod proxy. ready counts pods whose PodReady condition is True
// (a Running pod still loading the model shouldn't gate anything); answered
// counts how many of those actually returned parseable metrics — the caller
// uses answered vs. ready to tell a full scrape from a partial one.
func (s *Scaler) scrape(ctx context.Context, md *v1alpha1.ModelDeployment) (sum int64, answered int, ready int) {
	pods, err := s.Clientset.CoreV1().Pods(md.Namespace).List(ctx,
		listOptions("app=" + md.Name))
	if err != nil {
		return 0, 0, 0
	}
	for _, p := range pods.Items {
		if !podReady(&p) {
			continue
		}
		ready++
		cctx, cancel := context.WithTimeout(ctx, 2*time.Second)
		raw, err := s.Clientset.CoreV1().Pods(md.Namespace).
			ProxyGet("http", p.Name, "8080", "metrics", nil).DoRaw(cctx)
		cancel()
		if err != nil {
			continue
		}
		if n, ok := ParseQueueMetrics(string(raw)); ok {
			sum += n
			answered++
		}
	}
	return sum, answered, ready
}

func podReady(p *corev1.Pod) bool {
	for _, c := range p.Status.Conditions {
		if c.Type == corev1.PodReady {
			return c.Status == corev1.ConditionTrue
		}
	}
	return false
}

func listOptions(selector string) metav1.ListOptions {
	return metav1.ListOptions{LabelSelector: selector}
}
