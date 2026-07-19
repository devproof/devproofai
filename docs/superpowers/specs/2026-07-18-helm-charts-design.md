# Helm charts — design (2026-07-18)

One umbrella Helm chart installs the whole Devproof platform. Own templates for
everything Devproof-shaped; the only inherited chart is LLMkube (pinned
dependency). The chart replaces the raw manifests in `deploy/` as the single
source of truth, including for the docker-desktop dev cluster.

## Decisions (user-approved 2026-07-18)

- **Own templates, not upstream charts**, for postgres, minio, and the LiteLLM
  gateway. Rationale: Bitnami images frozen/paywalled (Aug 2025); MinIO
  community edition being stripped; the upstream litellm chart owns
  `proxy_config` as values and would fight the CP's runtime `syncGateway`.
- **LLMkube is inherited** as a Chart.yaml dependency (pinned 0.9.4,
  `condition: llmkube.enabled`). It is genuinely upstream (CRDs and all);
  hand-copying its manifests would mean tracking its CRDs manually.
- **One umbrella chart** (`charts/devproof`), not per-component charts or
  file:// subcharts. One `helm install` = a working platform.
- **One platform namespace** (the release namespace) **+ a configurable agents
  namespace** (default `devproof-agents`) — a real security boundary
  (NetworkPolicies, egress proxies, untrusted workloads).
- **Service-type exposure only** (ClusterIP/LoadBalancer/NodePort +
  annotations); no Ingress templating in v1.
- **Chart everywhere**: `values-dev.yaml` reproduces the dev cluster; the raw
  manifests `deploy/postgres`, `deploy/minio`, `deploy/gateway` are deleted
  after migration. `deploy/dev/localhost-lb.yaml` stays (additive dev-only
  Services).
- The resources/scheduling/PVC/service requirements **apply to the inherited
  LLMkube chart too**, via values passthrough (audit-first; gaps documented,
  candidate upstream PRs).

## Chart layout

```
charts/devproof/
  Chart.yaml            # apiVersion v2; dependency: llmkube 0.9.4 (condition: llmkube.enabled)
  values.yaml           # production-shaped defaults (images = ghcr.io/devproof/<name>)
  values-dev.yaml       # docker-desktop preset
  files/                # custom_callbacks.py (moved out of deploy/gateway/litellm.yaml)
  templates/
    _helpers.tpl        # labels, name helpers, shared scheduling/resources/service snippets
    controlplane/  console/  gateway/  operator/  postgres/  minio/  agents/
  tests/                # helm template snapshot tests for both values files
```

### Common knob contract

Every component block gets the same fields, rendered via shared helpers so the
contract cannot drift per component:

```yaml
<component>:
  enabled: true                      # where toggleable
  image: {repository, tag, pullPolicy}
  resources: {requests: {...}, limits: {...}}
  nodeSelector: {}
  tolerations: []
```

User-facing endpoints — `console`, `gateway`, `controlplane` — additionally get:

```yaml
  service:
    type: ClusterIP | LoadBalancer | NodePort
    port: <n>
    nodePort: null          # honored when type=NodePort
    annotations: {}         # cloud-LB behavior lives here
    loadBalancerClass: null
```

Postgres and MinIO are ClusterIP-only (internal databases per requirement); dev
host access continues via `deploy/dev/localhost-lb.yaml`.

### Namespaces

Four hardcoded namespaces in code become env-configurable (chart sets the envs;
defaults in code stay the current constants, so out-of-cluster dev keeps
working before migration):

| Constant | Where | Env |
|---|---|---|
| `devproof-agents` | `orchestrator.ts:10` | `DEVPROOF_AGENTS_NAMESPACE` |
| `devproof-gateway` | `kubestore.ts:7` | `DEVPROOF_GATEWAY_NAMESPACE` |
| `devproof-serving` | `catalog.ts:50` | `DEVPROOF_SERVING_NAMESPACE` |
| `devproof-system`/`-storage` | raw manifests | die with the manifests |

Gateway and serving namespaces default to the release namespace in the chart.
Consequence (accepted): ISVC engine pods land in the release namespace; a
separate serving ns stays one values line away. The agents namespace
(`agents.namespace`, default `devproof-agents`) is created by the chart along
with the CP's RoleBinding in it.

### CRDs

Our operator's CRDs (ModelPool, ModelDeployment — both `scope: Namespaced`)
ship as chart **templates** gated by `crds.install` (mirroring llmkube's
pattern) so `helm upgrade` re-applies them. A `crds/` directory would never
upgrade them.

### LLMkube passthrough

The umbrella's `llmkube:` values block forwards to the subchart, folding in the
current `deploy/llmkube/values.yaml` (`modelCache.mode: perService`). First
implementation step: audit llmkube 0.9.4's chart values for operator-pod
resources/nodeSelector/tolerations and model-cache PVC storageClass/size; any
knob upstream doesn't expose is documented as a gap (candidate upstream PR),
never silently dropped. As a dependency, llmkube installs into the **release
namespace**, not `llmkube-system` (verified: the operator watches cluster-wide
and creates ISVCs in the MD's own namespace, so no code change follows).

## Data services

### Postgres (bundled)

- `postgres.enabled: true` → single-pod Deployment (Recreate strategy, as
  today), `persistence: {storageClass, size}`.
- **Two credentials** in one chart-generated Secret: `admin-password` (the
  `postgres` superuser) and `app-password` (the `devproof` role the CP and
  gateway use). Generated with the lookup-and-reuse idiom — minted at install,
  byte-identical across `helm upgrade` (verified live on Helm 4.2.2 against
  docker-desktop). `auth.existingSecret` brings your own.
- An init-script ConfigMap (`docker-entrypoint-initdb.d`) creates the
  `devproof` role: non-superuser, owner of the `devproof` DB. (Today's manifest
  makes the app user the superuser — this design fixes that.) Verified: all 44
  migration files are plain DDL/plpgsql — no CREATE EXTENSION/ALTER SYSTEM —
  so the non-superuser DB owner suffices for `migrate()`.
- Known limitation (documented, not solved): the init script runs only on
  first init of an empty data volume; credential *rotation* after install is
  out of scope.

### External Postgres

`postgres.enabled: false` +
`externalDatabase: {host, port, database, user, sslMode, existingSecret | password}`.
The chart renders `DEVPROOF_DATABASE_URL` for CP and gateway from those values.
No admin credential involved — migrations run as the app user.

### MinIO (bundled)

Same pattern: `minio.enabled`, `persistence: {storageClass, size}`, generated
root-credential Secret (lookup-idempotent, `auth.existingSecret` override).
Bucket creation stays CP-side (`main.ts` `CreateBucketCommand` at boot).

### External S3 / AWS auth

```yaml
s3:
  endpoint: ""            # empty = real AWS S3
  bucket: devproof-files
  region: ""
  auth:
    mode: key | podIdentity
    existingSecret: ""    # mode=key: keys access-key-id / secret-access-key
```

- `mode: key` → `DEVPROOF_S3_ACCESS_KEY/SECRET_KEY` from the Secret.
- `mode: podIdentity` → **no credential envs**; the CP falls back to the AWS
  SDK default provider chain (IRSA / EKS Pod Identity).
  `controlplane.serviceAccount.annotations` carries the IRSA role ARN; EKS Pod
  Identity needs only the named ServiceAccount.

**In-scope CP change** (`filestore.ts:97-107`, `main.ts:165-179`): keys become
optional (absent → omit `credentials`); `endpoint` optional (absent → real
AWS S3); `region` env-driven (`AWS_REGION`/`DEVPROOF_S3_REGION`);
`forcePathStyle` only when a custom endpoint is set. The hardcoded dev-cred
defaults (`devproof`/`devproof-dev-secret`) are removed — credentials come
explicitly or not at all.

## Platform components

### Gateway

Chart owns Deployment, Service (exposure contract), HPA (configurable
min/max/CPU target, default 2/10), and:

- **`litellm-config` ConfigMap** — ownership resolved by how the CP actually
  writes it (verified `kubestore.ts:81-93`: merge-patch of the `config.yaml`
  key only; the ConfigMap must pre-exist):
  - `custom_callbacks.py`: ships as a chart file (`files/`), helm-owned,
    upgraded normally. A pod-template checksum annotation covers **only** this
    file, so pods roll on callbacks changes but not on every upgrade.
  - `config.yaml`: lookup-preserve — first install renders a minimal bootstrap
    config; later upgrades re-emit the CP-written content verbatim.
- **`gateway-auth` Secret** (`internal-key`): CP-managed — `ensureGatewayAuthSecret`
  (`main.ts:38`) creates it at CP boot and exports `DEVPROOF_INTERNAL_KEY`; the
  chart does not create it (found during implementation; the gateway pod already
  mounts it `optional: true`).
- `gateway-provider-keys` stays CP-managed; the pod mounts it `optional: true`.
- `DEVPROOF_DATABASE_URL` switches from plaintext to secretKeyRef composition
  from the app credential.
- Image stays `ghcr.io/berriai/litellm:main-stable` (configurable); the boot
  `pip install asyncpg` args stay. Baking a `devproof/gateway` image remains
  the documented air-gap follow-up.

### Control plane

Deployment + Service (user-facing: python client / API), ServiceAccount (with
`annotations` for IRSA), replicas configurable (boot migrations are
advisory-locked; >1 is safe). Env: DB URL, S3 block, `DEVPROOF_RUNNER_IMAGE`
(`agents.runnerImage`), `DEVPROOF_GATEWAY_LOCAL_URL` → in-cluster gateway
Service, internal key from `gateway-auth`, the three namespace envs.

**RBAC — enumerated from the complete audit of CP K8s calls (33 verbs across
`kubestore.ts`/`orchestrator.ts` et al.), not guessed:**

- Role, platform/gateway ns: ConfigMaps (read/patch/replace/create/delete),
  Secrets (read/patch/replace/create/delete), gateway Deployment (read/patch —
  rolling reload), Services, custom objects (`serving.devproof.ai` ModelPools/
  ModelDeployments + llmkube `models`).
- Role, agents ns: Jobs (create/read/deleteCollection), Deployments (egress
  Squid), Services, ConfigMaps, Secrets, PVCs (create/deleteCollection),
  NetworkPolicies (create/delete).
- ClusterRole: `nodes` list, `storageclasses` list. Nothing else
  cluster-scoped.

### Console

Deployment + Service (exposure contract). Only env: the CP's internal Service
URL — browser traffic proxies through Next (SSE lesson), so the console never
needs the CP exposed to reach it.

### Operator

Deployment + CRD templates. `cmd/main.go` takes zero flags/envs (kubeconfig
only) and watches cluster-wide — nothing to thread. **RBAC gap flushed out by
this work:** only 2 kubebuilder markers exist (PVC get/delete, pods
get/list/watch) against the real surface (ISVC/Model CR writes, MD/Pool watch
+ status, `pods/proxy` for the scaler's metrics scrape). Tasks: backfill the
markers, hand-author the ClusterRole from code. The operator has only ever run
out-of-cluster with an admin kubeconfig — the chart-install e2e is the first
real exercise of its in-cluster RBAC.

## Dev parity & migration

`values-dev.yaml`: `controlplane.enabled: false`, `console.enabled: false`
(both run out-of-cluster in dev), postgres/minio enabled with fixed dev
credentials, small resources, gateway HPA min 2, `llmkube.enabled: true` with
current values folded in.

One-time dev-cluster migration, ordered:

1. `helm uninstall llmkube -n llmkube-system`
2. Delete raw-manifest resources (namespaces `devproof-system`,
   `devproof-storage`, `devproof-gateway`); optional `pg_dump` first (re-seeding
   models/agents is tedious; data is otherwise dev-disposable).
3. `helm install devproof charts/devproof -n devproof -f values-dev.yaml`
4. Restart the out-of-cluster CP with the new namespace envs.

Model weights re-download into fresh cache PVCs (known consequence of moving
ISVCs; brief serving gap, dev-acceptable).

## Verification

- `helm lint` + `helm template` snapshot tests for both values files, in CI
  next to the backend suite.
- Real proof on docker-desktop: full install from `values-dev.yaml`, all
  console pages 200, deploy a model, run an e2e session (agent → session →
  gateway → events).
- `cd control-plane && npm test` and `npx tsc --noEmit` stay green after the
  CP env/S3 changes. The CP changes are backward-compatible (envs default to
  today's constants), so nothing breaks before the cluster migration.

## Out of scope (v1, documented in chart README)

- Ingress / TLS termination
- Credential rotation
- Prometheus / metrics-server / KEDA (documented prerequisites/optionals)
- Baking a `devproof/gateway` image (air-gap follow-up)
- Chart repository / OCI publishing (install from repo checkout; CI publishing
  is a follow-up)
- Per-model/pool scheduling (runtime concerns via pools/environments, not
  chart values)
