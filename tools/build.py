#!/usr/bin/env python3
"""Build the data bundle for the family-tree site.

    python3 tools/build.py                          # reads family-data/ (or example/), writes build/
    python3 tools/build.py --data ~/my-family --out build

Inputs (in the --data folder; keep it OUT of git):
  *.ged           GEDCOM export from Ancestry, Gramps, MyHeritage, FamilySearch …
  research.json   research layer: site settings, findings, statuses, stories, to-dos, corrections
  places.json     optional gazetteer for the map (regex -> coordinates)

Outputs (in --out):
  family.json     the whole bundle the app renders (used by tools/serve.py for local preview)
  seed.sql        full-replace load for Cloudflare D1:
                  npm run db:load
"""
import json
import re
import sys
from collections import defaultdict, deque
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gedcom_to_json as g2j  # noqa: E402
import graft  # noqa: E402
import edits  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent

# Events that happen during a life (a residence, an occupation …), as opposed to birth, death and burial.
LIFE_EVENTS = {"Residence", "Occupation", "Arrival", "Departure", "Emigration", "Immigration", "Naturalization", "Military", "Census", "Education", "Graduation", "Retirement"}
RX_YEAR = re.compile(r"(?<![0-9])(1[6-9][0-9][0-9])(?![0-9])")

MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3, "apr": 4, "april": 4,
    "may": 5, "mai": 5, "máj": 5, "jun": 6, "june": 6, "jún": 6, "jul": 7, "july": 7, "júl": 7,
    "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9, "szept": 9, "oct": 10, "october": 10,
    "okt": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
}
APPROX = re.compile(r"\b(abt\.?|about|circa|ca\.?|c\.|est\.?|estimated|bef\.?|before|aft\.?|after|bet\.?|between)\b", re.I)


def parse_date(raw):
    """Best-effort parse of the messy date strings found in Ancestry exports."""
    if not raw:
        return None
    s = re.sub(r"<[^>]+>", "", raw).strip()
    out = {"raw": raw, "text": s, "approx": bool(APPROX.search(s)), "malformed": s != raw.strip()}
    qual = APPROX.search(s)
    out["qualifier"] = qual.group(1).lower().rstrip(".") if qual else ""
    s2 = APPROX.sub("", s).replace(",", " ").strip()
    y = m = d = None
    mm = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", s2)
    if mm:
        m, d, y = int(mm.group(1)), int(mm.group(2)), int(mm.group(3))
        out["nonstandard"] = True
    elif re.match(r"^\d{4}\s*-\s*\d{4}$", s2):
        a, b = re.findall(r"\d{4}", s2)
        y = (int(a) + int(b)) // 2
        out["approx"] = True
        out["range"] = [int(a), int(b)]
    else:
        toks = s2.split()
        for t in toks:
            tl = t.lower().rstrip(".")
            if re.fullmatch(r"\d{4}", t):
                y = int(t)
            elif re.fullmatch(r"\d{1,2}", t):
                d = int(t)
            elif tl in MONTHS:
                m = MONTHS[tl]
                if tl in ("mai", "máj", "jún", "júl", "szept", "okt"):
                    out["nonstandard"] = True
        if toks and toks[0].lower().rstrip(".") in MONTHS and d is not None:
            out["nonstandard"] = True  # "May 13 1963"
        if y is not None and y < 1000:
            y = None
    if y is None:
        out["year"] = None
        out["sort"] = None
        out["malformed"] = True
        return out
    out.update({"year": y, "month": m, "day": d})
    out["sort"] = y * 10000 + (m or 6) * 100 + (d or 15)
    if out.get("qualifier") in ("bef", "before"):
        out["sort"] -= 1
    return out


def fmt_date(pd):
    if not pd or pd.get("year") is None:
        return pd["text"] if pd else ""
    names = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    parts = []
    if pd.get("day") and pd.get("month"):
        parts.append(str(pd["day"]))
    if pd.get("month"):
        parts.append(names[pd["month"]])
    parts.append(str(pd["year"]))
    s = " ".join(parts)
    q = pd.get("qualifier")
    if pd.get("range"):
        return f"{pd['range'][0]}–{pd['range'][1]}"
    if q in ("bef", "before"):
        return "before " + s
    if q in ("aft", "after"):
        return "after " + s
    if pd.get("approx"):
        return "c. " + s
    return s


def clean_place(p):
    if not p:
        return ""
    p = p.strip().lstrip("`").strip()
    p = re.sub(r"\s*,\s*", ", ", p)
    p = re.sub(r"\s{2,}", " ", p)
    return p.strip(", ")


def display_name(person):
    if not person["names"]:
        return "Unknown"
    n = person["names"][0]
    g = (n["given"] or "").strip()
    s = (n["surname"] or "").strip()
    if g in ("?", "") and s in ("?", ""):
        return "Unknown"
    if g in ("?", ""):
        g = "(unknown)"
    return f"{g} {s}".strip()


def best_event(events, typ):
    """Pick the most specific dated event of a type (most precise date wins, then most citations)."""
    cands = [e for e in events if e["type"] == typ and not e.get("misfiled")]
    if not cands:
        return None

    def score(e):
        pd = e.get("pdate") or {}
        prec = (1 if pd.get("year") else 0) + (1 if pd.get("month") else 0) + (1 if pd.get("day") else 0)
        prec -= 0.5 if pd.get("approx") else 0
        return (prec, len(e.get("citations", [])), 1 if e.get("place") else 0)

    return max(cands, key=score)


def main(ged_path, data_dir, out_dir, raw_out=None):
    raw = g2j.parse(ged_path)
    research = json.loads((data_dir / "research.json").read_text()) if (data_dir / "research.json").exists() else {}
    for gcfg in research.get("grafts", []):
        gpath = data_dir / gcfg["gedcom"]
        if not gpath.exists():
            sys.exit(f"graft: {gpath} not found")
        try:
            stats = graft.graft(raw, g2j.parse(gpath), gcfg)
        except ValueError as e:
            sys.exit(str(e))
        print("Grafted " + ", ".join(f"{k}={v}" for k, v in stats.items()))
    aliases = {}
    if research.get("edits"):
        try:
            aliases, elog = edits.apply_edits(raw, research["edits"])
        except edits.EditError as e:
            sys.exit(str(e))
        edits.remap_research(research, aliases)
        ov = research.get("overrides", {})
        for old, new in aliases.items():
            if old in ov:
                ov.setdefault(new, ov.pop(old))
        research["duplicates"] = [d for d in research.get("duplicates", []) if len(set(d["ids"])) > 1]
        print(f"Applied {len(elog)} edits ({len(aliases)} people merged)")
    places = json.loads((data_dir / "places.json").read_text()) if (data_dir / "places.json").exists() else {}
    if raw_out:
        # Snapshot of the stored (pre-derivation) data: what the database holds and worker/derive.js consumes.
        # Serialised now, so the derivation below can't leak into it.
        raw_out = Path(raw_out)
        raw_out.parent.mkdir(parents=True, exist_ok=True)
        raw_out.write_text(json.dumps({"raw": raw, "research": research, "places": places, "aliases": aliases},
                                      ensure_ascii=False, separators=(",", ":")))
    P, F, S = raw["people"], raw["families"], raw["sources"]
    overrides = research.get("overrides", {})
    issues = []

    def issue(pid, severity, kind, msg):
        issues.append({"person": pid, "severity": severity, "kind": kind, "message": msg})

    # ---------- normalise events ----------
    for pid, p in P.items():
        ov = overrides.get(pid, {})
        if ov.get("sex"):
            p["sexOriginal"] = p["sex"]
            p["sex"] = ov["sex"]
        if ov.get("name"):
            p["names"].insert(0, {"given": ov["name"].get("given", ""), "surname": ov["name"].get("surname", ""),
                                  "suffix": "", "type": "research"})
        for e in p["events"]:
            e["pdate"] = parse_date(e.get("date"))
            if e.get("place"):
                e["place"] = clean_place(e["place"])
            note = (e.get("note") or "")
            if e["type"] in ("Death", "Birth", "Marriage") and re.match(r"^(death|birth|marriage) of ", note, re.I):
                e["misfiled"] = True
                issue(pid, "warn", "misfiled-event",
                      f"{e['type']} event dated {e.get('date')} is really a relative's event (“{note}”). "
                      "Ancestry exports these 'family events' as if they were the person's own.")
            if e["pdate"] and (e["pdate"].get("malformed") or e["pdate"].get("nonstandard")) and e.get("date"):
                issue(pid, "info", "date-format",
                      f"Non-standard {e['type'].lower()} date “{e['date']}” — rewrite as e.g. “17 Mar 1923”.")
        for f_id in p["fams"]:
            pass
    for fid, f in F.items():
        for e in f["events"]:
            e["pdate"] = parse_date(e.get("date"))
            if e.get("place"):
                e["place"] = clean_place(e["place"])
            if e["pdate"] and e.get("date") and (e["pdate"].get("malformed") or e["pdate"].get("nonstandard")):
                issue(f.get("husband") or f.get("wife"), "warn" if e["pdate"].get("year") is None else "info",
                      "date-format", f"Family {fid}: {e['type'].lower()} date “{e['date']}” is malformed.")

    # ---------- summary fields ----------
    this_year = date.today().year
    for pid, p in P.items():
        p["name"] = display_name(p)
        p["given"] = p["names"][0]["given"] if p["names"] else ""
        p["surname"] = p["names"][0]["surname"] if p["names"] else ""
        b, d, bu = best_event(p["events"], "Birth"), best_event(p["events"], "Death"), best_event(p["events"], "Burial")
        p["birth"] = {"date": fmt_date(b["pdate"]), "year": b["pdate"]["year"] if b and b["pdate"] else None,
                      "place": b.get("place", ""), "sort": b["pdate"]["sort"] if b and b["pdate"] else None} if b else None
        p["death"] = {"date": fmt_date(d["pdate"]), "year": d["pdate"]["year"] if d and d["pdate"] else None,
                      "place": d.get("place", ""), "sort": d["pdate"]["sort"] if d and d["pdate"] else None} if d else None
        p["burial"] = {"place": bu.get("place", ""), "note": bu.get("note", "")} if bu else None
        by = p["birth"]["year"] if p["birth"] else None
        p["living"] = (not p["death"]) and (by is None or by > this_year - 100) and not p.get("deceased")
        if by is None and not p["death"]:
            # Unknown birth: treat as deceased if any dated event before 1930
            yrs = [e["pdate"]["year"] for e in p["events"] if e.get("pdate") and e["pdate"].get("year")]
            p["living"] = bool(yrs) and min(yrs) > 1930
            if not yrs:
                p["living"] = False
                p["livingUnknown"] = True
        if overrides.get(pid, {}).get("living") is not None:
            p["living"] = overrides[pid]["living"]
        # distinct birth years from different records
        byears = sorted({e["pdate"]["year"] for e in p["events"]
                         if e["type"] == "Birth" and e.get("pdate") and e["pdate"].get("year")})
        if len(byears) > 1 and byears[-1] - byears[0] >= 2:
            issue(pid, "warn", "conflicting-dates",
                  f"Records disagree on birth year: {', '.join(map(str, byears))}.")
        bplaces = {e.get("place") for e in p["events"] if e["type"] == "Birth" and e.get("place")}
        if len(bplaces) > 1:
            issue(pid, "info", "conflicting-places", "Different birthplaces recorded: " + " / ".join(sorted(bplaces)))
        if not p["sex"]:
            issue(pid, "warn", "missing-sex", "Sex is not recorded.")
        if len(p["famc"]) > 1:
            names = []
            for fc in p["famc"]:
                f = F[fc]
                names.append(" & ".join(display_name(P[x]) for x in (f["husband"], f["wife"]) if x))
            issue(pid, "error", "multiple-parents",
                  "Attached to more than one set of parents: " + " | ".join(names) + ". Only one can be right "
                  "(unless one is an adoptive/step family — mark it so).")
        if p["sex"] == "F":
            own = [(n.get("surname") or "").strip() for n in p["names"] if (n.get("surname") or "").strip()]
            lower = {x.lower() for x in own}
            if len(lower) == 1:
                low = next(iter(lower))
                sur = lambda x: ((P[x]["names"][0] if P[x]["names"] else {}).get("surname") or "").strip().lower()
                husbands = [F[fs]["husband"] for fs in p["fams"] if F[fs]["wife"] == pid and F[fs]["husband"]]
                fathers = [F[fc]["husband"] for fc in p["famc"] if F[fc]["husband"]]
                if any(sur(h) == low for h in husbands) and not any(sur(h) == low for h in fathers):
                    issue(pid, "info", "married-surname",
                          f"Recorded only under her husband's surname ({own[0]}). Add her maiden name, or leave the surname blank if it isn't known.")

    # No birth year of their own: estimate one from close relatives (parent + 25, spouse or sibling the same,
    # child - 25; the youngest estimate wins) and treat them as living when it falls within the last 100 years.
    est = {pid: p["birth"]["year"] for pid, p in P.items() if p["birth"] and p["birth"]["year"]}
    for _ in range(3):
        nxt = dict(est)
        for pid, p in P.items():
            if pid in est:
                continue
            c = []
            for fc in p["famc"]:
                f = F[fc]
                c += [est[x] + 25 for x in (f["husband"], f["wife"]) if x and x in est]
                c += [est[x] for x in f["children"] if x != pid and x in est]
            for fs in p["fams"]:
                f = F[fs]
                c += [est[x] for x in (f["husband"], f["wife"]) if x and x != pid and x in est]
                c += [est[x] - 25 for x in f["children"] if x in est]
            if c:
                nxt[pid] = max(c)
        est.update(nxt)
    # The estimate decides both ways for anyone without a birth year or a death: a 1940s emigration alone doesn't make
    # someone whose spouse was born in 1907 living. A dated record from the last 30 years still counts as alive.
    for pid, p in P.items():
        if (p["birth"] and p["birth"]["year"]) or p["death"] or p.get("deceased") \
                or overrides.get(pid, {}).get("living") is not None or pid not in est:
            continue
        recent = any(e.get("pdate") and e["pdate"].get("year") and e["pdate"]["year"] >= this_year - 30 for e in p["events"])
        p["living"] = est[pid] > this_year - 100 or recent

    # ---------- family checks ----------
    for fid, f in F.items():
        h, w = f["husband"], f["wife"]
        if h and P[h]["sex"] == "F":
            issue(h, "error", "sex-role", f"Recorded as female but is the husband in family {fid}.")
        if w and P[w]["sex"] == "M":
            issue(w, "error", "sex-role", f"Recorded as male but is the wife in family {fid}.")
        for parent_id, role, lo, hi in ((h, "father", 16, 70), (w, "mother", 14, 50)):
            if not parent_id or not P[parent_id]["birth"] or not P[parent_id]["birth"]["year"]:
                continue
            py = P[parent_id]["birth"]["year"]
            for c in f["children"]:
                cb = P[c]["birth"]
                if not cb or not cb["year"]:
                    continue
                age = cb["year"] - py
                if age < lo or age > hi:
                    issue(c, "error", "parent-age",
                          f"{P[parent_id]['name']} (b. {py}) would be {age} as {role} at this birth ({cb['year']}).")
            pd = P[parent_id]["death"]
            if pd and pd["sort"]:
                for c in f["children"]:
                    cb = P[c]["birth"]
                    if cb and cb["sort"] and cb["sort"] > pd["sort"] + (10000 if role == "father" else 0):
                        issue(c, "error", "born-after-parent-death",
                              f"Born {cb['date']} after {role} {P[parent_id]['name']} died ({pd['date']}).")
        for e in f["events"]:
            if e["type"] == "Marriage" and e.get("pdate") and e["pdate"].get("year"):
                for sp in (h, w):
                    if sp and P[sp]["birth"] and P[sp]["birth"]["year"]:
                        age = e["pdate"]["year"] - P[sp]["birth"]["year"]
                        if age < 14:
                            issue(sp, "error", "marriage-age",
                                  f"Would be {age} at marriage ({e.get('date')}) in family {fid}.")
        # one parent here, but that parent is half of a couple in another family: the children are probably the couple's
        if bool(h) != bool(w) and f["children"]:
            par = h or w
            other = next((x for x in P[par]["fams"] if x != fid and F[x]["husband"] and F[x]["wife"]), None)
            if other:
                issue(par, "info", "one-parent-family",
                      f"Family {fid} records only {P[par]['name']} as a parent, but {P[par]['name']} also has a spouse in family {other}. "
                      "If these children belong to that couple, merge the two families.")
        # siblings implausibly close
        kids = sorted([c for c in f["children"] if P[c]["birth"] and P[c]["birth"]["sort"]
                       and not (P[c]["events"] and all((e.get("pdate") or {}).get("approx") for e in P[c]["events"] if e["type"] == "Birth"))],
                      key=lambda c: P[c]["birth"]["sort"])
    for pid, p in P.items():
        if p["birth"] and p["death"] and p["birth"]["sort"] and p["death"]["sort"] and p["death"]["sort"] < p["birth"]["sort"]:
            issue(pid, "error", "death-before-birth", "Death date is before birth date.")
        if p["birth"] and p["death"] and p["birth"]["year"] and p["death"]["year"] and p["death"]["year"] - p["birth"]["year"] > 105:
            issue(pid, "warn", "age", f"Would have lived {p['death']['year'] - p['birth']['year']} years.")
        for e in p["events"]:
            y = (e.get("pdate") or {}).get("year")
            if y is None or e["type"] not in LIFE_EVENTS:
                continue
            if p["birth"] and p["birth"]["year"] and y < p["birth"]["year"]:
                issue(pid, "warn", "event-outside-life", f"{e['type']} dated {e.get('date')} is before the birth ({p['birth']['year']}); it may belong to someone else.")
            elif p["death"] and p["death"]["year"] and y > p["death"]["year"]:
                issue(pid, "warn", "event-outside-life", f"{e['type']} dated {e.get('date')} is after the death ({p['death']['year']}); it may belong to someone else.")
        for t in ("Birth", "Death"):
            n = sum(1 for e in p["events"] if e["type"] == t)
            if n > 1:
                issue(pid, "info", "duplicate-event", f"{n} {t.lower()} events recorded. Keep one and move the citations onto it, or note why they differ.")
        for e in p["events"]:
            y = (e.get("pdate") or {}).get("year")
            if y is None:
                continue
            for c in e.get("citations") or []:
                title = (S[c["source"]].get("title") if c.get("source") and c["source"] in S else None) or c.get("title") or ""
                if not re.search("census", title, re.I):
                    continue
                years = sorted({int(m) for m in RX_YEAR.findall(title)})
                if len(years) == 1 and y > years[0]:
                    issue(pid, "warn", "cited-after-record", f"{e['type']} dated {e.get('date')} cites the {years[0]} census (“{title}”), taken before it.")
                    break

    # possible duplicates: same death date (full) or same given+surname+birth year
    by_death = defaultdict(list)
    for pid, p in P.items():
        d = p["death"]
        if d and d["sort"] and d["date"] and len(d["date"].split()) == 3 and not d["date"].startswith("c."):
            by_death[d["sort"]].append(pid)
    for k, ids in by_death.items():
        if len(ids) > 1:
            for pid in ids:
                others = [P[o]["name"] for o in ids if o != pid]
                issue(pid, "error", "possible-duplicate",
                      f"Same exact death date ({P[pid]['death']['date']}) as {', '.join(others)} — likely the same person entered twice.")
    seen = defaultdict(list)
    for pid, p in P.items():
        key = (p["given"].split(" ")[0].lower(), p["surname"].lower(), p["birth"]["year"] if p["birth"] else None)
        if key[0] and key[1] and key[2]:
            seen[key].append(pid)
    for k, ids in seen.items():
        if len(ids) > 1:
            for pid in ids:
                issue(pid, "warn", "possible-duplicate",
                      f"Another person with the same name and birth year ({k[2]}) exists: "
                      + ", ".join(o for o in ids if o != pid))

    for rule in research.get("place_rules", []):
        rx = re.compile(rule["pattern"], re.I)
        for pid, p in P.items():
            for e in p["events"]:
                y = (e.get("pdate") or {}).get("year")
                if e.get("place") and rx.search(e["place"]) and (y is None or y < rule.get("before", 9999)):
                    issue(pid, "warn", "anachronistic-place", rule["message"])

    # ---------- places ----------
    gaz = places.get("places", [])
    compiled = [(pl, [re.compile(m, re.I) for m in pl["match"]]) for pl in gaz]
    unmatched = set()

    def place_key(txt):
        for pl, rxs in compiled:
            if any(r.search(txt) for r in rxs):
                return pl["key"]
        unmatched.add(txt)
        return None

    for p in P.values():
        for e in p["events"]:
            if e.get("place"):
                e["placeKey"] = place_key(e["place"])
    for f in F.values():
        for e in f["events"]:
            if e.get("place"):
                e["placeKey"] = place_key(e["place"])
    if unmatched:
        print("Places with no map entry (add to places.json):\n  " + "\n  ".join(sorted(unmatched)))

    # ---------- relationships & branches ----------
    home = research.get("home_person") or next(iter(P))

    def parents_of(pid):
        # a family with no parent recorded gets a stand-in parent ("~F12"), so its children are still siblings
        if pid not in P:
            return []
        out = []
        for fc in P[pid]["famc"]:
            f = F[fc]
            out += [x for x in (f["husband"], f["wife"]) if x]
            if not f["husband"] and not f["wife"]:
                out.append("~" + fc)
        return out

    def ancestors(pid):
        dist = {pid: 0}
        q = deque([pid])
        while q:
            x = q.popleft()
            for par in parents_of(x):
                if par not in dist:
                    dist[par] = dist[x] + 1
                    q.append(par)
        return dist

    home_anc = ancestors(home)
    ordinal = lambda n: {1: "1st", 2: "2nd", 3: "3rd"}.get(n, f"{n}th")

    def gendered(sex, m, f, n):
        return m if sex == "M" else f if sex == "F" else n

    def blood_relation(pid):
        if pid == home:
            return "Self"
        anc = ancestors(pid)
        common = [(home_anc[a] + anc[a], a) for a in anc if a in home_anc]
        if not common:
            return None
        _, ca = min(common)
        up, down = home_anc[ca], anc[ca]  # generations from home to CA, from person to CA
        sex = P[pid]["sex"]
        if down == 0:  # direct ancestor
            base = gendered(sex, "father", "mother", "parent")
            if up == 1:
                return base
            if up == 2:
                return "grand" + base
            return ("great-" if up == 3 else f"{ordinal(up - 2)} great-") + "grand" + base
        if up == 0:
            base = gendered(sex, "son", "daughter", "child")
            if down == 1:
                return base
            if down == 2:
                return "grand" + base
            return ("great-" if down == 3 else f"{ordinal(down - 2)} great-") + "grand" + base
        if up == 1 and down == 1:
            return gendered(sex, "brother", "sister", "sibling")
        if up == 1:  # nephew/niece line
            base = gendered(sex, "nephew", "niece", "nibling")
            if down == 2:
                return base
            return ("grand" if down == 3 else ("great-" if down == 4 else f"{ordinal(down - 3)} great-") + "grand") + base
        if down == 1:  # aunt/uncle line
            base = gendered(sex, "uncle", "aunt", "parent's sibling")
            if up == 2:
                return base
            if up == 3:
                return "great-" + base
            return f"{ordinal(up - 2)} great-" + base
        n = min(up, down) - 1
        r = abs(up - down)
        rel = f"{ordinal(n)} cousin"
        if r:
            rel += " once removed" if r == 1 else " twice removed" if r == 2 else f" {r}× removed"
        return rel

    rel = {}
    for pid in P:
        r = blood_relation(pid)
        if r:
            rel[pid] = r
    for pid, p in P.items():
        if pid in rel:
            continue
        for fs in p["fams"]:
            f = F[fs]
            sp = f["wife"] if f["husband"] == pid else f["husband"]
            if sp and sp in rel and rel[sp] != "Self":
                rel[pid] = gendered(p["sex"], "husband", "wife", "spouse") + " of " + rel[sp]
                break
            if sp and rel.get(sp) == "Self":
                rel[pid] = gendered(p["sex"], "husband", "wife", "spouse")
                break
    # anyone still unlabelled: describe via the nearest labelled relative (BFS through the family graph)
    def fam_neighbours(pid):
        p = P[pid]
        for fid in p["famc"] + p["fams"]:
            f = F[fid]
            for x in [f["husband"], f["wife"]] + f["children"]:
                if x and x != pid:
                    yield x
    via = {}
    for pid in P:
        if pid in rel:
            continue
        seen, q2 = {pid}, deque([pid])
        while q2:
            x = q2.popleft()
            hit = None
            for n in fam_neighbours(x):
                if n in seen:
                    continue
                if n in rel and rel[n] != "Self":
                    hit = n
                    break
                seen.add(n)
                q2.append(n)
            if hit:
                via[pid] = hit
                break
    for pid, p in P.items():
        p["relation"] = rel.get(pid)
        if pid in via:
            p["relationVia"] = via[pid]

    branches_cfg = research.get("branches", [])
    branch = {}
    core = set(research.get("core_people", [home]))
    for c in core:
        branch[c] = "home"
    q = deque()
    for b in branches_cfg:
        if b["root"] in P:
            branch[b["root"]] = b["key"]
            q.append(b["root"])

    def neighbours(pid):
        p = P[pid]
        for fid in p["famc"] + p["fams"]:
            f = F[fid]
            for x in [f["husband"], f["wife"]] + f["children"]:
                if x and x != pid:
                    yield x

    # ancestors of each root first (so a root's parents' other children stay in-branch), then BFS
    while q:
        x = q.popleft()
        for n in neighbours(x):
            if n not in branch:
                branch[n] = branch[x]
                q.append(n)
    for pid, p in P.items():
        p["branch"] = branch.get(pid, "other")
        p["direct"] = pid in home_anc
        p["generation"] = home_anc.get(pid)

    # ---------- research layer ----------
    status = {}
    for k, v in research.get("people_status", {}).items():
        status[k] = v
    for pid, p in P.items():
        p["status"] = status.get(pid, {}).get("status", "unverified")
        p["statusNote"] = status.get(pid, {}).get("note", "")
        p["issues"] = [i for i in issues if i["person"] == pid]
    for d in research.get("duplicates", []):
        for a in d["ids"]:
            if a in P:
                P[a].setdefault("duplicateOf", []).extend([b for b in d["ids"] if b != a])

    # strip noise before shipping
    for p in P.values():
        for e in p["events"]:
            e["dateDisplay"] = fmt_date(e.get("pdate")) if e.get("pdate") else ""
            e["sort"] = (e.get("pdate") or {}).get("sort")
            e.pop("pdate", None)
    for f in F.values():
        for e in f["events"]:
            e["dateDisplay"] = fmt_date(e.get("pdate")) if e.get("pdate") else ""
            e["sort"] = (e.get("pdate") or {}).get("sort")
            e.pop("pdate", None)

    bundle = {
        "generated": date.today().isoformat(),
        "home": home,
        "people": P, "families": F, "sources": S, "media": raw["media"],
        "issues": issues,
        "aliases": aliases,
        "research": {k: v for k, v in research.items() if k not in ("overrides", "place_rules")},
        # flat places.json entries; worker/derive.js placeTree() also nests places saved in the app
        "places": {pl["key"]: {"name": pl["name"], "short": pl["name"], "lat": pl["lat"], "lng": pl["lng"]} for pl in gaz},
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "family.json").write_text(json.dumps(bundle, ensure_ascii=False, separators=(",", ":")))
    (out_dir / "seed.sql").write_text(to_sql(bundle))
    sev = defaultdict(int)
    for i in issues:
        sev[i["severity"]] += 1
    print(f"Built {out_dir}/family.json and {out_dir}/seed.sql — {len(P)} people, {len(F)} families, "
          f"{len(S)} sources; issues: {dict(sev)}; findings: {len(research.get('findings', []))}")


def sql_str(v):
    return "'" + str(v).replace("'", "''") + "'"


def to_sql(b):
    """Full-replace seed for D1 (schema in worker/schema.sql)."""
    j = lambda o: sql_str(json.dumps(o, ensure_ascii=False, separators=(",", ":")))
    r = dict(b["research"])
    findings, stories, todos = r.pop("findings", []), r.pop("stories", []), r.pop("todo", [])
    lines = ["-- Generated by tools/build.py. Loads a full snapshot; existing rows are replaced.",
             (ROOT / "worker" / "schema.sql").read_text()]
    for t in ("meta", "people", "families", "sources", "media", "places", "findings", "stories", "todos", "issues"):
        lines.append(f"DELETE FROM {t};")
    for k, v in (("generated", b["generated"]), ("home", b["home"]), ("research", r)):
        lines.append(f"INSERT INTO meta (key, value) VALUES ({sql_str(k)}, {j(v)});")
    for pid, p in b["people"].items():
        lines.append(f"INSERT INTO people (id, branch, data) VALUES ({sql_str(pid)}, {sql_str(p['branch'])}, {j(p)});")
    for tbl, coll in (("families", b["families"]), ("sources", b["sources"]), ("media", b["media"])):
        for k, v in coll.items():
            lines.append(f"INSERT INTO {tbl} (id, data) VALUES ({sql_str(k)}, {j(v)});")
    for k, v in b["places"].items():
        lines.append(f"INSERT INTO places (key, data) VALUES ({sql_str(k)}, {j(v)});")
    for i, f in enumerate(findings):
        lines.append(f"INSERT INTO findings (id, person_id, data) VALUES ({i + 1}, {sql_str(f.get('person') or '')}, {j(f)});")
    for s in stories:
        lines.append(f"INSERT INTO stories (slug, data) VALUES ({sql_str(s['slug'])}, {j(s)});")
    for i, t in enumerate(todos):
        lines.append(f"INSERT INTO todos (id, person_id, data) VALUES ({i + 1}, {sql_str(t.get('person') or '')}, {j(t)});")
    for i, x in enumerate(b["issues"]):
        lines.append(f"INSERT INTO issues (id, person_id, data) VALUES ({i + 1}, {sql_str(x.get('person') or '')}, {j(x)});")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Build a family-tree data bundle from a GEDCOM + research layer.")
    ap.add_argument("--data", default=str(ROOT / "family-data"),
                    help="folder holding your .ged, research.json and places.json (default: family-data/, falls back to example/)")
    ap.add_argument("--out", default=str(ROOT / "build"), help="output folder (default: build/)")
    ap.add_argument("--raw-out", metavar="PATH",
                    help="also write the parsed data (after grafts and edits, before derivation) as JSON to PATH; "
                         "this is the input of worker/derive.js")
    a = ap.parse_args()
    data_dir = Path(a.data)
    if not data_dir.exists() and a.data == str(ROOT / "family-data"):
        data_dir = ROOT / "example"
        print("No family-data/ folder — using the fictional example family.")
    geds = sorted(data_dir.glob("*.ged"))
    if not geds:
        sys.exit(f"No .ged file found in {data_dir}")
    rj = data_dir / "research.json"
    cfg = json.loads(rj.read_text()) if rj.exists() else {}
    grafted = {g["gedcom"] for g in cfg.get("grafts", [])}
    if cfg.get("gedcom"):
        primary = data_dir / cfg["gedcom"]
        if not primary.exists():
            sys.exit(f'research.json "gedcom" names {primary.name}, which is not in {data_dir}')
    else:
        candidates = [g for g in geds if g.name not in grafted]
        if len(candidates) != 1:
            sys.exit(f"Found {len(candidates)} main .ged files in {data_dir} ({', '.join(g.name for g in candidates)}). "
                     'Set "gedcom" in research.json to the main tree, and list the others under "grafts".')
        primary = candidates[0]
    main(primary, data_dir, Path(a.out), a.raw_out)
