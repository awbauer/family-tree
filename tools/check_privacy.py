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
  - ...or a specific place from your private data: words from the GEDCOM's places, and the proper nouns in
    research.json / places.json (places, photo captions, notes). Words the example family uses, and words already
    in the public repo, don't count, so ordinary words don't trip it.
  - python3 tools/check_privacy.py --audit   scans every tracked file (not just staged changes), and doesn't excuse
    place words that are already in the repo: run it to find anything that slipped in earlier.

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
                "may", "june", "april", "street", "church", "hall", "wood", "hill", "field", "page", "case", "mark",
                # generic place words and countries: not identifying on their own
                "local", "city", "county", "town", "township", "village", "parish", "district", "province", "state",
                "cemetery", "graveyard", "hospital", "home", "road", "avenue", "united", "states", "america", "europe",
                "canada", "mexico", "england", "scotland", "wales", "ireland", "britain", "france", "germany", "italy",
                "spain", "portugal", "austria", "hungary", "poland", "russia", "ukraine", "sweden", "norway",
                "denmark", "netherlands", "belgium", "switzerland", "greece", "slovakia", "czechia", "romania",
                "serbia", "croatia", "lithuania", "latvia", "finland", "australia", "unknown"}


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


def _words(text, n=4):
    return set(re.findall(r"[A-ZÀ-Ž][\w\u00C0-\u017F'-]{%d,}" % (n - 1), text))


def private_places(baseline=True):
    """Specific place words from the private data (cemetery, street, town names…)."""
    fd = ROOT / "family-data"
    text = ""
    for f in list(fd.glob("*.ged")) + list(fd.glob("*.json")):
        try:
            text += f.read_text(encoding="utf-8-sig", errors="replace") + "\n"
        except OSError:
            pass
    words = set()
    for m in re.finditer(r"^\s*\d PLAC (.+)$", text, re.M):
        words |= _words(m.group(1))
    for m in re.finditer(r'"(?:place|location|caption|address|cemetery|plac)"\s*:\s*"([^"]{3,400})"', text):
        words |= _words(m.group(1), 5)
    ex = " ".join(f.read_text(encoding="utf-8", errors="replace") for f in (ROOT / "example").glob("*")).lower()
    words = {w for w in words if w.lower() not in ex and w.lower() not in COMMON_WORDS and w not in SURNAMES}
    if baseline:  # already-public words (code, docs) aren't news; --audit skips this so earlier slips still show
        words -= _committed_words()
    return words


def _committed_words():
    """Words in tracked files as they are in the last commit (HEAD). Never the working copy or the index: a word
    being committed right now must not count as already public, or a new private word would excuse itself."""
    try:
        listing = subprocess.run(["git", "ls-tree", "-r", "--name-only", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split("\n")
    except (subprocess.CalledProcessError, OSError):
        return set()  # no commits yet: nothing is public
    paths = [f for f in listing if f and not f.endswith("package-lock.json") and not CONTENT_EXEMPT.search(f)]
    if not paths:
        return set()
    proc = subprocess.run(["git", "cat-file", "--batch"], cwd=ROOT, input="".join(f"HEAD:{f}\n" for f in paths).encode(), capture_output=True)
    out, pub, i = proc.stdout, set(), 0
    while i < len(out):
        nl = out.index(b"\n", i)
        header = out[i:nl].split()
        i = nl + 1
        if len(header) < 3 or header[1] == b"missing":
            continue
        size = int(header[2])
        pub |= _words(out[i:i + size].decode("utf-8", errors="ignore"))
        i += size + 1  # the content is followed by a newline
    return pub


def scan_text(text, where, names_re, places=None):
    problems = []
    for w in sorted(places if places is not None else PLACES):
        if re.search(r"(?<![\w@/.-])" + re.escape(w) + r"(?!\w)", text):
            problems.append(f"{where}: a specific place or detail from your private data: {w!r}")
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
PLACES = private_places()


def audit():
    """Every tracked file, with no allowance for words already in the repo."""
    places = private_places(baseline=False)
    nre = names_regex()
    problems = []
    for f in subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True).stdout.split():
        if f.endswith("package-lock.json") or CONTENT_EXEMPT.search(f):
            continue
        try:
            text = (ROOT / f).read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        problems += scan_text(text, f, nre, places)
    return problems


def main(argv):
    if "--audit" in argv:
        problems = audit()
    elif "--file" in argv:
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
