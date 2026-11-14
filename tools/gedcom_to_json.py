#!/usr/bin/env python3
"""Convert an Ancestry GEDCOM export into the site's data file.

Usage:
    python3 tools/gedcom_to_json.py data/bauer-family-tree.ged

Writes data/tree.json (raw, from GEDCOM). Research findings live separately in
data/research.json and are merged at build time by tools/build.py, so you can
re-export from Ancestry and re-run this without losing research work.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def parse_lines(path):
    """Yield (level, xref, tag, value) tuples."""
    rx = re.compile(r"^\s*(\d+)\s+(?:(@[^@]+@)\s+)?(\S+)(?:\s(.*))?$")
    with open(path, encoding="utf-8-sig") as fh:
        for raw in fh:
            raw = raw.rstrip("\r\n")
            if not raw.strip():
                continue
            m = rx.match(raw)
            if not m:
                continue
            lvl, xref, tag, val = m.groups()
            yield int(lvl), xref, tag, (val or "")


def build_tree(path):
    """Return list of top-level nodes; each node = {tag, xref, value, children}."""
    roots, stack = [], []
    for lvl, xref, tag, val in parse_lines(path):
        node = {"tag": tag, "xref": xref, "value": val, "children": []}
        if tag in ("CONC", "CONT") and stack and lvl - 1 < len(stack):
            parent = stack[lvl - 1]
            parent["value"] += ("\n" if tag == "CONT" else "") + val
            continue
        del stack[lvl:]
        if lvl == 0:
            roots.append(node)
        else:
            stack[-1]["children"].append(node)
        stack.append(node)
    return roots


def first(node, tag, default=""):
    for c in node["children"]:
        if c["tag"] == tag:
            return c["value"]
    return default


def all_(node, tag):
    return [c for c in node["children"] if c["tag"] == tag]


def strip_id(x):
    return x.strip("@") if x else x


EVENT_TAGS = {
    "BIRT": "Birth", "DEAT": "Death", "BURI": "Burial", "CHR": "Christening",
    "BAPM": "Baptism", "RESI": "Residence", "OCCU": "Occupation",
    "IMMI": "Immigration", "EMIG": "Emigration", "NATU": "Naturalization",
    "CENS": "Census", "MILI": "Military", "EDUC": "Education",
    "RELI": "Religion", "GRAD": "Graduation", "RETI": "Retirement",
    "PROB": "Probate", "WILL": "Will", "EVEN": "Event", "MARR": "Marriage",
    "DIV": "Divorce", "ENGA": "Engagement", "_MILT": "Military",
    "TITL": "Title", "NATI": "Nationality", "SSN": "Social Security",
    "_DEG": "Degree", "ARVL": "Arrival", "DPRT": "Departure",
}


def citations(node):
    out = []
    for s in all_(node, "SOUR"):
        c = {"source": strip_id(s["value"])}
        page = first(s, "PAGE")
        if page:
            c["page"] = page
        data = [d for d in all_(s, "DATA")]
        for d in data:
            t = first(d, "TEXT")
            if t:
                c["text"] = t
        note = first(s, "NOTE")
        if note:
            c["note"] = note
        apid = first(s, "_APID")
        if apid:
            c["apid"] = apid
        out.append(c)
    return out


def event(node):
    e = {"type": EVENT_TAGS.get(node["tag"], node["tag"])}
    if node["tag"] == "EVEN":
        e["type"] = first(node, "TYPE") or "Event"
    elif first(node, "TYPE"):
        e["subtype"] = first(node, "TYPE")
    if node["value"] and node["value"] != "Y":
        e["value"] = node["value"]
    for k, tag in (("date", "DATE"), ("place", "PLAC"), ("note", "NOTE"), ("age", "AGE")):
        v = first(node, tag)
        if v:
            e[k] = v
    addr = first(node, "ADDR")
    if addr:
        e["address"] = addr
    cites = citations(node)
    if cites:
        e["citations"] = cites
    return e


def parse(ged):
    roots = build_tree(ged)
    people, families, sources, media = {}, {}, {}, {}
    for n in roots:
        x = strip_id(n["xref"])
        if n["tag"] == "INDI":
            names = []
            for nm in all_(n, "NAME"):
                raw = nm["value"]
                given = first(nm, "GIVN") or raw.split("/")[0].strip()
                surn = first(nm, "SURN") or (raw.split("/")[1] if "/" in raw else "")
                names.append({"given": given.strip(), "surname": surn.strip(),
                              "suffix": first(nm, "NSFX"), "type": first(nm, "TYPE")})
            events = [event(c) for c in n["children"] if c["tag"] in EVENT_TAGS]
            people[x] = {
                "id": x,
                "names": names,
                "sex": first(n, "SEX"),
                "famc": [strip_id(c["value"]) for c in all_(n, "FAMC")],
                "fams": [strip_id(c["value"]) for c in all_(n, "FAMS")],
                "events": events,
                "notes": [c["value"] for c in all_(n, "NOTE") if c["value"]],
                "citations": citations(n),
                "media": [strip_id(c["value"]) for c in all_(n, "OBJE")],
            }
        elif n["tag"] == "FAM":
            families[x] = {
                "id": x,
                "husband": strip_id(first(n, "HUSB")) or None,
                "wife": strip_id(first(n, "WIFE")) or None,
                "children": [strip_id(c["value"]) for c in all_(n, "CHIL")],
                "events": [event(c) for c in n["children"] if c["tag"] in EVENT_TAGS],
            }
        elif n["tag"] == "SOUR":
            sources[x] = {
                "id": x,
                "title": first(n, "TITL"),
                "author": first(n, "AUTH"),
                "publication": first(n, "PUBL"),
                "apid": first(n, "_APID"),
            }
        elif n["tag"] == "OBJE":
            f = all_(n, "FILE")
            fnode = f[0] if f else {"children": [], "value": ""}
            form = all_(fnode, "FORM")
            mtype = first(form[0], "TYPE") if form else ""
            media[x] = {
                "id": x,
                "title": first(fnode, "TITL") or first(n, "TITL"),
                "file": fnode["value"],
                "kind": first(form[0], "_MTYPE") if form else "",
                "date": first(n, "DATE"),
                "place": first(n, "PLAC"),
                "type": mtype,
            }
    return {"people": people, "families": families, "sources": sources, "media": media}


def main(ged):
    out = parse(ged)
    people, families, sources, media = out["people"], out["families"], out["sources"], out["media"]
    dest = ROOT / "data" / "tree.json"
    dest.write_text(json.dumps(out, indent=1, ensure_ascii=False))
    print(f"Wrote {dest}: {len(people)} people, {len(families)} families, "
          f"{len(sources)} sources, {len(media)} media")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ROOT / "data" / "bauer-family-tree.ged")
