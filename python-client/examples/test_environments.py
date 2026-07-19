"""Environments: egress allowlist, pod config, update, validation, delete.

Environments are mandatory for agents; they carry the session pod's Squid
egress allowlist, package-manager toggle, resources, and the /work disk.
"""
from __future__ import annotations

from _common import check, client, step
from devproof import BadRequestError


def main() -> None:
    c = client()
    env_id = None
    try:
        step("create environment with allowlist + pod requests/limits")
        env = c.environments.create(
            name="api-example-environment",
            allowed_hosts=["pypi.org", "*.github.com"],
            allow_package_managers=True,
            pod={"requests": {"cpu": "250m", "memory": "512Mi"},
                 "limits": {"cpu": "1", "memory": "2Gi"},
                 "disk": {"type": "emptyDir"}},
        )
        env_id = env["id"]
        # Note the shape asymmetry: create echoes camelCase keys, while
        # update/list return the stored row with snake_case keys.
        check(env["allowPackageManagers"] is True, "package managers enabled")
        check("pypi.org" in env["allowedHosts"], "allowlist recorded")
        check(env["pod"]["requests"] == {"cpu": "250m", "memory": "512Mi"}, "pod requests recorded")
        check(env["pod"]["limits"] == {"cpu": "1", "memory": "2Gi"}, "pod limits recorded")

        step("update: tighten the allowlist, drop package managers, raise limits")
        upd = c.environments.update(env_id, allowedHosts=["pypi.org"], allowPackageManagers=False,
                                    pod={"requests": {"cpu": "500m", "memory": "1Gi"},
                                         "limits": {"cpu": "2", "memory": "4Gi"},
                                         "disk": {"type": "emptyDir"}})
        check(upd["allowed_hosts"] == ["pypi.org"], "allowlist updated")
        check(upd["allow_package_managers"] is False, "package managers disabled")
        check(upd["pod"]["limits"]["memory"] == "4Gi", "pod limits updated")

        step("list contains the environment")
        check(any(e["id"] == env_id for e in c.environments.list()), "environment listed")

        step("invalid pod config -> 400")
        try:
            c.environments.create(name="api-example-bad-pod",
                                  pod={"requests": {"cpu": "not-a-quantity"}})
            check(False, "bad pod quantity must 400")
        except BadRequestError:
            check(True, "bad pod quantity 400s")

        step("delete environment")
        c.environments.delete(env_id)
        env_id = None
        print("PASS test_environments")
    finally:
        if env_id:
            try: c.environments.delete(env_id)
            except Exception: pass


if __name__ == "__main__":
    main()
