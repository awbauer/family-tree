#!/usr/bin/env python3
"""Merge a research batch (JSON in the 'branch findings' shape) into your research.json.

    python3 tools/merge_research.py batch1.json [batch2.json ...]          # into family-data/research.json
    RESEARCH=path/to/research.json python3 tools/merge_research.py batch.json

Batch shape:
  {"branch": "smith",
   "findings": [{person, personName, kind, field, claim, finding, confidence, sources:[{title,url,note}]}],
   "people_status": {"<id>": {"status": "verified|partly-verified|unverified|disputed", "note": "..."}},
   "stories": [{title, people:[ids], body, sources:[...], era?, slug?}],
   "todo": [{person, task, where, priority}]}

Re-running with the same batch is safe: duplicates (same person + same text) are skipped.
Status precedence when two batches disagree: disputed > verified > partly-verified > unverified
(a later 'disputed' always wins; otherwise the stronger evidence wins).
"""
import json
import re
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
import os
RESEARCH = Path(os.environ.get("RESEARCH", ROOT / "family-data" / "research.json"))
RANK = {"unverified": 0, "partly-verified": 1, "verified": 2, "disputed": 3}


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:60]


def main(paths):
    r = json.loads(RESEARCH.read_text())
    for k in ("findings", "stories", "todo"):
        r.setdefault(k, [])
    r.setdefault("people_status", {})
    today = date.today().isoformat()
    for path in paths:
        b = json.loads(Path(path).read_text())
        branch = b.get("branch")
        seen = {(f.get("person"), f.get("finding")) for f in r["findings"]}
        nf = 0
        for f in b.get("findings", []):
            if (f.get("person"), f.get("finding")) in seen:
                continue
            f.setdefault("branch", branch)
            f.setdefault("date", today)
            r["findings"].append(f)
            nf += 1
        for pid, st in b.get("people_status", {}).items():
            cur = r["people_status"].get(pid)
            if not cur or RANK.get(st["status"], 0) >= RANK.get(cur["status"], 0):
                if cur and cur.get("note") and cur["note"] != st.get("note") and RANK.get(st["status"]) == RANK.get(cur["status"]):
                    st = dict(st, note=cur["note"] + " " + st.get("note", ""))
                r["people_status"][pid] = st
        slugs = {s["slug"] for s in r["stories"]}
        for s in b.get("stories", []):
            s.setdefault("slug", slugify(s["title"]))
            s.setdefault("branch", branch)
            if s["slug"] in slugs:
                continue
            r["stories"].append(s)
        tseen = {(t.get("person"), t.get("task")) for t in r["todo"]}
        for t in b.get("todo", []):
            if (t.get("person"), t.get("task")) not in tseen:
                t.setdefault("branch", branch)
                r["todo"].append(t)
        print(f"{path}: +{nf} findings, {len(b.get('people_status', {}))} statuses, "
              f"{len(b.get('stories', []))} stories, {len(b.get('todo', []))} to-dos")
    RESEARCH.write_text(json.dumps(r, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main(sys.argv[1:])
