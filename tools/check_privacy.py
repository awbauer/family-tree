#!/usr/bin/env python3
"""Block private family data from reaching git (or a PR description).

    python3 tools/check_privacy.py                 # check staged changes (the pre-commit hook runs this)
    python3 tools/check_privacy.py --file msg.txt  # check any text: commit message, PR body, issue comment
    echo "$TEXT" | python3 tools/check_privacy.py --file -

Fails (exit 1) if:
  - a staged path is private: family-data/, build/, *.ged outside example/, wrangler.local.jsonc,
    .dev.vars, *.zip, *.sql outside worker/
  - added lines or the given text contain a UUID or a 64-hex string (D1 database_id, Access AUD tag)
  - added lines or the given text contain the full name of anyone in your private GEDCOM
    (family-data/*.ged), except names that also appear in the fictional example family
  - ...or any SURNAME from your private GEDCOM written as a capitalized word ("Smith", "Van Dyke"),
    or as a lowercase branch-style key ("vandyke"), except surnames in the example family and
    common words listed in COMMON_WORDS (repo-owner usernames inside URLs don't match: "@jsmith" isn't "Smith")
  - ...or a person/family ID from your private GEDCOM, or a prefix of one ("I12…" when your IDs look like I123456)

Enable the hooks once per clone:  git config core.hooksPath .githooks   (npm install does this)
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRIVATE_PATHS = [
    (re.compile(r"^family-data/"), "private data folder"),
    (re.compile(r"^build(-[^/]*)?/"), "build output (contains your data)"),
    (re.compile(r"^(?!example/).*\.ged$", re.I), "GEDCOM file"),
    (re.compile(r"(^|/)wrangler\.local\.jsonc$"), "your real Cloudflare IDs"),
    (re.compile(r"(^|/)\.dev\.vars$"), "local secrets"),
    (re.compile(r"\.zip$", re.I), "archive (could hold anything)"),
    (re.compile(r"^(?!worker/|migrations/).*\.sql$", re.I), "SQL dump (schema belongs in worker/ or migrations/)"),
    (re.compile(r"^site/(family\.json|data\.js)$"), "built data in the public site folder"),
]
ID_PATTERNS = [
    (re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I), "UUID (D1 database_id?)"),
    (re.compile(r"\b[0-9a-f]{64}\b", re.I), "64-hex string (Access AUD tag?)"),
]
# Files whose content is allowed to contain hashes/ids (lockfiles carry integrity hashes, not UUIDs, but be safe).
CONTENT_EXEMPT = re.compile(r"(^|/)package-lock\.json$")


def names_in(ged):
    out = set()
    if not ged.exists():
        return out
    for line in ged.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        m = re.match(r"\s*1 NAME (.*?)\s*/([^/]+)/", line)
        if not m:
            continue
        given = [g for g in re.sub(r"\(.*?\)", " ", m.group(1)).split() if re.match(r"\w", g)]
        surname = re.sub(r"\(.*?\)", " ", m.group(2)).strip()
        if not given or not surname or given[0].lower() in ("unknown", "nn"):
            continue
        out.add(f"{given[0]} {surname}")
        if len(given) > 1:
            out.add(f"{' '.join(given)} {surname}")
    return out


COMMON_WORDS = {"daily", "young", "king", "white", "black", "green", "brown", "long", "short", "little", "rose",
                "may", "june", "april", "street", "church", "hall", "wood", "hill", "field", "page", "case", "mark"}


def surnames_in(ged):
    out = set()
    if ged.exists():
        for m in re.finditer(r"^\s*1 NAME [^/\n]*/([^/\n]+)/", ged.read_text(encoding="utf-8-sig", errors="replace"), re.M):
            sn = re.sub(r"\(.*?\)", "", m.group(1)).strip()
            if len(sn) >= 4 and re.match(r"\w", sn):
                out.add(sn)
    return out


def private_surnames():
    s = set()
    for ged in (ROOT / "family-data").glob("*.ged"):
        s |= surnames_in(ged)
    ex = {x.lower() for g in (ROOT / "example").glob("*.ged") for x in surnames_in(g)}
    return {x for x in s if x.lower() not in ex and x.lower() not in COMMON_WORDS}


def private_ids():
    ids = set()
    for ged in (ROOT / "family-data").glob("*.ged"):
        ids |= set(re.findall(r"^0 @([A-Z]\d{4,})@", ged.read_text(encoding="utf-8-sig", errors="replace"), re.M))
    return ids


def private_names():
    names = set()
    for ged in (ROOT / "family-data").glob("*.ged"):
        names |= names_in(ged)
    for ged in (ROOT / "example").glob("*.ged"):
        names -= names_in(ged)
    return names


def scan_text(text, where, names_re):
    problems = []
    for sn in SURNAMES:
        cap = re.compile(r"(?<![\w@/.-])" + re.escape(sn) + r"(?!\w)")          # "Van Dyke" as written
        key = re.compile(r"(?<![\w@/.-])" + re.escape(re.sub(r"\W", "", sn).lower()) + r"(?!\w)")  # "vandyke"
        if cap.search(text) or (len(sn) >= 6 and key.search(text)):
            problems.append(f"{where}: surname from your private tree: {sn!r}")
    for tok in set(re.findall(r"\b([A-Z]\d{3,})", text)):
        if tok in IDS or any(i.startswith(tok) for i in IDS if len(tok) >= 4):
            problems.append(f"{where}: ID (or ID prefix) from your private tree: {tok!r}")
    for pat, why in ID_PATTERNS:
        for m in pat.finditer(text):
            problems.append(f"{where}: {why}: {m.group(0)[:12]}…")
    if names_re:
        for m in names_re.finditer(text):
            problems.append(f"{where}: full name of someone in your private tree: {m.group(0)!r}")
    return problems


def names_regex():
    names = private_names()
    if not names:
        return None
    return re.compile(r"(?<!\w)(" + "|".join(sorted(map(re.escape, names), key=len, reverse=True)) + r")(?!\w)", re.I)


def staged():
    git = lambda *a: subprocess.run(["git", *a], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    problems = []
    files = [f for f in git("diff", "--cached", "--name-only", "--diff-filter=ACMR").splitlines() if f]
    for f in files:
        for pat, why in PRIVATE_PATHS:
            if pat.search(f):
                problems.append(f"{f}: {why} must never be committed")
    nre = names_regex()
    for f in files:
        if CONTENT_EXEMPT.search(f):
            continue
        added = "\n".join(l[1:] for l in git("diff", "--cached", "-U0", "--", f).splitlines()
                          if l.startswith("+") and not l.startswith("+++"))
        problems += scan_text(added, f, nre)
    return problems


SURNAMES = private_surnames()
IDS = private_ids()


def main(argv):
    if "--file" in argv:
        src = argv[argv.index("--file") + 1]
        text = sys.stdin.read() if src == "-" else Path(src).read_text()
        problems = scan_text(text, "text", names_regex())
    else:
        problems = staged()
    if problems:
        print("PRIVACY CHECK FAILED. Nothing from your private data may leave this machine:", file=sys.stderr)
        for p in problems:
            print("  - " + p, file=sys.stderr)
        print("Unstage or edit, then try again. (Do not bypass with --no-verify.)", file=sys.stderr)
        sys.exit(1)
    print("privacy check: ok")


if __name__ == "__main__":
    main(sys.argv[1:])
