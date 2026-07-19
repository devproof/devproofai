# Devproof AI — Decisions Log

A faithful record of the product and technical decisions **the user** made across
the project. Grouped by theme. Dates: the project began **2026-07-07** (concept +
Phase 1–4 build) and continued **2026-07-08** (workspaces, new pages, polish,
deletes/redesign). Companion to `devproof-ai-concept.md` and
`platform-alignment-and-scale.md`.

---

## 1. Product scope & audience

| # | Decision | Rationale / context | Date |
|---|----------|---------------------|------|
| 1.1 | The concept paper serves **both as a pitch and as an implementation blueprint** | Chosen over "internal blueprint only" or "commercial product concept only" | 07-07 |
| 1.2 | Product has **two parts**: (1) deploy/run models on Kubernetes, (2) a managed-agents platform with a Python API | Stated in the original brief | 07-07 |
| 1.3 | Core motivation is **independence/sovereignty** — independent from cloud providers and from AI companies (OpenAI/Anthropic); run AI in own data centers | Drove the whole concept and the pitch-deck narrative | 07-07 |
| 1.4 | The **entire platform must run on a local K8s cluster** for testing/development | Later pinned to the docker-desktop cluster | 07-07 |
| 1.5 | Security (authN/authZ) **not required in the first implementation** | Explicitly deferred | 07-07 |

## 2. Architecture

| # | Decision | Rationale / context | Date |
|---|----------|---------------------|------|
| 2.1 | Target **the full range of model sizes including large models** | Chosen over "small/quantized only"; implies vLLM alongside llama.cpp | 07-07 |
| 2.2 | Agent runtime: **build the agent loop in-house** — realized as the in-process `devproof_runner` loop, written from scratch for the platform (see 4.13) | Full control over the loop; zero external runtime dependencies | 07-07 |
| 2.3 | Python API: **server-side managed sessions** (agents run inside the platform; the Python API is a thin client) | Chosen over client-side SDK only or both; enables central monitoring | 07-07 |
| 2.4 | Backend stack: **Node/TypeScript services + a Go operator** (Next.js UI, Go for K8s reconciliation) | Chosen over all-TypeScript or deferring | 07-07 |
| 2.5 | Frontend: **NodeJS with Next.js** | From the original brief | 07-07 |
| 2.6 | Tenancy: **workspace-scoped data model from the start, no auth yet** | Chosen over single-tenant flat or full multi-tenancy+auth; cheap now, avoids migration later | 07-07 |

## 3. Serving plane

| # | Decision | Rationale / context | Date |
|---|----------|---------------------|------|
| 3.1 | Use **LLMkube as the base**, but **behind a Devproof-owned abstraction** (swappable serving provider) | Chosen over using LLMkube directly or building an own operator; de-risks the pre-1.0 dependency | 07-07 |
| 3.2 | Endpoints must be **OpenAI-compatible** and also usable by local coding-agent CLIs (e.g. Codex, Hermes) | From the brief; led to the dual-dialect gateway | 07-07 |
| 3.3 | A **logical nodepool** concept: model↔nodepool mapping with token capacity, dynamic scaling for cloud + static mode for on-prem | From the brief | 07-07 |
| 3.4 | **Caching** of downloaded model weights to avoid re-downloading from the internet | From the brief | 07-07 |
| 3.5 | Model catalog UX **similar to Unsloth.ai** | From the brief | 07-07 |
| 3.6 | Catalog should show **many models**, and expose **required capacity, instance type, and expected cost per hour**; the catalog must be **configurable** | Requested 07-08 | 07-08 |
| 3.7 | **API keys from the console must be enforced at the gateway** (delete/deactivate revokes); enforcement lives outside the control plane so traffic can be routed via a different service/LB later; usage (tokens in/out) tracked per key with deployment/key/date-range filters | Requested 07-08, shipped 07-09 | 07-09 |
| 3.8 | **Gateway routes register automatically** — the operator triggers a gateway sync when a deployment becomes/stops being Ready or is deleted (previously manual "Sync gateway" button after every deploy) | Requested after hitting "Invalid model name" on a fresh deployment | 07-09 |
| 3.9 | **External provider endpoints as deployments** — typed providers (OpenAI/Anthropic/OpenRouter/custom OpenAI-compatible), keys write-only in a K8s Secret, deployments editable (operational fields); version tracking explicitly deferred | Requested 07-09 | 07-09 |
| 3.10 | **Known tradeoff (recorded, not yet actioned):** agent sessions authenticate to the gateway with the internal key and are deliberately **unmetered**. Now that a session can point at an **external** provider endpoint, it can consume **paid provider tokens with no Usage-page visibility**. Acceptable while external-backed agents are rare; revisit (meter internal-key traffic, or attribute per session) if that changes | Surfaced in the 07-09 external-endpoints review | 07-09 |
| 3.11 | **Bundled-model overrides snapshot ALL fields** — editing a bundled catalog model stores a full DB copy that shadows the YAML entry, so later catalog/models.yaml upgrades don't surface for overridden models until "Reset to defaults" | Accepted in the 2026-07-09 console-dialog-rework final review; keeps PATCH trivial (merge + upsert, no per-field override tracking) | 07-09 |
| 3.12 | **Keep the model cache in `perService` mode — do NOT revert to `shared`** (implements 3.4's cache goal). Reconsidered reverting to `shared` for one real benefit: a shared cluster-wide cache volume lets a **second deployment of the same model skip the weight download** (matters most for very large models). Rejected because on this cluster's node-local storage (local-path, no RWX class) the shared cache is a single **RWO** PVC that pins **ALL models to one node** — with the platform's "large model = 1 whole node" reality that caps the cluster at whatever fits on a single node and makes multi-large-model serving impossible. `perService`'s advantages win: (a) **multi-node placement** — each model on its own node (the decisive one); (b) **zone redundancy** — WaitForFirstConsumer binds each per-service PVC in its pod's zone; (c) **isolated disk bandwidth** — separate volumes avoid shared read-bandwidth contention during weight load. Note neither mode enables single-model **replica scale-out** across nodes (both are RWO); that needs RWX and is out of scope. The shared-mode download-dedup only helps same-node co-located deployments anyway. Cache-mode is a one-line Helm value (`deploy/llmkube/values.yaml`); the placement-change re-provision code stays. | User reconsidered 07-15; builds on the 2026-07-12 placement-cache-reprovision spec | 07-15 |

## 4. Agents platform

| # | Decision | Rationale / context | Date |
|---|----------|---------------------|------|
| 4.1 | First implementation must include **core (agents + sessions + monitoring), environments + networking policy, skills + memory stores, and MCP connectors + credential vaults** | Multi-select MVP scope | 07-07 |
| 4.2 | **Build exactly like the Anthropic Managed Agents** console in the screenshots | Explicit; drove the entity model and UI | 07-07 / 08 |
| 4.3 | Monitor session activity — adding tools, files, etc. must work | From the brief | 07-07 |
| 4.4 | A **session lives in a K8s container that idles to zero pod resources** and **resumes on the next message** | Explicit lifecycle requirement | 07-08 |
| 4.5 | Sessions read **attached files, memory, and skills** | Explicit | 07-08 |
| 4.6 | Out-of-the-box tools: **bash, python, webfetch**; must be able to **install Python packages** | Explicit | 07-08 |
| 4.7 | **Outbound network access blocked unless the host is configured in the UI** (per-environment egress allowlist) | Explicit | 07-08 |
| 4.8 | **Workspaces must be supported** | Requested 07-08 | 07-08 |
| 4.9 | **Sessions must be interruptible** | Requested 07-08 | 07-08 |
| 4.10 | **Sessions, files, and memory must be deletable** | Requested 07-08 | 07-08 |
| 4.11 | **Memory store "Add memory"** action, and memory must **scale when replicas go up to hundreds** | Requested 07-08 | 07-08 |
| 4.12 | Reuse Anthropic's Python API shape where sensible (a Devproof-owned client modeled on it) | From the brief ("maybe reuse Anthropic's for now") | 07-07 |
| 4.13 | **Retire the "agent SDK" terminology**: `agent-sdk/devproof_agent_sdk` merged into `session-runner/devproof_runner` as plain files (pyproject/pip packaging dropped; image COPYs the package next to runner.py + explicit httpx/anyio install; one unified test suite under `session-runner/tests/`). Wire/env contract unchanged (`DEVPROOF_SDK_*`, `sdkSessionId`, `sessions.sdk_session_id`). Image `dev46` | Requested — the loop is runner-internal, not a product SDK; one component, one directory | 07-17 |

## 5. UI / UX

| # | Decision | Rationale / context | Date |
|---|----------|---------------------|------|
| 5.1 | The UI must be **real functionality, not a mockup** | Confirmed when the user asked | 07-08 |
| 5.2 | Include the pages seen in the screenshots — the user explicitly **missed API keys, Analytics/Usage, and Batches** | Requested 07-08 | 07-08 |
| 5.3 | **Dashboard stats must be clickable** and link to the right page | Requested 07-08 | 07-08 |
| 5.4 | UI should be **kept simple but nicer**, and **use symbols/icons on links** | Requested 07-08 | 07-08 |
| 5.5 | **Table layouts (e.g. sessions) are too packed** — add breathing room and **outer border contrast** | Requested 07-08 | 07-08 |
| 5.6 | **Clickable links (e.g. session ID) must be visually clear — underline them** | Requested 07-08 | 07-08 |
| 5.7 | The **session page must have the Anthropic Managed Agents look & feel**: a right block showing tool calls / agent messages / the input message, a **top timeline bar** | Requested 07-08 | 07-08 |
| 5.8 | Brand headline is **DEVPROOF.AI** (not "DEVPROOF") | Requested 07-08 | 07-08 |
| 5.9 | Responsiveness matters — the user flagged the UI as unresponsive (led to production build over dev mode) | Reported 07-08 | 07-08 |

## 6. Scale

| # | Decision | Rationale / context | Date |
|---|----------|---------------------|------|
| 6.1 | The **entire system must scale to hundreds, maybe thousands, of pods** | Repeated standing constraint | 07-08 |
| 6.2 | Memory store must not corrupt/last-write-wipe under **hundreds of concurrent replicas** | Explicit | 07-08 |

## 7. Deliverables

| # | Decision | Rationale / context | Date |
|---|----------|---------------------|------|
| 7.1 | A **concept paper** first (phase 1), implementation later | From the brief; implementation later proceeded via /goal | 07-07 |
| 7.2 | A **pitch deck** using the story of independence from AI-leading **countries** and AI **companies**, and that **local models get much more powerful** (example: z.ai with GLM-5.2) | Requested via /goal | 07-07 |
| 7.3 | **Review the Anthropic platform docs** and **align functionality with the documentation** | Requested 07-08 | 07-08 |
| 7.4 | **Document all of the user's decisions for later** (this file) | Requested 07-08 | 07-08 |
| 7.5 | **AI-brand references scrubbed from `docs/`** — docs rewritten to current reality (the from-scratch in-process `devproof_runner` loop, `~/.devproof` paths, vendor-neutral coding-agent wording); supersedes the 2026-07-17 note that historical docs stay untouched | Requested 07-18; keeps docs consistent with 4.13 and the no-third-party-references rule in `session-runner/` | 07-18 |

## 8. Lifecycle, catalog & branding (2026-07-08)

| # | Decision | Rationale / context | Date |
|---|----------|---------------------|------|
| 8.1 | **Every resource type must be deletable** — agents (cascade their sessions/batches/versions), API keys, credential vaults, environments, batches, and cached models — in addition to the earlier sessions/files/memory/skills | Requested; migration `014` adds FK `ON DELETE CASCADE`/`SET NULL` so parents delete cleanly; deleting a vault/env also tears down its K8s Secret / Squid proxy + NetworkPolicy | 07-08 |
| 8.2 | **Users can manage the model catalog with custom models** — add a HuggingFace GGUF/safetensors model from the UI, deploy it, and remove it | DB-backed `catalog_models` table merged with the bundled YAML; custom entries auto-get a CPU capacity profile so they're deployable immediately | 07-08 |
| 8.3 | Ship a set of **small, CPU-runnable test models** in the catalog (1B–3B, ~1–3 GB): Llama 3.2 1B/3B, SmolLM2 1.7B, Qwen 2.5 1.5B/3B, Gemma 2 2B | So the local docker-desktop cluster can be exercised end-to-end without a GPU; Qwen 1.5B/3B chosen as the "strong tool-calling" picks for agents | 07-08 |
| 8.4 | Catalog shows the **model download size next to the license**; the VRAM column renamed **"GPU RAM"** and shows "—" for CPU models (the literal "CPU" under a VRAM header was confusing) | Requested | 07-08 |
| 8.5 | Deployments surface a **"Downloading" phase with a percentage** (and "Copying") while weights pull, with a live progress bar + auto-refresh | Operator reads the LLMkube Model status (`phase`, `size`, `sourceContentLength`) and computes `downloadPercent`; note: on fast links small models download in ~1 s so the phase is brief — it's meaningful for large/slow pulls | 07-08 |
| 8.6 | **Logo = the "proofmark":** a checkmark + Q.E.D. tombstone (∎) inside a tessellating hexagon, with a terminal-cursor underline. **A borgified-fox concept was explicitly rejected** (read as Firefox / too scary) | Grounded in the name (dev + proof), infra/scalable (hexagons tile), and dev (terminal). Vector SVG in `docs/brand/devproof-logo.html`; wired into the console sidebar + favicon (`console/app/icon.svg`, `app/lib/mark.tsx`) | 07-08 |
| 8.7 | **All lists paginate at 100/page**; the pager is **always shown** and its controls **disable when there are ≤100 items** | Requested; shared `Pager` component; list endpoints return `{rows, count, offset}` | 07-08 |
| 8.8 | **Skills are versioned** — re-uploading a skill with the same name bumps its version in place; a skill detail page lists the package files (SKILL.md + scripts), each clickable to view its contents | Requested | 07-08 |
| 8.9 | **Credential vaults are editable** — add / rotate / remove named credentials from a vault detail page; values are write-only (names stored in `vault_credentials`, values only in the K8s Secret, patched per-key) | Requested; migration `015` | 07-08 |
| 8.10 | UI legibility: **larger table body + header fonts**; sidebar tagline **"OWN YOUR SCALABLE AI"** replaces "CONTROL PLANE"; the **`.AI` is orange**; larger logo + nav labels; pager buttons get a solid fill with a clearly-inactive disabled state | Requested across several rounds — recurring theme: fonts too small, transparent/greyed controls hard to read | 07-08 |

---

## Standing constraints (always in force)

- **Scale:** the whole system must scale to **hundreds — maybe thousands — of pods**.
- **Local-first:** everything must run on the **local docker-desktop K8s cluster** for dev/test.
- **Alignment:** align entities, APIs, and naming with the **Anthropic platform docs**.
- **Sovereignty:** the guiding motivation is **independence** from cloud providers and AI
  companies — run applications and AI in your own data centers.
- **Fidelity:** the managed-agents experience should **match the Anthropic Managed Agents**
  console (from the screenshots) in entity model and look & feel.
