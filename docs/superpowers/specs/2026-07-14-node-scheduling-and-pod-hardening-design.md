# Node-driven scheduling pickers + pod-config hardening

**Date:** 2026-07-14
**Status:** Design approved, pending implementation plan

## Motivation

The environment form lets a user type nodeSelector labels and tolerations as
free text (`environments/create.tsx` `kvrow` inputs). Nothing checks that the
typed labels exist on any node, nothing validates k8s label syntax, and the
`sizeGb` for a durable `/work` PVC has a lower bound (`≥1`) but no ceiling — a
typo like `9999999` passes validation and leaves a PVC Pending forever.
Separately, `buildTurnJob` spreads the stored `tolerations` raw into the Job
(`orchestrator.ts:295`), and the session routes carry the environment as `any`.

This work replaces free-text scheduling inputs with pickers populated from the
cluster's actual node labels and taints, makes the disk cap a platform setting,
declutters the (separately overloaded) **settings page** with an accordion, and
closes the remaining backend hardening items.

This supersedes the four-item "env pod-config hardening" TODO
(label-value validation for nodeSelector, sizeGb sanity cap, typed environment,
whitelist toleration fields in buildTurnJob) — items 1 and 4 are reshaped into
the node-driven picker + render-time whitelist below.

## Non-goals

- No accordion/reorg of the **environment** form — it stays flat; only the two
  scheduling editors change.
- No in-cluster RBAC work. The control plane runs out-of-cluster
  (`loadFromDefault()`); there is no CP `ClusterRole` in the repo, and
  `/v1/storage-classes` already reads cluster resources by the same path with no
  RBAC. `core.listNode()` behaves identically. (Should an in-cluster CP
  deployment ever be introduced, it will need `nodes: list` alongside the
  storageclasses grant — noted, out of scope here.)
- MCP OAuth, autoscaling, and cost-model changes are untouched.

## Section 1 — Node introspection endpoint (backend)

A read-only, cluster-global endpoint, sibling to `GET /v1/storage-classes`.

- `orchestrator.listNodeScheduling()` calls `core.listNode()` and aggregates
  across all nodes:
  - **labels** → `Record<string, string[]>`: every label key mapped to the
    sorted, de-duplicated set of values seen on nodes.
  - **taints** → `{ key: string; value: string; effect: string }[]`: distinct
    taints (deduped by `key|value|effect`) collected from each node's
    `spec.taints`.
- Shape mirrors `listStorageClasses` (`orchestrator.ts:234`): tolerant of
  missing fields (`res.items ?? []`), never throws on an empty cluster.
- `GET /v1/node-scheduling` returns `{ labels, taints }`. Registered on **both**
  API surfaces (`agents-api.ts` and `public-api.ts`) exactly where
  `/v1/storage-classes` is. Not workspace-scoped — Serving/cluster resources are
  global.
- Added to the `Orchestrator` interface in `agents-api.ts` next to
  `listStorageClasses`.

**Testing:** unit test `listNodeScheduling`'s aggregation against a fake node
list (overlapping label values, duplicate taints, a node with no taints).

## Section 2 — nodeSelector / toleration pickers (console)

New `console/app/lib/label-combobox.tsx`, modeled on `mcp-picker.tsx`
(search-filtered dropdown panel, click-outside via a `wrapRef`, local Escape
handling that does not hijack the modal's Escape stack, free-text fallback).

- **Node selector** — each row is a **key combobox** (typeahead over discovered
  label keys) plus a **value combobox** (typeahead over the values observed for
  the chosen key). Both accept a typed value not present on any node — the
  free-text escape hatch. Emits the same `{ k, v }` row shape the form already
  uses, so `submit()`'s `nodeSelector` assembly (`create.tsx:81-82`) is
  unchanged.
- **Tolerations** — a combobox over discovered **taints**; selecting one fills
  `key`, `value`, and `effect` in one action. The existing operator/effect
  `select`s remain for manual/custom entry. Emits the same `TolDraft` shape, so
  `submit()`'s toleration assembly (`create.tsx:83-91`) is unchanged.
- The modal loads `/v1/node-scheduling` once on open, mirroring the existing
  storage-classes load (`create.tsx:43-47`). **On fetch failure the fields
  degrade to plain free-text inputs** (today's behavior) — no hard dependency on
  cluster reachability, and no blocking error.

**Testing:** manual — open create/edit against docker-desktop, confirm the
combobox lists the single node's labels/taints; confirm free-text entry still
submits; confirm a fetch failure degrades to text inputs.

## Section 3 — Settings page accordion + Limits (console + backend)

`settings/form.tsx` is one `setpanel` with a "Cost tracking" heading and nested
"Real costs"/"Billing" sections. Adding the disk cap on top overloads it.

- Reorganize into collapsible **accordion** sections, panel styling adapted to
  fit (the existing `setpanel`/`setsection` look is preserved inside each
  section):
  - **Cost tracking** — the entire existing block, unchanged internally.
  - **Limits** (new) — "Max session disk (GiB)", default **2048**, with room for
    future platform limits.
- Persistence: extend the `app_settings` singleton JSON with a `limits` key
  beside `costs` — `data->'limits'->'maxWorkGb'`. **No migration** (jsonb;
  `getLimits` defaults to 2048 when the key is absent, matching the
  `getCostSettings` pattern at `repo.ts:1221`).
- `GET /v1/settings` returns `{ costs, limits }`; `PUT /v1/settings` accepts an
  optional `limits` and writes it via `jsonb_set(data, '{limits}', …)` (mirrors
  `setCostSettings` at `repo.ts:1227`). `settings/page.tsx` loads `limits`
  alongside costs and threads it into `SettingsForm`.

**Testing:** unit test `getLimits`/`setLimits` default + round-trip; manual —
save a cap, reload, confirm it persists; confirm accordion collapse/expand.

## Section 4 — Settings-driven sizeGb cap (backend)

- `validatePodConfig` gains a second argument and stays pure:
  `validatePodConfig(pod, opts?: { maxWorkGb?: number })`. `sizeGb` must be an
  integer in `[1, maxWorkGb]` (default `maxWorkGb = 2048` when not supplied, so
  existing callers/tests keep working). Error message names the cap.
- The four call sites (`agents-api.ts:272,283`; `public-api.ts:386,397`) fetch
  the setting (`repo.getLimits()`) and pass `{ maxWorkGb }`.
- The console `submit()` disk check (`create.tsx:69`) is advisory only; the API
  edge is the enforcing boundary.

**Testing:** unit tests for the cap bound (below 1, above cap, at cap,
non-integer) in `pod-config` tests.

## Section 5 — Backend hardening (typed env, whitelist render, label syntax)

- **Label-syntax validation** in `validatePodConfig`:
  - nodeSelector **keys** validated as k8s label keys: optional
    `DNS-subdomain/` prefix, then a name segment matching
    `[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?`, each segment ≤63 chars.
  - nodeSelector **values** validated as k8s label values: ≤63 chars, same
    charset, empty string allowed.
  - toleration **keys** validated with the same key rule.
  - This is the safety net for free-text and direct API/kubectl callers;
    combobox-sourced picks are inherently valid.
- **Reject unknown fields at the edge (strict):** unknown top-level `pod` keys
  and unknown toleration keys return a 400. Only affects future writes; existing
  rows are not re-validated on read.
- **Whitelist at render:** `buildTurnJob` rebuilds `tolerations` from only
  `{ key, operator, value, effect }` (drops any extra field) instead of
  spreading `pod.tolerations` raw (`orchestrator.ts:295`). `nodeSelector` is
  already a plain `Record<string,string>`; rebuilt for symmetry
  (`orchestrator.ts:294`).
- **Typed environment:** replace `const environment: any` in `session-actions.ts`
  (lines 60, 112) with a concrete type, and type the launch payload's
  `environment: { id: string; pod: PodConfig }`.

**Testing:** unit tests — label-syntax accept/reject cases; unknown-field
rejection; a `buildTurnJob` test asserting a stored toleration carrying an extra
field renders clean (only the four allowed fields).

## Files touched

**Backend (`control-plane/src/`)**
- `orchestrator.ts` — `listNodeScheduling()`; `buildTurnJob` toleration/nodeSelector rebuild.
- `agents-api.ts` — `/v1/node-scheduling` route; `Orchestrator` interface; pass `maxWorkGb` to `validatePodConfig`; `GET/PUT /v1/settings` limits.
- `public-api.ts` — `/v1/node-scheduling` route; pass `maxWorkGb` to `validatePodConfig`.
- `pod-config.ts` — cap arg; label-syntax validation; strict unknown-field rejection.
- `repo.ts` — `getLimits`/`setLimits`.
- `session-actions.ts` — typed `environment`.
- Tests: `pod-config` tests, `orchestrator`/`buildTurnJob` test, `listNodeScheduling` test.

**Console (`console/app/`)**
- `lib/label-combobox.tsx` — new.
- `environments/create.tsx` — swap the two scheduling editors for the comboboxes; load `/v1/node-scheduling`.
- `settings/form.tsx` — accordion + Limits section.
- `settings/page.tsx` — load `limits`.
- CSS — accordion + combobox styles.

## Verification

`cd control-plane && npm test && npx tsc --noEmit`. Then restart CP + console,
confirm all pages 200, and exercise: create an environment (combobox lists the
docker-desktop node's labels/taints, free-text still works), a `sizeGb` above the
cap 400s, the settings accordion saves a cap that then enforces, and a session
turn on an env with a nodeSelector/toleration schedules and bills.
