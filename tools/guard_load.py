#!/usr/bin/env python3
"""Refuse a full-replace load once the app is the source of truth.

    python3 tools/guard_load.py --remote|--local     # exit 0 = safe to load, 1 = refuse

Checks meta.source_of_truth in the D1 database (via wrangler). 'app' means people have been editing in the app
and a full replace would destroy their work. Use the app, `tools/merge_research.py --submit`, or (later)
`tools/import_hints.py` instead.
"""
import json
import subprocess
import sys


def main(argv):
    where = "--local" if "--local" in argv else "--remote"
    cmd = ["npx", "wrangler", "d1", "execute", "family-tree", "-c", "wrangler.local.jsonc", where, "--json",
           "--command", "SELECT value FROM meta WHERE key = 'source_of_truth'"]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except Exception as e:  # noqa: BLE001
        sys.exit(f"guard: couldn't read the database ({e}); refusing to load.")
    if out.returncode != 0:
        if "no such table" in (out.stdout + out.stderr):
            print("guard: no meta table (fresh database); load allowed")
            return
        sys.exit("guard: couldn't read the database; refusing to load.\n" + (out.stderr or out.stdout)[-500:])
    rows = json.loads(out.stdout)[0]["results"]
    if not rows:
        # Legacy schema (no source_of_truth row, or the meta table has the old layout): loading is allowed.
        print("guard: legacy database, no source-of-truth marker; load allowed")
        return
    value = rows[0]["value"] if rows else None
    if "--legacy" in argv:
        sys.exit("guard: REFUSED. This database uses the app schema; the legacy snapshot (build/seed.sql) no longer "
                 "fits. Use `npm run db:import` for the one-time import.")
    if value == "app":
        sys.exit("guard: REFUSED. This database is the source of truth (meta.source_of_truth = 'app'). "
                 "A full replace would wipe edits made in the app.")
    print(f"guard: source_of_truth = {value!r}; load allowed")


if __name__ == "__main__":
    main(sys.argv[1:])
