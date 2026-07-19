package controller

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	v1alpha1 "github.com/devproof/devproof/operator/api/v1alpha1"
)

// A pool event must enqueue exactly the deployments that reference it —
// same namespace, matching poolRef — and nothing else.
func TestDeploymentsForPool(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := v1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	mk := func(name, ns, poolRef string) *v1alpha1.ModelDeployment {
		return &v1alpha1.ModelDeployment{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
			Spec: v1alpha1.ModelDeploymentSpec{
				PoolRef: poolRef,
				Model:   v1alpha1.ModelSource{Source: "https://x/m.gguf", Format: "gguf"},
			},
		}
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(
		mk("d1", "devproof-serving", "cpu-default"),
		mk("d2", "devproof-serving", "cpu-default"),
		mk("d3", "devproof-serving", "other-pool"),
		mk("d4", "elsewhere", "cpu-default"), // other namespace — not enqueued
	).Build()
	r := &ModelDeploymentReconciler{Client: c}
	pool := &v1alpha1.ModelPool{ObjectMeta: metav1.ObjectMeta{Name: "cpu-default", Namespace: "devproof-serving"}}

	reqs := r.deploymentsForPool(context.Background(), pool)

	names := map[string]bool{}
	for _, q := range reqs {
		if q.Namespace != "devproof-serving" {
			t.Fatalf("unexpected namespace in request: %v", q)
		}
		names[q.Name] = true
	}
	if len(reqs) != 2 || !names["d1"] || !names["d2"] {
		t.Fatalf("expected exactly d1+d2, got %v", reqs)
	}
}

func bounceScheme(t *testing.T) *runtime.Scheme {
	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := v1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	return scheme
}

func TestDeleteModelCachePVC(t *testing.T) {
	ns := "devproof-serving"
	c := fake.NewClientBuilder().WithScheme(bounceScheme(t)).WithObjects(
		&corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Name: "qwen-model-cache", Namespace: ns}},
		&corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Name: "llmkube-model-cache", Namespace: ns}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "qwen-a", Namespace: ns,
			Labels: map[string]string{"inference.llmkube.dev/service": "qwen"}}},
	).Build()
	r := &ModelDeploymentReconciler{Client: c}
	md := &v1alpha1.ModelDeployment{ObjectMeta: metav1.ObjectMeta{Name: "qwen", Namespace: ns}}

	if err := r.deleteModelCachePVC(context.Background(), md); err != nil {
		t.Fatalf("deleteModelCachePVC: %v", err)
	}
	pvc := &corev1.PersistentVolumeClaim{}
	if err := c.Get(context.Background(), types.NamespacedName{Name: "qwen-model-cache", Namespace: ns}, pvc); !errors.IsNotFound(err) {
		t.Fatalf("per-service cache PVC must be deleted, got err=%v", err)
	}
	if err := c.Get(context.Background(), types.NamespacedName{Name: "llmkube-model-cache", Namespace: ns}, pvc); err != nil {
		t.Fatalf("shared cache PVC must be untouched: %v", err)
	}
	pod := &corev1.Pod{}
	if err := c.Get(context.Background(), types.NamespacedName{Name: "qwen-a", Namespace: ns}, pod); err != nil {
		t.Fatalf("the helper must not touch pods (the drain does that): %v", err)
	}
	// Second call: PVC already gone — NotFound no-op, not an error.
	if err := r.deleteModelCachePVC(context.Background(), md); err != nil {
		t.Fatalf("deleteModelCachePVC must tolerate a missing PVC: %v", err)
	}
}

func TestEnginePodsRemain(t *testing.T) {
	ns := "devproof-serving"
	pod := func(name, service, namespace string) *corev1.Pod {
		return &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace,
			Labels: map[string]string{"inference.llmkube.dev/service": service}}}
	}
	c := fake.NewClientBuilder().WithScheme(bounceScheme(t)).WithObjects(
		pod("qwen-a", "qwen", ns),
		pod("other-a", "other", ns),
		pod("qwen-elsewhere", "qwen", "elsewhere"),
	).Build()
	r := &ModelDeploymentReconciler{Client: c}
	md := func(name string) *v1alpha1.ModelDeployment {
		return &v1alpha1.ModelDeployment{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns}}
	}

	remain, err := r.enginePodsRemain(context.Background(), md("qwen"))
	if err != nil || !remain {
		t.Fatalf("qwen pod exists — want remain=true, got %v err=%v", remain, err)
	}
	// Only the labeled pod in the MD's namespace counts.
	remain, err = r.enginePodsRemain(context.Background(), md("nobody"))
	if err != nil || remain {
		t.Fatalf("no pods for 'nobody' — want remain=false, got %v err=%v", remain, err)
	}
	if err := c.Delete(context.Background(), pod("qwen-a", "qwen", ns)); err != nil {
		t.Fatal(err)
	}
	remain, err = r.enginePodsRemain(context.Background(), md("qwen"))
	if err != nil || remain {
		t.Fatalf("qwen pod deleted (other-label/other-ns pods must not count) — want remain=false, got %v err=%v", remain, err)
	}
}
