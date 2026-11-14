#!/usr/bin/env python3
"""Save a private copy of every source cited in research.json, in case the web page or image goes offline.

    python3 tools/archive_sources.py              # archive anything not yet archived
    python3 tools/archive_sources.py --refresh    # re-download everything
    python3 tools/archive_sources.py --list       # show what's archived / failed, download nothing

Writes to family-data/evidence/ (git-ignored, like the rest of family-data/):
  evidence/<host>/<slug>-<hash>.<ext>    the file as served (image, PDF, or HTML page)
  evidence/index.json                    manifest: url -> {file, sha256, bytes, type, fetched, status, cited_by}

What it fetches:
  - direct images and PDFs (e.g. 1950 census IIIF images) are saved as-is
  - archive.org /details/ pages: the item's original files (PDF/images) via archive.org's metadata API
  - other web pages: the HTML, plus the page's main image (og:image) when it has one
  - search-results pages are skipped: they're not evidence and their contents change
IIIF image citations (e.g. the 1950 census) also get the full page, not just the cited region.
archive.org scans cited with a page number ("image n477") get that page only, not the whole microfilm roll.
Sites that block automated downloads (some genealogy sites do) are recorded as "blocked" with the HTTP status;
they are not worked around.
Save those by hand (browser: Save Page / Print to PDF) into the same folder and run with --list to see what's missing.

It sends only plain GET requests for URLs you've already cited, with a generic User-Agent and no personal data.
"""
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESEARCH = Path(os.environ.get("RESEARCH", ROOT / "family-data" / "research.json"))
OUT = Path(os.environ.get("EVIDENCE_DIR", RESEARCH.parent / "evidence"))
UA = "Mozilla/5.0 (compatible; family-tree-archiver/1.0; private research archive)"
SEARCH_PAGE = re.compile(r"/search(\?|/|$)|[?&](q|query|firstname|lastname)=|/search/collection/", re.I)
MAX_BYTES = 80 * 1024 * 1024


NOTES = {}


def cited_urls(r):
    urls = {}
    for i, f in enumerate(r.get("findings", [])):
        for s in f.get("sources", []):
            if s.get("url"):
                urls.setdefault(s["url"], []).append(f"finding:{i}:{f.get('person', '')}")
                NOTES.setdefault(s["url"], []).append(f"{s.get('title', '')} {s.get('note', '')}")
    for st in r.get("stories", []):
        for s in st.get("sources", []):
            if s.get("url"):
                urls.setdefault(s["url"], []).append(f"story:{st.get('slug', '')}")
    return urls


def iri_to_uri(url):
    parts = urllib.parse.urlsplit(url)
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc.encode("idna").decode() if parts.netloc else "",
                                    urllib.parse.quote(parts.path, safe="/%:@!$&'()*+,;=~"),
                                    urllib.parse.quote(parts.query, safe="=&%+/:?@!$'()*,;~"), parts.fragment))


def fetch(url):
    url = iri_to_uri(url)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=90) as res:
        data = res.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise ValueError(f"larger than {MAX_BYTES // 1024 // 1024} MB")
        return data, res.headers.get_content_type(), res.geturl()


def ext_for(ctype, url):
    known = {"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp",
             "image/tiff": ".tif", "application/pdf": ".pdf", "text/html": ".html", "application/json": ".json",
             "text/plain": ".txt"}
    if ctype in known:
        return known[ctype]
    m = re.search(r"\.(jpe?g|png|gif|pdf|tiff?|webp)(?:$|[/?])", url, re.I)
    return "." + m.group(1).lower() if m else ".bin"


def save(url, data, ctype, note=""):
    host = urllib.parse.urlparse(url).netloc.replace("www.", "")
    path = urllib.parse.unquote(urllib.parse.urlparse(url).path)
    slug = re.sub(r"[^A-Za-z0-9]+", "-", path).strip("-")[-60:] or "index"
    name = f"{slug}-{hashlib.sha1(url.encode()).hexdigest()[:8]}{ext_for(ctype, url)}"
    dest = OUT / host / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return {"file": str(dest.relative_to(OUT)), "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data),
            "type": ctype, "note": note}


def archive_org(url):
    m = re.search(r"archive\.org/details/([^/?#]+)", url)
    ident = m.group(1)
    meta = json.loads(fetch(f"https://archive.org/metadata/{ident}")[0])
    saved = []
    pages = {int(n) for t in NOTES.get(url, []) for n in re.findall(r"\bn(\d{1,5})\b", t)}
    for t in NOTES.get(url, []):  # "PDF page 567" is 1-based; archive.org's n-index is 0-based, so keep both to be safe
        for n in re.findall(r"PDF page (\d{1,5})", t):
            pages |= {int(n) - 1, int(n)}
    pages = sorted(pages)
    if pages:  # a page inside a big scanned volume or microfilm roll: save just the cited pages
        for n in pages:
            purl = f"https://archive.org/download/{ident}/page/n{n}.jpg"
            data, ctype, _ = fetch(purl)
            saved.append(save(purl, data, ctype, note=f"archive.org item {ident}, page image n{n}"))
            time.sleep(1)
        return saved
    files = [f for f in meta.get("files", []) if f.get("source") == "original"
             and re.search(r"\.(pdf|jpe?g|png|tiff?)$", f.get("name", ""), re.I)
             and int(f.get("size") or 0) <= MAX_BYTES]
    if not files:  # a dataset (e.g. an index as SQL/CSV): keep the item metadata; the finding records the row
        saved.append(save(f"https://archive.org/metadata/{ident}", json.dumps(meta, indent=1).encode(), "application/json",
                          note="dataset item: metadata only; the cited row is transcribed in the finding"))
        return saved
    for f in files[:20]:
        furl = f"https://archive.org/download/{ident}/{urllib.parse.quote(f['name'])}"
        data, ctype, _ = fetch(furl)
        saved.append(save(furl, data, ctype, note=f"archive.org item {ident}: {f['name']}"))
        time.sleep(1)
    return saved


def iiif_full(url):
    m = re.match(r"(https?://[^?#]*/iiif/2/[^/]+\.(?:jpe?g|tiff?|png|jp2))/", url, re.I)
    return f"{m.group(1)}/full/full/0/default.jpg" if m else None


def og_image(html, base):
    m = re.search(r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)', html, re.I) or \
        re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image', html, re.I)
    return urllib.parse.urljoin(base, m.group(1)) if m else None


def main(argv):
    r = json.loads(RESEARCH.read_text())
    OUT.mkdir(parents=True, exist_ok=True)
    idx_path = OUT / "index.json"
    index = json.loads(idx_path.read_text()) if idx_path.exists() else {}
    urls = cited_urls(r)
    if "--list" in argv:
        for u in urls:
            e = index.get(u, {})
            print(f"{e.get('status', 'missing'):9} {u}")
        return
    refresh = "--refresh" in argv
    counts = {}
    for url, cited in urls.items():
        prev = index.get(url, {})
        if prev.get("status") in ("saved", "skipped") and not refresh:
            prev["cited_by"] = cited
            counts["already"] = counts.get("already", 0) + 1
            continue
        entry = {"cited_by": cited, "fetched": date.today().isoformat()}
        try:
            if SEARCH_PAGE.search(url):
                entry.update(status="skipped", reason="search-results page, not a record")
            elif iiif_full(url):
                full = iiif_full(url)
                data, ctype, _ = fetch(full)
                files = [save(full, data, ctype, note="full page image")]
                if full != url and not url.endswith("info.json"):
                    data, ctype, _ = fetch(url)
                    files.append(save(url, data, ctype, note="the cited region"))
                entry.update(status="saved", files=files)
            elif "archive.org/details/" in url:
                entry.update(status="saved", files=archive_org(url))
            else:
                data, ctype, final = fetch(url)
                files = [save(url, data, ctype)]
                if ctype == "text/html":
                    img = og_image(data.decode("utf-8", "replace"), final)
                    if img:
                        try:
                            idata, ictype, _ = fetch(img)
                            if ictype.startswith("image/"):
                                files.append(save(img, idata, ictype, note="page's main image (og:image)"))
                        except Exception as e:  # noqa: BLE001
                            entry["image_error"] = str(e)[:120]
                entry.update(status="saved", files=files, final_url=final)
        except urllib.error.HTTPError as e:
            entry.update(status="blocked" if e.code in (401, 403, 429) else "failed", reason=f"HTTP {e.code}")
        except Exception as e:  # noqa: BLE001
            entry.update(status="failed", reason=str(e)[:200])
        index[url] = entry
        counts[entry["status"]] = counts.get(entry["status"], 0) + 1
        print(f"{entry['status']:8} {url}" + (f"  ({entry.get('reason')})" if entry.get("reason") else ""))
        idx_path.write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n")
        time.sleep(1)
    idx_path.write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n")
    print("Summary:", counts)


if __name__ == "__main__":
    main(sys.argv[1:])
