"""Files: small upload round trip + big file through the chunked path."""
from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path

from _common import check, client, step
from devproof import NotFoundError

BIG_MB = int(os.environ.get("DEVPROOF_TEST_BIG_MB", "100"))


def sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    c = client()
    tmp = Path(tempfile.mkdtemp(prefix="dp-files-"))
    uploaded: list[str] = []
    try:
        step("small file: upload -> retrieve -> download -> compare")
        small = tmp / "small.txt"
        small.write_bytes(b"devproof public api small file\n" * 100)
        rec = c.files.upload(small)
        uploaded.append(rec["id"])
        check(rec["sha256"] == sha(small), "small upload sha matches")
        got = c.files.download(rec["id"], tmp / "small.out")
        check(sha(got) == sha(small), "small download bytes identical")

        step(f"big file ({BIG_MB} MB): chunked upload -> streamed download -> compare")
        big = tmp / "big.bin"
        with big.open("wb") as f:
            for _ in range(BIG_MB):
                f.write(os.urandom(1 << 20))
        rec = c.files.upload(big, on_progress=lambda d, t: print(f"    up {d >> 20}/{t >> 20} MB", end="\r"))
        print()
        uploaded.append(rec["id"])
        check(rec["size"] == big.stat().st_size, "size recorded")
        got = c.files.download(rec["id"], tmp / "big.out", on_progress=lambda d, t: print(f"    down {d >> 20}/{t >> 20} MB", end="\r"))
        print()
        check(sha(got) == sha(big), "big download bytes identical")

        step("list contains both; delete -> 404")
        ids = {f["id"] for f in c.files.list()}
        check(all(u in ids for u in uploaded), "uploads listed")
        for u in list(uploaded):
            c.files.delete(u)
            uploaded.remove(u)
        try:
            c.files.retrieve(rec["id"])
            check(False, "deleted file must 404")
        except NotFoundError:
            check(True, "deleted file 404s")
        print("PASS test_files")
    finally:
        for u in uploaded:
            try: c.files.delete(u)
            except Exception: pass


if __name__ == "__main__":
    main()
