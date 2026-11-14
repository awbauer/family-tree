# Family Tree App

A private family-history site you run on your own Cloudflare account. You keep your tree in Ancestry, Gramps or anything else that exports **GEDCOM**. This project turns that export, plus your own research notes, into an interactive site:

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
  merge_research.py  validate + merge a research batch into research.json
  check_privacy.py   pre-commit guard against leaking family data
AGENTS.md, docs/agents/  instructions for AI agents (CLAUDE.md imports AGENTS.md)
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
npm install                                   # also enables the privacy git hooks
npx wrangler login
cp wrangler.jsonc wrangler.local.jsonc        # git-ignored; your real IDs go here, never in wrangler.jsonc
npx wrangler d1 create family-tree            # copy the database_id into wrangler.local.jsonc
npx wrangler r2 bucket create family-tree-media   # optional, for photos
python3 tools/build.py
npm run db:load                                # loads build/seed.sql into D1 (full replace)
npm run db:counts                              # check people / families / findings
```

All npm scripts pass `-c wrangler.local.jsonc`, so the tracked `wrangler.jsonc` stays a placeholder template. To deploy automatically on every push from Cloudflare (Workers Builds), see [operations.md → Automatic deploys](docs/agents/operations.md#automatic-deploys-from-github-workers-builds). Runtime variables (Access settings, owner email) are set in the dashboard and survive deploys.

Then protect it with **Cloudflare Access** (Zero Trust → Access → Applications → *Self-hosted*):

1. Create an application for the hostname you'll use (e.g. `family.example.com`) and add a policy allowing your family's emails.
2. Copy the application's **Audience (AUD) tag** and your **team domain** (`<team>.cloudflareaccess.com`) into the `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` variables in the dashboard (Workers & Pages → family-tree → Settings → Variables and Secrets). Deploys keep them (`keep_vars`).
3. Add the hostname as a custom domain for the Worker (Workers → family-tree → Settings → Domains), then run `npm run deploy`.

Prefer **Worker-level Access** (Workers & Pages → family-tree → Access), which covers every domain and preview URL the Worker has. Why the Worker still checks the JWT itself instead of using `ctx.access` is explained in [docs/agents/operations.md → Deployment considerations](docs/agents/operations.md#deployment-considerations-how-the-worker-checks-access).

`workers_dev` is off, so the only way in is the Access-protected domain. Even if it were on, the Worker verifies the Access JWT itself (signature, audience, issuer, expiry) and answers **403** to anything else. The static app shell is public-safe because it contains no data.

**Making the app the source of truth (recommended once you're happy with the import):** see [docs/agents/operations.md → Cutover](docs/agents/operations.md#cutover-the-app-becomes-the-source-of-truth-one-time). After cutover, people edit, assign to-dos and review suggestions in the app; the steps below are for the import phase only.

**Updating (import phase):** re-export the GEDCOM → `python3 tools/build.py` → `npm run db:load`. The load replaces everything, and research survives because it lives in `research.json`, keyed by GEDCOM IDs (Ancestry keeps them stable across exports). If you merge two people in your tree software, move research from the vanished ID to the survivor.

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

| `todo_done` | closed to-dos with their `outcome` (written by `merge_research.py`) |
| `research_log` | every search tried, including nil results, so nobody repeats it (written by `merge_research.py`) |

Don't hand-edit findings, statuses, to-dos or media. Write a **batch** file (see `example/batch-example.json`) and run `tools/merge_research.py --check batch.json`, then `tools/merge_research.py batch.json`. The merge checks that every person ID exists in your GEDCOM and every finding has a citation, and it's safe to re-run.

## Working with AI agents

The repo is set up for agents (Claude Code, Codex, Cursor and others) to do both code work and research:

- **[AGENTS.md](AGENTS.md)**: the rules every agent follows (privacy, no invented records, what needs your OK). `CLAUDE.md` imports it.
- **[docs/agents/research-protocol.md](docs/agents/research-protocol.md)**: how to research, weigh evidence, cite, and record results as batches.
- **[docs/agents/operations.md](docs/agents/operations.md)**: build, load, deploy, Access, photos, restore.
- **`.claude/skills/`**: `research` and `publish` skills for Claude Code. **`.claude/settings.json`** asks before remote loads, deploys and pushes.
- **`tools/check_privacy.py`** runs as a pre-commit and commit-msg hook. It blocks private paths, Cloudflare IDs, and the full name of anyone in your private GEDCOM. Run it on PR text too: `echo "$BODY" | python3 tools/check_privacy.py --file -`.

To run several research agents at once, give each one a branch. Each writes its own `family-data/batches/<date>-<branch>-<agent>.json`, and one person or agent merges them.

## places.json

The map groups raw GEDCOM place strings into canonical places using regexes: `{"key", "name", "lat", "lng", "match": ["regex", …]}`, where the first match wins. The build lists any places that didn't match.

## Privacy notes

- The site shows living people. Access is what protects them; `noindex` is just belt and braces.
- `.assetsignore` keeps a stray `site/family.json` from being uploaded as a public static file.
- GEDCOM, `family-data/`, `build/`, `wrangler.local.jsonc` and `.dev.vars` are git-ignored, and the pre-commit hook blocks them even with `git add -f`. Check `git status` before you push anyway.

## License

MIT
