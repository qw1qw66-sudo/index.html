#!/usr/bin/env python3
"""Fetch a workspace (chalets + bookings) from Supabase for server-side export.

Read-only, least-privilege path: calls the existing public RPC
``get_shared_workspace(p_workspace_key, p_access_pin)`` with the workspace key
and PIN supplied via GitHub Actions repo secrets. NO service-role key is used or
required. Writes the RPC response JSON to --output for the exporter to consume
(the exporter understands the ``{ "data": { chalets, bookings } }`` wrapper).

Required environment (all from repo secrets except the two public values, which
may be repo *variables*):
  SUPABASE_URL          e.g. https://xxxx.supabase.co        (public)
  SUPABASE_ANON_KEY     the public anon/publishable key       (public)
  EXPORT_WORKSPACE_KEY  workspace key to export               (secret)
  EXPORT_ACCESS_PIN     access PIN for that workspace          (secret)

Exits non-zero with a helpful message if any value is missing or the RPC fails.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request


REQUIRED = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "EXPORT_WORKSPACE_KEY", "EXPORT_ACCESS_PIN"]


def main(argv=None):
    import argparse

    ap = argparse.ArgumentParser(description="Fetch workspace from Supabase RPC")
    ap.add_argument("--output", required=True, help="Where to write the workspace JSON")
    args = ap.parse_args(argv)

    missing = [k for k in REQUIRED if not os.environ.get(k)]
    if missing:
        print("ERROR: missing required environment/secrets: %s" % ", ".join(missing), file=sys.stderr)
        print("Set these as GitHub repo secrets (workspace key/PIN) and variables (URL/anon key).", file=sys.stderr)
        print("Never put the service-role key here; this path is read-only via the public RPC.", file=sys.stderr)
        return 2

    url = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1/rpc/get_shared_workspace"
    anon = os.environ["SUPABASE_ANON_KEY"]
    payload = json.dumps({
        "p_workspace_key": os.environ["EXPORT_WORKSPACE_KEY"],
        "p_access_pin": os.environ["EXPORT_ACCESS_PIN"],
    }).encode("utf-8")

    req = urllib.request.Request(url, data=payload, method="POST")
    req.add_header("apikey", anon)
    req.add_header("Authorization", "Bearer " + anon)
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:500]
        print("ERROR: Supabase RPC HTTP %s: %s" % (e.code, detail), file=sys.stderr)
        return 1
    except urllib.error.URLError as e:
        print("ERROR: could not reach Supabase: %s" % e, file=sys.stderr)
        return 1

    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        print("ERROR: RPC did not return JSON.", file=sys.stderr)
        return 1

    if not isinstance(data, dict) or data.get("ok") is not True:
        print("ERROR: RPC response not ok (wrong workspace key/PIN?).", file=sys.stderr)
        return 1

    with open(args.output, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False)

    ws = data.get("data") or {}
    print("Fetched workspace: chalets=%d bookings=%d -> %s" % (
        len(ws.get("chalets") or []), len(ws.get("bookings") or []), args.output))
    return 0


if __name__ == "__main__":
    sys.exit(main())
