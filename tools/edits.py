"""Structural corrections applied to the imported tree at build time (after grafts).

Configured in research.json → "edits": a list of operations, applied in order. Each should say why:

  {"op": "merge_people",   "keep": "I1", "drop": "I2",            "reason": "...", "finding": "optional ref"}
  {"op": "merge_families", "keep": "F1", "drop": "F2",            "reason": "..."}
  {"op": "delete_family",  "family": "F3",                        "reason": "..."}
  {"op": "unlink_child",   "family": "F1", "person": "I3",        "reason": "..."}
  {"op": "link_child",     "family": "F1", "person": "I3",        "reason": "..."}
  {"op": "swap_spouses",   "family": "F1",                        "reason": "..."}
  {"op": "set_sex",        "person": "I3", "sex": "M"|"F"|"U",    "reason": "..."}

These are the same operations the app will offer once it becomes the source of truth (see
docs/design/source-of-truth.md). Until then, this is how fixes found by research are applied to an import
without editing the GEDCOM: the GEDCOM stays as exported, and the corrections are recorded with reasons.

merge_people keeps the first person's names and sex, adds the dropped person's other names as alternates,
adds events the kept person doesn't already have, and re-points every family link. The dropped ID becomes an
alias: research (findings, statuses, to-dos, media, stories) that mentions it is shown on the kept person.
"""


def _event_key(e):
    return (e.get("type"), (e.get("date") or "").strip().lower(), (e.get("place") or "").strip().lower(),
            (e.get("value") or ""))


class EditError(ValueError):
    pass


def apply_edits(raw, edits):
    """Mutates raw (gedcom_to_json.parse() shape). Returns (aliases {dropped_id: kept_id}, log lines)."""
    P, F = raw["people"], raw["families"]
    aliases, log = {}, []

    def person(pid, op):
        pid = aliases.get(pid, pid)
        if pid not in P:
            raise EditError(f"{op}: person {pid!r} not found")
        return pid

    def family(fid, op):
        if fid not in F:
            raise EditError(f"{op}: family {fid!r} not found")
        return fid

    def repoint(old, new):
        for f in F.values():
            if f["husband"] == old:
                f["husband"] = new
            if f["wife"] == old:
                f["wife"] = new
            f["children"] = list(dict.fromkeys(new if c == old else c for c in f["children"]))

    for i, e in enumerate(edits, 1):
        op = e.get("op")
        tag = f"edit {i} ({op})"
        if not e.get("reason"):
            raise EditError(f"{tag}: every edit needs a reason")
        if op == "merge_people":
            keep, drop = person(e["keep"], tag), person(e["drop"], tag)
            if keep == drop:
                raise EditError(f"{tag}: keep and drop are the same person")
            k, d = P[keep], P[drop]
            have_names = {(n.get("given"), n.get("surname")) for n in k["names"]}
            for n in d["names"]:
                if (n.get("given"), n.get("surname")) not in have_names:
                    k["names"].append(dict(n, type=n.get("type") or "alternate"))
            have = {_event_key(x) for x in k["events"]}
            for ev in d["events"]:
                if _event_key(ev) not in have:
                    k["events"].append(ev)
            for key in ("citations", "media", "notes"):
                k[key] = k.get(key, []) + [x for x in d.get(key, []) if x not in k.get(key, [])]
            k["famc"] += [f for f in d["famc"] if f not in k["famc"]]
            k["fams"] += [f for f in d["fams"] if f not in k["fams"]]
            k.setdefault("mergedFrom", []).append(drop)
            repoint(drop, keep)
            del P[drop]
            aliases[drop] = keep
            for a, b in list(aliases.items()):
                if b == drop:
                    aliases[a] = keep
        elif op == "merge_families":
            keep, drop = family(e["keep"], tag), family(e["drop"], tag)
            fk, fd = F[keep], F[drop]
            for role in ("husband", "wife"):
                if fd[role] and fk[role] and fd[role] != fk[role]:
                    raise EditError(f"{tag}: {role}s differ ({fk[role]} vs {fd[role]}); merge those people first")
                fk[role] = fk[role] or fd[role]
            fk["children"] += [c for c in fd["children"] if c not in fk["children"]]
            have = {_event_key(x) for x in fk["events"]}
            fk["events"] += [x for x in fd["events"] if _event_key(x) not in have]
            for p in P.values():
                p["famc"] = list(dict.fromkeys(keep if f == drop else f for f in p["famc"]))
                p["fams"] = list(dict.fromkeys(keep if f == drop else f for f in p["fams"]))
            del F[drop]
        elif op == "delete_family":
            fid = family(e["family"], tag)
            for p in P.values():
                p["famc"] = [f for f in p["famc"] if f != fid]
                p["fams"] = [f for f in p["fams"] if f != fid]
            del F[fid]
        elif op in ("unlink_child", "link_child"):
            fid, pid = family(e["family"], tag), person(e["person"], tag)
            if op == "unlink_child":
                F[fid]["children"] = [c for c in F[fid]["children"] if c != pid]
                P[pid]["famc"] = [f for f in P[pid]["famc"] if f != fid]
            else:
                if pid not in F[fid]["children"]:
                    F[fid]["children"].append(pid)
                if fid not in P[pid]["famc"]:
                    P[pid]["famc"].append(fid)
        elif op == "swap_spouses":
            fid = family(e["family"], tag)
            F[fid]["husband"], F[fid]["wife"] = F[fid]["wife"], F[fid]["husband"]
        elif op == "set_sex":
            pid = person(e["person"], tag)
            if e.get("sex") not in ("M", "F", "U"):
                raise EditError(f"{tag}: sex must be M, F or U")
            P[pid]["sex"] = e["sex"]
        else:
            raise EditError(f"{tag}: unknown op {op!r}")
        log.append(f"{op}: {e.get('reason')}")
    return aliases, log


def remap_research(research, aliases):
    """Point research entries at surviving IDs after merges (in memory; research.json is not rewritten)."""
    if not aliases:
        return research
    a = lambda x: aliases.get(x, x)
    for k in ("findings", "todo", "todo_done", "research_log"):
        for item in research.get(k, []):
            if item.get("person"):
                item["person"] = a(item["person"])
    st = research.get("people_status", {})
    for old, new in aliases.items():
        if old in st:
            st.setdefault(new, st[old])
            del st[old]
    media = research.get("media", {})
    for old, new in aliases.items():
        if old in media:
            media.setdefault(new, [])
            media[new] += [m for m in media.pop(old) if m not in media[new]]
    for s in research.get("stories", []):
        s["people"] = list(dict.fromkeys(a(x) for x in s.get("people", [])))
    for d in research.get("duplicates", []):
        d["ids"] = list(dict.fromkeys(a(x) for x in d.get("ids", [])))
    return research
