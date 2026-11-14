#!/usr/bin/env python3
"""Validate and merge research batches into your research.json.

    python3 tools/merge_research.py --check batch.json        # validate only, change nothing
    python3 tools/merge_research.py batch1.json [batch2.json] # validate, then merge
    RESEARCH=path/to/research.json GEDCOM_DIR=path/to/data python3 tools/merge_research.py batch.json

Agents and people should never hand-edit research.json for findings: write a batch file
(see example/batch-example.json and docs/agents/research-protocol.md) and merge it here.

Batch shape:
  {"branch": "smith",
   "agent": "who produced this batch (optional, recorded on each finding)",
   "findings": [{person, personName, kind, field, claim, finding, confidence,
                 sources:[{title, url?, note?}]}],
   "people_status": {"<id>": {"status": "verified|partly-verified|unverified|disputed", "note": "..."}},
   "stories": [{title, people:[ids], body, sources:[...], era?, slug?}],
   "todo": [{person, task, where, priority}],
   "todo_done": [{person, task, outcome}],     # closes an open to-do (task = exact text or unique prefix)
   "log": [{person, question, searched, result: "found|nil|inconclusive", note?}],
   "media": {"<id>": [{file, caption, portrait?, date?, source?}]}}   # file = key in the R2 bucket

"log" records every search, including searches that found nothing, so the next agent
doesn't repeat it. It is stored in research.json → research_log and not shown on the site.

Validation (any error aborts the whole merge; nothing is written):
  - every person ID must exist in the GEDCOM (findings, statuses, to-dos, stories, log)
  - every finding and story needs at least one source with a title and a url or note
    (a citation precise enough for someone else to find the record again)
  - kind / confidence / status / priority / result must be one of the allowed values

Re-running with the same batch is safe: duplicates (same person + same text) are skipped.
Status precedence when two batches disagree: disputed > verified > partly-verified > unverified
(a later 'disputed' always wins; otherwise the stronger evidence wins).
"""
import json
import os
import re
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESEARCH = Path(os.environ.get("RESEARCH", ROOT / "family-data" / "research.json"))
GEDCOM_DIR = Path(os.environ.get("GEDCOM_DIR", RESEARCH.parent))
RANK = {"unverified": 0, "partly-verified": 1, "verified": 2, "disputed": 3}
KINDS = {"confirmed", "correction", "conflict", "data-error", "new-fact", "new-person"}
CONFIDENCE = {"high", "medium", "low"}
PRIORITY = {"high", "medium", "low"}
RESULTS = {"found", "nil", "inconclusive"}


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:60]


def gedcom_ids():
    ids = set()
    for ged in GEDCOM_DIR.glob("*.ged"):
        for line in ged.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            m = re.match(r"0 @([^@]+)@ INDI", line)
            if m:
                ids.add(m.group(1))
    return ids


def validate(b, ids):
    errs = []

    def person(pid, where, required=True):
        if not pid:
            if required:
                errs.append(f"{where}: missing person")
        elif ids and pid not in ids:
            errs.append(f"{where}: person {pid!r} is not in the GEDCOM")

    def sources(srcs, where):
        if not srcs:
            errs.append(f"{where}: no sources. Every claim needs a citation")
        for j, s in enumerate(srcs or []):
            if not (s.get("title") or "").strip():
                errs.append(f"{where}.sources[{j}]: missing title")
            if not ((s.get("url") or "").strip() or (s.get("note") or "").strip()):
                errs.append(f"{where}.sources[{j}]: needs a url or a note saying where the record is")

    for i, f in enumerate(b.get("findings", [])):
        w = f"findings[{i}]"
        person(f.get("person"), w, required=f.get("kind") != "new-person")
        if f.get("kind") not in KINDS:
            errs.append(f"{w}: kind must be one of {sorted(KINDS)}")
        if f.get("confidence") not in CONFIDENCE:
            errs.append(f"{w}: confidence must be one of {sorted(CONFIDENCE)}")
        if not (f.get("finding") or "").strip():
            errs.append(f"{w}: empty finding")
        sources(f.get("sources"), w)
    for pid, st in b.get("people_status", {}).items():
        person(pid, f"people_status[{pid}]")
        if st.get("status") not in RANK:
            errs.append(f"people_status[{pid}]: status must be one of {list(RANK)}")
    for i, s in enumerate(b.get("stories", [])):
        for pid in s.get("people", []):
            person(pid, f"stories[{i}]")
        for pid in re.findall(r"\[\[([^|\]]+)", s.get("body", "")):
            person(pid, f"stories[{i}].body link")
        sources(s.get("sources"), f"stories[{i}]")
    for i, t in enumerate(b.get("todo", [])):
        person(t.get("person"), f"todo[{i}]", required=False)
        if t.get("priority") not in PRIORITY:
            errs.append(f"todo[{i}]: priority must be one of {sorted(PRIORITY)}")
    for i, t in enumerate(b.get("todo_done", [])):
        if not t.get("task"):
            errs.append(f"todo_done[{i}]: missing task")
    for i, l in enumerate(b.get("log", [])):
        person(l.get("person"), f"log[{i}]", required=False)
        if l.get("result") not in RESULTS:
            errs.append(f"log[{i}]: result must be one of {sorted(RESULTS)}")
        if not (l.get("searched") or "").strip():
            errs.append(f"log[{i}]: say what was searched (collection, site, archive)")
    for pid, items in b.get("media", {}).items():
        person(pid, f"media[{pid}]")
        for j, m in enumerate(items):
            f = m.get("file", "")
            if not f or f.startswith("/") or ".." in f:
                errs.append(f"media[{pid}][{j}]: file must be a relative R2 key like photos/name.jpg")
    return errs


def merge(r, b, today):
    branch = b.get("branch")
    agent = b.get("agent")
    seen = {(f.get("person"), f.get("finding")) for f in r["findings"]}
    nf = 0
    for f in b.get("findings", []):
        if (f.get("person"), f.get("finding")) in seen:
            continue
        f.setdefault("branch", branch)
        f.setdefault("date", today)
        if agent:
            f.setdefault("agent", agent)
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
        if s["slug"] not in slugs:
            r["stories"].append(s)
    tseen = {(t.get("person"), t.get("task")) for t in r["todo"]}
    for t in b.get("todo", []):
        if (t.get("person"), t.get("task")) not in tseen:
            t.setdefault("branch", branch)
            r["todo"].append(t)
    closed, missing = 0, []
    for d in b.get("todo_done", []):
        hits = [t for t in r["todo"] if (not d.get("person") or t.get("person") == d["person"])
                and t.get("task", "").startswith(d["task"])]
        if len(hits) != 1:
            missing.append(f"{d['task'][:60]!r} matched {len(hits)} open to-dos")
            continue
        r["todo"].remove(hits[0])
        r["todo_done"].append(dict(hits[0], outcome=d.get("outcome", ""), closed=today))
        closed += 1
    lseen = {(l.get("person"), l.get("searched")) for l in r["research_log"]}
    nl = 0
    for l in b.get("log", []):
        if (l.get("person"), l.get("searched")) not in lseen:
            l.setdefault("date", today)
            if agent:
                l.setdefault("agent", agent)
            r["research_log"].append(l)
            nl += 1
    for pid, items in b.get("media", {}).items():
        have = {m.get("file") for m in r["media"].setdefault(pid, [])}
        r["media"][pid] += [m for m in items if m.get("file") not in have]
    return nf, closed, nl, missing


def main(argv):
    check_only = "--check" in argv
    paths = [a for a in argv if a != "--check"]
    if not paths:
        sys.exit(__doc__)
    ids = gedcom_ids()
    if not ids:
        print(f"warning: no GEDCOM found in {GEDCOM_DIR}; person IDs will not be checked", file=sys.stderr)
    batches, failed = [], False
    for path in paths:
        b = json.loads(Path(path).read_text())
        errs = validate(b, ids)
        for e in errs:
            print(f"{path}: {e}", file=sys.stderr)
        failed |= bool(errs)
        batches.append((path, b))
    if failed:
        sys.exit("Validation failed; nothing was merged.")
    if check_only:
        print(f"OK: {len(paths)} batch(es) valid.")
        return
    r = json.loads(RESEARCH.read_text())
    for k in ("findings", "stories", "todo", "todo_done", "research_log"):
        r.setdefault(k, [])
    r.setdefault("people_status", {})
    r.setdefault("media", {})
    today = date.today().isoformat()
    for path, b in batches:
        nf, closed, nl, missing = merge(r, b, today)
        print(f"{path}: +{nf} findings, {len(b.get('people_status', {}))} statuses, "
              f"{len(b.get('stories', []))} stories, {len(b.get('todo', []))} new to-dos, "
              f"{closed} to-dos closed, +{nl} log entries")
        for m in missing:
            print(f"  warning: could not close to-do {m}", file=sys.stderr)
    RESEARCH.write_text(json.dumps(r, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main(sys.argv[1:])
