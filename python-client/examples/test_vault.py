"""Credentials vault: create, add credential, secrets never echoed, delete."""
from __future__ import annotations

import json

from _common import check, client, step
from devproof import ConflictError

SECRET = "super-secret-value-1234"
MCP_URL = "https://mcp.context7.com/mcp"


def main() -> None:
    c = client()
    vault_id = None
    try:
        step("create vault with an initial secret")
        vault = c.vaults.create(name="api-example-vault", secrets={"API_TOKEN": SECRET})
        vault_id = vault["id"]
        check(SECRET not in json.dumps(vault), "create response does not echo the secret")

        step("add a second credential")
        cred = c.vaults.credentials.create(vault_id, name="DB_PASSWORD", value=SECRET)
        check(SECRET not in json.dumps(cred), "credential create response does not echo the secret")

        step("read back: names visible, values never echoed")
        got = c.vaults.retrieve(vault_id)
        names = {cred["name"] for cred in got["credentials"]}
        check(names == {"API_TOKEN", "DB_PASSWORD"}, f"credential names listed ({names})")
        check(SECRET not in json.dumps(got), "secret value never appears in any response")

        step("add a bearer MCP credential")
        cred = c.vaults.credentials.create(vault_id, name="context7", type="bearer_token",
                                           mcp_server_url=MCP_URL, mcp_server_name="context7",
                                           token="mcp-token-v1")
        check(SECRET not in json.dumps(cred) and "mcp-token-v1" not in json.dumps(cred),
              "bearer credential create response does not echo the token")
        got = c.vaults.retrieve(vault_id)
        row = next(cr for cr in got["credentials"] if cr["name"] == "context7")
        check(row["type"] == "bearer_token", f"credential type is bearer_token ({row['type']})")
        check(row["mcp_server_url"] == MCP_URL, "mcp_server_url recorded")

        step("rotate the bearer credential (same name, new token)")
        cred = c.vaults.credentials.create(vault_id, name="context7", type="bearer_token",
                                           mcp_server_url=MCP_URL, mcp_server_name="context7",
                                           token="mcp-token-v2")
        check("mcp-token-v2" not in json.dumps(cred), "rotated credential response does not echo the new token")
        got = c.vaults.retrieve(vault_id)
        names = {cr["name"] for cr in got["credentials"]}
        check("context7" in names, "rotated credential still named context7 (upsert, not duplicate)")

        step("name reused with a different server -> 409")
        try:
            c.vaults.credentials.create(vault_id, name="context7", type="bearer_token",
                                        mcp_server_url="https://other.example.com/mcp",
                                        mcp_server_name="other", token="mcp-token-v3")
            check(False, "reusing a name with a different server must 409")
        except ConflictError:
            check(True, "reusing a name with a different server 409s")

        step("name differing only by case -> 409 (derived secret key collision)")
        try:
            c.vaults.credentials.create(vault_id, name="Context7", type="bearer_token",
                                        mcp_server_url=MCP_URL, mcp_server_name="context7",
                                        token="mcp-token-v4")
            check(False, "a case-variant name must 409 on derived secret key collision")
        except ConflictError:
            check(True, "case-variant name 409s on derived secret key collision")

        step("delete credential, then vault")
        c.vaults.credentials.delete(vault_id, "DB_PASSWORD")
        c.vaults.credentials.delete(vault_id, "context7")
        got = c.vaults.retrieve(vault_id)
        check({cr["name"] for cr in got["credentials"]} == {"API_TOKEN"}, "credentials removed")
        c.vaults.delete(vault_id)
        vault_id = None
        print("PASS test_vault")
    finally:
        if vault_id:
            try: c.vaults.delete(vault_id)
            except Exception: pass


if __name__ == "__main__":
    main()
