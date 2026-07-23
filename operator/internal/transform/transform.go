// Package transform maps Devproof resources to LLMkube provider resources.
// Pure functions, no I/O — the provider seam per concept §5.4.
package transform

import (
	"sort"
	"strconv"

	apiequality "k8s.io/apimachinery/pkg/api/equality"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	v1alpha1 "github.com/devproof/devproof/operator/api/v1alpha1"
)

// OwnedByLabel marks provider resources managed by a ModelDeployment.
const OwnedByLabel = "serving.devproof.ai/owned-by"

// ReasoningWrapUp is injected by llama.cpp before the end-of-thinking tag
// when the reasoning budget runs out — without it the model continues
// thinking-style prose in the visible answer (verified live 2026-07-12).
const ReasoningWrapUp = "Thinking budget reached — concluding and answering now."

const llmkubeAPIVersion = "inference.llmkube.dev/v1alpha1"

// EngineImages are the llama.cpp engine images stamped into ISVC spec.image
// (chart operator.engineImage → env DEVPROOF_ENGINE_IMAGE[_GPU] — Devproof
// mirrors of ghcr.io/ggml-org/llama.cpp). Empty = leave the ISVC image unset
// so the LLMkube upstream default applies. PullSecret (chart registryAuth →
// env DEVPROOF_IMAGE_PULL_SECRET) is stamped as ISVC spec.imagePullSecrets —
// engine pods pull the private curl-init mirror even when the engine image
// itself is the public upstream default.
type EngineImages struct {
	CPU        string
	GPU        string
	PullSecret string
}

// Build returns the desired LLMkube Model and InferenceService for a
// ModelDeployment given its pool. Both are named after the ModelDeployment,
// live in its namespace, and carry the owned-by label.
func Build(md *v1alpha1.ModelDeployment, pool *v1alpha1.ModelPool, replicas int32, engines EngineImages) (*unstructured.Unstructured, *unstructured.Unstructured) {
	labels := map[string]interface{}{OwnedByLabel: md.Name}

	model := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": llmkubeAPIVersion,
		"kind":       "Model",
		"metadata": map[string]interface{}{
			"name":      md.Name,
			"namespace": md.Namespace,
			"labels":    labels,
		},
		"spec": map[string]interface{}{
			"source": md.Spec.Model.Source,
			"format": md.Spec.Model.Format,
		},
	}}
	// GPU deployments must declare hardware.gpu on the Model CR: LLMkube's
	// CUDA-image divert (resolveRuntimeImage, 0.9.9+) keys ONLY on it — ISVC
	// resources.gpu feeds --n-gpu-layers and the device request but NOT image
	// selection, so without this block the engine runs the CPU-only image with
	// an allocated-but-unused GPU (vendor unset = NVIDIA upstream default).
	if g, ok := md.Spec.Resources["gpu"]; ok {
		if n, err := strconv.ParseInt(g, 10, 32); err == nil && n > 0 {
			model.Object["spec"].(map[string]interface{})["hardware"] = map[string]interface{}{
				"gpu": map[string]interface{}{"count": n},
			}
		}
	}

	isvcSpec := map[string]interface{}{
		"modelRef": md.Name,
		"replicas": int64(replicas),
		// Tool calling requires the engine's jinja chat-template mode
		// (verified: without it llama.cpp rejects tool schemas at sampler init).
		"jinja": true,
	}
	// Serve the model's full context window — the engine default (4k) is far
	// too small for agentic clients (Claude Code's system prompt + tools alone
	// exceed it). Capped via EffectiveContextTokens.
	if ctx := EffectiveContextTokens(md); ctx > 0 {
		isvcSpec["contextSize"] = int64(ctx)
	}
	// Reasoning budget (llama.cpp --reasoning-budget): 0 disables thinking,
	// N>0 caps it; omitted = engine default (-1, unrestricted).
	if md.Spec.Reasoning != nil {
		isvcSpec["reasoningBudget"] = int64(md.Spec.Reasoning.BudgetTokens)
		if md.Spec.Reasoning.BudgetTokens > 0 {
			isvcSpec["reasoningBudgetMessage"] = ReasoningWrapUp
		}
	}
	// Engine "sglang" selects LLMkube's SGLang runtime (ISVC spec.runtime,
	// 0.9.4+). Every other value omits the field so the provider default
	// (llamacpp) applies — vllm stays accepted-but-unmapped, as before.
	if md.Spec.Engine == "sglang" {
		isvcSpec["runtime"] = "sglang"
	}
	// Engine image (Devproof mirror): deployments requesting GPUs (resources
	// gpu key) get the CUDA variant. llamacpp-runtime only — sglang keeps its
	// provider image.
	if md.Spec.Engine != "sglang" {
		img := engines.CPU
		if g, ok := md.Spec.Resources["gpu"]; ok && g != "" && g != "0" {
			img = engines.GPU
		}
		if img != "" {
			isvcSpec["image"] = img
		}
	}
	if engines.PullSecret != "" {
		isvcSpec["imagePullSecrets"] = []interface{}{
			map[string]interface{}{"name": engines.PullSecret},
		}
	}
	// Replicas are written by the devproof scaler (queue-depth based, see
	// internal/scaler) and enforced by LLMkube onto the engine Deployment.
	// LLMkube's own autoscaling block is never set: its 0.9.1 custom-metric
	// HPA is broken (dotted selector labels) and CPU utilization is a poor
	// signal for GPU inference.
	if len(md.Spec.Resources) > 0 {
		res := map[string]interface{}{}
		for k, v := range md.Spec.Resources {
			// The ISVC CRD types resources.gpu as integer (cpu/memory are
			// strings); a string gpu fails the typed server-side apply.
			if k == "gpu" {
				if n, err := strconv.ParseInt(v, 10, 32); err == nil {
					res[k] = n
					continue
				}
			}
			res[k] = v
		}
		isvcSpec["resources"] = res
	}
	if len(pool.Spec.NodeSelector) > 0 {
		sel := map[string]interface{}{}
		for k, v := range pool.Spec.NodeSelector {
			sel[k] = v
		}
		isvcSpec["nodeSelector"] = sel
	}
	if len(pool.Spec.Tolerations) > 0 {
		tols := make([]interface{}, 0, len(pool.Spec.Tolerations))
		for _, t := range pool.Spec.Tolerations {
			m := map[string]interface{}{}
			if t.Key != "" {
				m["key"] = t.Key
			}
			if t.Operator != "" {
				m["operator"] = string(t.Operator)
			}
			if t.Value != "" {
				m["value"] = t.Value
			}
			if t.Effect != "" {
				m["effect"] = string(t.Effect)
			}
			tols = append(tols, m)
		}
		isvcSpec["tolerations"] = tols
	}

	// LLMkube (verified through 0.9.7) renders ISVC nodeSelector/tolerations into the engine pod
	// template only for GPU/DRA workloads (deployment_builder.go gates them
	// behind gpuCount > 0) — CPU pods silently ignore them. Affinity is applied
	// unconditionally, so the selector is additionally expressed as a required
	// node affinity. Keys are sorted: a random map order would change the
	// applied ISVC every reconcile and roll pods forever.
	if len(pool.Spec.NodeSelector) > 0 {
		keys := make([]string, 0, len(pool.Spec.NodeSelector))
		for k := range pool.Spec.NodeSelector {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		exprs := make([]interface{}, 0, len(keys))
		for _, k := range keys {
			exprs = append(exprs, map[string]interface{}{
				"key": k, "operator": "In", "values": []interface{}{pool.Spec.NodeSelector[k]},
			})
		}
		isvcSpec["affinity"] = map[string]interface{}{
			"nodeAffinity": map[string]interface{}{
				"requiredDuringSchedulingIgnoredDuringExecution": map[string]interface{}{
					"nodeSelectorTerms": []interface{}{
						map[string]interface{}{"matchExpressions": exprs},
					},
				},
			},
		}
	}

	isvc := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": llmkubeAPIVersion,
		"kind":       "InferenceService",
		"metadata": map[string]interface{}{
			"name":      md.Name,
			"namespace": md.Namespace,
			"labels":    labels,
		},
		"spec": isvcSpec,
	}}

	return model, isvc
}

// MaxContextTokens caps the served context window: KV-cache memory grows
// linearly with context, and a 128k window (Llama 3.2 catalog value) would
// OOM the 2Gi CPU pods.
const MaxContextTokens = 32768

// EffectiveContextTokens is the context window actually served for a
// deployment — the catalog value clamped to MaxContextTokens (0 = engine
// default). Surfaced in the ModelDeployment status so a silently capped
// window (live bug 2026-07-13: 262144 requested, 32768 served, session
// overflowed) is visible to the control plane and console.
func EffectiveContextTokens(md *v1alpha1.ModelDeployment) int32 {
	ctx := md.Spec.Model.ContextTokens
	if ctx > MaxContextTokens {
		return MaxContextTokens
	}
	return ctx
}

// DesiredReplicas resolves the scaler's target-replicas annotation into the
// replica count to render. Explicit "0" with min=0 means Idle (scale-to-zero,
// spec 2026-07-15); anything else clamps into [max(min,1), max]. A missing or
// invalid annotation floors at 1 so a fresh min=0 deploy warms up first and
// earns its sleep through the idle window.
func DesiredReplicas(md *v1alpha1.ModelDeployment, annotation string, ok bool) int32 {
	if ok {
		if n, err := strconv.ParseInt(annotation, 10, 32); err == nil {
			if n == 0 && md.Spec.Replicas.Min == 0 {
				return 0
			}
			return ClampReplicas(md, n)
		}
	}
	return ClampReplicas(md, int64(md.Spec.Replicas.Min))
}

// ClampReplicas bounds a live replica count into the deployment's [min, max]
// window, min floored at 1 — scale-to-zero resolves through DesiredReplicas.
func ClampReplicas(md *v1alpha1.ModelDeployment, current int64) int32 {
	lo := md.Spec.Replicas.Min
	if lo < 1 {
		lo = 1
	}
	hi := md.Spec.Replicas.Max
	if hi < lo {
		hi = lo
	}
	switch {
	case current < int64(lo):
		return lo
	case current > int64(hi):
		return hi
	default:
		return int32(current)
	}
}

// PlacementChanged reports whether the scheduling-relevant ISVC spec fields —
// nodeSelector, affinity, tolerations — differ between the live object and
// the desired rendering. Used by the reconciler to detect placement moves
// that strand the engine pods on the old node's cache PVC (node-local
// storage): those require deleting the per-service cache PVC and bouncing
// the pods. Absent fields compare as nil, and Build renders deterministically
// (sorted affinity keys), so identical placement never reports a change.
func PlacementChanged(live, desired *unstructured.Unstructured) bool {
	for _, field := range []string{"nodeSelector", "affinity", "tolerations"} {
		a, _, _ := unstructured.NestedFieldNoCopy(live.Object, "spec", field)
		b, _, _ := unstructured.NestedFieldNoCopy(desired.Object, "spec", field)
		if !apiequality.Semantic.DeepEqual(a, b) {
			return true
		}
	}
	return false
}

// unstructuredString reads a nested string field.
func unstructuredString(u *unstructured.Unstructured, fields ...string) (string, bool, error) {
	return unstructured.NestedString(u.Object, fields...)
}

// unstructuredInt reads a nested int64 field.
func unstructuredInt(u *unstructured.Unstructured, fields ...string) (int64, bool, error) {
	return unstructured.NestedInt64(u.Object, fields...)
}

// unstructuredMap reads a nested string map field.
func unstructuredMap(u *unstructured.Unstructured, fields ...string) (map[string]string, bool, error) {
	return unstructured.NestedStringMap(u.Object, fields...)
}
