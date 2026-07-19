// Deployment badge mapping (spec 2026-07-15 badges). Plain module — imported
// by the server list page AND the client detail tabs, so it must stay free of
// a "use client" directive.

/** Badge label + CSS class. `activity` overlays `phase`; both scaling states
 *  reuse the existing orange `.phase.Deploying` styling. */
export function phaseBadge(phase: string, activity?: string | null) {
  if (phase === "External") return { label: "External", cls: "Ready" };
  if (activity === "ScalingUp") return { label: "Scaling up", cls: "Deploying" };
  if (activity === "ScalingDown") return { label: "Scaling down", cls: "Deploying" };
  const cls = phase === "Ready" ? "Ready" : phase === "Failed" ? "Failed"
            : phase === "Idle" ? "Idle" : "Deploying";
  return { label: phase, cls };
}

/** True when nothing is moving, so the page can stop auto-refreshing. The
 *  `activity` term is load-bearing: a grow is Ready+ScalingUp and a drain is
 *  Idle+ScalingDown, both otherwise-terminal phases. */
export const isSettled = (d: { phase: string; activity?: string | null }) =>
  ["Ready", "Failed", "External", "Idle"].includes(d.phase) && !d.activity;
