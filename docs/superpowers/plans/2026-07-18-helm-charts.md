# Helm Charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One umbrella Helm chart (`charts/devproof`) installs the whole platform — own templates for postgres/minio/gateway/CP/console/operator, LLMkube inherited as a pinned dependency — replacing the raw manifests in `deploy/` everywhere, including the docker-desktop dev cluster.

**Architecture:** Single chart, release namespace + configurable agents namespace. Chart-generated credentials use the lookup-and-reuse idiom (verified stable across `helm upgrade` on Helm 4.2.2). The gateway ConfigMap splits ownership: `custom_callbacks.py` is helm-owned (chart file), `config.yaml` is CP-owned at runtime (lookup-preserve). Small in-scope code changes: CP namespace envs, S3 default-credential-chain support, HOST bind, console runtime API proxy.

**Tech Stack:** Helm 4.2.2, Kubernetes (docker-desktop dev / EKS-class prod), Node test runner for chart render tests, existing CP test suite.

**Spec:** `docs/superpowers/specs/2026-07-18-helm-charts-design.md`

## Global Constraints

- kubectl context is `docker-desktop`; never switch context in scripts.
- Everything must scale to hundreds–thousands of pods AND run on docker-desktop.
- Go binary: `$HOME/sdk/go/bin/go` (not on PATH).
- CP tests: `cd control-plane && npm test` (serial on purpose — never remove `--test-concurrency=1`) and `npx tsc --noEmit`.
- Resource names the CP references by string must not change: Deployment `gateway`, ConfigMap `litellm-config`, Secrets `gateway-auth`, `gateway-provider-keys`, custom-object plurals `modelpools`/`modeldeployments`/`models`.
- `gateway-auth` and `gateway-provider-keys` Secrets are **CP-managed** (`ensureGatewayAuthSecret` in `main.ts:38`, provider keys in `kubestore.ts:142`) — the chart must NOT create them. (Amends the spec, which assumed the chart generates `gateway-auth`.)
- CP env-default changes must be backward-compatible: defaults stay today's constants so the out-of-cluster dev flow keeps working until migration.
- Console UI rules and CLAUDE.md conventions apply to any console change.
- Commits end with the standard `Co-Authored-By: Claude Fable 5` / `Claude-Session` trailer.

---

### Task 1: LLMkube chart values audit

**Files:**
- Create: `charts/devproof/README.md` (audit section only; expanded in Task 11)

**Interfaces:**
- Produces: the documented mapping of umbrella `llmkube.*` values → upstream knobs, used verbatim by Task 2's `values.yaml` and Task 11's `values-dev.yaml`.

- [ ] **Step 1: Fetch upstream values**

```bash
helm repo add llmkube https://defilantech.github.io/LLMKube 2>/dev/null; helm repo update llmkube
helm show values llmkube/llmkube --version 0.9.4 > "$TMPDIR/llmkube-values.yaml" 2>/dev/null \
  || helm show values llmkube/llmkube --version 0.9.4
```

(Use the scratchpad directory if `$TMPDIR` is unset.)

- [ ] **Step 2: Record the audit**

Read the full values output. For each required knob, record the upstream path or mark it a GAP:

| Requirement | Upstream path (fill from audit) |
|---|---|
| operator pod resources | e.g. `resources:` or `controllerManager.resources:` |
| operator nodeSelector | ... |
| operator tolerations | ... |
| model-cache PVC storageClass | under `modelCache:` |
| model-cache PVC size | under `modelCache:` |

Create `charts/devproof/README.md` (the file will not exist yet; `charts/` may need creating):

```markdown
# Devproof umbrella chart

(Install docs land here in a later task.)

## LLMkube passthrough (audited 2026-07-18, chart 0.9.4)

Everything under the `llmkube:` values key passes through to the upstream
LLMkube chart (pinned dependency). Scheduling/resources/PVC requirements map
as follows:

| Umbrella value | Upstream effect |
|---|---|
| llmkube.<path from audit> | operator pod resources |
| llmkube.<path from audit> | operator nodeSelector |
| llmkube.<path from audit> | operator tolerations |
| llmkube.modelCache.<path> | model-cache PVC storage class |
| llmkube.modelCache.<path> | model-cache PVC size |

### Gaps

<List any knob upstream does not expose. For each: what we need, what exists,
candidate upstream PR. If none: "No gaps — all required knobs exposed.">
```

Fill the table with the real paths from Step 1 — do not leave the placeholders.

- [ ] **Step 3: Commit**

```bash
git add charts/devproof/README.md
git commit -m "docs(chart): llmkube 0.9.4 values audit for passthrough knobs"
```

---

### Task 2: Chart scaffold, helpers, values.yaml, test harness

**Files:**
- Create: `charts/devproof/Chart.yaml`
- Create: `charts/devproof/values.yaml`
- Create: `charts/devproof/templates/_helpers.tpl`
- Create: `charts/devproof/tests/render.test.mjs`
- Modify: `.gitignore` (add `charts/devproof/charts/`)

**Interfaces:**
- Produces (used by every later chart task):
  - Helpers: `devproof.app` (component → `devproof-<name>` label), `devproof.podScheduling` (nodeSelector+tolerations block from a component values object), `devproof.image` (`{repository,tag}` → ref), `devproof.gatewayNamespace`, `devproof.servingNamespace`, `devproof.service` (full Service manifest from `dict "root" $ "name" .. "component" .. "svc" .. "targetPort" ..`), `devproof.stableSecretValue` (`dict "root" $ "secret" name "key" key "value" fixedOrEmpty` → b64 value, reused from live cluster if present).
  - Values contract: blocks `postgres, externalDatabase, minio, s3, gateway, controlplane, console, operator, agents, namespaces, crds, llmkube` exactly as written below.
  - Test helper: `render(args)` in `render.test.mjs` returning `helm template` output.

- [ ] **Step 1: Write Chart.yaml**

```yaml
apiVersion: v2
name: devproof
description: Devproof AI — self-hosted LLM serving + managed-agents platform
type: application
version: 0.1.0
appVersion: "0.1.0"
dependencies:
  - name: llmkube
    version: 0.9.4
    repository: https://defilantech.github.io/LLMKube
    condition: llmkube.enabled
```

- [ ] **Step 2: Write values.yaml**

```yaml
# Every component carries the same contract: image, resources, nodeSelector,
# tolerations; user-facing endpoints (console, gateway, controlplane) add a
# service block (type/port/nodePort/annotations/loadBalancerClass).

crds:
  install: true

# Passthrough to the pinned LLMkube dependency (see README audit table).
llmkube:
  enabled: true
  modelCache:
    mode: perService

namespaces:
  # "" = the release namespace. Override only for a split layout.
  gateway: ""
  serving: ""

agents:
  namespace: devproof-agents
  runnerImage: devproof/session-runner:dev50

postgres:
  enabled: true
  image: { repository: postgres, tag: 17-alpine, pullPolicy: IfNotPresent }
  resources:
    requests: { cpu: 100m, memory: 256Mi }
    limits: { memory: 512Mi }
  nodeSelector: {}
  tolerations: []
  persistence: { storageClass: "", size: 2Gi }
  auth:
    # Empty passwords = generated once at install (stable across upgrades).
    adminPassword: ""
    appPassword: ""
    # Bring-your-own secret with keys admin-password / app-password
    # (must exist before install — read via lookup).
    existingSecret: ""

# Used when postgres.enabled=false.
externalDatabase:
  host: ""
  port: 5432
  database: devproof
  user: devproof
  password: ""
  existingSecret: ""   # key: password (must exist before install)
  sslMode: ""          # e.g. require

minio:
  enabled: true
  image: { repository: minio/minio, tag: latest, pullPolicy: IfNotPresent }
  resources:
    requests: { cpu: 100m, memory: 256Mi }
    limits: { memory: 1Gi }
  nodeSelector: {}
  tolerations: []
  persistence: { storageClass: "", size: 10Gi }
  auth:
    rootUser: devproof
    rootPassword: ""     # "" = generated
    existingSecret: ""   # keys MINIO_ROOT_USER / MINIO_ROOT_PASSWORD

# Used when minio.enabled=false.
s3:
  endpoint: ""           # "" = real AWS S3
  bucket: devproof-files
  region: ""
  auth:
    mode: key            # key | podIdentity
    existingSecret: ""   # mode=key: keys access-key-id / secret-access-key

gateway:
  image: { repository: ghcr.io/berriai/litellm, tag: main-stable, pullPolicy: IfNotPresent }
  resources:
    requests: { cpu: 250m, memory: 1Gi }
    limits: { memory: 2Gi }
  nodeSelector: {}
  tolerations: []
  service:
    type: ClusterIP
    port: 4000
    nodePort: null
    annotations: {}
    loadBalancerClass: null
  hpa:
    minReplicas: 2
    maxReplicas: 10
    targetCPUUtilizationPercentage: 75

controlplane:
  enabled: true
  image: { repository: ghcr.io/devproof/control-plane, tag: latest, pullPolicy: IfNotPresent }
  replicas: 1
  resources:
    requests: { cpu: 250m, memory: 512Mi }
    limits: { memory: 1Gi }
  nodeSelector: {}
  tolerations: []
  service:
    type: ClusterIP
    port: 7080
    nodePort: null
    annotations: {}
    loadBalancerClass: null
  serviceAccount:
    annotations: {}      # e.g. eks.amazonaws.com/role-arn for IRSA

console:
  enabled: true
  image: { repository: ghcr.io/devproof/console, tag: latest, pullPolicy: IfNotPresent }
  resources:
    requests: { cpu: 100m, memory: 256Mi }
    limits: { memory: 512Mi }
  nodeSelector: {}
  tolerations: []
  service:
    type: ClusterIP
    port: 7090
    nodePort: null
    annotations: {}
    loadBalancerClass: null

operator:
  enabled: true
  image: { repository: ghcr.io/devproof/operator, tag: latest, pullPolicy: IfNotPresent }
  resources:
    requests: { cpu: 100m, memory: 128Mi }
    limits: { memory: 256Mi }
  nodeSelector: {}
  tolerations: []
```

- [ ] **Step 3: Write templates/_helpers.tpl**

```yaml
{{/* Selector label value: devproof-<component> (matches the raw manifests,
     so deploy/dev/localhost-lb.yaml selectors keep working). */}}
{{- define "devproof.app" -}}devproof-{{ . }}{{- end }}

{{- define "devproof.image" -}}{{ .repository }}:{{ .tag }}{{- end }}

{{/* nodeSelector + tolerations from a component values block.
     Usage: {{- include "devproof.podScheduling" .Values.gateway | nindent 6 }} */}}
{{- define "devproof.podScheduling" -}}
{{- with .nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}

{{- define "devproof.gatewayNamespace" -}}{{ .Values.namespaces.gateway | default .Release.Namespace }}{{- end }}
{{- define "devproof.servingNamespace" -}}{{ .Values.namespaces.serving | default .Release.Namespace }}{{- end }}

{{/* User-facing Service. Usage:
     {{ include "devproof.service" (dict "root" $ "name" "gateway" "component" "gateway"
        "svc" .Values.gateway.service "targetPort" 4000 "namespace" (include "devproof.gatewayNamespace" $)) }} */}}
{{- define "devproof.service" -}}
apiVersion: v1
kind: Service
metadata:
  name: {{ .name }}
  namespace: {{ .namespace | default .root.Release.Namespace }}
  {{- with .svc.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
spec:
  type: {{ .svc.type }}
  {{- with .svc.loadBalancerClass }}
  loadBalancerClass: {{ . }}
  {{- end }}
  selector:
    app: {{ include "devproof.app" .component }}
  ports:
    - port: {{ .svc.port }}
      targetPort: {{ .targetPort }}
      {{- if and (eq .svc.type "NodePort") .svc.nodePort }}
      nodePort: {{ .svc.nodePort }}
      {{- end }}
{{- end }}

{{/* Stable secret value: reuse the live cluster value if present (lookup),
     else the fixed value from values, else 24 random alphanumerics.
     Returns base64. Empty under `helm template` (no cluster) unless fixed. */}}
{{- define "devproof.stableSecretValue" -}}
{{- $existing := lookup "v1" "Secret" .root.Release.Namespace .secret -}}
{{- if and $existing (hasKey ($existing.data | default dict) .key) -}}
{{ index $existing.data .key }}
{{- else if .value -}}
{{ .value | b64enc }}
{{- else -}}
{{ randAlphaNum 24 | b64enc }}
{{- end -}}
{{- end }}
```

- [ ] **Step 4: Write the test harness**

`charts/devproof/tests/render.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const chart = fileURLToPath(new URL("..", import.meta.url));

// The llmkube dependency must be present for template/lint (one-time network fetch).
if (!existsSync(new URL("../charts", import.meta.url)))
  execFileSync("helm", ["dependency", "build", chart], { stdio: "inherit" });

export function render(args = []) {
  return execFileSync("helm", ["template", "devproof", chart, "-n", "devproof", ...args], {
    encoding: "utf8",
  });
}

test("chart lints clean", () => {
  execFileSync("helm", ["lint", chart], { encoding: "utf8" });
});

test("default render succeeds", () => {
  assert.ok(render().length > 0);
});
```

- [ ] **Step 5: Run the tests — expect FAIL (dependency/template errors) then fix until green**

```bash
node --test charts/devproof/tests/
```

Expected first run: `helm dependency build` fetches llmkube; both tests PASS once Chart.yaml/values/helpers are syntactically valid. Iterate on syntax errors until green.

- [ ] **Step 6: Ignore the vendored dependency tarballs**

Append to `.gitignore`:

```
charts/devproof/charts/
```

Commit `Chart.lock` (created by dependency build) — it pins the resolved dependency.

- [ ] **Step 7: Commit**

```bash
git add charts/devproof .gitignore
git commit -m "feat(chart): devproof umbrella chart scaffold — helpers, values contract, render tests"
```

---

### Task 3: Postgres + database-url templates

**Files:**
- Create: `charts/devproof/templates/postgres/database.yaml` (pg secret + devproof-db secret — one file so first-install passwords agree)
- Create: `charts/devproof/templates/postgres/initdb-configmap.yaml`
- Create: `charts/devproof/templates/postgres/pvc.yaml`
- Create: `charts/devproof/templates/postgres/deployment.yaml`
- Create: `charts/devproof/templates/postgres/service.yaml`
- Test: `charts/devproof/tests/render.test.mjs`

**Interfaces:**
- Consumes: helpers + values contract from Task 2.
- Produces: Secret `devproof-db` key `database-url` (rendered into the release namespace AND the gateway namespace when different) — consumed by the CP (Task 7) and gateway (Task 5) deployments. Secret `devproof-pg` keys `admin-password`/`app-password`. Service `postgres` port 5432.

- [ ] **Step 1: Add failing render tests**

Append to `render.test.mjs`:

```js
test("bundled postgres renders workload, pvc, and both secrets", () => {
  const out = render(["--set", "postgres.auth.appPassword=fixed-app-pw"]);
  assert.ok(out.includes("image: postgres:17-alpine"));
  assert.ok(out.includes("name: devproof-pg-data"));
  assert.ok(out.includes("admin-password:"));
  assert.ok(out.includes("app-password:"));
  const url = Buffer.from(/database-url: (\S+)/.exec(out)[1], "base64").toString();
  assert.ok(url.includes("fixed-app-pw@postgres.devproof.svc.cluster.local:5432/devproof"), url);
});

test("external database renders url and no bundled postgres", () => {
  const out = render([
    "--set", "postgres.enabled=false",
    "--set", "externalDatabase.host=db.example.com",
    "--set", "externalDatabase.password=xyz",
    "--set", "externalDatabase.sslMode=require",
  ]);
  assert.ok(!out.includes("image: postgres:"));
  const url = Buffer.from(/database-url: (\S+)/.exec(out)[1], "base64").toString();
  assert.strictEqual(url, "postgresql://devproof:xyz@db.example.com:5432/devproof?sslmode=require");
});

test("postgres persistence knobs render", () => {
  const out = render(["--set", "postgres.persistence.storageClass=fast", "--set", "postgres.persistence.size=20Gi"]);
  assert.ok(out.includes("storageClassName: fast"));
  assert.ok(out.includes("storage: 20Gi"));
});
```

- [ ] **Step 2: Run — expect FAIL** (`node --test charts/devproof/tests/`, regex match errors)

- [ ] **Step 3: Write templates/postgres/database.yaml**

```yaml
{{- /* pg credentials and the composed database-url live in ONE template so a
       first install mints the app password exactly once. */}}
{{- $appPw := "" }}
{{- if .Values.postgres.enabled }}
  {{- if .Values.postgres.auth.existingSecret }}
    {{- $s := lookup "v1" "Secret" .Release.Namespace .Values.postgres.auth.existingSecret }}
    {{- if $s }}{{- $appPw = index $s.data "app-password" }}{{- end }}
  {{- else }}
    {{- $appPw = include "devproof.stableSecretValue" (dict "root" $ "secret" "devproof-pg" "key" "app-password" "value" .Values.postgres.auth.appPassword) }}
apiVersion: v1
kind: Secret
metadata:
  name: devproof-pg
type: Opaque
data:
  admin-password: {{ include "devproof.stableSecretValue" (dict "root" $ "secret" "devproof-pg" "key" "admin-password" "value" .Values.postgres.auth.adminPassword) }}
  app-password: {{ $appPw }}
  {{- end }}
{{- else if .Values.externalDatabase.existingSecret }}
  {{- $s := lookup "v1" "Secret" .Release.Namespace .Values.externalDatabase.existingSecret }}
  {{- if $s }}{{- $appPw = index $s.data "password" }}{{- end }}
{{- else }}
  {{- $appPw = .Values.externalDatabase.password | b64enc }}
{{- end }}
{{- $host := ternary (printf "postgres.%s.svc.cluster.local" .Release.Namespace) .Values.externalDatabase.host .Values.postgres.enabled }}
{{- $port := ternary 5432 (.Values.externalDatabase.port | int) .Values.postgres.enabled }}
{{- $db := ternary "devproof" .Values.externalDatabase.database .Values.postgres.enabled }}
{{- $user := ternary "devproof" .Values.externalDatabase.user .Values.postgres.enabled }}
{{- $url := printf "postgresql://%s:%s@%s:%d/%s" $user ($appPw | b64dec) $host $port $db }}
{{- if and (not .Values.postgres.enabled) .Values.externalDatabase.sslMode }}
{{- $url = printf "%s?sslmode=%s" $url .Values.externalDatabase.sslMode }}
{{- end }}
{{- range $ns := (list $.Release.Namespace (include "devproof.gatewayNamespace" $) | uniq) }}
---
apiVersion: v1
kind: Secret
metadata:
  name: devproof-db
  namespace: {{ $ns }}
type: Opaque
data:
  database-url: {{ $url | b64enc }}
{{- end }}
```

- [ ] **Step 4: Write templates/postgres/initdb-configmap.yaml**

```yaml
{{- if .Values.postgres.enabled }}
apiVersion: v1
kind: ConfigMap
metadata:
  name: devproof-pg-initdb
data:
  # Runs only on first init of an empty data dir. Creates the non-superuser
  # app role (spec: admin + operations credentials are separate).
  10-app-role.sh: |
    #!/bin/bash
    set -e
    psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" <<-SQL
      CREATE ROLE devproof LOGIN PASSWORD '$DEVPROOF_APP_PASSWORD';
      CREATE DATABASE devproof OWNER devproof;
    SQL
{{- end }}
```

- [ ] **Step 5: Write templates/postgres/pvc.yaml**

```yaml
{{- if .Values.postgres.enabled }}
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: devproof-pg-data
spec:
  accessModes: [ReadWriteOnce]
  {{- with .Values.postgres.persistence.storageClass }}
  storageClassName: {{ . }}
  {{- end }}
  resources:
    requests:
      storage: {{ .Values.postgres.persistence.size }}
{{- end }}
```

- [ ] **Step 6: Write templates/postgres/deployment.yaml**

```yaml
{{- if .Values.postgres.enabled }}
{{- $secret := .Values.postgres.auth.existingSecret | default "devproof-pg" }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
spec:
  replicas: 1
  strategy: { type: Recreate }
  selector:
    matchLabels:
      app: {{ include "devproof.app" "postgres" }}
  template:
    metadata:
      labels:
        app: {{ include "devproof.app" "postgres" }}
    spec:
      {{- include "devproof.podScheduling" .Values.postgres | nindent 6 }}
      containers:
        - name: postgres
          image: {{ include "devproof.image" .Values.postgres.image }}
          imagePullPolicy: {{ .Values.postgres.image.pullPolicy }}
          env:
            - name: POSTGRES_USER
              value: postgres
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef: { name: {{ $secret }}, key: admin-password }
            - name: DEVPROOF_APP_PASSWORD
              valueFrom:
                secretKeyRef: { name: {{ $secret }}, key: app-password }
          ports: [{ containerPort: 5432 }]
          volumeMounts:
            - { name: data, mountPath: /var/lib/postgresql/data, subPath: pgdata }
            - { name: initdb, mountPath: /docker-entrypoint-initdb.d }
          readinessProbe:
            exec: { command: ["pg_isready", "-U", "postgres"] }
            initialDelaySeconds: 5
            periodSeconds: 5
          resources:
            {{- toYaml .Values.postgres.resources | nindent 12 }}
      volumes:
        - name: data
          persistentVolumeClaim: { claimName: devproof-pg-data }
        - name: initdb
          configMap: { name: devproof-pg-initdb }
{{- end }}
```

- [ ] **Step 7: Write templates/postgres/service.yaml** (internal — plain ClusterIP, no exposure contract)

```yaml
{{- if .Values.postgres.enabled }}
apiVersion: v1
kind: Service
metadata:
  name: postgres
spec:
  selector:
    app: {{ include "devproof.app" "postgres" }}
  ports: [{ port: 5432 }]
{{- end }}
```

- [ ] **Step 8: Run tests — expect PASS** (`node --test charts/devproof/tests/`)

- [ ] **Step 9: Commit**

```bash
git add charts/devproof
git commit -m "feat(chart): bundled postgres (admin+app credentials, initdb role split) and database-url secret"
```

---

### Task 4: MinIO templates

**Files:**
- Create: `charts/devproof/templates/minio/secret.yaml`, `pvc.yaml`, `deployment.yaml`, `service.yaml`
- Test: `charts/devproof/tests/render.test.mjs`

**Interfaces:**
- Consumes: helpers from Task 2.
- Produces: Secret `devproof-minio` keys `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` (same keys as today's manifest, consumed by Task 7's CP env); Service `minio` ports 9000/9001.

- [ ] **Step 1: Add failing render tests**

```js
test("bundled minio renders with generated secret", () => {
  const out = render();
  assert.ok(out.includes("image: minio/minio:"));
  assert.ok(out.includes("MINIO_ROOT_USER:"));
  assert.ok(out.includes("name: devproof-minio-data"));
});

test("minio disabled renders none of it", () => {
  const out = render(["--set", "minio.enabled=false"]);
  assert.ok(!out.includes("minio/minio"));
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Write templates/minio/secret.yaml**

```yaml
{{- if and .Values.minio.enabled (not .Values.minio.auth.existingSecret) }}
apiVersion: v1
kind: Secret
metadata:
  name: devproof-minio
type: Opaque
data:
  MINIO_ROOT_USER: {{ .Values.minio.auth.rootUser | b64enc }}
  MINIO_ROOT_PASSWORD: {{ include "devproof.stableSecretValue" (dict "root" $ "secret" "devproof-minio" "key" "MINIO_ROOT_PASSWORD" "value" .Values.minio.auth.rootPassword) }}
{{- end }}
```

- [ ] **Step 4: Write templates/minio/pvc.yaml**

```yaml
{{- if .Values.minio.enabled }}
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: devproof-minio-data
spec:
  accessModes: [ReadWriteOnce]
  {{- with .Values.minio.persistence.storageClass }}
  storageClassName: {{ . }}
  {{- end }}
  resources:
    requests:
      storage: {{ .Values.minio.persistence.size }}
{{- end }}
```

- [ ] **Step 5: Write templates/minio/deployment.yaml**

```yaml
{{- if .Values.minio.enabled }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: minio
spec:
  replicas: 1
  strategy: { type: Recreate }
  selector:
    matchLabels:
      app: {{ include "devproof.app" "minio" }}
  template:
    metadata:
      labels:
        app: {{ include "devproof.app" "minio" }}
    spec:
      {{- include "devproof.podScheduling" .Values.minio | nindent 6 }}
      containers:
        - name: minio
          image: {{ include "devproof.image" .Values.minio.image }}
          imagePullPolicy: {{ .Values.minio.image.pullPolicy }}
          args: ["server", "/data", "--console-address", ":9001"]
          envFrom:
            - secretRef: { name: {{ .Values.minio.auth.existingSecret | default "devproof-minio" }} }
          ports: [{ containerPort: 9000 }, { containerPort: 9001 }]
          volumeMounts: [{ name: data, mountPath: /data }]
          readinessProbe:
            httpGet: { path: /minio/health/ready, port: 9000 }
            initialDelaySeconds: 5
            periodSeconds: 5
          resources:
            {{- toYaml .Values.minio.resources | nindent 12 }}
      volumes:
        - name: data
          persistentVolumeClaim: { claimName: devproof-minio-data }
{{- end }}
```

- [ ] **Step 6: Write templates/minio/service.yaml**

```yaml
{{- if .Values.minio.enabled }}
apiVersion: v1
kind: Service
metadata:
  name: minio
spec:
  selector:
    app: {{ include "devproof.app" "minio" }}
  ports:
    - { name: s3, port: 9000, targetPort: 9000 }
    - { name: console, port: 9001, targetPort: 9001 }
{{- end }}
```

- [ ] **Step 7: Run tests — expect PASS. Commit**

```bash
git add charts/devproof
git commit -m "feat(chart): bundled minio with generated root credentials"
```

---

### Task 5: Gateway — file extraction + templates

**Files:**
- Create: `charts/devproof/files/custom_callbacks.py` (extracted)
- Create: `charts/devproof/files/gateway-bootstrap-config.yaml` (extracted)
- Move: `deploy/gateway/test_custom_callbacks.py` → `charts/devproof/files/test_custom_callbacks.py`
- Create: `charts/devproof/templates/gateway/configmap.yaml`, `deployment.yaml`, `service.yaml`, `hpa.yaml`
- Modify: `docs/superpowers/specs/2026-07-18-helm-charts-design.md` (gateway-auth correction)
- Test: `charts/devproof/tests/render.test.mjs`

**Interfaces:**
- Consumes: `devproof.gatewayNamespace`, `devproof.service`, scheduling/image helpers; Secret `devproof-db` (Task 3).
- Produces: Deployment `gateway`, ConfigMap `litellm-config` (keys `custom_callbacks.py` helm-owned, `config.yaml` lookup-preserved), Service `gateway` — names fixed (CP contract).

- [ ] **Step 1: Extract the two ConfigMap keys from the raw manifest**

Write to the scratchpad and run (uses the CP's `yaml` package):

```js
// extract-gateway-files.mjs — run: node extract-gateway-files.mjs from repo root
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const yaml = createRequire(process.cwd() + "/control-plane/package.json")("yaml");
const docs = yaml.parseAllDocuments(readFileSync("deploy/gateway/litellm.yaml", "utf8"));
const cm = docs.map(d => d.toJS()).find(d => d?.kind === "ConfigMap" && d?.metadata?.name === "litellm-config");
writeFileSync("charts/devproof/files/custom_callbacks.py", cm.data["custom_callbacks.py"]);
writeFileSync("charts/devproof/files/gateway-bootstrap-config.yaml", cm.data["config.yaml"]);
console.log("ok:", Object.keys(cm.data));
```

Expected: `ok: [ 'config.yaml', 'custom_callbacks.py' ]` (order may differ). If the `yaml` package is absent from control-plane, extract the two block scalars manually from `deploy/gateway/litellm.yaml` (they are the only two keys of the `litellm-config` ConfigMap) and de-indent.

Verify: `python -c "import ast,sys; ast.parse(open('charts/devproof/files/custom_callbacks.py').read())" && echo PY-OK` and the bootstrap YAML parses (`node -e` with the same yaml package). Then:

```bash
git mv deploy/gateway/test_custom_callbacks.py charts/devproof/files/test_custom_callbacks.py
grep -rn "test_custom_callbacks\|deploy/gateway" .github/ scripts/ BUILD.md 2>/dev/null
```

Update any hit to the new path (if none, move on).

- [ ] **Step 2: Add failing render tests**

```js
test("gateway renders deployment, configmap with both keys, service, hpa", () => {
  const out = render();
  assert.ok(out.includes("name: litellm-config"));
  assert.ok(out.includes("custom_callbacks.py: |-"));
  assert.ok(out.includes("config.yaml: |-"));
  assert.ok(out.includes("image: ghcr.io/berriai/litellm:main-stable"));
  assert.ok(out.includes("checksum/callbacks:"));
  assert.ok(/kind: HorizontalPodAutoscaler[\s\S]*minReplicas: 2/.test(out));
});

test("gateway service exposure contract", () => {
  const out = render([
    "--set", "gateway.service.type=LoadBalancer",
    "--set", "gateway.service.annotations.foo=bar",
  ]);
  assert.ok(/name: gateway[\s\S]*?foo: bar[\s\S]*?type: LoadBalancer/.test(out));
});
```

- [ ] **Step 3: Run — expect FAIL**

- [ ] **Step 4: Write templates/gateway/configmap.yaml**

```yaml
{{- $ns := include "devproof.gatewayNamespace" $ }}
{{- $existing := lookup "v1" "ConfigMap" $ns "litellm-config" }}
{{- $cfg := "" }}
{{- if $existing }}{{ $cfg = index $existing.data "config.yaml" }}{{ end }}
{{- $cfg = $cfg | default ($.Files.Get "files/gateway-bootstrap-config.yaml") }}
apiVersion: v1
kind: ConfigMap
metadata:
  name: litellm-config
  namespace: {{ $ns }}
data:
  # Helm-owned: shipped with the chart, upgraded normally.
  custom_callbacks.py: |-
{{ $.Files.Get "files/custom_callbacks.py" | indent 4 }}
  # CP-owned at runtime (syncGateway merge-patches this key); helm re-emits
  # the live value verbatim on upgrade, bootstrap content on first install.
  config.yaml: |-
{{ $cfg | indent 4 }}
```

- [ ] **Step 5: Write templates/gateway/deployment.yaml**

(Copy of the raw manifest's Deployment, parameterized. The `pip install asyncpg` boot args and image stay — air-gap image baking is out of scope. `gateway-auth`/`gateway-provider-keys` stay CP-managed and `optional: true`.)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gateway
  namespace: {{ include "devproof.gatewayNamespace" $ }}
spec:
  selector:
    matchLabels:
      app: {{ include "devproof.app" "gateway" }}
  template:
    metadata:
      labels:
        app: {{ include "devproof.app" "gateway" }}
      annotations:
        # Roll pods when the chart-shipped callbacks change — and only then.
        checksum/callbacks: {{ $.Files.Get "files/custom_callbacks.py" | sha256sum }}
    spec:
      {{- include "devproof.podScheduling" .Values.gateway | nindent 6 }}
      containers:
        - name: litellm
          image: {{ include "devproof.image" .Values.gateway.image }}
          imagePullPolicy: {{ .Values.gateway.image.pullPolicy }}
          command: ["/bin/sh", "-c"]
          # asyncpg is not in the litellm image and its venv has no pip;
          # ensurepip is available. Air-gap follow-up: bake a devproof/gateway image.
          args:
            - python3 -m ensurepip && python3 -m pip install --no-cache-dir asyncpg
              && exec litellm --config /etc/litellm/config.yaml --port 4000
          env:
            # NOT named DATABASE_URL: that exact name flips LiteLLM into its own
            # Prisma-managed DB mode which drops tables it doesn't own.
            - name: DEVPROOF_DATABASE_URL
              valueFrom:
                secretKeyRef: { name: devproof-db, key: database-url }
            - name: DEVPROOF_INTERNAL_KEY
              valueFrom:
                secretKeyRef: { name: gateway-auth, key: internal-key, optional: true }
          envFrom:
            - secretRef: { name: gateway-provider-keys, optional: true }
          ports: [{ containerPort: 4000 }]
          volumeMounts: [{ name: config, mountPath: /etc/litellm }]
          readinessProbe:
            httpGet: { path: /health/readiness, port: 4000 }
            initialDelaySeconds: 10
            periodSeconds: 5
          resources:
            {{- toYaml .Values.gateway.resources | nindent 12 }}
      volumes:
        - name: config
          configMap: { name: litellm-config }
```

- [ ] **Step 6: Write templates/gateway/service.yaml and hpa.yaml**

`service.yaml`:

```yaml
{{ include "devproof.service" (dict "root" $ "name" "gateway" "component" "gateway" "svc" .Values.gateway.service "targetPort" 4000 "namespace" (include "devproof.gatewayNamespace" $)) }}
```

`hpa.yaml`:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: gateway
  namespace: {{ include "devproof.gatewayNamespace" $ }}
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: gateway }
  minReplicas: {{ .Values.gateway.hpa.minReplicas }}
  maxReplicas: {{ .Values.gateway.hpa.maxReplicas }}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: {{ .Values.gateway.hpa.targetCPUUtilizationPercentage }}
```

- [ ] **Step 7: Amend the spec** — in `docs/superpowers/specs/2026-07-18-helm-charts-design.md`, replace the `gateway-auth` bullet ("chart-generated (lookup idiom), wired into both gateway and CP envs (today the pairing is manual)") with:

```markdown
- **`gateway-auth` Secret** (`internal-key`): CP-managed — `ensureGatewayAuthSecret`
  (`main.ts:38`) creates it at CP boot and exports `DEVPROOF_INTERNAL_KEY`; the
  chart does not create it (found during implementation; the gateway pod already
  mounts it `optional: true`).
```

- [ ] **Step 8: Run tests — expect PASS. Commit**

```bash
git add charts/devproof deploy/gateway docs/superpowers/specs/2026-07-18-helm-charts-design.md
git commit -m "feat(chart): gateway templates; callbacks/bootstrap extracted from raw manifest; config.yaml lookup-preserved"
```

---

### Task 6: CP code — namespace envs, S3 auth modes, HOST bind

**Files:**
- Create: `control-plane/src/namespaces.ts`
- Modify: `control-plane/src/orchestrator.ts:10` (AGENTS_NAMESPACE), `control-plane/src/kubestore.ts:7` (GATEWAY_NAMESPACE), `control-plane/src/catalog.ts:50` (SERVING_NAMESPACE)
- Modify: `control-plane/src/filestore.ts:97-107`, `control-plane/src/main.ts:164-179`, `control-plane/src/main.ts:218-219`
- Test: `control-plane/test/namespaces.test.ts`, `control-plane/test/s3-options.test.ts`

**Interfaces:**
- Produces:
  - `src/namespaces.ts`: `export const AGENTS_NAMESPACE, GATEWAY_NAMESPACE, SERVING_NAMESPACE` (env-driven `DEVPROOF_AGENTS_NAMESPACE`/`DEVPROOF_GATEWAY_NAMESPACE`/`DEVPROOF_SERVING_NAMESPACE`, defaults = today's constants). `orchestrator.ts`, `kubestore.ts`, `catalog.ts` import from it; `catalog.ts` and `kubestore.ts` keep re-exporting their old names so other importers are untouched.
  - `filestore.ts`: `export function s3ClientOptions(o: { endpoint?: string; region?: string; accessKey?: string; secretKey?: string })` → S3Client ctor options; `s3FileStore` opts become `{ endpoint?: string; region?: string; accessKey?: string; secretKey?: string; bucket: string }`.
  - Envs consumed by the chart (Task 7): `DEVPROOF_S3_REGION` (new), `HOST` (new), S3 enabled when `DEVPROOF_S3_ENDPOINT` **or** `DEVPROOF_S3_BUCKET` set; key envs no longer default.

- [ ] **Step 1: Write failing tests**

`control-plane/test/namespaces.test.ts` (subprocess so env is read at module load; `src/namespaces.ts` must stay side-effect-free):

```ts
import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";

const read = (env: Record<string, string>) =>
  JSON.parse(execFileSync("npx", ["tsx", "-e",
    `import("./src/namespaces.ts").then(m => console.log(JSON.stringify(m)))`],
    { env: { ...process.env, ...env }, encoding: "utf8", shell: process.platform === "win32" }));

test("namespace constants default to today's values", () => {
  const m = read({});
  assert.strictEqual(m.AGENTS_NAMESPACE, "devproof-agents");
  assert.strictEqual(m.GATEWAY_NAMESPACE, "devproof-gateway");
  assert.strictEqual(m.SERVING_NAMESPACE, "devproof-serving");
});

test("namespace constants honor env overrides", () => {
  const m = read({
    DEVPROOF_AGENTS_NAMESPACE: "a", DEVPROOF_GATEWAY_NAMESPACE: "g", DEVPROOF_SERVING_NAMESPACE: "s",
  });
  assert.deepStrictEqual([m.AGENTS_NAMESPACE, m.GATEWAY_NAMESPACE, m.SERVING_NAMESPACE], ["a", "g", "s"]);
});
```

`control-plane/test/s3-options.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert";
import { s3ClientOptions } from "../src/filestore.ts";

test("custom endpoint (minio): path style + default region + static creds", () => {
  const o = s3ClientOptions({ endpoint: "http://minio:9000", accessKey: "a", secretKey: "b" });
  assert.deepStrictEqual(o, {
    endpoint: "http://minio:9000", forcePathStyle: true, region: "us-east-1",
    credentials: { accessKeyId: "a", secretAccessKey: "b" },
  });
});

test("real AWS + pod identity: no endpoint, no creds, region from config", () => {
  const o = s3ClientOptions({ region: "eu-central-1" });
  assert.deepStrictEqual(o, { region: "eu-central-1" });
});

test("real AWS without region lets the SDK chain resolve it", () => {
  assert.deepStrictEqual(s3ClientOptions({}), {});
});
```

- [ ] **Step 2: Run — expect FAIL** (`cd control-plane && npx tsx --test test/namespaces.test.ts test/s3-options.test.ts` — module/function not found)

- [ ] **Step 3: Implement**

`control-plane/src/namespaces.ts`:

```ts
// Kubernetes namespaces the CP operates in. Env-driven for the Helm chart
// (spec 2026-07-18-helm-charts); defaults preserve the raw-manifest layout so
// out-of-cluster dev keeps working unchanged. Keep this module side-effect-free
// (tests import it in a subprocess).
export const AGENTS_NAMESPACE = process.env.DEVPROOF_AGENTS_NAMESPACE ?? "devproof-agents";
export const GATEWAY_NAMESPACE = process.env.DEVPROOF_GATEWAY_NAMESPACE ?? "devproof-gateway";
export const SERVING_NAMESPACE = process.env.DEVPROOF_SERVING_NAMESPACE ?? "devproof-serving";
```

- `orchestrator.ts`: delete `const AGENTS_NAMESPACE = "devproof-agents";` (line 10), add `import { AGENTS_NAMESPACE } from "./namespaces.ts";`
- `kubestore.ts`: replace `export const GATEWAY_NAMESPACE = "devproof-gateway";` with `export { GATEWAY_NAMESPACE } from "./namespaces.ts";` and replace its `import { SERVING_NAMESPACE } from "./catalog.ts"` with `import { SERVING_NAMESPACE } from "./namespaces.ts";`
- `catalog.ts`: replace `export const SERVING_NAMESPACE = "devproof-serving";` with `export { SERVING_NAMESPACE } from "./namespaces.ts";` and add the import where it's used locally (`catalog.ts:89`): `import { SERVING_NAMESPACE } from "./namespaces.ts";` (a module can import and re-export; keep one statement: `export { SERVING_NAMESPACE };` after the import if the re-export-only form conflicts with local use).

`filestore.ts` — add the pure options builder and loosen `s3FileStore`:

```ts
/** S3Client options from config: custom endpoint (MinIO/S3-compatible) implies
 *  path-style + a default region; absent keys defer to the AWS SDK default
 *  credential chain (IRSA / EKS Pod Identity). */
export function s3ClientOptions(o: { endpoint?: string; region?: string; accessKey?: string; secretKey?: string }) {
  return {
    ...(o.endpoint ? { endpoint: o.endpoint, forcePathStyle: true } : {}),
    ...(o.region ?? o.endpoint ? { region: o.region ?? "us-east-1" } : {}),
    ...(o.accessKey && o.secretKey
      ? { credentials: { accessKeyId: o.accessKey, secretAccessKey: o.secretKey } }
      : {}),
  };
}
```

In `s3FileStore`, change the opts type to `{ endpoint?: string; region?: string; accessKey?: string; secretKey?: string; bucket: string }` and construct with `new S3Client(s3ClientOptions(opts))` (drop the inline endpoint/region/forcePathStyle/credentials literal).

`main.ts:164-179` — S3 enabled by endpoint OR bucket; no credential defaults; region env:

```ts
let files = localFileStore();
if (process.env.DEVPROOF_S3_ENDPOINT || process.env.DEVPROOF_S3_BUCKET) {
  const bucket = process.env.DEVPROOF_S3_BUCKET ?? "devproof-files";
  const cfg = {
    endpoint: process.env.DEVPROOF_S3_ENDPOINT,
    region: process.env.DEVPROOF_S3_REGION,
    accessKey: process.env.DEVPROOF_S3_ACCESS_KEY,
    secretKey: process.env.DEVPROOF_S3_SECRET_KEY,
    bucket,
  };
  const { S3Client, CreateBucketCommand } = await import("@aws-sdk/client-s3");
  const c = new S3Client(s3ClientOptions(cfg));
  try { await c.send(new CreateBucketCommand({ Bucket: bucket })); } catch { /* exists */ }
  files = s3FileStore(cfg);
  console.log(`file store: S3 ${cfg.endpoint ?? "aws"}/${bucket}`);
}
```

(Import `s3ClientOptions` alongside the existing `s3FileStore` import. NOTE: this removes the `devproof`/`devproof-dev-secret` credential defaults — the dev CP run command gains two envs; CLAUDE.md is updated in Task 12.)

`main.ts:218-219` — bind address:

```ts
const port = Number(process.env.PORT ?? 7080);
const host = process.env.HOST ?? "127.0.0.1";
app.listen({ port, host }).then(async (addr) => {
```

- [ ] **Step 4: Run the new tests — expect PASS**, then the full gates:

```bash
cd control-plane && npx tsc --noEmit && npm test
```

Expected: green (the suite runs against the live dev cluster/DB as usual).

- [ ] **Step 5: Commit**

```bash
git add control-plane
git commit -m "feat(cp): env-configurable namespaces, S3 default-credential-chain support, HOST bind"
```

---

### Task 7: Control-plane chart templates (SA, RBAC, Deployment, Service)

**Files:**
- Create: `charts/devproof/templates/controlplane/serviceaccount.yaml`, `rbac.yaml`, `deployment.yaml`, `service.yaml`
- Test: `charts/devproof/tests/render.test.mjs`

**Interfaces:**
- Consumes: Secrets `devproof-db` (Task 3), `devproof-minio` (Task 4), namespace helpers (Task 2); CP envs defined in Task 6.
- Produces: ServiceAccount `devproof-controlplane` (referenced by Task 10's agents-ns RoleBinding); Service `controlplane` port 7080 (referenced by Task 8's console env and Task 5's runner callback URL).

- [ ] **Step 1: Add failing render tests**

```js
test("controlplane renders with minio-backed S3 env and namespace envs", () => {
  const out = render();
  assert.ok(out.includes("name: devproof-controlplane"));
  assert.ok(/DEVPROOF_S3_ENDPOINT[\s\S]*?http:\/\/minio\.devproof\.svc\.cluster\.local:9000/.test(out));
  assert.ok(out.includes("DEVPROOF_AGENTS_NAMESPACE"));
  assert.ok(/HOST[\s\S]*?0\.0\.0\.0/.test(out));
});

test("pod identity mode renders no S3 key envs", () => {
  const out = render([
    "--set", "minio.enabled=false",
    "--set", "s3.auth.mode=podIdentity",
    "--set", "s3.region=eu-central-1",
  ]);
  const cp = out.split("---").find(d => d.includes("ghcr.io/devproof/control-plane"));
  assert.ok(!cp.includes("DEVPROOF_S3_ACCESS_KEY"));
  assert.ok(cp.includes("DEVPROOF_S3_REGION"));
});

test("controlplane disabled renders no CP workload or RBAC", () => {
  const out = render(["--set", "controlplane.enabled=false"]);
  assert.ok(!out.includes("ghcr.io/devproof/control-plane"));
  assert.ok(!out.includes("devproof-controlplane"));
});

test("serviceaccount annotations render (IRSA)", () => {
  const out = render(["--set-string", String.raw`controlplane.serviceAccount.annotations.eks\.amazonaws\.com/role-arn=arn:aws:iam::1:role/x`]);
  assert.ok(out.includes("arn:aws:iam::1:role/x"));
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Write templates/controlplane/serviceaccount.yaml**

```yaml
{{- if .Values.controlplane.enabled }}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: devproof-controlplane
  {{- with .Values.controlplane.serviceAccount.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
{{- end }}
```

- [ ] **Step 4: Write templates/controlplane/rbac.yaml**

Rules are the enumerated CP surface from the spec (33 K8s calls audit) — platform Role per distinct platform namespace, plus the two cluster-scoped reads:

```yaml
{{- if .Values.controlplane.enabled }}
{{- range $ns := (list $.Release.Namespace (include "devproof.gatewayNamespace" $) (include "devproof.servingNamespace" $) | uniq) }}
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: devproof-controlplane
  namespace: {{ $ns }}
rules:
  - apiGroups: [""]
    resources: [configmaps, secrets, services]
    verbs: [get, list, create, update, patch, delete]
  - apiGroups: [apps]
    resources: [deployments]
    verbs: [get, create, update, patch, delete]
  - apiGroups: [serving.devproof.ai]
    resources: [modelpools, modeldeployments]
    verbs: [get, list, create, update, patch, delete]
  - apiGroups: [inference.llmkube.dev]
    resources: [models]
    verbs: [get, list, create, update, patch, delete]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: devproof-controlplane
  namespace: {{ $ns }}
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: devproof-controlplane }
subjects:
  - { kind: ServiceAccount, name: devproof-controlplane, namespace: {{ $.Release.Namespace }} }
---
{{- end }}
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: devproof-controlplane
rules:
  - apiGroups: [""]
    resources: [nodes]
    verbs: [get, list]
  - apiGroups: [storage.k8s.io]
    resources: [storageclasses]
    verbs: [get, list]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: devproof-controlplane
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: devproof-controlplane }
subjects:
  - { kind: ServiceAccount, name: devproof-controlplane, namespace: {{ .Release.Namespace }} }
{{- end }}
```

- [ ] **Step 5: Write templates/controlplane/deployment.yaml**

```yaml
{{- if .Values.controlplane.enabled }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: controlplane
spec:
  replicas: {{ .Values.controlplane.replicas }}
  selector:
    matchLabels:
      app: {{ include "devproof.app" "controlplane" }}
  template:
    metadata:
      labels:
        app: {{ include "devproof.app" "controlplane" }}
    spec:
      serviceAccountName: devproof-controlplane
      {{- include "devproof.podScheduling" .Values.controlplane | nindent 6 }}
      containers:
        - name: controlplane
          image: {{ include "devproof.image" .Values.controlplane.image }}
          imagePullPolicy: {{ .Values.controlplane.image.pullPolicy }}
          env:
            - { name: HOST, value: "0.0.0.0" }
            - name: DEVPROOF_DATABASE_URL
              valueFrom:
                secretKeyRef: { name: devproof-db, key: database-url }
            {{- if .Values.minio.enabled }}
            - { name: DEVPROOF_S3_ENDPOINT, value: http://minio.{{ .Release.Namespace }}.svc.cluster.local:9000 }
            - { name: DEVPROOF_S3_BUCKET, value: devproof-files }
            - name: DEVPROOF_S3_ACCESS_KEY
              valueFrom:
                secretKeyRef: { name: {{ .Values.minio.auth.existingSecret | default "devproof-minio" }}, key: MINIO_ROOT_USER }
            - name: DEVPROOF_S3_SECRET_KEY
              valueFrom:
                secretKeyRef: { name: {{ .Values.minio.auth.existingSecret | default "devproof-minio" }}, key: MINIO_ROOT_PASSWORD }
            {{- else }}
            {{- with .Values.s3.endpoint }}
            - { name: DEVPROOF_S3_ENDPOINT, value: {{ . | quote }} }
            {{- end }}
            - { name: DEVPROOF_S3_BUCKET, value: {{ .Values.s3.bucket | quote }} }
            {{- with .Values.s3.region }}
            - { name: DEVPROOF_S3_REGION, value: {{ . | quote }} }
            {{- end }}
            {{- if eq .Values.s3.auth.mode "key" }}
            - name: DEVPROOF_S3_ACCESS_KEY
              valueFrom:
                secretKeyRef: { name: {{ .Values.s3.auth.existingSecret }}, key: access-key-id }
            - name: DEVPROOF_S3_SECRET_KEY
              valueFrom:
                secretKeyRef: { name: {{ .Values.s3.auth.existingSecret }}, key: secret-access-key }
            {{- end }}
            {{- end }}
            - { name: DEVPROOF_RUNNER_IMAGE, value: {{ .Values.agents.runnerImage | quote }} }
            - { name: DEVPROOF_GATEWAY_INTERNAL, value: http://gateway.{{ include "devproof.gatewayNamespace" $ }}.svc.cluster.local:4000 }
            - { name: DEVPROOF_GATEWAY_LOCAL_URL, value: http://gateway.{{ include "devproof.gatewayNamespace" $ }}.svc.cluster.local:4000 }
            - { name: DEVPROOF_CALLBACK_URL, value: http://controlplane.{{ .Release.Namespace }}.svc.cluster.local:7080 }
            - { name: DEVPROOF_AGENTS_NAMESPACE, value: {{ .Values.agents.namespace | quote }} }
            - { name: DEVPROOF_GATEWAY_NAMESPACE, value: {{ include "devproof.gatewayNamespace" $ | quote }} }
            - { name: DEVPROOF_SERVING_NAMESPACE, value: {{ include "devproof.servingNamespace" $ | quote }} }
            - { name: DEVPROOF_CATALOG, value: /app/catalog/models.yaml }
            - { name: DEVPROOF_MCP_REGISTRY, value: /app/catalog/mcp-servers.yaml }
          ports: [{ containerPort: 7080 }]
          readinessProbe:
            httpGet: { path: /healthz, port: 7080 }
            initialDelaySeconds: 5
            periodSeconds: 5
          resources:
            {{- toYaml .Values.controlplane.resources | nindent 12 }}
{{- end }}
```

Before finalizing, verify the health endpoint: `grep -n "healthz\|/health" control-plane/src/main.ts control-plane/src/server.ts | head -3`. If none exists, use a TCP probe instead: `readinessProbe: { tcpSocket: { port: 7080 }, initialDelaySeconds: 5, periodSeconds: 5 }`.

- [ ] **Step 6: Write templates/controlplane/service.yaml**

```yaml
{{- if .Values.controlplane.enabled }}
{{ include "devproof.service" (dict "root" $ "name" "controlplane" "component" "controlplane" "svc" .Values.controlplane.service "targetPort" 7080) }}
{{- end }}
```

- [ ] **Step 7: Run tests — expect PASS. Commit**

```bash
git add charts/devproof
git commit -m "feat(chart): control-plane deployment, exposure, and audited least-privilege RBAC"
```

---

### Task 8: Console — runtime API proxy + chart templates

**Files:**
- Create: `console/app/api/[...path]/route.ts`
- Modify: `console/next.config.ts` (drop `rewrites()`)
- Create: `charts/devproof/templates/console/deployment.yaml`, `service.yaml`
- Test: `charts/devproof/tests/render.test.mjs` + manual dev-mode check

**Interfaces:**
- Consumes: Service `controlplane` (Task 7).
- Produces: runtime `/api/*` proxy honoring `DEVPROOF_API` at request time (browser + SSE traffic); Service `console` port 7090.

Why: `output: "standalone"` bakes `rewrites()` destinations into the build (`next.config.ts:3-8` reads `DEVPROOF_API` at build time), so the generic console image would proxy `/api/*` to `127.0.0.1:7080` inside its own pod. A route handler reads the env per request instead.

- [ ] **Step 1: Write the route handler**

`console/app/api/[...path]/route.ts`:

```ts
import { NextRequest } from "next/server";

// Runtime proxy for browser calls to the control plane. Replaces the old
// next.config rewrite, whose destination was baked into the standalone bundle
// at build time (breaks the generic Docker image). Streams bodies untouched —
// the CP already sends identity encoding + keep-alives for SSE.
const API = () => process.env.DEVPROOF_API ?? "http://127.0.0.1:7080";

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const url = new URL(req.url);
  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("connection");
  const res = await fetch(`${API()}/${path.join("/")}${url.search}`, {
    method: req.method,
    headers,
    body: req.body,
    // @ts-expect-error undici requires half-duplex for streamed request bodies
    duplex: "half",
    redirect: "manual",
  });
  const out = new Headers(res.headers);
  out.delete("content-encoding");
  out.delete("content-length");
  out.delete("transfer-encoding");
  return new Response(res.body, { status: res.status, headers: out });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
```

- [ ] **Step 2: Remove the rewrite** — `console/next.config.ts` becomes:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone server bundle for the Docker image (reproducible-builds spec
  // 2026-07-18); local `next start` dev flow is unaffected.
  output: "standalone",
};

export default nextConfig;
```

- [ ] **Step 3: Verify against the running dev stack**

With the dev CP running (`control-plane` on :7080), build and start the console (per CLAUDE.md, always a production build):

```bash
cd console && npx next build && npx next start -p 7090
```

Then in a real browser (SSE rule — never plain curl): open `http://localhost:7090`, confirm pages load, open a session view and confirm live events stream (Think/tool rows appear without reload). Also `curl -s -o /dev/null -w "%{http_code}" http://localhost:7090/api/v1/agents -H "X-Devproof-Workspace: wrkspc_default"` → `200`.

- [ ] **Step 4: Add failing chart render test**

```js
test("console renders with runtime DEVPROOF_API pointing at the CP service", () => {
  const out = render();
  assert.ok(/ghcr\.io\/devproof\/console/.test(out));
  assert.ok(/DEVPROOF_API[\s\S]*?http:\/\/controlplane\.devproof\.svc\.cluster\.local:7080/.test(out));
});
```

Run — expect FAIL.

- [ ] **Step 5: Write templates/console/deployment.yaml and service.yaml**

`deployment.yaml`:

```yaml
{{- if .Values.console.enabled }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: console
spec:
  selector:
    matchLabels:
      app: {{ include "devproof.app" "console" }}
  template:
    metadata:
      labels:
        app: {{ include "devproof.app" "console" }}
    spec:
      {{- include "devproof.podScheduling" .Values.console | nindent 6 }}
      containers:
        - name: console
          image: {{ include "devproof.image" .Values.console.image }}
          imagePullPolicy: {{ .Values.console.image.pullPolicy }}
          env:
            - { name: DEVPROOF_API, value: http://controlplane.{{ .Release.Namespace }}.svc.cluster.local:7080 }
          ports: [{ containerPort: 7090 }]
          readinessProbe:
            httpGet: { path: /, port: 7090 }
            initialDelaySeconds: 10
            periodSeconds: 5
          resources:
            {{- toYaml .Values.console.resources | nindent 12 }}
{{- end }}
```

`service.yaml`:

```yaml
{{- if .Values.console.enabled }}
{{ include "devproof.service" (dict "root" $ "name" "console" "component" "console" "svc" .Values.console.service "targetPort" 7090) }}
{{- end }}
```

- [ ] **Step 6: Run chart tests — expect PASS. Commit**

```bash
git add console charts/devproof
git commit -m "feat(console+chart): runtime /api proxy (standalone-safe) and console chart templates"
```

---

### Task 9: Operator — RBAC backfill + chart templates + CRDs

**Files:**
- Modify: `operator/internal/controller/modeldeployment_controller.go:64-65` (extend markers)
- Create: `charts/devproof/templates/operator/serviceaccount.yaml`, `rbac.yaml`, `deployment.yaml`
- Create: `charts/devproof/templates/operator/crds/modelpools.yaml`, `modeldeployments.yaml` (from `operator/config/crd/`)
- Test: `charts/devproof/tests/render.test.mjs`

**Interfaces:**
- Consumes: helpers (Task 2), `crds.install` value.
- Produces: ClusterRole `devproof-operator` (the operator's first real in-cluster RBAC — exercised live in Task 12).

- [ ] **Step 1: Backfill kubebuilder markers** — replace lines 64-65 of `modeldeployment_controller.go` with the full set (comments only; no behavior change):

```go
// +kubebuilder:rbac:groups=serving.devproof.ai,resources=modelpools;modeldeployments,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=serving.devproof.ai,resources=modelpools/status;modeldeployments/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=inference.llmkube.dev,resources=inferenceservices;models,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=persistentvolumeclaims,verbs=get;list;watch;delete
// +kubebuilder:rbac:groups=core,resources=pods,verbs=get;list;watch
// +kubebuilder:rbac:groups=core,resources=pods/proxy,verbs=get
// +kubebuilder:rbac:groups=core,resources=events,verbs=create;patch
```

Verify it still compiles: `cd operator && $HOME/sdk/go/bin/go build ./...` → exit 0.

- [ ] **Step 2: Add failing render tests**

```js
test("operator renders deployment, clusterrole, and gated CRDs", () => {
  const out = render();
  assert.ok(out.includes("ghcr.io/devproof/operator"));
  assert.ok(out.includes("name: devproof-operator"));
  assert.ok(out.includes("pods/proxy"));
  assert.ok(out.includes("kind: CustomResourceDefinition"));
  assert.ok(out.includes("modeldeployments.serving.devproof.ai"));
});

test("crds.install=false skips CRDs but keeps the operator", () => {
  const out = render(["--set", "crds.install=false"]);
  assert.ok(!out.includes("kind: CustomResourceDefinition"));
  assert.ok(out.includes("ghcr.io/devproof/operator"));
});
```

- [ ] **Step 3: Run — expect FAIL**

- [ ] **Step 4: Copy CRDs as gated templates**

```bash
mkdir -p charts/devproof/templates/operator/crds
cp operator/config/crd/serving.devproof.ai_modelpools.yaml charts/devproof/templates/operator/crds/modelpools.yaml
cp operator/config/crd/serving.devproof.ai_modeldeployments.yaml charts/devproof/templates/operator/crds/modeldeployments.yaml
```

Wrap EACH file's entire content:

```yaml
{{- if .Values.crds.install }}
<original CRD content, unmodified>
{{- end }}
```

Add a maintenance note to `charts/devproof/README.md` (Gaps section is fine for now): after `controller-gen` regenerates `operator/config/crd/`, re-copy both files into the chart (same wrap).

- [ ] **Step 5: Write serviceaccount.yaml, rbac.yaml, deployment.yaml**

`serviceaccount.yaml`:

```yaml
{{- if .Values.operator.enabled }}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: devproof-operator
{{- end }}
```

`rbac.yaml` (mirrors the Step 1 markers exactly — cluster-scoped because the manager watches cluster-wide):

```yaml
{{- if .Values.operator.enabled }}
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: devproof-operator
rules:
  - apiGroups: [serving.devproof.ai]
    resources: [modelpools, modeldeployments]
    verbs: [get, list, watch, update, patch]
  - apiGroups: [serving.devproof.ai]
    resources: [modelpools/status, modeldeployments/status]
    verbs: [get, update, patch]
  - apiGroups: [inference.llmkube.dev]
    resources: [inferenceservices, models]
    verbs: [get, list, watch, create, update, patch, delete]
  - apiGroups: [""]
    resources: [persistentvolumeclaims]
    verbs: [get, list, watch, delete]
  - apiGroups: [""]
    resources: [pods]
    verbs: [get, list, watch]
  - apiGroups: [""]
    resources: [pods/proxy]
    verbs: [get]
  - apiGroups: [""]
    resources: [events]
    verbs: [create, patch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: devproof-operator
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: devproof-operator }
subjects:
  - { kind: ServiceAccount, name: devproof-operator, namespace: {{ .Release.Namespace }} }
{{- end }}
```

`deployment.yaml`:

```yaml
{{- if .Values.operator.enabled }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: devproof-operator
spec:
  replicas: 1
  selector:
    matchLabels:
      app: {{ include "devproof.app" "operator" }}
  template:
    metadata:
      labels:
        app: {{ include "devproof.app" "operator" }}
    spec:
      serviceAccountName: devproof-operator
      {{- include "devproof.podScheduling" .Values.operator | nindent 6 }}
      containers:
        - name: operator
          image: {{ include "devproof.image" .Values.operator.image }}
          imagePullPolicy: {{ .Values.operator.image.pullPolicy }}
          resources:
            {{- toYaml .Values.operator.resources | nindent 12 }}
{{- end }}
```

- [ ] **Step 6: Run tests — expect PASS. Commit**

```bash
git add operator charts/devproof
git commit -m "feat(operator+chart): backfilled RBAC markers, operator templates, gated CRDs"
```

---

### Task 10: Agents namespace + RBAC

**Files:**
- Create: `charts/devproof/templates/agents/namespace.yaml`, `rbac.yaml`
- Test: `charts/devproof/tests/render.test.mjs`

**Interfaces:**
- Consumes: `agents.namespace` value; ServiceAccount `devproof-controlplane` (Task 7).
- Produces: the namespace session pods run in; the CP's Role there (from the spec's agents-ns verb audit).

- [ ] **Step 1: Add failing render tests**

```js
test("agents namespace + CP role render; namespace is configurable", () => {
  const out = render(["--set", "agents.namespace=my-agents"]);
  assert.ok(/kind: Namespace[\s\S]*?name: my-agents/.test(out));
  assert.ok(/kind: Role[\s\S]*?namespace: my-agents[\s\S]*?jobs/.test(out));
});

test("agents RBAC absent when controlplane disabled, namespace still rendered", () => {
  const out = render(["--set", "controlplane.enabled=false"]);
  assert.ok(/kind: Namespace[\s\S]*?name: devproof-agents/.test(out));
  assert.ok(!/namespace: devproof-agents[\s\S]{0,200}?kind: Role/.test(out));
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Write templates/agents/namespace.yaml**

```yaml
# Session pods run here even when the CP runs out-of-cluster (dev), so the
# namespace renders regardless of controlplane.enabled.
apiVersion: v1
kind: Namespace
metadata:
  name: {{ .Values.agents.namespace }}
```

- [ ] **Step 4: Write templates/agents/rbac.yaml**

```yaml
{{- if .Values.controlplane.enabled }}
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: devproof-controlplane
  namespace: {{ .Values.agents.namespace }}
rules:
  - apiGroups: [batch]
    resources: [jobs]
    verbs: [get, list, create, delete, deletecollection]
  - apiGroups: [""]
    resources: [configmaps, secrets, services, persistentvolumeclaims]
    verbs: [get, list, create, update, patch, delete, deletecollection]
  - apiGroups: [apps]
    resources: [deployments]
    verbs: [get, create, update, patch, delete]
  - apiGroups: [networking.k8s.io]
    resources: [networkpolicies]
    verbs: [get, create, update, delete]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: devproof-controlplane
  namespace: {{ .Values.agents.namespace }}
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: devproof-controlplane }
subjects:
  - { kind: ServiceAccount, name: devproof-controlplane, namespace: {{ .Release.Namespace }} }
{{- end }}
```

- [ ] **Step 5: Run tests — expect PASS. Commit**

```bash
git add charts/devproof
git commit -m "feat(chart): configurable agents namespace with CP role"
```

---

### Task 11: values-dev.yaml, dev-profile tests, README, CI

**Files:**
- Create: `charts/devproof/values-dev.yaml`
- Modify: `charts/devproof/README.md`, `charts/devproof/tests/render.test.mjs`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: everything above.
- Produces: the dev install profile used by Task 12.

- [ ] **Step 1: Write values-dev.yaml**

```yaml
# docker-desktop dev preset. CP and console run OUT of cluster (CLAUDE.md run
# block); fixed dev credentials keep the documented localhost URLs working.
controlplane:
  enabled: false
console:
  enabled: false
postgres:
  auth:
    adminPassword: devproof-admin-dev
    appPassword: devproof-dev        # matches the CP's default dev DB URL
minio:
  auth:
    rootUser: devproof
    rootPassword: devproof-dev-secret
```

- [ ] **Step 2: Add failing dev-profile render tests, then run**

```js
test("dev profile: no CP/console, dev creds, llmkube dependency present", () => {
  const out = render(["-f", chart + "/values-dev.yaml"]);
  assert.ok(!out.includes("ghcr.io/devproof/control-plane"));
  assert.ok(!out.includes("ghcr.io/devproof/console"));
  assert.ok(out.includes(Buffer.from("devproof-dev").toString("base64")));
  assert.ok(/llmkube/.test(out));   // dependency rendered
});
```

Run — expect FAIL until values-dev.yaml exists, then PASS.

- [ ] **Step 3: Expand README.md** — prepend install docs above the audit section:

```markdown
# Devproof umbrella chart

One `helm install` deploys the platform: control plane, console, LiteLLM
gateway, Devproof operator, and (toggleable) bundled Postgres + MinIO. The
LLMkube operator is a pinned chart dependency.

## Install

    helm dependency build charts/devproof
    helm install devproof charts/devproof -n devproof --create-namespace

Dev (docker-desktop):

    helm install devproof charts/devproof -n devproof --create-namespace \
      -f charts/devproof/values-dev.yaml

## Prerequisites

- metrics-server (gateway HPA)
- Optional: Prometheus (dashboards), KEDA (reserved) — not chart-managed

## Key values

| Value | Meaning |
|---|---|
| `postgres.enabled=false` + `externalDatabase.*` | bring your own Postgres |
| `minio.enabled=false` + `s3.*` | real S3; `s3.auth.mode=podIdentity` uses the pod's AWS identity (set `controlplane.serviceAccount.annotations` for IRSA) |
| `<component>.service.{type,annotations,nodePort}` | endpoint exposure (console, gateway, controlplane) |
| `<component>.{resources,nodeSelector,tolerations}` | scheduling — every component |
| `postgres|minio.persistence.{storageClass,size}` | disks |
| `agents.namespace` | session-pod namespace (chart-created) |
| `namespaces.gateway|serving` | split layouts; default = release namespace |
| `llmkube.*` | passthrough to the LLMkube dependency (see audit below) |

## Out of scope (v1)

Ingress/TLS, credential rotation, observability stack, gateway image baking,
chart publishing. `existingSecret` values must exist before install (read via
`lookup`). Generated passwords are minted once and survive upgrades; rotation
is not supported.
```

- [ ] **Step 4: CI** — add to `.github/workflows/ci.yml` a `chart` job (adapt indentation to the existing file; it already checks out the repo and can install helm via `azure/setup-helm@v4`):

```yaml
  chart:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: azure/setup-helm@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: helm dependency build charts/devproof
      - run: helm lint charts/devproof
      - run: node --test charts/devproof/tests/
```

- [ ] **Step 5: Run the full chart suite — expect PASS. Commit**

```bash
node --test charts/devproof/tests/
git add charts/devproof .github/workflows/ci.yml
git commit -m "feat(chart): dev values profile, README, chart CI job"
```

---

### Task 12: Dev-cluster migration + live verification + raw-manifest removal

This is the live cutover — execute sequentially, verifying each step. The dev DB is worth preserving (re-seeding models/agents is tedious).

**Files:**
- Delete: `deploy/postgres/postgres.yaml`, `deploy/minio/minio.yaml`, `deploy/gateway/litellm.yaml`, `deploy/llmkube/values.yaml`
- Modify: `deploy/dev/localhost-lb.yaml` (namespaces → `devproof`), `deploy/README.md`, `CLAUDE.md`

- [ ] **Step 1: Dump the dev DB**

```bash
PGPASSWORD=devproof-dev pg_dump -h localhost -p 15432 -U devproof -d devproof --clean --if-exists > "$TMPDIR/devproof-dev.sql"
```

(If `pg_dump` isn't on the host, exec it in the postgres pod: `kubectl exec -n devproof-system deploy/postgres -- pg_dump -U devproof devproof --clean --if-exists > ...`.)

- [ ] **Step 2: Stop the out-of-cluster CP/console; tear down old installs**

```bash
helm uninstall llmkube -n llmkube-system
kubectl delete ns devproof-system devproof-storage devproof-gateway devproof-agents devproof-serving llmkube-system --wait=true
```

(Deleting `devproof-serving` deletes deployed models — redeployed in Step 7. `devproof-agents` must go so Helm can own it.)

- [ ] **Step 3: Install the chart**

```bash
helm dependency build charts/devproof
helm install devproof charts/devproof -n devproof --create-namespace -f charts/devproof/values-dev.yaml
kubectl get pods -n devproof
```

Expected: postgres, minio, gateway (2 replicas), devproof-operator, llmkube manager Running; no CP/console pods.

- [ ] **Step 4: Update and apply localhost-lb** — edit `deploy/dev/localhost-lb.yaml`: every Service's `namespace:` becomes `devproof` (selectors `app: devproof-postgres|minio|gateway` already match the chart labels). Then:

```bash
kubectl apply -f deploy/dev/localhost-lb.yaml
```

- [ ] **Step 5: Restore the DB**

```bash
PGPASSWORD=devproof-dev psql -h localhost -p 15432 -U devproof -d devproof -f "$TMPDIR/devproof-dev.sql"
```

- [ ] **Step 6: Start CP + console with the new envs** (note the two new S3 credential envs — defaults were removed):

```bash
cd control-plane
DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev50 \
DEVPROOF_S3_ENDPOINT=http://127.0.0.1:19000 DEVPROOF_S3_BUCKET=devproof-files \
DEVPROOF_S3_ACCESS_KEY=devproof DEVPROOF_S3_SECRET_KEY=devproof-dev-secret \
DEVPROOF_GATEWAY_NAMESPACE=devproof DEVPROOF_SERVING_NAMESPACE=devproof \
npx tsx src/main.ts
# separate shell:
cd console && npx next build && npx next start -p 7090
```

(`DEVPROOF_AGENTS_NAMESPACE` stays default `devproof-agents`.)

- [ ] **Step 7: Live verification** (CLAUDE.md gate)

1. All console pages 200 (dashboard, catalog, pools, deployments, routings, agents, sessions, environments, vaults, memory stores, wikis, skills, files, keys, usage, settings, workspaces).
2. Deploy a model (qwen0.5b) from the catalog → deployment reaches Ready; gateway sync writes `config.yaml` into the chart-owned ConfigMap (`kubectl get cm litellm-config -n devproof -o jsonpath='{.data.config\.yaml}' | head -5` shows generated content).
3. Run an e2e session (agent → session → events stream in a real browser; session completes).
4. Operator RBAC is exercised for the first time in-cluster: `kubectl logs -n devproof deploy/devproof-operator | grep -i forbidden` → no output. If Forbidden errors appear, add the missing verb to BOTH `templates/operator/rbac.yaml` and the kubebuilder markers, `helm upgrade`, re-check.
5. `helm upgrade devproof charts/devproof -n devproof -f charts/devproof/values-dev.yaml` → passwords unchanged (`kubectl get secret devproof-pg -n devproof -o jsonpath='{.data.app-password}'` identical before/after), `config.yaml` still the CP-generated content.

- [ ] **Step 8: Remove the raw manifests + update docs**

```bash
git rm deploy/postgres/postgres.yaml deploy/minio/minio.yaml deploy/gateway/litellm.yaml deploy/llmkube/values.yaml
```

- `deploy/README.md`: replace the LLMkube/MinIO install notes with "Deployed via `charts/devproof` (see chart README); dev profile `values-dev.yaml`."
- `CLAUDE.md`: update the Running block (new CP env line from Step 6), note the chart as the deploy source of truth, and update the "LLMkube" / component bullets that reference the deleted files.

- [ ] **Step 9: Final gates**

```bash
cd control-plane && npx tsc --noEmit && npm test
node --test charts/devproof/tests/
```

Expected: all green.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(deploy): dev cluster runs from the devproof chart; raw manifests removed"
```

---

## Self-review notes

- Spec coverage: umbrella+dependency (T2), knob contract incl. llmkube passthrough (T1/T2), postgres both modes + credential split (T3), minio/S3 + pod identity (T4/T6/T7), gateway ConfigMap ownership (T5), CP namespaces/RBAC/exposure (T6/T7), console (T8), operator RBAC+CRDs (T9), agents ns (T10), dev parity/README/CI (T11), migration+verification+manifest removal (T12). Spec's `gateway-auth` assumption corrected in T5 (CP-managed, discovered in code).
- The console runtime-proxy task (T8) is an addition beyond the spec, forced by Next standalone baking rewrite destinations at build time — without it the chart's console image cannot reach the CP.
