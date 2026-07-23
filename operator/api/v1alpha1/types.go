package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ModelPoolSpec declares homogeneous compute capacity; it never deploys anything.
type ModelPoolSpec struct {
	// NodeSelector maps the logical pool to physical nodes.
	NodeSelector map[string]string `json:"nodeSelector,omitempty"`
	// Tolerations let this pool's pods run on tainted nodes (the taints are
	// set on the nodes themselves, outside Devproof).
	Tolerations []corev1.Toleration `json:"tolerations,omitempty"`
	// GPUType is the accelerator class ("cpu" allowed). Informational + capacity math.
	GPUType string `json:"gpuType,omitempty"`
	// GPUsPerNode is the accelerator count per node.
	GPUsPerNode int32 `json:"gpusPerNode,omitempty"`
	// MaxNodes is the pool's replica budget: the summed replicas.max of the
	// deployments on this pool must not exceed it (0 = unlimited). Enforced
	// by the control plane, not in-cluster.
	MaxNodes int32 `json:"maxNodes,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:resource:shortName=mpool

// ModelPool is a logical node pool for model serving.
type ModelPool struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              ModelPoolSpec `json:"spec,omitempty"`
}

// +kubebuilder:object:root=true

// ModelPoolList contains a list of ModelPool.
type ModelPoolList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []ModelPool `json:"items"`
}

// ModelSource identifies the model artifact to serve.
type ModelSource struct {
	// Source is the download URL (e.g. HuggingFace resolve URL).
	Source string `json:"source"`
	// Format is the artifact format.
	// +kubebuilder:validation:Enum=gguf;safetensors
	Format string `json:"format"`
	// ContextTokens is the context window to serve with (engine ctx-size).
	// Engine default applies when 0.
	ContextTokens int32 `json:"contextTokens,omitempty"`
}

// ReasoningSpec caps the model's thinking output. The control plane resolves
// a catalog-defined effort label into a token budget at deploy time
// (snapshot semantics — later catalog edits don't retune existing
// deployments). llama.cpp runtimes only.
type ReasoningSpec struct {
	// Effort is the catalog effort label this budget was resolved from (display).
	Effort string `json:"effort,omitempty"`
	// BudgetTokens caps reasoning tokens per response; 0 disables thinking.
	// +kubebuilder:validation:Minimum=0
	BudgetTokens int32 `json:"budgetTokens"`
}

// ReplicaBounds bounds autoscaling.
type ReplicaBounds struct {
	// +kubebuilder:validation:Minimum=0
	Min int32 `json:"min"`
	// +kubebuilder:validation:Minimum=0
	Max int32 `json:"max"`
	// Reserve keeps this many warm replicas above current demand so bursts
	// don't wait for scale-up (scaler input; 0 = scale on demand only).
	// +kubebuilder:validation:Minimum=0
	// +optional
	Reserve int32 `json:"reserve,omitempty"`
	// IdleMinutes is the scale-to-zero window (min=0 only): after this many
	// minutes with zero in-flight requests the scaler parks the deployment at
	// zero replicas (phase Idle); it wakes on the first request. 0 = default
	// (15). Spec 2026-07-15.
	// +kubebuilder:validation:Minimum=0
	// +kubebuilder:validation:Maximum=1440
	// +optional
	IdleMinutes int32 `json:"idleMinutes,omitempty"`
}

// ModelDeploymentSpec binds a model to a pool.
type ModelDeploymentSpec struct {
	Model ModelSource `json:"model"`
	// CatalogID references the Devproof catalog entry this spec was resolved from.
	CatalogID string `json:"catalogId,omitempty"`
	// PoolRef names the ModelPool (same namespace).
	PoolRef string `json:"poolRef"`
	// Engine selects the inference engine. "sglang" maps to the LLMkube
	// SGLang runtime; auto/llama.cpp/vllm keep the provider default engine.
	// +kubebuilder:validation:Enum=auto;llama.cpp;vllm;sglang
	Engine   string        `json:"engine,omitempty"`
	Replicas ReplicaBounds `json:"replicas"`
	// Resources are per-replica requests (keys: cpu, memory, gpu).
	Resources map[string]string `json:"resources,omitempty"`
	// Reasoning caps the model's thinking output (llama.cpp runtimes only).
	// +optional
	Reasoning *ReasoningSpec `json:"reasoning,omitempty"`
	// TargetTokensPerSec is the desired aggregate capacity (sizing input).
	TargetTokensPerSec int32 `json:"targetTokensPerSec,omitempty"`
}

// ModelDeploymentStatus mirrors provider state.
type ModelDeploymentStatus struct {
	// +kubebuilder:validation:Enum=Pending;Downloading;Copying;Deploying;Ready;Failed;Idle
	Phase         string `json:"phase,omitempty"`
	ReadyReplicas int32  `json:"readyReplicas,omitempty"`
	Endpoint      string `json:"endpoint,omitempty"`
	Message       string `json:"message,omitempty"`
	// DownloadPercent is 0-100 while the model weights are downloading (-1 = unknown).
	DownloadPercent int32 `json:"downloadPercent,omitempty"`
	// QueueDepth is requests processing+deferred summed across replicas,
	// published by the operator's scaler; -1 = unknown (no replica reachable).
	// +optional
	QueueDepth int32 `json:"queueDepth"`
	// EffectiveContextTokens is the context window actually served — the
	// spec value clamped to the operator's KV-cache memory cap. 0 = engine
	// default. Lets the control plane and console see a capped window
	// instead of trusting spec.model.contextTokens.
	// +optional
	EffectiveContextTokens int32 `json:"effectiveContextTokens,omitempty"`
	// Activity is a DISPLAY-ONLY overlay on Phase: the deployment is moving
	// between replica counts (spec 2026-07-15 badges). Nothing routes on it.
	// Empty (omitted) means "no overlay: show Phase" — omitempty matters, or
	// the enum below would reject the empty string.
	// +kubebuilder:validation:Enum=ScalingUp;ScalingDown
	// +optional
	Activity string `json:"activity,omitempty"`
	// Provisioned goes true once the deployment has served and stays true: its
	// weights are cached, so later pod starts are scale-ups, not deployments.
	// +optional
	Provisioned bool `json:"provisioned,omitempty"`
	// SettledReplicas is the last desired count that ready fully reached.
	// Activity compares desired against THIS (not ready), so a rollout or a
	// crashed replica — desired unchanged — shows no phantom scale overlay
	// (spec 2026-07-23). Carried forward like Provisioned.
	// +optional
	SettledReplicas int32 `json:"settledReplicas,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:shortName=mdep
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Pool",type=string,JSONPath=`.spec.poolRef`
// +kubebuilder:printcolumn:name="Endpoint",type=string,JSONPath=`.status.endpoint`

// ModelDeployment deploys a catalog model onto a ModelPool.
type ModelDeployment struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              ModelDeploymentSpec   `json:"spec,omitempty"`
	Status            ModelDeploymentStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// ModelDeploymentList contains a list of ModelDeployment.
type ModelDeploymentList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []ModelDeployment `json:"items"`
}
