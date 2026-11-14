#!/usr/bin/env python3
"""Turn a fresh tree-software (Ancestry) GEDCOM export into suggestions against the live tree.

    python3 tools/import_hints.py new-export.ged [--current state.json] [--research family-data/research.json]
                                                 [--dry-run out.json] [--submit] [--ledger PATH]

The app is the source of truth; a new export is only a source of *suggestions*. This compares the export with the
live data by ID (Ancestry keeps IDs stable) and turns the differences into edit proposals (docs/design/edit-ops.md)
with origin "gedcom-hints:<file name>". An editor reviews every one.

  - IDs are mapped the way the original import mapped them: if research.json lists this file under "grafts", the
    graft's prefix / join / anchor / stop_at rules apply; research.json "edits" are applied to the export too, so
    known corrections don't come back as suggestions; live `config.aliases` (dropped ID -> surviving ID) apply last.
  - New people -> person.create (same ID) plus family.create / family.add_child / family.set_spouse.
    New events -> event.add; new names -> name.add; new citations -> citation.add; new sources -> source.upsert.
  - A same-type event whose date or place differs, where the live person has exactly one event of that type, becomes
    an event.update with "conflict": true and an "explanation", in a proposal of its own ("CONFLICT: ...").
  - Never deletes, unlinks, replaces a spouse or changes sex. Notes and media are not compared.

Live data: --current FILE (the /api/export.json shape) or GET /api/export.json using the same environment as
tools/agent_api.py (FT_URL, FT_TREE, CF_ACCESS_CLIENT_ID/SECRET, FT_DEV_PRINCIPAL).

--dry-run out.json writes the proposals to a file. --submit POSTs each to /api/proposals and records the hash of every
op submitted in the ledger (default family-data/hints-ledger.json); ops already in the ledger are skipped next time.
"""
import argparse
import copy
import hashlib
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import gedcom_to_json as g2j  # noqa: E402
import edits as edits_mod  # noqa: E402

MAX_OPS = 25
EVENT_KEYS = ("type", "date", "place", "note", "value", "age")
CITE_KEYS = ("source", "page", "url", "note", "text")
SOURCE_KEYS = ("title", "author", "publication", "url", "repository")
OP_ORDER = {"source.upsert": 0, "person.create": 1, "family.create": 2, "family.set_spouse": 3,
            "family.add_child": 4, "name.add": 5, "event.add": 6, "event.update": 7, "citation.add": 8}


# ---------------------------------------------------------------- helpers

def norm(s):
    return (s or "").strip().lower()


def clean_cite(c):
    return {k: c[k] for k in CITE_KEYS if c.get(k)}


def cite_key(c):
    return (c.get("source"), norm(c.get("page")))


def clean_event(e, known_sources):
    out = {k: e[k] for k in EVENT_KEYS if e.get(k)}
    cites = [clean_cite(c) for c in e.get("citations") or [] if c.get("source") in known_sources]
    if cites:
        out["citations"] = cites
    return out


def clean_name(n):
    out = {"given": n.get("given") or "", "surname": n.get("surname") or ""}
    for k in ("suffix", "type"):
        if n.get(k):
            out[k] = n[k]
    return out


def name_key(n):
    return (norm(n.get("given")), norm(n.get("surname")))


def op_hash(op):
    return hashlib.sha256(json.dumps(op, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:32]


def display(person):
    if not person or not person.get("names"):
        return "?"
    n = person["names"][0]
    return " ".join(x for x in (n.get("given"), n.get("surname")) if x) or "?"


def ev_label(e):
    return " ".join(x for x in (e.get("type"), e.get("date")) if x)


# ---------------------------------------------------------------- loading

def remap_graft(other, cfg, live):
    """Map a graft file's IDs into the main tree's ID space, the way tools/graft.py did at import time.

    Unlike graft.graft this doesn't merge anything: it returns a stand-alone tree (only the people the graft walk
    reaches) whose IDs are main-tree IDs, so it can be diffed against the live data."""
    origin = cfg["gedcom"]
    pre = (cfg.get("prefix") or "g") + "-"
    join = dict(cfg.get("join", {}))
    stop = set(cfg.get("stop_at", []))
    anchor = cfg.get("anchor")
    OP, OF = other["people"], other["families"]
    LP, LF = live["people"], live["families"]
    if anchor not in OP:
        raise ValueError(f"graft {origin}: anchor {anchor!r} is not in the export")

    keep, stack = set(), [anchor]
    while stack:
        x = stack.pop()
        if x in keep or x not in OP:
            continue
        keep.add(x)
        if x in stop:
            continue
        p = OP[x]
        for fid in p["famc"] + p["fams"]:
            f = OF.get(fid)
            if f:
                stack.extend(y for y in [f["husband"], f["wife"]] + f["children"] if y and y != x)
    keep = {x for x in keep if x not in stop or x in join}

    by_orig = {(p.get("origin"), p.get("originalId")): pid for pid, p in LP.items() if p.get("originalId")}
    pmap = {}
    for x in keep:
        if x in join:
            pmap[x] = join[x]
        elif (origin, x) in by_orig:
            pmap[x] = by_orig[(origin, x)]
        elif x in LP and LP[x].get("origin") == origin:
            pmap[x] = x
        elif pre + x in LP:
            pmap[x] = pre + x
        elif x in LP:
            pmap[x] = pre + x   # collides with a main-tree person: the import would have prefixed it
        else:
            pmap[x] = x
    smap = {s: pre + s for s in other["sources"]}
    by_spouses = {(f["husband"], f["wife"]): fid for fid, f in LF.items() if f.get("husband") and f.get("wife")}

    out = {"people": {}, "families": {}, "sources": {}, "media": {}}
    fmap = {}
    for fid, f in OF.items():
        members = [x for x in [f["husband"], f["wife"]] + f["children"] if x in keep]
        if len(members) < 2:
            continue
        h = pmap.get(f["husband"]) if f["husband"] in keep else None
        w = pmap.get(f["wife"]) if f["wife"] in keep else None
        nid = by_spouses.get((h, w)) if h and w else None
        nid = nid or pre + fid
        fmap[fid] = nid
        out["families"][nid] = {"id": nid, "husband": h, "wife": w,
                                "children": [pmap[c] for c in f["children"] if c in keep],
                                "events": _remap_event_sources(f["events"], smap)}
    for x in keep:
        p = copy.deepcopy(OP[x])
        p.update({"id": pmap[x], "famc": [fmap[f] for f in p["famc"] if f in fmap],
                  "fams": [fmap[f] for f in p["fams"] if f in fmap],
                  "events": _remap_event_sources(p["events"], smap),
                  "citations": [dict(c, source=smap.get(c.get("source"), c.get("source"))) for c in p.get("citations", [])]})
        if x in join:
            p["_joined"] = True
        out["people"][pmap[x]] = p
    for s, v in other["sources"].items():
        out["sources"][smap[s]] = dict(v, id=smap[s])
    return out


def _remap_event_sources(events, smap):
    out = copy.deepcopy(events)
    for e in out:
        for c in e.get("citations") or []:
            if c.get("source") in smap:
                c["source"] = smap[c["source"]]
    return out


def apply_known_edits(new, edit_list, warnings):
    """Apply research.json edits one at a time; an edit that doesn't fit this export is skipped."""
    aliases = {}
    applied = 0
    for e in edit_list:
        e = dict(e)
        for k in ("keep", "drop", "person"):
            if e.get(k) in aliases:
                e[k] = aliases[e[k]]
        try:
            a, _ = edits_mod.apply_edits(new, [e])
        except (edits_mod.EditError, KeyError) as err:
            warnings.append(f"research edit skipped for this export: {err}")
            continue
        applied += 1
        for old, kept in a.items():
            for x, y in list(aliases.items()):
                if y == old:
                    aliases[x] = kept
            aliases[old] = kept
    return applied


def apply_aliases(new, aliases):
    """Rename people in the export through the live aliases (dropped ID -> surviving ID)."""
    if not aliases:
        return
    def a(x):
        seen = set()
        while x in aliases and x not in seen:
            seen.add(x)
            x = aliases[x]
        return x
    P = {}
    for pid, p in new["people"].items():
        k = a(pid)
        if k in P:   # two export people are one live person: fold the second into the first for diffing
            q = P[k]
            q["names"] += p["names"]
            q["events"] += p["events"]
            q["citations"] = q.get("citations", []) + p.get("citations", [])
            q["famc"] += [f for f in p["famc"] if f not in q["famc"]]
            q["fams"] += [f for f in p["fams"] if f not in q["fams"]]
        else:
            P[k] = dict(p, id=k)
    new["people"] = P
    for f in new["families"].values():
        f["husband"] = a(f["husband"]) if f["husband"] else None
        f["wife"] = a(f["wife"]) if f["wife"] else None
        f["children"] = list(dict.fromkeys(a(c) for c in f["children"]))


def load_current(path):
    if path:
        data = json.loads(Path(path).read_text())
    else:
        import agent_api  # reads FT_URL / FT_TREE / credentials from the environment
        data = agent_api.call("GET", "export.json")
    if "raw" not in data:
        sys.exit("current data: expected the /api/export.json shape ({format, raw, config})")
    raw = data["raw"]
    for k in ("people", "families", "sources", "media"):
        raw.setdefault(k, {})
    aliases = (data.get("config") or {}).get("aliases") or data.get("aliases") or {}
    return raw, aliases


# ---------------------------------------------------------------- diff

class Diff:
    def __init__(self, new, live, warnings):
        self.new, self.live, self.warnings = new, live, warnings
        self.known_sources = set(live["sources"]) | set(new["sources"])
        self.items = []   # (cluster key, op, conflict?)
        self.new_people = set()
        self.parent = {}

    # union-find over cluster keys, so a new couple and their new children land in one proposal
    def find(self, k):
        while self.parent.get(k, k) != k:
            k = self.parent[k]
        return k

    def union(self, a, b):
        a, b = self.find(a), self.find(b)
        if a != b:
            self.parent[b] = a

    def emit(self, key, op, conflict=False):
        self.items.append((key, op, conflict))

    def run(self):
        N, L = self.new, self.live
        for sid, s in sorted(N["sources"].items()):
            if sid not in L["sources"]:
                data = {k: s[k] for k in SOURCE_KEYS if s.get(k)}
                data.setdefault("title", sid)
                self.emit("src:" + sid, {"op": "source.upsert", "id": sid, "data": data})
        for pid in sorted(N["people"]):
            if pid not in L["people"]:
                self.new_people.add(pid)
        for pid in sorted(N["people"]):
            self.person(pid, N["people"][pid])
        for fid in sorted(N["families"]):
            self.family(fid, N["families"][fid])

    def person(self, pid, p):
        key = "p:" + pid
        if pid in self.new_people:
            op = {"op": "person.create", "id": pid, "names": [clean_name(n) for n in p["names"]] or [clean_name({})]}
            if p.get("sex") in ("M", "F", "U"):
                op["sex"] = p["sex"]
            evs = [clean_event(e, self.known_sources) for e in p["events"]]
            if evs:
                op["events"] = evs
            self.emit(key, op)
            for c in p.get("citations") or []:
                if c.get("source") in self.known_sources:
                    self.emit(key, {"op": "citation.add", "entity": "person", "id": pid, "citation": clean_cite(c)})
            return
        lp = self.live["people"][pid]
        have = {name_key(n) for n in lp.get("names", [])}
        for n in p["names"]:
            if name_key(n) not in have and any(name_key(n)):
                have.add(name_key(n))
                self.emit(key, {"op": "name.add", "person": pid, "name": clean_name(n)})
        live_cites = {cite_key(c) for c in lp.get("citations") or []}
        for c in p.get("citations") or []:
            if c.get("source") in self.known_sources and cite_key(c) not in live_cites:
                live_cites.add(cite_key(c))
                self.emit(key, {"op": "citation.add", "entity": "person", "id": pid, "citation": clean_cite(c)})
        self.events(key, "person", pid, lp.get("events") or [], p["events"], display(lp))

    def events(self, key, entity, eid, live_events, new_events, label):
        matched = set()
        unmatched = []
        for e in new_events:
            hit = next((i for i, le in enumerate(live_events)
                        if le.get("type") == e.get("type") and norm(le.get("date")) == norm(e.get("date"))), None)
            if hit is None:
                unmatched.append(e)
                continue
            matched.add(hit)
            le = live_events[hit]
            same_type = [x for x in live_events if x.get("type") == e.get("type")]
            if e.get("place") and norm(e.get("place")) != norm(le.get("place")) and len(same_type) == 1:
                self.update(key, entity, eid, le, e, {"place": e["place"]}, label)
            self.cites(key, entity, eid, le, e)
        for e in unmatched:
            same_type = [i for i, x in enumerate(live_events) if x.get("type") == e.get("type")]
            if len(same_type) == 1 and same_type[0] not in matched:
                le = live_events[same_type[0]]
                matched.add(same_type[0])
                s = {}
                if e.get("date") and norm(e["date"]) != norm(le.get("date")):
                    s["date"] = e["date"]
                if e.get("place") and norm(e["place"]) != norm(le.get("place")):
                    s["place"] = e["place"]
                if s:
                    self.update(key, entity, eid, le, e, s, label)
                self.cites(key, entity, eid, le, e)
            else:
                self.emit(key, {"op": "event.add", "entity": entity, "id": eid,
                                "event": clean_event(e, self.known_sources)})

    def update(self, key, entity, eid, le, e, s, label):
        if not le.get("fid"):
            self.warnings.append(f"{entity} {eid}: {le.get('type')} differs from the export but the live event has "
                                 "no fid, so no update can be suggested")
            return
        was = "; ".join(f"{k} {le.get(k) or '(none)'!r} -> {v!r}" for k, v in s.items())
        self.emit(key, {"op": "event.update", "entity": entity, "id": eid, "fid": le["fid"], "set": s,
                        "conflict": True,
                        "explanation": f"The new export's {le.get('type')} for {label} ({eid}) differs from the live "
                                       f"tree: {was}. The live value may have been corrected in the app; check "
                                       "before accepting."}, conflict=True)
        self.cites(key, entity, eid, le, e)

    def cites(self, key, entity, eid, le, e):
        if not le.get("fid"):
            return
        have = {cite_key(c) for c in le.get("citations") or []}
        for c in e.get("citations") or []:
            if c.get("source") in self.known_sources and cite_key(c) not in have:
                have.add(cite_key(c))
                self.emit(key, {"op": "citation.add", "entity": entity, "id": eid, "fid": le["fid"],
                                "citation": clean_cite(c)})

    def family(self, fid, f):
        LF, LP = self.live["families"], self.live["people"]
        members = [x for x in [f["husband"], f["wife"]] + f["children"] if x]
        new_members = [x for x in members if x in self.new_people]
        exists = lambda x: x in LP or x in self.new_people  # noqa: E731
        key = "p:" + new_members[0] if new_members else "f:" + fid
        for x in new_members[1:]:
            self.union("p:" + new_members[0], "p:" + x)
        if fid not in LF:
            # a live family with the same two spouses is the same family under another ID
            same = next((k for k, lf in LF.items() if f["husband"] and f["wife"]
                         and lf.get("husband") == f["husband"] and lf.get("wife") == f["wife"]), None)
            if same:
                return self.family(same, dict(f, id=same)) if same not in self.new["families"] else None
            op = {"op": "family.create", "id": fid}
            for role in ("husband", "wife"):
                if f[role] and exists(f[role]):
                    op[role] = f[role]
            kids = [c for c in f["children"] if exists(c)]
            if kids:
                op["children"] = kids
            evs = [clean_event(e, self.known_sources) for e in f["events"]]
            if evs:
                op["events"] = evs
            if new_members:
                self.emit(key, op)
            else:
                op.update({"conflict": True, "explanation":
                           f"Family {fid} is in the new export but not in the live tree, and everyone in it is "
                           "already in the tree. It may have been removed or merged in the app on purpose."})
                self.emit(key, op, conflict=True)
            return
        lf = LF[fid]
        for role in ("husband", "wife"):
            x = f[role]
            if not x or not exists(x) or lf.get(role) == x:
                continue
            if lf.get(role):
                self.warnings.append(f"family {fid}: export has {role} {x}, live has {lf[role]}; not suggested "
                                     "(replacing a spouse would unlink someone)")
                continue
            k = "p:" + x if x in self.new_people else key
            self.emit(k, {"op": "family.set_spouse", "family": fid, "role": role, "person": x})
        for c in f["children"]:
            if exists(c) and c not in (lf.get("children") or []):
                k = "p:" + c
                self.emit(k, {"op": "family.add_child", "family": fid, "person": c})
        names = " & ".join(display(LP.get(x) or self.new["people"].get(x)) for x in (lf.get("husband"), lf.get("wife")) if x)
        self.events(key, "family", fid, lf.get("events") or [], f["events"], f"family {names or fid}")


# ---------------------------------------------------------------- proposals

def sources_needed(ops):
    out = set()
    for op in ops:
        for e in [op.get("event") or {}] + (op.get("events") or []):
            out |= {c.get("source") for c in e.get("citations") or []}
        if op.get("citation"):
            out.add(op["citation"].get("source"))
    out.discard(None)
    return out


def summarize(ops, new, live):
    counts = {}
    for op in ops:
        counts[op["op"]] = counts.get(op["op"], 0) + 1
    who = []
    for op in ops:
        pid = op.get("id") if op["op"] == "person.create" else op.get("person") if op["op"] == "name.add" else \
            op.get("id") if op.get("entity") == "person" else None
        if pid and pid not in [w[0] for w in who]:
            who.append((pid, display(live["people"].get(pid) or new["people"].get(pid))))
    head = ", ".join(f"{n} {k}" for k, n in sorted(counts.items(), key=lambda kv: OP_ORDER.get(kv[0], 99)))
    names = "; ".join(f"{n} ({p})" for p, n in who[:4]) + ("; ..." if len(who) > 4 else "")
    return head + (f" for {names}" if names else "")


def build_proposals(diff, origin, ledger):
    upserts = {op["id"]: op for _, op, _ in diff.items if op["op"] == "source.upsert"}
    used_sources = set()
    clusters, order = {}, []
    for key, op, conflict in diff.items:
        if op["op"] == "source.upsert":
            continue
        ck = (diff.find(key), conflict)
        if ck not in clusters:
            clusters[ck] = []
            order.append(ck)
        clusters[ck].append(op)
    groups = []
    for ck in order:
        ops = sorted(clusters[ck], key=lambda o: OP_ORDER.get(o["op"], 99))   # stable: keeps per-kind order
        for i in range(0, len(ops), MAX_OPS):
            groups.append((ck[1], ops[i:i + MAX_OPS]))
    for sid, op in upserts.items():
        if not any(sid in sources_needed(g[1]) for g in groups):
            groups.append((False, [op]))

    proposals, skipped = [], 0
    for conflict, ops in groups:
        fresh = [op for op in ops if op_hash(op) not in ledger]
        skipped += len(ops) - len(fresh)
        if not fresh:
            continue
        deps = [upserts[s] for s in sorted(sources_needed(fresh)) if s in upserts and upserts[s] not in fresh]
        ops = deps + fresh
        used_sources |= {op["id"] for op in ops if op["op"] == "source.upsert"}
        text = summarize(ops, diff.new, diff.live)
        if conflict:
            reason = "Ancestry export differs from the live tree; values may have been corrected in the app"
            rationale = "CONFLICT: " + text + ". " + " ".join(op.get("explanation", "") for op in ops if op.get("conflict"))
        else:
            reason = f"New in the Ancestry export {origin}"
            rationale = f"From {origin}: " + text
        proposals.append({"kind": "edit",
                          "payload": {"reason": reason, "ops": ops, "origin": f"gedcom-hints:{origin}"},
                          "rationale": rationale.strip()})
    return proposals, skipped


def compute(ged, current, research_path, ledger_path, warnings):
    ged = Path(ged)
    research = json.loads(Path(research_path).read_text()) if research_path and Path(research_path).exists() else {}
    live, aliases = load_current(current)
    new = g2j.parse(ged)
    gcfg = next((g for g in research.get("grafts", []) if g.get("gedcom") == ged.name), None)
    if gcfg:
        new = remap_graft(new, gcfg, live)
    if research.get("edits"):
        apply_known_edits(new, research["edits"], warnings)
    apply_aliases(new, aliases)
    diff = Diff(new, live, warnings)
    diff.run()
    for _, op, _ in diff.items:
        assert op["op"] in OP_ORDER, op["op"]   # never anything destructive
    ledger = load_ledger(ledger_path)
    proposals, skipped = build_proposals(diff, ged.name, ledger)
    return proposals, skipped, bool(gcfg)


def load_ledger(path):
    p = Path(path)
    if not p.exists():
        return set()
    return set(json.loads(p.read_text()).get("ops", {}))


def save_ledger(path, hashes, origin):
    p = Path(path)
    data = json.loads(p.read_text()) if p.exists() else {"ops": {}}
    for h, pid in hashes:
        data["ops"][h] = {"file": origin, "proposal": pid}
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1, sort_keys=True))
    os.replace(tmp, p)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Suggest changes from a new GEDCOM export as edit proposals.")
    ap.add_argument("gedcom")
    ap.add_argument("--current", metavar="FILE", help="live data in the /api/export.json shape (default: fetch it)")
    ap.add_argument("--research", default=str(ROOT / "family-data" / "research.json"),
                    help="research.json with grafts and edits (default: family-data/research.json)")
    ap.add_argument("--dry-run", metavar="OUT", help="write the proposals to OUT instead of submitting")
    ap.add_argument("--submit", action="store_true", help="POST each proposal to /api/proposals")
    ap.add_argument("--ledger", default=str(ROOT / "family-data" / "hints-ledger.json"),
                    help="ops already submitted (default: family-data/hints-ledger.json)")
    a = ap.parse_args(argv)
    if not a.dry_run and not a.submit:
        ap.error("choose --dry-run OUT and/or --submit")

    warnings = []
    try:
        proposals, skipped, grafted = compute(a.gedcom, a.current, a.research, a.ledger, warnings)
    except ValueError as e:
        sys.exit(str(e))
    origin = Path(a.gedcom).name
    nops = sum(len(p["payload"]["ops"]) for p in proposals)
    nconf = sum(1 for p in proposals if p["rationale"].startswith("CONFLICT:"))
    counts = {}
    for p in proposals:
        for op in p["payload"]["ops"]:
            counts[op["op"]] = counts.get(op["op"], 0) + 1
    print(f"{origin}{' (graft)' if grafted else ''}: {len(proposals)} proposals ({nconf} conflicts), {nops} ops"
          + (f": " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())) if counts else "")
          + (f"; {skipped} ops already submitted earlier" if skipped else ""))
    for w in warnings:
        print("warning: " + w, file=sys.stderr)

    if a.dry_run:
        Path(a.dry_run).write_text(json.dumps(proposals, indent=1, ensure_ascii=False))
        print(f"Wrote {a.dry_run}")
    if a.submit:
        import agent_api
        for p in proposals:
            res = agent_api.call("POST", "proposals", p).get("proposal") or {}
            # recorded after each successful POST, so an interrupted run resumes where it stopped
            save_ledger(a.ledger, [(op_hash(op), res.get("id")) for op in p["payload"]["ops"]], origin)
            print(f"Submitted proposal #{res.get('id', '?')}: {p['rationale'][:100]}")


if __name__ == "__main__":
    main()
