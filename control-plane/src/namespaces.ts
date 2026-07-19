// Kubernetes namespaces the CP operates in. Env-driven for the Helm chart
// (spec 2026-07-18-helm-charts); defaults preserve the raw-manifest layout so
// out-of-cluster dev keeps working unchanged. Keep this module side-effect-free
// (tests import it in a subprocess).
export const AGENTS_NAMESPACE = process.env.DEVPROOF_AGENTS_NAMESPACE ?? "devproof-agents";
export const GATEWAY_NAMESPACE = process.env.DEVPROOF_GATEWAY_NAMESPACE ?? "devproof-gateway";
export const SERVING_NAMESPACE = process.env.DEVPROOF_SERVING_NAMESPACE ?? "devproof-serving";
