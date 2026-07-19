# Platform improvements batch — design

Date: 2026-07-10. Status: approved by Carsten (WebFetch fix = disable the
Anthropic pre-check, not allowlist it; no-env sessions = block by default;
API keys = soft delete; first-call slowness = warmup + evidence-gated docs).

Eleven small improvements across the session runner, egress control,
environments, API keys, the operator, and console polish. Grouped into six
work areas; each is independently shippable.

## Verified findings (live, 2026-07-10)

- **WebFetch failure root cause** (session `sesn_6903d5f0df83dcefeff8ec12`,
  env allows `docs.dremio.com`): every WebFetch failed — the CLI's WebFetch
  preflight ("unable to verify if domain X is safe to fetch") blocked the
  fetch — while `curl` to
  docs.dremio.com from the same session succeeded. The CLI's WebFetch
  pre-checks each hostname against `api.anthropic.com` before fetching; the
  egress proxy blocks that, so ALL WebFetches fail regardless of allowlist.
  Disable: `skipWebFetchPreflight: true` — settings.json only, no env var
  (docs: the vendor CLI docs, data-usage.md). WebFetch honors `HTTPS_PROXY` for
  the actual fetch, so Squid enforcement then works as intended.
- **No-env sessions are wide open**: pods without `environment_id` get no
  proxy env and no `devproof.ai/environment` label, so no NetworkPolicy
  selects them — unrestricted outbound, pip works. The session panel's
  "Packages: Disabled" is cosmetic (`env?.allow_package_managers` on an
  undefined env).
- **Models are NOT lazy**: `minElastic` floors HPA min at 1
  (`operator/internal/transform/transform.go:104`), serving pod up 25h,
  llama-server runs without `--no-warmup` (weights warmed at load). The slow
  first call is something else — most plausibly full prompt prefill on CPU
  for the first large request; later requests hit llama.cpp's per-slot
  prompt-prefix cache.
- **Key delete is a hard row DELETE** (`repo.deleteApiKey`); `gateway_usage`
  FK is `ON DELETE SET NULL`, so the name is gone forever → "(deleted key)".
- **Grey content boxes** are all `pre.block`
  (`background: var(--paper)` = #eaeef3): skill viewer, memory-store
  browser, session panels, trace previews, api-key reveal.
- Runner loads project settings: `setting_sources=["project"]` reads the
  CLI's project config dir under `/work` (of the legacy CLI
  runtime) — a staged `settings.json` is picked up.

## A. Session runner image → dev15

- `session-runner/Dockerfile`:
  - apt line gains `unzip zip gzip bzip2 xz-utils p7zip-full file jq curl`
    (`gunzip` is part of gzip; "bzip" = bzip2; `tar` already in base).
  - pip analysis stack gains `requests`.
- `session-runner/runner.py`: during staging, write a `settings.json` =
  `{"skipWebFetchPreflight": true}` into the CLI's project config dir under
  `/work` (created
  fresh; skills stage into that dir's `skills/` subdir — now
  `/work/.devproof/skills` — no collision).
- Bump `DEVPROOF_RUNNER_IMAGE` tag `dev14` → `dev15`; update CLAUDE.md run
  notes (tag + preinstalled-tools list).

## B. Egress: wildcard allowlists + secure no-env default

**Wildcards** (`ensureEnvironmentPolicy` squid conf generation, extracted to
a pure exported function `squidConf(hosts, allowPackageManagers)` for
testability):
- `*` → allow all outbound (`http_access allow all`; traffic still flows
  through the proxy).
- `*.foo.com` → normalize to `.foo.com` (apex + all subdomains — identical
  to today's leading-dot semantics for plain hosts, accepted as an alias).
- Plain hosts unchanged (inclusive: `docs.dremio.com` matches itself + its
  subdomains). No existing environment breaks.
- Console hint text (create + edit): *"comma or newline separated; supports
  `*.domain.com` and `*` (allow all); empty = all outbound blocked"*.

**No-env lockdown** (items "validate packages-disabled" + "block by
default"):
- CP startup ensures a built-in deny-all egress by calling
  `ensureEnvironmentPolicy` with a pseudo-env
  `{ id: "env_none", allowedHosts: [], allowPackageManagers: false }` →
  Squid `egress-env-none` (deny all) + NetworkPolicy `env-env-none`.
- Orchestrator: sessions WITHOUT `environment_id` now get label
  `devproof.ai/environment: env_none` and HTTP(S)_PROXY pointing at
  `egress-env-none` (same NO_PROXY exemptions: gateway, CP callback). On
  docker-desktop the proxy env is the enforcing layer (CNI ignores
  NetworkPolicy); on enforcing CNIs the policy closes the ignore-the-proxy
  loophole.
- `deleteEnvironmentResources` must never tear down `env_none` (not a DB
  row, so unaffected by environment CRUD).
- Session panel copy when no environment: "No environment — all outbound
  blocked" (replaces the misleading Packages: Disabled-only display; the
  Packages row stays and is now truthful).

## C. Environments become editable

- CP: `PATCH /v1/environments/:id` accepting
  `{ name?, allowed_hosts?, allow_package_managers? }` →
  `repo.updateEnvironment(ws, id, fields)` (404 if not found in workspace),
  then re-run `ensureEnvironmentPolicy` with the updated env. The existing
  409-path (replace ConfigMap + annotation patch on the Deployment) restarts
  Squid with the new allowlist; the Service name stays, so running sessions
  pick up new rules as soon as Squid reloads — no pod changes.
- Console (`/environments`): clicking the environment **name** opens the
  shared `Modal` pre-filled with the same fields as create
  (catalog/pools convention — environments have no detail page). Save =
  PATCH + refresh.

## D. API keys: soft delete + honest usage labels

- `repo.deleteApiKey` → `UPDATE api_keys SET status='deleted' WHERE id=$1
  AND workspace_id=$2` (row + name survive). Gateway revocation unchanged:
  auth requires `status='active'` (≤30s cache TTL). `setApiKeyStatus` keeps
  rejecting 'deleted' as an input (delete is the only path in).
- `listApiKeys` gains `includeDeleted` flag (default false → API-keys page
  unchanged). `GET /v1/api-keys?include=deleted` returns them for the usage
  filter dropdown.
- `gatewayUsage` byKey: LEFT JOIN already yields the name; also select
  `k.status`. UI label rules (usage page + usage filter dropdown):
  - `api_key_id === null` → "(deleted key)" (legacy hard-deleted rows —
    names unrecoverable, keep the `__deleted__` sentinel filter).
  - `status === 'deleted'` → `"<name> [deleted]"`.
  - else → name.
- No migration needed (status is TEXT; 'deleted' is a new value).

## E. First-call slowness: warmup + evidence-gated docs

- (Amended during planning: the operator AND the CP run out-of-cluster in
  dev and cannot reach ClusterIP pod endpoints; the gateway is reachable
  everywhere and is the true serving path — so warmup moves from the
  operator to the CP's gateway sync.)
- CP `syncGateway` (server.ts): track which local deployments are routed
  (module-level Set). When a deployment newly enters the ready-routed set,
  fire-and-forget `warmDeployment(name)`: up to 12 attempts, 10s apart,
  `POST ${DEVPROOF_GATEWAY_LOCAL_URL ?? http://127.0.0.1:14000}/v1/chat/completions`
  with Bearer `DEVPROOF_INTERNAL_KEY`, body `{model, messages:[{role:"user",
  content:"hi"}], max_tokens: 8}`; stop on first 2xx; log outcome; never
  throw (retries cover the gateway's config-reload restart window). Names
  that drop out of the ready set are removed so a re-deploy re-warms.
  Warmup requests meter as `source='session'` (internal key) — invisible to
  billing (Usage filters `source='api'`), ~8 tokens in deployment stats.
  After a CP restart every ready model gets one redundant warmup — harmless.
- Measured gate (during implementation, not speculation): redeploy a local
  model, time 1st vs 2nd identical call. If a large gap remains and is
  prefill-bound (big prompt on CPU), document it as expected behavior in
  CLAUDE.md + a hint on the deployment detail Overview ("first large prompt
  pays full prefill; repeated prefixes are cached") instead of chasing a
  fix.

## F. Console polish

- `pre.block` background: `var(--paper)` → `var(--panel)` (white in light
  mode; dark mode keeps panel navy). Border stays `var(--line)` for shape.
  Affects: skill viewer, memory-store browser, session panels (system
  prompt, previews, event payloads), trace previews, api-key reveal — all
  intended.
- Files → sessions drill-down:
  - CP: `GET /v1/sessions?file=<file_id>` — `repo.listSessions` gains an
    optional `fileId` (JOIN `session_files sf ON sf.session_id = s.id AND
    sf.file_id = $n`), combinable with the existing agent filter and
    pagination.
  - CP: new `GET /v1/files/:id` returning the file's metadata row (404 as
    `{error:"file not found"}`) — none exists today (only /content).
  - Console: Files table "Sessions" count becomes a Link to
    `/sessions?file=<id>` when count > 0. Sessions page reads
    `searchParams.file`, passes it to the CP list call, and shows a
    clearable filter chip ("file: <name> ×" → links back to `/sessions`);
    the chip label comes from the new metadata endpoint (falls back to the
    raw id if the file was deleted).

## Failure & scale posture

- Deny-all default egress is one extra Squid Deployment total (not per
  session) — negligible; scales exactly like existing per-env proxies.
- Soft-deleted keys accumulate rows (fine — same table growth as inactive
  keys; excluded from default lists and auth).
- Warmup request is once per Ready transition per deployment; on scale-out
  events readyReplicas stays >0 → no repeat warmups.

## Verification

- CP tests: `squidConf` mapping (`*`, `*.foo.com`, plain host, empty,
  packages on/off), `updateEnvironment` (fields + 404), soft delete
  (status flip, excluded from default list, included with flag),
  `listSessions` file filter (+ pagination), usage byKey carrying status.
- `npx tsc --noEmit` + full `npm test`; console production build.
- Live gates (docker-desktop):
  1. New runner image: session in the dremio env — WebFetch docs.dremio.com
     succeeds, WebFetch docs.crewai.com blocked (proxy denial, not
     "unable to verify"); `unzip`/`jq`/`curl` present; `python -c "import
     requests"` works.
  2. No-env session: outbound curl blocked, pip install blocked, model
     calls + file publishing still work; panel shows the new copy.
  3. Edit an environment's allowlist → Squid reloads → next request obeys
     the new list without recreating the session.
  4. Delete an API key mid-traffic → 401 within ~30s → Usage shows
     "name [deleted]"; legacy NULL rows still "(deleted key)".
  5. Files page → sessions link → filtered list with chip.
  6. Warmup: redeploy a model, compare 1st/2nd call timings; document
     residual prefill if present.
  7. All console pages 200 after CP + console restart.
