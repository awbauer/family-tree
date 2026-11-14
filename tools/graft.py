"""Graft part of a second GEDCOM (e.g. a spouse's tree kept as a separate Ancestry tree) onto the main tree.

Configured in research.json:

  "gedcom": "my-tree.ged",                 # the main tree (required once there is more than one .ged)
  "grafts": [{
    "gedcom": "spouse-tree.ged",           # file in the same folder
    "prefix": "sp",                        # prepended to the graft's family/source/media IDs (they collide across exports)
    "anchor": "I1001",                     # graft-file ID of the person where the two trees meet (the spouse)
    "join":   {"I1001": "I12", …},         # graft-file person ID -> main-tree person ID: the SAME person in both files
    "stop_at": ["I1002"]                   # graft-file people not to walk past (usually you: your side comes from the main tree)
  }]

What happens:
  - Starting at `anchor`, every person connected through parent/child/spouse links is imported, except that the walk
    does not continue past anyone in `stop_at`.
  - People in `join` are merged into the main-tree person: the main record keeps its names and sex; graft events
    that the main record doesn't already have (same type and date) are added, plus citations, media and family links.
  - Families whose two spouses both map to an existing main-tree family are merged into it.
  - Other IDs from the graft get the prefix, so they can never collide with the main tree.
  - Every imported person and every added event carries "origin": <graft file name>, so you can see where data came from.

Anyone in the graft file who is the same person as someone in the main tree but NOT listed in `join` will show up
as a duplicate (and the "multiple parents" / "possible duplicate" checks will flag them). Add them to `join`.
"""
import copy


def _neighbours(T, pid):
    p = T["people"][pid]
    for fid in p["famc"] + p["fams"]:
        f = T["families"].get(fid)
        if not f:
            continue
        for x in [f["husband"], f["wife"]] + f["children"]:
            if x and x != pid:
                yield x


def _remap_cites(cites, smap):
    out = []
    for c in cites or []:
        c = dict(c)
        if c.get("source") in smap:
            c["source"] = smap[c["source"]]
        out.append(c)
    return out


def _remap_events(events, smap, origin):
    out = []
    for e in events:
        e = copy.deepcopy(e)
        if e.get("citations"):
            e["citations"] = _remap_cites(e["citations"], smap)
        e["origin"] = origin
        out.append(e)
    return out


def _merge_events(dst, src):
    have = {(e.get("type"), (e.get("date") or "").strip().lower(), (e.get("value") or "")) for e in dst}
    n = 0
    for e in src:
        k = (e.get("type"), (e.get("date") or "").strip().lower(), (e.get("value") or ""))
        if k not in have:
            dst.append(e)
            have.add(k)
            n += 1
    return n


def graft(main, other, cfg):
    """Mutates `main` (a gedcom_to_json.parse() result). Returns a stats dict. Raises ValueError on bad config."""
    origin = cfg["gedcom"]
    pre = (cfg.get("prefix") or "g") + "-"
    join = dict(cfg.get("join", {}))
    stop = set(cfg.get("stop_at", []))
    anchor = cfg.get("anchor")
    MP, MF = main["people"], main["families"]
    OP, OF = other["people"], other["families"]

    errs = []
    if anchor not in OP:
        errs.append(f"anchor {anchor!r} is not in {origin}")
    for o, m in join.items():
        if o not in OP:
            errs.append(f"join: {o!r} is not in {origin}")
        if m not in MP:
            errs.append(f"join: {m!r} is not in the main tree")
    for s in stop:
        if s not in OP:
            errs.append(f"stop_at: {s!r} is not in {origin}")
    if errs:
        raise ValueError(f"graft {origin}: " + "; ".join(errs))

    # 1. which graft people come across
    keep, stack = set(), [anchor]
    while stack:
        x = stack.pop()
        if x in keep:
            continue
        keep.add(x)
        if x in stop:
            continue
        stack.extend(_neighbours(other, x))
    keep = {x for x in keep if x not in stop or x in join}

    pmap = {}
    for x in sorted(keep):
        if x in join:
            pmap[x] = join[x]
        else:
            pmap[x] = x if x not in MP else pre + x
    smap = {s: pre + s for s in other["sources"]}
    omap = {o: pre + o for o in other["media"]}

    # 2. families
    by_spouses = {(f["husband"], f["wife"]): fid for fid, f in MF.items() if f["husband"] and f["wife"]}
    fmap, fam_added, fam_merged = {}, 0, 0
    for fid, f in OF.items():
        members = [x for x in [f["husband"], f["wife"]] + f["children"] if x in keep]
        if len(members) < 2:
            continue
        h = pmap.get(f["husband"]) if f["husband"] in keep else None
        w = pmap.get(f["wife"]) if f["wife"] in keep else None
        kids = [pmap[c] for c in f["children"] if c in keep]
        events = _remap_events(f["events"], smap, origin)
        existing = by_spouses.get((h, w)) if h and w else None
        if existing:
            ef = MF[existing]
            ef["children"] += [c for c in kids if c not in ef["children"]]
            _merge_events(ef["events"], events)
            fmap[fid] = existing
            fam_merged += 1
        else:
            nid = pre + fid
            MF[nid] = {"id": nid, "husband": h, "wife": w, "children": kids, "events": events, "origin": origin}
            fmap[fid] = nid
            fam_added += 1

    # 3. people
    added, merged, ev_added = 0, 0, 0
    for x in sorted(keep):
        p = OP[x]
        famc = [fmap[f] for f in p["famc"] if f in fmap]
        fams = [fmap[f] for f in p["fams"] if f in fmap]
        events = _remap_events(p["events"], smap, origin)
        cites = _remap_cites(p.get("citations"), smap)
        media = [omap.get(o, o) for o in p.get("media", [])]
        mid = pmap[x]
        if x in join:
            mp = MP[mid]
            mp["famc"] += [f for f in famc if f not in mp["famc"]]
            mp["fams"] += [f for f in fams if f not in mp["fams"]]
            ev_added += _merge_events(mp["events"], events)
            mp["citations"] = mp.get("citations", []) + [c for c in cites if c not in mp.get("citations", [])]
            mp["media"] = mp.get("media", []) + [m for m in media if m not in mp.get("media", [])]
            mp["notes"] = mp.get("notes", []) + [n for n in p.get("notes", []) if n not in mp.get("notes", [])]
            mp.setdefault("joinedFrom", []).append({"file": origin, "id": x})
            merged += 1
        else:
            np_ = copy.deepcopy(p)
            np_.update({"id": mid, "famc": famc, "fams": fams, "events": events, "citations": cites,
                        "media": media, "origin": origin})
            if mid != x:
                np_["originalId"] = x
            MP[mid] = np_
            added += 1

    # 4. sources and media referenced by what came across
    for s, v in other["sources"].items():
        main["sources"][smap[s]] = dict(v, id=smap[s], origin=origin)
    for o, v in other["media"].items():
        main["media"][omap[o]] = dict(v, id=omap[o], origin=origin)

    return {"file": origin, "people_added": added, "people_joined": merged, "events_added_to_joined": ev_added,
            "families_added": fam_added, "families_merged": fam_merged,
            "skipped": len(OP) - len(keep)}
