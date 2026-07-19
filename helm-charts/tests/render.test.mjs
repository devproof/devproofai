import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const chart = fileURLToPath(new URL("..", import.meta.url));

// The llmkube dependency must be present for template/lint (one-time network fetch).
if (!existsSync(new URL("../charts", import.meta.url)))
  execFileSync("helm", ["dependency", "build", chart], { stdio: "inherit" });

// llmkube 0.9.7's values.schema.json has additionalProperties:false and does
// not declare `enabled` or `global` — both of which Helm always injects into
// subchart values (the `condition: llmkube.enabled` convention, and Helm's
// automatic global-values propagation to every subchart). That's an upstream
// llmkube schema gap, not an error in this chart, so schema validation is
// disabled for both lint and template.
const SKIP_SCHEMA = "--skip-schema-validation";

export function render(args = []) {
  return execFileSync(
    "helm",
    ["template", "devproof", chart, "-n", "devproof", SKIP_SCHEMA, ...args],
    { encoding: "utf8" },
  );
}

test("chart lints clean", () => {
  execFileSync("helm", ["lint", chart, SKIP_SCHEMA], { encoding: "utf8" });
});

test("default render succeeds", () => {
  assert.ok(render().length > 0);
});

test("bundled postgres renders workload, pvc, and both secrets", () => {
  const out = render(["--set", "postgres.auth.appPassword=fixed-app-pw"]);
  assert.ok(out.includes("image: ghcr.io/devproof/devproofai-postgres:17.10-alpine"));
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

test("bundled minio renders with generated secret", () => {
  const out = render();
  assert.ok(out.includes("image: ghcr.io/devproof/devproofai-minio:"));
  assert.ok(out.includes("MINIO_ROOT_USER:"));
  assert.ok(out.includes("name: devproof-minio-data"));
});

test("minio disabled renders none of it", () => {
  const out = render(["--set", "minio.enabled=false"]);
  assert.ok(!out.includes("minio/minio"));
});

test("gateway renders deployment, configmap with both keys, service, hpa", () => {
  const out = render();
  assert.ok(out.includes("name: litellm-config"));
  assert.ok(out.includes("custom_callbacks.py: |"));
  assert.ok(out.includes("config.yaml: |"));
  assert.ok(out.includes("image: ghcr.io/devproof/devproofai-gateway:v0.1.2"));
  assert.ok(out.includes("checksum/callbacks:"));
  assert.ok(/kind: HorizontalPodAutoscaler[\s\S]*minReplicas: 2/.test(out));
});

test("registryAuth: pull secrets in both namespaces, attached everywhere; off by default", () => {
  const off = render();
  // (the llmkube CRDs mention imagePullSecrets in their schemas — assert on
  // the rendered pod-spec pattern, not the bare word)
  assert.ok(!/imagePullSecrets:\s+- name:/.test(off));
  assert.ok(!off.includes("name: devproof-registry"));
  const on = render(["--set", "registryAuth.token=tok-test"]);
  assert.ok((on.match(/kind: Secret[\s\S]{0,200}?name: devproof-registry/g) || []).length >= 2);
  assert.ok(on.includes(Buffer.from(JSON.stringify({auths:{"ghcr.io":{auth:Buffer.from("devproof:tok-test").toString("base64")}}})).toString("base64")));
  assert.ok((on.match(/imagePullSecrets:\s+- name: devproof-registry/g) || []).length >= 6);
  assert.ok(/DEVPROOF_IMAGE_PULL_SECRET[\s\S]{0,40}?devproof-registry/.test(on));
  const ext = render(["--set", "registryAuth.existingSecret=my-pull"]);
  assert.ok(!ext.includes("name: devproof-registry"));
  assert.ok((ext.match(/imagePullSecrets:\s+- name: my-pull/g) || []).length >= 6);
});

test("gateway master key: generated secret + env; existingSecret overrides", () => {
  const fixed = render(["--set", "gateway.auth.masterKey=sk-fixed-test"]);
  assert.ok(fixed.includes("name: gateway-master-key"));
  assert.ok(fixed.includes(Buffer.from("sk-fixed-test").toString("base64")));
  assert.ok(/LITELLM_MASTER_KEY[\s\S]{0,120}?name: gateway-master-key/.test(fixed));
  const ext = render(["--set", "gateway.auth.existingSecret=my-mk"]);
  assert.ok(!ext.includes("name: gateway-master-key"));
  assert.ok(/LITELLM_MASTER_KEY[\s\S]{0,120}?name: my-mk/.test(ext));
});

test("gateway service exposure contract", () => {
  const out = render([
    "--set", "gateway.service.type=LoadBalancer",
    "--set", "gateway.service.annotations.foo=bar",
  ]);
  assert.ok(/name: gateway[\s\S]*?foo: bar[\s\S]*?type: LoadBalancer/.test(out));
});

test("controlplane renders with minio-backed S3 env and namespace envs", () => {
  const out = render();
  assert.ok(out.includes("name: devproof-controlplane"));
  assert.ok(/DEVPROOF_S3_ENDPOINT[\s\S]*?http:\/\/minio\.devproof\.svc\.cluster\.local:9000/.test(out));
  assert.ok(out.includes("DEVPROOF_AGENTS_NAMESPACE"));
  assert.ok(/DEVPROOF_RUNNER_IMAGE[^\n]*ghcr\.io\/devproof\/devproofai-session-runner:dev51/.test(out));
  assert.ok(/DEVPROOF_EGRESS_PROXY_IMAGE[^\n]*ghcr\.io\/devproof\/devproofai-squid:6\.13/.test(out));
  assert.ok(out.includes("DEVPROOF_EGRESS_PROXY_POD"));
  assert.ok(/HOST[\s\S]*?0\.0\.0\.0/.test(out));
});

test("pod identity mode renders no S3 key envs", () => {
  const out = render([
    "--set", "minio.enabled=false",
    "--set", "s3.auth.mode=podIdentity",
    "--set", "s3.region=eu-central-1",
  ]);
  const cp = out.split("---").find(d => d.includes("ghcr.io/devproof/devproofai-control-plane"));
  assert.ok(!cp.includes("DEVPROOF_S3_ACCESS_KEY"));
  assert.ok(cp.includes("DEVPROOF_S3_REGION"));
});

test("controlplane disabled renders no CP workload or RBAC", () => {
  const out = render(["--set", "controlplane.enabled=false"]);
  assert.ok(!out.includes("ghcr.io/devproof/devproofai-control-plane"));
  assert.ok(!out.includes("devproof-controlplane"));
});

test("serviceaccount annotations render (IRSA)", () => {
  const out = render(["--set-string", String.raw`controlplane.serviceAccount.annotations.eks\.amazonaws\.com/role-arn=arn:aws:iam::1:role/x`]);
  assert.ok(out.includes("arn:aws:iam::1:role/x"));
});

test("console renders with runtime DEVPROOF_API pointing at the CP service", () => {
  const out = render();
  assert.ok(/ghcr\.io\/devproof\/devproofai-console/.test(out));
  assert.ok(/DEVPROOF_API[\s\S]*?http:\/\/controlplane\.devproof\.svc\.cluster\.local:7080/.test(out));
});

test("operator renders deployment, clusterrole, and gated CRDs", () => {
  const out = render();
  assert.ok(out.includes("ghcr.io/devproof/devproofai-operator"));
  assert.ok(out.includes("name: devproof-operator"));
  // engineImage ships disabled (empty repository; llmkube 0.9.7 flaps on
  // ISVC spec.image) — no env by default, rendered when a repository is set.
  assert.ok(!out.includes("DEVPROOF_ENGINE_IMAGE"));
  const eng = render(["--set", "operator.engineImage.cpu.repository=ghcr.io/devproof/devproofai-llama.cpp"]);
  assert.ok(/DEVPROOF_ENGINE_IMAGE[^\n]*ghcr\.io\/devproof\/devproofai-llama\.cpp:server-b10068/.test(eng));
  assert.ok(!eng.includes("DEVPROOF_ENGINE_IMAGE_GPU"));
  assert.ok(out.includes("pods/proxy"));
  assert.ok(out.includes("kind: CustomResourceDefinition"));
  assert.ok(out.includes("modeldeployments.serving.devproof.ai"));
});

test("crds.install=false skips CRDs but keeps the operator", () => {
  const out = render(["--set", "crds.install=false"]);
  // Note: the bundled llmkube dependency ships its own unconditional CRDs
  // (inferenceservices/modelrouters/models), so "kind: CustomResourceDefinition"
  // as a whole-output substring is not a valid negative check here — this
  // chart's crds.install only gates the two devproof-authored CRDs.
  assert.ok(!out.includes("modelpools.serving.devproof.ai"));
  assert.ok(!out.includes("modeldeployments.serving.devproof.ai"));
  assert.ok(out.includes("ghcr.io/devproof/devproofai-operator"));
});

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

test("dev profile: no CP/console, dev creds, llmkube dependency present", () => {
  const out = render(["-f", chart + "/values-dev.yaml"]);
  assert.ok(!out.includes("ghcr.io/devproof/devproofai-control-plane"));
  assert.ok(!out.includes("ghcr.io/devproof/devproofai-console"));
  assert.ok(out.includes(Buffer.from("devproof-dev").toString("base64")));
  assert.ok(/llmkube/.test(out));   // dependency rendered
});

test("gateway service.port threads into DEVPROOF_GATEWAY_INTERNAL while the container port stays fixed", () => {
  const out = render(["--set", "gateway.service.port=14000"]);
  assert.ok(/DEVPROOF_GATEWAY_INTERNAL[\s\S]*?http:\/\/gateway\.devproof\.svc\.cluster\.local:14000/.test(out));
  assert.ok(out.includes("containerPort: 4000"));
});

test("per-component labels/annotations/podAnnotations render on the workload and pod template", () => {
  const out = render([
    "--set", "gateway.labels.team=ml",
    "--set", "gateway.podAnnotations.foo=bar",
    "--set", "postgres.annotations.owner=ops",
  ]);

  const gw = out.split("---").find(d => d.includes("kind: Deployment") && d.includes("name: gateway"));
  assert.ok(gw, "gateway Deployment doc not found");
  assert.ok(/metadata:[\s\S]*?team: ml/.test(gw), "gateway Deployment metadata missing team: ml");
  assert.ok(/template:[\s\S]*?labels:[\s\S]*?team: ml/.test(gw), "gateway pod template labels missing team: ml");
  assert.ok(/template:[\s\S]*?annotations:[\s\S]*?foo: bar/.test(gw), "gateway pod template annotations missing foo: bar");
  assert.ok(gw.includes("checksum/callbacks:"), "checksum/callbacks must still render");

  const selectorBlock = /selector:\s*\n\s*matchLabels:\s*\n([\s\S]*?)\n\s*template:/.exec(gw)[1];
  assert.ok(!selectorBlock.includes("team:"), "matchLabels must stay app-only, not gain extra labels");

  const pg = out.split("---").find(d => d.includes("kind: Deployment") && d.includes("name: postgres"));
  assert.ok(pg, "postgres Deployment doc not found");
  assert.ok(/metadata:[\s\S]*?owner: ops/.test(pg), "postgres Deployment metadata missing owner: ops");
});

test("operator DEVPROOF_CONTROL_PLANE_URL: derived in-cluster by default, dev override out-of-cluster", () => {
  const defaultOut = render();
  assert.ok(/DEVPROOF_CONTROL_PLANE_URL[\s\S]*?http:\/\/controlplane\.devproof\.svc\.cluster\.local:7080/.test(defaultOut));

  const devOut = render(["-f", chart + "/values-dev.yaml"]);
  assert.ok(/DEVPROOF_CONTROL_PLANE_URL[\s\S]*?http:\/\/host\.docker\.internal:7080/.test(devOut));
});
