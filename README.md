# Family Tree on Cloudflare

A private, good-looking family-history site you run on your own Cloudflare account. You keep your tree in Ancestry, Gramps or anything else that exports **GEDCOM**. This project turns that export, plus your own research notes, into an interactive site:

- **Interactive tree:** pan and zoom through ancestor and descendant charts, plus a fan chart on the home page.
- **Person pages:** life timeline with historical context, family links, footnoted sources, and research findings.
- **Verification tracking:** each person is *verified*, *partly verified*, *unverified* or *disputed*, with notes.
- **Automatic data checks:** duplicates, people attached to two sets of parents, impossible ages, misfiled Ancestry events, anachronistic places, malformed dates.
- **Stories, a map of where everyone lived, a timeline, a research to-do list, and a source index.**

**Your family data never goes in this repository.** The repo holds only code and a fictional example family. Your GEDCOM and research files live in a git-ignored folder on your machine. The built data is loaded into a **Cloudflare D1** database, and photos go into **R2**. The Worker serves data only to people signed in through **Cloudflare Access**, and without Access configured it refuses.

```
site/            the web app (static; contains no family data)
worker/          Cloudflare Worker: serves /api/tree from D1, /media/* from R2, checks Access JWTs
tools/
  build.py       GEDCOM + research.json → build/family.json + build/seed.sql
  serve.py       local preview (http://localhost:8000) without Cloudflare
  merge_research.py  fold a batch of research findings into research.json
example/         a fictional family to try it out and to copy from
family-data/     ← YOUR private data (git-ignored): *.ged, research.json, places.json, media/
```

## Try it

```sh
python3 tools/build.py --data example      # builds build/ from the fictional family
python3 tools/serve.py --data example      # http://localhost:8000
```

Requires Python 3.9+ only. No pip packages.

## Use it for your family

1. Export a GEDCOM from your tree software (Ancestry: *Trees → Tree settings → Export tree*).
2. `mkdir family-data` and put the `.ged` file in it. Copy `example/research.json` and `example/places.json` alongside it and edit them: set `home_person` (your GEDCOM ID, e.g. `I123`), name your grandparent `branches`, and set the `site` title.
3. `python3 tools/build.py && python3 tools/serve.py`. The build prints places missing from the map and a summary of data problems.

`family-data/` and `build/` are git-ignored. Keep a backup of `family-data/` somewhere private (a private repo, iCloud/Drive, or R2), because it's the only copy of your research.

## Deploy to Cloudflare

You need a Cloudflare account, a domain on Cloudflare, and Node 18+.

```sh
npm install
npx wrangler login
npx wrangler d1 create family-tree            # copy the database_id into wrangler.jsonc
npx wrangler r2 bucket create family-tree-media   # optional, for photos
python3 tools/build.py
npm run db:load                                # loads build/seed.sql into D1 (full replace)
```

Then protect it with **Cloudflare Access** (Zero Trust → Access → Applications → *Self-hosted*):

1. Create an application for the hostname you'll use (e.g. `family.example.com`) and add a policy allowing your family's emails.
2. Copy the application's **Audience (AUD) tag** and your **team domain** (`<team>.cloudflareaccess.com`) into `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` in `wrangler.jsonc`.
3. Add the hostname as a custom domain for the Worker (Workers → family-tree → Settings → Domains), then run `npm run deploy`.

`workers_dev` is off, so the only way in is the Access-protected domain. Even if it were on, the Worker verifies the Access JWT itself (signature, audience, issuer, expiry) and answers **403** to anything else. The static app shell is public-safe because it contains no data.

**Updating:** re-export the GEDCOM → `python3 tools/build.py` → `npm run db:load`. The load replaces everything, and research survives because it lives in `research.json`, keyed by GEDCOM IDs (Ancestry keeps them stable across exports). If you merge two people in your tree software, move research from the vanished ID to the survivor.

**Photos:** `npx wrangler r2 object put family-tree-media/photos/grandma.jpg --file grandma.jpg --remote`, then add `"I123": [{"file": "photos/grandma.jpg", "portrait": true, "caption": "…"}]` under `media` in `research.json`. For local preview, put the same files in `family-data/media/photos/`.

**Local Worker:** `npm run db:load:local` then `npm run dev`. Create a git-ignored `.dev.vars` containing `ALLOW_UNAUTHENTICATED=true` to skip the Access check locally. Never set that in production.

## research.json

| key | what |
|---|---|
| `site` | `title`, `familyName`, `mark` (logo letter), `eyebrow`, `lede` |
| `home_person`, `core_people` | whose tree it is; the people (you, parents, siblings) who sit above the branches |
| `branches` | `[{key, root, label, tagline, color, intro, inLaw?}]`: one per grandparent line, rooted at the grandparent. `inLaw: true` for a spouse's family |
| `people_status` | `{id: {status: verified / partly-verified / unverified / disputed, note}}` |
| `findings` | `{person, kind: confirmed / correction / conflict / data-error / new-fact / new-person, field, claim, finding, confidence, sources: [{title, url, note}]}` |
| `stories` | `{slug, title, branch, era, people, body, sources}`. In `body`, paragraphs are separated by blank lines; `[[I123\|label]]` links a person, and `**bold**`, `*italic*` and `## heading` work |
| `todo` | `{person, task, where, priority: high / medium / low}` |
| `context` | historical events for timelines: `{year, month, title, text, branches?, places?}` |
| `duplicates` | `[{ids: [a, b], note}]` flags probable duplicates on each profile |
| `overrides` | display-only fixes `{id: {sex, name: {given, surname}, living}}`. Prefer fixing the tree itself |
| `place_rules` | `[{pattern, before, message}]` flags anachronistic place names |
| `methodology` | text for the Research overview |

`tools/merge_research.py batch.json` merges a batch of findings, statuses, stories and to-dos (same shape, plus `"branch"`) into `family-data/research.json`. It's handy when a research assistant, human or AI, works one branch at a time.

## places.json

The map groups raw GEDCOM place strings into canonical places using regexes: `{"key", "name", "lat", "lng", "match": ["regex", …]}`, where the first match wins. The build lists any places that didn't match.

## Privacy notes

- The site shows living people. Access is what protects them; `noindex` is just belt and braces.
- `.assetsignore` keeps a stray `site/family.json` from being uploaded as a public static file.
- GEDCOM, `family-data/`, `build/` and `.dev.vars` are git-ignored. Check `git status` before you push anyway.

## License

MIT
