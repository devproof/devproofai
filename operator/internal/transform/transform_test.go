package transform

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	v1alpha1 "github.com/devproof/devproof/operator/api/v1alpha1"
)

func fixtures() (*v1alpha1.ModelDeployment, *v1alpha1.ModelPool) {
	md := &v1alpha1.ModelDeployment{
		ObjectMeta: metav1.ObjectMeta{Name: "qwen05b-dp", Namespace: "devproof-serving"},
		Spec: v1alpha1.ModelDeploymentSpec{
			Model:     v1alpha1.ModelSource{Source: "https://huggingface.co/x.gguf", Format: "gguf"},
			PoolRef:   "cpu-default",
			Replicas:  v1alpha1.ReplicaBounds{Min: 2, Max: 5},
			Resources: map[string]string{"cpu": "2", "memory": "2Gi"},
		},
	}
	pool := &v1alpha1.ModelPool{
		ObjectMeta: metav1.ObjectMeta{Name: "cpu-default", Namespace: "devproof-serving"},
		Spec: v1alpha1.ModelPoolSpec{
			NodeSelector: map[string]string{"devproof.ai/pool": "cpu-default"},
			GPUType:      "cpu",
		},
	}
	return md, pool
}

func TestBuildModel(t *testing.T) {
	md, pool := fixtures()
	model, _ := Build(md, pool, 2, EngineImages{})

	if model.GetAPIVersion() != "inference.llmkube.dev/v1alpha1" || model.GetKind() != "Model" {
		t.Fatalf("wrong GVK: %s/%s", model.GetAPIVersion(), model.GetKind())
	}
	if model.GetName() != "qwen05b-dp" || model.GetNamespace() != "devproof-serving" {
		t.Fatalf("wrong name/ns: %s/%s", model.GetNamespace(), model.GetName())
	}
	src, _, _ := unstructuredString(model, "spec", "source")
	if src != "https://huggingface.co/x.gguf" {
		t.Fatalf("source not propagated: %q", src)
	}
	if model.GetLabels()[OwnedByLabel] != "qwen05b-dp" {
		t.Fatalf("owned-by label missing: %v", model.GetLabels())
	}
}

func TestBuildInferenceService(t *testing.T) {
	md, pool := fixtures()
	_, isvc := Build(md, pool, 2, EngineImages{})

	if isvc.GetKind() != "InferenceService" {
		t.Fatalf("wrong kind: %s", isvc.GetKind())
	}
	modelRef, _, _ := unstructuredString(isvc, "spec", "modelRef")
	if modelRef != "qwen05b-dp" {
		t.Fatalf("modelRef must equal deployment name, got %q", modelRef)
	}
	replicas, _, _ := unstructuredInt(isvc, "spec", "replicas")
	if replicas != 2 {
		t.Fatalf("replicas must be the given count, got %d", replicas)
	}
	if jinja, _, _ := unstructured.NestedBool(isvc.Object, "spec", "jinja"); !jinja {
		t.Fatal("jinja must be enabled for tool calling")
	}
	sel, _, _ := unstructuredMap(isvc, "spec", "nodeSelector")
	if sel["devproof.ai/pool"] != "cpu-default" {
		t.Fatalf("nodeSelector not taken from pool: %v", sel)
	}
}

func TestBuildOmitsEmptyNodeSelector(t *testing.T) {
	md, pool := fixtures()
	pool.Spec.NodeSelector = nil
	_, isvc := Build(md, pool, 2, EngineImages{})
	if _, found, _ := unstructuredMap(isvc, "spec", "nodeSelector"); found {
		t.Fatal("nodeSelector must be omitted when pool has none")
	}
}

func TestBuildUsesGivenReplicas(t *testing.T) {
	md, pool := fixtures()
	_, isvc := Build(md, pool, 4, EngineImages{})
	replicas, _, _ := unstructuredInt(isvc, "spec", "replicas")
	if replicas != 4 {
		t.Fatalf("replicas must be the given count, got %d", replicas)
	}
	if _, found, _ := unstructured.NestedMap(isvc.Object, "spec", "autoscaling"); found {
		t.Fatal("autoscaling must never be set — the devproof scaler owns replicas")
	}
}

func TestBuildTolerations(t *testing.T) {
	md, pool := fixtures()
	pool.Spec.Tolerations = []corev1.Toleration{
		{Key: "gpu", Operator: corev1.TolerationOpEqual, Value: "true", Effect: corev1.TaintEffectNoSchedule},
		{Operator: corev1.TolerationOpExists},
	}
	_, isvc := Build(md, pool, 1, EngineImages{})
	tols, _, _ := unstructured.NestedSlice(isvc.Object, "spec", "tolerations")
	if len(tols) != 2 {
		t.Fatalf("expected 2 tolerations, got %d", len(tols))
	}
	first := tols[0].(map[string]interface{})
	if first["key"] != "gpu" || first["operator"] != "Equal" || first["value"] != "true" || first["effect"] != "NoSchedule" {
		t.Fatalf("toleration not propagated: %v", first)
	}
	second := tols[1].(map[string]interface{})
	if second["operator"] != "Exists" || second["key"] != nil {
		t.Fatalf("empty fields must be omitted: %v", second)
	}
}

func TestBuildOmitsEmptyTolerations(t *testing.T) {
	md, pool := fixtures()
	_, isvc := Build(md, pool, 1, EngineImages{})
	if _, found, _ := unstructured.NestedSlice(isvc.Object, "spec", "tolerations"); found {
		t.Fatal("tolerations must be omitted when pool has none")
	}
}

func TestBuildEngineSGLangSetsRuntime(t *testing.T) {
	md := &v1alpha1.ModelDeployment{}
	md.Name = "sg-test"
	md.Namespace = "devproof-serving"
	md.Spec.Model.Source = "https://example.com/m.safetensors"
	md.Spec.Model.Format = "safetensors"
	md.Spec.Engine = "sglang"
	pool := &v1alpha1.ModelPool{}
	_, isvc := Build(md, pool, 1, EngineImages{})
	spec := isvc.Object["spec"].(map[string]interface{})
	if spec["runtime"] != "sglang" {
		t.Fatalf("engine sglang must map to isvc runtime sglang, got %v", spec["runtime"])
	}
}

func TestBuildDefaultEngineOmitsRuntime(t *testing.T) {
	for _, engine := range []string{"", "auto", "llama.cpp", "vllm"} {
		md := &v1alpha1.ModelDeployment{}
		md.Name = "def-test"
		md.Namespace = "devproof-serving"
		md.Spec.Model.Source = "https://example.com/m.gguf"
		md.Spec.Model.Format = "gguf"
		md.Spec.Engine = engine
		pool := &v1alpha1.ModelPool{}
		_, isvc := Build(md, pool, 1, EngineImages{})
		spec := isvc.Object["spec"].(map[string]interface{})
		if _, ok := spec["runtime"]; ok {
			t.Fatalf("engine %q must not set isvc runtime (llamacpp default applies)", engine)
		}
	}
}

func TestBuildAffinityFromNodeSelector(t *testing.T) {
	md, pool := fixtures()
	pool.Spec.NodeSelector = map[string]string{"zone": "a", "disk": "ssd"} // unsorted on purpose
	_, isvc := Build(md, pool, 1, EngineImages{})

	terms, found, err := unstructured.NestedSlice(isvc.Object, "spec", "affinity", "nodeAffinity",
		"requiredDuringSchedulingIgnoredDuringExecution", "nodeSelectorTerms")
	if err != nil || !found || len(terms) != 1 {
		t.Fatalf("expected exactly one nodeSelectorTerm, found=%v len=%d err=%v", found, len(terms), err)
	}
	exprs := terms[0].(map[string]interface{})["matchExpressions"].([]interface{})
	if len(exprs) != 2 {
		t.Fatalf("expected 2 matchExpressions, got %d", len(exprs))
	}
	// Sorted by key — random map order would churn the SSA apply and roll pods.
	first := exprs[0].(map[string]interface{})
	second := exprs[1].(map[string]interface{})
	if first["key"] != "disk" || second["key"] != "zone" {
		t.Fatalf("matchExpressions must be key-sorted, got %v then %v", first["key"], second["key"])
	}
	if first["operator"] != "In" {
		t.Fatalf("operator must be In, got %v", first["operator"])
	}
	vals := first["values"].([]interface{})
	if len(vals) != 1 || vals[0] != "ssd" {
		t.Fatalf("values must be the single selector value, got %v", vals)
	}
}

func TestBuildOmitsAffinityWhenNoSelector(t *testing.T) {
	md, pool := fixtures()
	pool.Spec.NodeSelector = nil
	_, isvc := Build(md, pool, 1, EngineImages{})
	if _, found, _ := unstructured.NestedMap(isvc.Object, "spec", "affinity"); found {
		t.Fatal("affinity must be omitted when the pool has no nodeSelector")
	}
}

func TestClampReplicas(t *testing.T) {
	md, _ := fixtures() // min 2, max 5
	cases := []struct {
		current int64
		want    int32
	}{
		{0, 2}, {2, 2}, {4, 4}, {5, 5}, {9, 5},
	}
	for _, c := range cases {
		if got := ClampReplicas(md, c.current); got != c.want {
			t.Fatalf("ClampReplicas(%d) = %d, want %d", c.current, got, c.want)
		}
	}
	md.Spec.Replicas = v1alpha1.ReplicaBounds{Min: 0, Max: 3}
	if got := ClampReplicas(md, 0); got != 1 {
		t.Fatalf("min must floor at 1 (no scale-to-zero), got %d", got)
	}
}

func TestDesiredReplicas(t *testing.T) {
	md, _ := fixtures() // min 2, max 5
	md.Spec.Replicas = v1alpha1.ReplicaBounds{Min: 0, Max: 3}
	cases := []struct {
		name string
		anno string
		ok   bool
		want int32
	}{
		{"explicit zero with min=0 is Idle", "0", true, 0},
		{"missing annotation floors at 1 (fresh deploy warms first)", "", false, 1},
		{"invalid annotation floors at 1", "x", true, 1},
		{"normal value passes through", "2", true, 2},
		{"above max clamps", "9", true, 3},
	}
	for _, c := range cases {
		if got := DesiredReplicas(md, c.anno, c.ok); got != c.want {
			t.Errorf("%s: DesiredReplicas(%q,%v) = %d, want %d", c.name, c.anno, c.ok, got, c.want)
		}
	}
	md.Spec.Replicas = v1alpha1.ReplicaBounds{Min: 2, Max: 5}
	if got := DesiredReplicas(md, "0", true); got != 2 {
		t.Fatalf("explicit zero with min>0 must clamp to min, got %d", got)
	}
}

func isvcWithSpec(spec map[string]interface{}) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{"spec": spec}}
}

func TestPlacementChanged(t *testing.T) {
	base := func() map[string]interface{} {
		return map[string]interface{}{
			"modelRef": "m", "replicas": int64(1),
			"nodeSelector": map[string]interface{}{"a": "1"},
		}
	}

	if PlacementChanged(isvcWithSpec(base()), isvcWithSpec(base())) {
		t.Fatal("identical specs must not report a change")
	}

	repl := base()
	repl["replicas"] = int64(4)
	if PlacementChanged(isvcWithSpec(base()), isvcWithSpec(repl)) {
		t.Fatal("a replicas-only diff is not a placement change")
	}

	sel := base()
	sel["nodeSelector"] = map[string]interface{}{"a": "2"}
	if !PlacementChanged(isvcWithSpec(base()), isvcWithSpec(sel)) {
		t.Fatal("a nodeSelector value change must be reported")
	}

	aff := base()
	aff["affinity"] = map[string]interface{}{"nodeAffinity": map[string]interface{}{}}
	if !PlacementChanged(isvcWithSpec(base()), isvcWithSpec(aff)) {
		t.Fatal("adding affinity must be reported")
	}

	tol := base()
	tol["tolerations"] = []interface{}{map[string]interface{}{"operator": "Exists"}}
	if !PlacementChanged(isvcWithSpec(base()), isvcWithSpec(tol)) {
		t.Fatal("adding tolerations must be reported")
	}

	bare := map[string]interface{}{"modelRef": "m"}
	if PlacementChanged(isvcWithSpec(bare), isvcWithSpec(map[string]interface{}{"modelRef": "m"})) {
		t.Fatal("both sides absent must not report a change")
	}
}

// Build is deterministic (sorted affinity keys), so re-rendering the same
// pool must never look like a placement change — the no-churn guarantee.
func TestPlacementChangedStableAcrossRebuilds(t *testing.T) {
	md, pool := fixtures()
	pool.Spec.NodeSelector = map[string]string{"b": "2", "a": "1"}
	_, first := Build(md, pool, 1, EngineImages{})
	_, second := Build(md, pool, 3, EngineImages{}) // replicas differ; placement must not
	if PlacementChanged(first, second) {
		t.Fatal("identical pool rendering must not report a placement change")
	}
}

func TestEffectiveContextTokens(t *testing.T) {
	md, _ := fixtures()
	cases := []struct {
		spec int32
		want int32
	}{
		{0, 0},           // unset — engine default, nothing served explicitly
		{20000, 20000},   // under the cap — served as requested
		{32768, 32768},   // exactly the cap
		{262144, 32768},  // above the cap — silently capped no more: surfaced
	}
	for _, c := range cases {
		md.Spec.Model.ContextTokens = c.spec
		if got := EffectiveContextTokens(md); got != c.want {
			t.Fatalf("EffectiveContextTokens(%d) = %d, want %d", c.spec, got, c.want)
		}
	}
}

func TestBuildContextSizeMatchesEffective(t *testing.T) {
	md, pool := fixtures()
	md.Spec.Model.ContextTokens = 262144
	_, isvc := Build(md, pool, 1, EngineImages{})
	ctx, found, _ := unstructuredInt(isvc, "spec", "contextSize")
	if !found || ctx != int64(EffectiveContextTokens(md)) {
		t.Fatalf("contextSize must equal the effective context (%d), found=%v got %d",
			EffectiveContextTokens(md), found, ctx)
	}
	md.Spec.Model.ContextTokens = 0
	_, isvc = Build(md, pool, 1, EngineImages{})
	if _, found, _ := unstructuredInt(isvc, "spec", "contextSize"); found {
		t.Fatal("contextSize must be omitted when ContextTokens is 0 (engine default)")
	}
}

func TestBuildReasoningBudget(t *testing.T) {
	md, pool := fixtures()
	md.Spec.Reasoning = &v1alpha1.ReasoningSpec{Effort: "medium", BudgetTokens: 4096}
	_, isvc := Build(md, pool, 1, EngineImages{})
	budget, found, _ := unstructuredInt(isvc, "spec", "reasoningBudget")
	if !found || budget != 4096 {
		t.Fatalf("reasoningBudget must be 4096, found=%v got %d", found, budget)
	}
	msg, _, _ := unstructuredString(isvc, "spec", "reasoningBudgetMessage")
	if msg != ReasoningWrapUp {
		t.Fatalf("wrap-up message must be set for budget > 0, got %q", msg)
	}
}

func TestBuildReasoningOffHasNoMessage(t *testing.T) {
	md, pool := fixtures()
	md.Spec.Reasoning = &v1alpha1.ReasoningSpec{Effort: "off", BudgetTokens: 0}
	_, isvc := Build(md, pool, 1, EngineImages{})
	budget, found, _ := unstructuredInt(isvc, "spec", "reasoningBudget")
	if !found || budget != 0 {
		t.Fatalf("budget 0 (thinking off) must be rendered, found=%v got %d", found, budget)
	}
	if _, found, _ := unstructuredString(isvc, "spec", "reasoningBudgetMessage"); found {
		t.Fatal("budget 0 must not set a wrap-up message (nothing to wrap up)")
	}
}

func TestBuildOmitsReasoningWhenUnset(t *testing.T) {
	md, pool := fixtures()
	_, isvc := Build(md, pool, 1, EngineImages{})
	if _, found, _ := unstructuredInt(isvc, "spec", "reasoningBudget"); found {
		t.Fatal("reasoningBudget must be omitted when spec.reasoning is nil (engine default -1)")
	}
	if _, found, _ := unstructuredString(isvc, "spec", "reasoningBudgetMessage"); found {
		t.Fatal("reasoningBudgetMessage must be omitted when spec.reasoning is nil")
	}
}

func TestBuildEngineImageSelection(t *testing.T) {
	engines := EngineImages{CPU: "devproof/devproofai-llama.cpp:server", GPU: "devproof/devproofai-llama.cpp:server-cuda"}

	md, pool := fixtures()
	_, isvc := Build(md, pool, 1, engines)
	if img, _, _ := unstructuredString(isvc, "spec", "image"); img != engines.CPU {
		t.Fatalf("cpu deployment must get the cpu engine image, got %q", img)
	}

	md, pool = fixtures()
	md.Spec.Resources["gpu"] = "1"
	_, isvc = Build(md, pool, 1, engines)
	if img, _, _ := unstructuredString(isvc, "spec", "image"); img != engines.GPU {
		t.Fatalf("gpu deployment must get the cuda engine image, got %q", img)
	}

	md, pool = fixtures()
	md.Spec.Engine = "sglang"
	_, isvc = Build(md, pool, 1, engines)
	if img, found, _ := unstructuredString(isvc, "spec", "image"); found {
		t.Fatalf("sglang must keep the provider image, got %q", img)
	}

	md, pool = fixtures()
	_, isvc = Build(md, pool, 1, EngineImages{})
	if img, found, _ := unstructuredString(isvc, "spec", "image"); found {
		t.Fatalf("empty EngineImages must leave spec.image unset, got %q", img)
	}
}

func TestBuildModelHardwareGpu(t *testing.T) {
	// LLMkube's CUDA-image divert (resolveRuntimeImage) keys ONLY on the Model
	// CR's spec.hardware.gpu — ISVC resources.gpu feeds --n-gpu-layers but NOT
	// image selection. Without the hardware block a GPU deployment runs the
	// CPU-only llama.cpp:server image with an allocated-but-unused GPU (live
	// bug: gemma-4-12b-it-q4 at 0.18 tok/s, 2026-07-23).
	md, pool := fixtures()
	md.Spec.Resources["gpu"] = "2"
	model, _ := Build(md, pool, 1, EngineImages{})
	count, found, err := unstructured.NestedInt64(model.Object, "spec", "hardware", "gpu", "count")
	if err != nil || !found || count != 2 {
		t.Fatalf("gpu deployment must declare Model hardware.gpu.count: found=%v err=%v count=%d", found, err, count)
	}

	md, pool = fixtures()
	model, _ = Build(md, pool, 1, EngineImages{})
	if _, found, _ := unstructured.NestedMap(model.Object, "spec", "hardware"); found {
		t.Fatalf("cpu deployment must not declare Model hardware")
	}
}

func TestBuildResourcesGpuIsNumeric(t *testing.T) {
	// The LLMkube ISVC CRD types spec.resources.gpu as integer (int32) while
	// cpu/memory are strings — a string gpu fails the typed server-side apply
	// ("expected numeric (int or float), got string") and the ISVC is never
	// created (live bug: gemma-4-12b-it-q4, 2026-07-22).
	md, pool := fixtures()
	md.Spec.Resources["gpu"] = "1"
	_, isvc := Build(md, pool, 1, EngineImages{})
	res, found, err := unstructured.NestedMap(isvc.Object, "spec", "resources")
	if err != nil || !found {
		t.Fatalf("spec.resources missing: found=%v err=%v", found, err)
	}
	if g, ok := res["gpu"].(int64); !ok || g != 1 {
		t.Fatalf("resources.gpu must be numeric for the ISVC CRD, got %T %v", res["gpu"], res["gpu"])
	}
	if c, ok := res["cpu"].(string); !ok || c != "2" {
		t.Fatalf("resources.cpu must stay a string, got %T %v", res["cpu"], res["cpu"])
	}
	if m, ok := res["memory"].(string); !ok || m != "2Gi" {
		t.Fatalf("resources.memory must stay a string, got %T %v", res["memory"], res["memory"])
	}
}

func TestBuildImagePullSecret(t *testing.T) {
	md, pool := fixtures()
	_, isvc := Build(md, pool, 1, EngineImages{PullSecret: "ghcr-pull"})
	sec, found, _ := unstructured.NestedSlice(isvc.Object, "spec", "imagePullSecrets")
	if !found || len(sec) != 1 || sec[0].(map[string]interface{})["name"] != "ghcr-pull" {
		t.Fatalf("pull secret must be stamped, got %v", sec)
	}

	md, pool = fixtures()
	_, isvc = Build(md, pool, 1, EngineImages{})
	if _, found, _ := unstructured.NestedSlice(isvc.Object, "spec", "imagePullSecrets"); found {
		t.Fatalf("no pull secret configured must leave imagePullSecrets unset")
	}
}
