// Lite deployments (spec 2026-07-19): DEVPROOF_LOCAL_SERVING is rendered by
// the chart from llmkube.enabled — an install-time truth, not a runtime
// toggle. Absent = enabled (out-of-cluster dev default). Read per call so
// tests can flip the env.
export const localServingEnabled = (): boolean =>
  process.env.DEVPROOF_LOCAL_SERVING !== "false";
