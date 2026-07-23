// Package controller reconciles Devproof serving resources.
package controller

import (
	"context"
	"fmt"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	v1alpha1 "github.com/devproof/devproof/operator/api/v1alpha1"
	"github.com/devproof/devproof/operator/internal/scaler"
	"github.com/devproof/devproof/operator/internal/transform"
)

const fieldOwner = client.FieldOwner("devproof-operator")

// cacheBounceAnnotation marks a placement-move cache bounce in flight. It is
// the EXPLICIT phase-2 sentinel: liveReplicas==0 alone is ambiguous now that
// Idle (scale-to-zero, spec 2026-07-15) is a steady state — inferring the
// bounce from zero replicas deleted a sleeping deployment's model-cache PVC
// (reproduced live 2026-07-15).
const cacheBounceAnnotation = "serving.devproof.ai/cache-bounce"

// bounceAction decides the cache-bounce step this reconcile: "drain" applies
// the new placement at zero replicas (phase 1), "finish" waits for pods to
// vanish then deletes the cache PVC and clears the annotation (phase 2),
// "none" leaves the bounce machinery alone.
func bounceAction(annotated, placementMoved bool, liveReplicas int64) string {
	if placementMoved {
		return "drain"
	}
	if annotated {
		return "finish"
	}
	_ = liveReplicas // steady zero (Idle) is deliberately NOT a bounce state
	return "none"
}

var isvcGVK = schema.GroupVersionKind{
	Group: "inference.llmkube.dev", Version: "v1alpha1", Kind: "InferenceService",
}

var modelGVK = schema.GroupVersionKind{
	Group: "inference.llmkube.dev", Version: "v1alpha1", Kind: "Model",
}

// ModelDeploymentReconciler reconciles ModelDeployments into LLMkube resources.
type ModelDeploymentReconciler struct {
	client.Client
	// EngineImages are stamped into each ISVC (empty = provider default).
	EngineImages transform.EngineImages
}

// +kubebuilder:rbac:groups=serving.devproof.ai,resources=modelpools;modeldeployments,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=serving.devproof.ai,resources=modelpools/status;modeldeployments/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=inference.llmkube.dev,resources=inferenceservices;models,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=persistentvolumeclaims,verbs=get;list;watch;delete
// +kubebuilder:rbac:groups=core,resources=pods,verbs=get;list;watch
// +kubebuilder:rbac:groups=core,resources=pods/proxy,verbs=get
// +kubebuilder:rbac:groups=core,resources=events,verbs=create;patch
func (r *ModelDeploymentReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	md := &v1alpha1.ModelDeployment{}
	if err := r.Get(ctx, req.NamespacedName, md); err != nil {
		if errors.IsNotFound(err) {
			// Deployment deleted (from any path, not just the console) — drop
			// its gateway route. Diff-aware on the CP side, so over-triggering
			// is a no-op.
			triggerGatewaySync(ctx, req.Name+" deleted")
		}
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	pool := &v1alpha1.ModelPool{}
	if err := r.Get(ctx, types.NamespacedName{Namespace: md.Namespace, Name: md.Spec.PoolRef}, pool); err != nil {
		if errors.IsNotFound(err) {
			return r.setStatus(ctx, md, v1alpha1.ModelDeploymentStatus{
				Phase: "Failed", Message: fmt.Sprintf("ModelPool %q not found", md.Spec.PoolRef),
				QueueDepth:             md.Status.QueueDepth,
				EffectiveContextTokens: transform.EffectiveContextTokens(md),
				Provisioned:            md.Status.Provisioned,
			}, 30*time.Second)
		}
		return ctrl.Result{}, err
	}

	// Replicas are scaler-owned via the target-replicas annotation (single
	// ISVC writer: this reconciler). Explicit "0" (min=0) = Idle (scale-to-
	// zero); missing/invalid = max(min, 1).
	anno, hasAnno := md.Annotations[scaler.TargetReplicasAnnotation]
	replicas := transform.DesiredReplicas(md, anno, hasAnno)
	model, isvc := transform.Build(md, pool, replicas, r.EngineImages)

	// Placement diff against the live ISVC BEFORE the apply. A placement move
	// strands the engine pods: with node-local storage the model-cache PVC is
	// bound to the old node, the old pod holds the RWO claim, and the
	// replacement can never become Ready on the new node. Detect it here so
	// the cache can be re-provisioned after the apply (LLMkube recreates a
	// missing per-service cache PVC on its next reconcile).
	placementMoved := false
	liveReplicas := int64(-1)
	liveISVC := &unstructured.Unstructured{}
	liveISVC.SetGroupVersionKind(isvcGVK)
	if err := r.Get(ctx, req.NamespacedName, liveISVC); err == nil {
		placementMoved = transform.PlacementChanged(liveISVC, isvc)
		if v, found, _ := unstructured.NestedInt64(liveISVC.Object, "spec", "replicas"); found {
			liveReplicas = v
		}
	} else if !errors.IsNotFound(err) {
		return ctrl.Result{}, err
	}

	switch bounceAction(md.Annotations[cacheBounceAnnotation] == "1", placementMoved, liveReplicas) {
	case "drain":
		// Phase 1 of the cache bounce: mark the bounce EXPLICITLY, then apply
		// the NEW placement at zero replicas. Deleting pods instead re-arms
		// the race that deadlocked live verification (3/3): the old
		// ReplicaSet recreates its pod first, it schedules on the OLD node
		// and claims the freshly recreated WaitForFirstConsumer cache PVC
		// there, and the new pod can never schedule while RollingUpdate
		// keeps the old one alive. At zero replicas every ReplicaSet drains,
		// so nothing can claim the PVC while phase 2 re-provisions it.
		// Annotation BEFORE the drain apply: a crash between the two leaves
		// a marked, undrained bounce that phase 2's pod-wait completes.
		if md.Annotations[cacheBounceAnnotation] != "1" {
			patch := []byte(fmt.Sprintf(`{"metadata":{"annotations":{%q:"1"}}}`, cacheBounceAnnotation))
			if err := r.Patch(ctx, md, client.RawPatch(types.MergePatchType, patch)); err != nil {
				return ctrl.Result{}, err
			}
		}
		if err := unstructured.SetNestedField(isvc.Object, int64(0), "spec", "replicas"); err != nil {
			return ctrl.Result{}, err
		}
	case "finish":
		remain, err := r.enginePodsRemain(ctx, md)
		if err != nil {
			return ctrl.Result{}, err
		}
		if remain {
			// Hold the drain at zero until every pod (Terminating included —
			// pvc-protection finalizer) is gone; also completes a bounce that
			// crashed after annotating but before draining.
			if err := unstructured.SetNestedField(isvc.Object, int64(0), "spec", "replicas"); err != nil {
				return ctrl.Result{}, err
			}
			for _, obj := range []*unstructured.Unstructured{model, isvc} {
				if err := ctrl.SetControllerReference(md, obj, r.Scheme()); err != nil {
					return ctrl.Result{}, err
				}
				if err := r.Patch(ctx, obj, client.Apply, fieldOwner, client.ForceOwnership); err != nil {
					return ctrl.Result{}, fmt.Errorf("apply %s: %w", obj.GetKind(), err)
				}
			}
			return ctrl.Result{RequeueAfter: 3 * time.Second}, nil
		}
		// Phase 2: wait until the engine pods are fully gone (Terminating
		// pods still hold the pvc-protection finalizer), then delete the
		// cache PVC, clear the bounce mark, and fall through to the apply,
		// which restores the real replica count; LLMkube recreates the PVC
		// and the new pods bind it on the target placement.
		if err := r.deleteModelCachePVC(ctx, md); err != nil {
			return ctrl.Result{}, err
		}
		patch := []byte(fmt.Sprintf(`{"metadata":{"annotations":{%q:null}}}`, cacheBounceAnnotation))
		if err := r.Patch(ctx, md, client.RawPatch(types.MergePatchType, patch)); err != nil {
			return ctrl.Result{}, err
		}
		logger.Info("cache bounce complete — restoring replicas", "modeldeployment", md.Name)
	}

	for _, obj := range []*unstructured.Unstructured{model, isvc} {
		if err := ctrl.SetControllerReference(md, obj, r.Scheme()); err != nil {
			return ctrl.Result{}, err
		}
		if err := r.Patch(ctx, obj, client.Apply, fieldOwner, client.ForceOwnership); err != nil {
			return ctrl.Result{}, fmt.Errorf("apply %s: %w", obj.GetKind(), err)
		}
	}
	logger.V(1).Info("applied provider resources", "modeldeployment", md.Name)

	if placementMoved {
		logger.Info("placement changed — draining engine pods to re-provision the model cache",
			"modeldeployment", md.Name)
		return ctrl.Result{RequeueAfter: 3 * time.Second}, nil
	}

	// Mirror provider status.
	observed := &unstructured.Unstructured{}
	observed.SetGroupVersionKind(isvcGVK)
	if err := r.Get(ctx, req.NamespacedName, observed); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	phase, _, _ := unstructured.NestedString(observed.Object, "status", "phase")
	endpoint, _, _ := unstructured.NestedString(observed.Object, "status", "endpoint")
	ready, _, _ := unstructured.NestedInt64(observed.Object, "status", "readyReplicas")

	status := v1alpha1.ModelDeploymentStatus{ReadyReplicas: int32(ready), Endpoint: endpoint,
		QueueDepth: md.Status.QueueDepth, // scaler-owned; preserved across reconciles
		// The served (capped) window — what Build rendered into the ISVC.
		EffectiveContextTokens: transform.EffectiveContextTokens(md)}
	switch phase {
	case "Ready":
		status.Phase = "Ready"
	case "Failed":
		status.Phase = "Failed"
		status.Message = "provider InferenceService failed"
	case "":
		status.Phase = "Pending"
	default:
		// Scale events (e.g. HPA) put the provider in "Progressing" while it is
		// still serving. Keep it Ready so the gateway doesn't drop the route.
		if ready > 0 && endpoint != "" {
			status.Phase = "Ready"
		} else {
			status.Phase = "Deploying"
		}
	}

	// Scale-to-zero: intended zero (min=0 + explicit "0" annotation) is Idle —
	// a healthy ROUTED state, not Deploying/Failed. Keep the last endpoint:
	// the ClusterIP Service survives at zero and the gateway route must too.
	// A mid-bounce zero (cache-bounce annotation) is NOT Idle.
	if replicas == 0 && md.Annotations[cacheBounceAnnotation] != "1" {
		status.Phase = "Idle"
		if status.Endpoint == "" {
			status.Endpoint = md.Status.Endpoint
		}
	}

	// Until the model is serving, surface the weight-download progress from the
	// LLMkube Model (phases Pending → Downloading → Copying → Ready). This is
	// the long pole for large models, so it gets its own phase + percent.
	requeue := time.Duration(0)
	if status.Phase != "Ready" && status.Phase != "Failed" && status.Phase != "Idle" {
		model := &unstructured.Unstructured{}
		model.SetGroupVersionKind(modelGVK)
		if err := r.Get(ctx, req.NamespacedName, model); err == nil {
			mphase, _, _ := unstructured.NestedString(model.Object, "status", "phase")
			switch mphase {
			case "Downloading", "Copying", "Pending":
				status.Phase = mphase
				total, _, _ := unstructured.NestedInt64(model.Object, "status", "sourceContentLength")
				sizeStr, _, _ := unstructured.NestedString(model.Object, "status", "size")
				status.DownloadPercent = downloadPercent(sizeStr, total)
				// Poll while downloading — the Model status has no watch wired.
				requeue = 3 * time.Second
			}
		}
	}

	// Display overlay, LAST: the block above mutates Phase, and Activity's
	// precedence reads the final Phase (assigning earlier would emit
	// Downloading + ScalingUp together on a placement move). Provisioned first
	// — Activity reads it. Carried forward explicitly from the previous status
	// because this struct is rebuilt every reconcile, exactly like QueueDepth.
	status.Provisioned = provisionedNow(md.Status.Provisioned, status.Phase)
	status.SettledReplicas = settleNow(md.Status.SettledReplicas, replicas, int32(ready))
	status.Activity = activityFor(status.Phase, status.Provisioned, replicas, status.SettledReplicas)
	return r.setStatus(ctx, md, status, requeue)
}

// downloadPercent computes 0-100 from LLMkube's human size ("1.6 GiB") vs the
// upstream byte length. Returns -1 when it can't be computed yet.
func downloadPercent(size string, total int64) int32 {
	if total <= 0 {
		return -1
	}
	got := parseHumanBytes(size)
	if got <= 0 {
		return 0
	}
	pct := got * 100 / total
	if pct > 100 {
		pct = 100
	}
	return int32(pct)
}

// settleNow tracks the last desired count that ready fully reached; carried
// forward through moves exactly like Provisioned (status rebuilt per reconcile).
func settleNow(prev, desired, ready int32) int32 {
	if ready == desired {
		return desired
	}
	return prev
}

// Activity is a DISPLAY-ONLY overlay on Phase: the deployment is moving
// between replica COUNTS. desired vs last-SETTLED desired (not ready): a
// rollout or crashed replica keeps desired == settled and shows no overlay
// (spec 2026-07-23; the pre-settled comparison against ready flagged every
// rollout as a phantom "Scaling up"). Nothing routes on it — Phase stays
// authoritative for the gateway, launch gate and model_routing projection.
func activityFor(phase string, provisioned bool, desired, settled int32) string {
	if !provisioned {
		return "" // first deploy: Downloading/Copying/Deploying are the truth
	}
	switch phase {
	case "Failed", "Downloading", "Copying", "Pending":
		return "" // a real (re-)provision outranks any replica delta
	}
	switch {
	case desired > settled:
		return "ScalingUp"
	case desired < settled:
		return "ScalingDown"
	}
	return ""
}

// provisioned is sticky once the deployment has served: its weights are
// cached, so later pod starts are scale-ups rather than deployments. Idle
// seeds it too — Idle is only reachable after serving (the scaler sleeps only
// from current > 0), which also covers deployments already asleep at upgrade.
func provisionedNow(prev bool, phase string) bool {
	return prev || phase == "Ready" || phase == "Idle"
}

func parseHumanBytes(s string) int64 {
	var n float64
	var unit string
	if _, err := fmt.Sscanf(strings.TrimSpace(s), "%f %s", &n, &unit); err != nil {
		return 0
	}
	mult := map[string]float64{
		"B": 1, "KiB": 1 << 10, "MiB": 1 << 20, "GiB": 1 << 30, "TiB": 1 << 40,
		"KB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12,
	}[unit]
	if mult == 0 {
		return 0
	}
	return int64(n * mult)
}

func (r *ModelDeploymentReconciler) setStatus(ctx context.Context, md *v1alpha1.ModelDeployment,
	status v1alpha1.ModelDeploymentStatus, requeue time.Duration) (ctrl.Result, error) {
	if md.Status == status {
		return ctrl.Result{RequeueAfter: requeue}, nil
	}
	syncGateway := routingChanged(md.Status, status)
	md.Status = status
	if err := r.Status().Update(ctx, md); err != nil {
		return ctrl.Result{}, err
	}
	if syncGateway {
		// Ready-set membership or endpoint changed → (de)register the route
		// automatically instead of waiting for the console's manual sync.
		triggerGatewaySync(ctx, md.Name+" → "+status.Phase)
	}
	return ctrl.Result{RequeueAfter: requeue}, nil
}

// deploymentsForPool maps a ModelPool event to reconcile requests for every
// ModelDeployment that references it, so pool placement edits (node selector,
// tolerations) propagate to the engine pods without touching each deployment.
func (r *ModelDeploymentReconciler) deploymentsForPool(ctx context.Context, obj client.Object) []reconcile.Request {
	mds := &v1alpha1.ModelDeploymentList{}
	if err := r.List(ctx, mds, client.InNamespace(obj.GetNamespace())); err != nil {
		return nil
	}
	var reqs []reconcile.Request
	for _, md := range mds.Items {
		if md.Spec.PoolRef == obj.GetName() {
			reqs = append(reqs, reconcile.Request{
				NamespacedName: types.NamespacedName{Namespace: md.Namespace, Name: md.Name},
			})
		}
	}
	return reqs
}

// enginePodsRemain reports whether any engine pods for the deployment still
// exist — Terminating included, since the PVC's pvc-protection finalizer
// holds until they are fully gone.
func (r *ModelDeploymentReconciler) enginePodsRemain(ctx context.Context, md *v1alpha1.ModelDeployment) (bool, error) {
	pods := &corev1.PodList{}
	if err := r.List(ctx, pods, client.InNamespace(md.Namespace),
		client.MatchingLabels{"inference.llmkube.dev/service": md.Name}); err != nil {
		return false, fmt.Errorf("list engine pods: %w", err)
	}
	return len(pods.Items) > 0, nil
}

// deleteModelCachePVC deletes the deployment's per-service model-cache PVC so
// LLMkube re-provisions it (ensureModelCachePVC, every ISVC reconcile) and
// WaitForFirstConsumer binds it on the new placement. Targets ONLY the
// perService-mode name "<name>-model-cache": in shared cache mode it does not
// exist and the delete is a NotFound no-op, so the shared cache can never be
// destroyed here.
func (r *ModelDeploymentReconciler) deleteModelCachePVC(ctx context.Context, md *v1alpha1.ModelDeployment) error {
	pvc := &corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{
		Name: md.Name + "-model-cache", Namespace: md.Namespace}}
	if err := r.Delete(ctx, pvc); err != nil && !errors.IsNotFound(err) {
		return fmt.Errorf("delete model cache PVC: %w", err)
	}
	return nil
}

// SetupWithManager wires the controller: owns LLMkube InferenceServices so
// provider status changes re-trigger reconciliation.
func (r *ModelDeploymentReconciler) SetupWithManager(mgr ctrl.Manager) error {
	ownedISVC := &unstructured.Unstructured{}
	ownedISVC.SetGroupVersionKind(isvcGVK)
	return ctrl.NewControllerManagedBy(mgr).
		For(&v1alpha1.ModelDeployment{}).
		Watches(&v1alpha1.ModelPool{}, handler.EnqueueRequestsFromMapFunc(r.deploymentsForPool)).
		Watches(ownedISVC, handler.EnqueueRequestForOwner(mgr.GetScheme(), mgr.GetRESTMapper(),
			&v1alpha1.ModelDeployment{}, handler.OnlyControllerOwner())).
		Complete(r)
}
