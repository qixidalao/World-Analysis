#!/usr/bin/env python3
"""Sign a JieXi rule-source JSON payload.

Usage:
  JIEXI_RULE_KEY=/path/to/private.pem python3 scripts/sign_rule_source.py rules.json > signed.json

The output is {"payload": "...", "sig": "<base64 RSA-SHA256>"}.
Only the matching public key embedded in the app is accepted.
"""
import base64
import json
import os
import subprocess
import sys
import tempfile


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    key = os.environ.get("JIEXI_RULE_KEY", "")
    if not key or not os.path.isfile(key):
        print("set JIEXI_RULE_KEY to a PEM private key", file=sys.stderr)
        return 2
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        payload = f.read()
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "payload.json")
        sig = os.path.join(td, "sig.bin")
        with open(src, "wb") as f:
            f.write(payload.encode("utf-8"))
        subprocess.check_call(["openssl", "dgst", "-sha256", "-sign", key, "-out", sig, src])
        with open(sig, "rb") as f:
            signature = base64.b64encode(f.read()).decode("ascii")
    print(json.dumps({"payload": payload, "sig": signature}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
