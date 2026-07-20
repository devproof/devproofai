#!/usr/bin/env python3
"""Ensure a mirrored tag's top-level manifest carries the source annotation,
so GHCR lists the package under the devproofai repo.

`docker buildx imagetools create --annotation` silently drops the annotation
when the upstream is a DOCKER-format manifest list (minio, squid): Docker's
list schema has no annotations field, and buildx matches the children's
format, so the copy comes out unannotated no matter what is passed. An OCI
index MAY reference Docker-format child manifests, so re-PUTting just the
top-level index adds the annotation without touching a single blob — the
children buildx already copied are reused by digest.

Idempotent: a manifest that already carries the annotation is left alone.
Credentials come from $GHCR_TOKEN/$CR_PAT/$GITHUB_TOKEN, else from the
docker config / credential helper that `docker login ghcr.io` populated.
"""
import base64
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

DOCKER_LIST = "application/vnd.docker.distribution.manifest.list.v2+json"
OCI_INDEX = "application/vnd.oci.image.index.v1+json"
ACCEPT = f"{OCI_INDEX},{DOCKER_LIST}"
SOURCE_KEY = "org.opencontainers.image.source"


def credentials(host):
    for env in ("GHCR_TOKEN", "CR_PAT", "GITHUB_TOKEN"):
        if os.environ.get(env):
            return "oauth2", os.environ[env]

    path = os.path.expanduser("~/.docker/config.json")
    try:
        with open(path) as f:
            config = json.load(f)
    except OSError:
        sys.exit(f"no credentials: set GHCR_TOKEN or run `docker login {host}`")

    entry = config.get("auths", {}).get(host, {})
    if entry.get("auth"):
        user, _, secret = base64.b64decode(entry["auth"]).decode().partition(":")
        return user, secret

    helper = config.get("credHelpers", {}).get(host) or config.get("credsStore")
    if not helper:
        sys.exit(f"no credentials for {host}: run `docker login {host}`")
    out = subprocess.run(
        [f"docker-credential-{helper}", "get"],
        input=host, capture_output=True, text=True,
    )
    if out.returncode != 0:
        sys.exit(f"docker-credential-{helper} failed: {out.stderr.strip()}")
    creds = json.loads(out.stdout)
    return creds["Username"], creds["Secret"]


def bearer(host, repo, user, secret):
    basic = base64.b64encode(f"{user}:{secret}".encode()).decode()
    url = f"https://{host}/token?service={host}&scope=repository:{repo}:pull,push"
    req = urllib.request.Request(url, headers={"Authorization": f"Basic {basic}"})
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)["token"]


def annotate(ref, source):
    host, _, rest = ref.partition("/")
    repo, _, tag = rest.rpartition(":")
    user, secret = credentials(host)
    token = bearer(host, repo, user, secret)
    auth = {"Authorization": f"Bearer {token}"}
    base = f"https://{host}/v2/{repo}/manifests/{tag}"

    req = urllib.request.Request(base, headers={**auth, "Accept": ACCEPT})
    with urllib.request.urlopen(req) as resp:
        manifest = json.load(resp)

    if manifest.get("annotations", {}).get(SOURCE_KEY) == source:
        print(f"    annotation already set ({manifest['mediaType'].split('.')[-2]})")
        return

    manifest["mediaType"] = OCI_INDEX
    manifest.setdefault("annotations", {})[SOURCE_KEY] = source
    body = json.dumps(manifest).encode()

    req = urllib.request.Request(
        base, data=body, method="PUT",
        headers={**auth, "Content-Type": OCI_INDEX},
    )
    try:
        with urllib.request.urlopen(req) as resp:
            print(f"    re-PUT as annotated OCI index -> {resp.headers.get('Docker-Content-Digest')}")
    except urllib.error.HTTPError as e:
        sys.exit(f"PUT {ref} failed: {e.code} {e.read().decode()[:200]}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: mirror-annotate.py <registry/name:tag> <source-url>")
    annotate(sys.argv[1], sys.argv[2])
