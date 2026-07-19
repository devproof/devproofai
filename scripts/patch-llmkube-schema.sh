#!/usr/bin/env bash
# The bundled LLMkube chart's values.schema.json declares
# additionalProperties:false at the root but omits the two keys that
# unavoidably land in its values when it runs as a SUBCHART: 'enabled'
# (from the umbrella chart's dependency condition) and 'global' (injected
# by Helm into every subchart). Every umbrella install therefore fails
# schema validation and needs --skip-schema-validation.
#
# This re-packages the vendored tgz with those two keys allowed — the rest
# of the schema stays strict, so it still catches typos. Run AFTER
# `helm dependency build` (which restores the pristine upstream tgz) and
# BEFORE `helm package`; release.yml does. Drop this script once the fix
# lands upstream in LLMKube.
set -euo pipefail

tgz=$(ls helm-charts/charts/llmkube-*.tgz)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

tar -xzf "$tgz" -C "$tmp"
python3 - "$tmp/llmkube/values.schema.json" <<'EOF'
import json, sys
path = sys.argv[1]
with open(path) as f:
    schema = json.load(f)
schema["properties"].setdefault("enabled", {"type": "boolean"})
schema["properties"].setdefault("global", {"type": "object"})
with open(path, "w") as f:
    json.dump(schema, f, indent=2)
EOF
tar -czf "$tgz" -C "$tmp" llmkube
echo "patched $tgz: schema now allows subchart keys 'enabled'/'global'"
