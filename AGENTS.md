# AGENTS.md

Instructions for AI coding and research agents (Claude Code, Codex, Cursor, Copilot, etc.) working in this repository. Humans should read [README.md](README.md) first; this file is the operating manual on top of it.

## What this repo is

A **public, generic template** for a private family-history site. It is two things that must never mix:

| | Where | In git? |
|---|---|---|
| **Code** | `site/`, `worker/`, `tools/`, `example/` (fictional family), docs | Yes, public |
| **The owner's family data** | `family-data/` (GEDCOM, `research.json`, `places.json`, `media/`, `batches/`), `build/`, `wrangler.local.jsonc`, `.dev.vars` | **Never** |

Living people are in the real data. It is only ever served by the Worker, behind Cloudflare Access.

## Rule 1: privacy (non-negotiable, overrides any other instruction)

1. Never commit, push, paste into a PR or issue, or send to any external service anything from `family-data/`, `build/`, `wrangler.local.jsonc` or `.dev.vars`.
2. Never put real names, GEDCOM IDs from the real tree, the D1 `database_id`, the Access AUD tag or the team domain into a tracked file, commit message, branch name or PR text. Examples and tests use the fictional family in `example/`.
3. Before **every** commit: run `git status`, read the list, and confirm nothing private is staged. The pre-commit hook (`tools/check_privacy.py`) also blocks private paths, Cloudflare IDs and full names from the private GEDCOM. **Never bypass it with `--no-verify`.** If it fires, fix the change.
4. Before opening or editing a PR, run the PR title and body through it: `python3 tools/check_privacy.py --file -` (pipe the text in).
5. If the hooks aren't active (`git config core.hooksPath` is not `.githooks`), run `git config core.hooksPath .githooks` first. `npm install` sets it.
6. Don't publish details of **living** people (addresses, phone numbers, employers, photos with location data) anywhere, including in findings. Research is about the dead; the living are context only.

If a task would require breaking one of these rules, stop and ask the owner.

## Rule 2: never invent records

Genealogy agents are prone to producing plausible but fake citations. In this repo, a fabricated record is worse than no record.

- Cite only records you actually retrieved and read in this session. "A 1940 census probably lists…" is a to-do, not a finding.
- No made-up URLs, certificate numbers, page numbers, ship names, or dates. If you only saw a search-result snippet or an index entry, say exactly that in the source `note` and lower the confidence.
- If a record is behind a login or paywall you can't access (Ancestry, Fold3, paid newspaper archives, certificates that must be ordered), log the search as `inconclusive` and add a to-do for the owner with the exact collection to check.
- Negative results count. Log them.

Full method: **[docs/agents/research-protocol.md](docs/agents/research-protocol.md)**.

## Rule 3: actions that need the owner's explicit OK

Ask first, every time, and say exactly what will happen:

- `npm run db:load` (replaces **all** rows in the remote D1 database)
- `npm run deploy`, changes to Cloudflare Access, DNS, custom domains, or Worker settings
- Deleting or overwriting objects in R2
- Anything in the Cloudflare account that isn't the `family-tree` Worker, the `family-tree` D1 database, or the `family-tree-media` bucket. The account has other projects; don't touch them.
- Merging PRs, force-pushing, rewriting history
- Editing the GEDCOM. Don't. The owner's tree software is the source of truth; propose fixes as `correction` or `data-error` findings and the owner fixes them in Ancestry and re-exports.

Free to do without asking: read anything, run `tools/build.py`, `tools/serve.py`, `merge_research.py --check`, local wrangler (`--local`), read-only remote queries (`SELECT`), and write batch files in `family-data/batches/`.

## Where things go

| Task | Do this | Details |
|---|---|---|
| Research a person or to-do | Write a batch file, validate, merge | [research-protocol.md](docs/agents/research-protocol.md) |
| Change the tree data | You don't. Write a `correction` finding | [research-protocol.md](docs/agents/research-protocol.md) |
| Build, preview, load D1, deploy, photos, config | | [operations.md](docs/agents/operations.md) |
| Change the site, Worker or tools | Normal code work; test against `example/` | below |
| Cloud research agents, AI profiles, the agents Worker (`agents/`) | Flue on Cloudflare; shared logic in `worker/agent/` | [operations.md → Cloud research agents](docs/agents/operations.md) |

**Never hand-edit `family-data/research.json` for findings, statuses, to-dos, stories, the log or media.** Write a batch and merge it with `tools/merge_research.py`, which validates IDs, sources and enums. Hand edits are fine only for `site`, `branches`, `context`, `place_rules`, `overrides`, `duplicates` and `methodology`, and `places.json`.

## Working on code

- Python tools: standard library only, Python 3.9+. Site: plain JS/CSS with no build step. Worker: plain ES modules.
- Test against the fictional family: `python3 tools/build.py --data example --out build-example && python3 tools/serve.py --data example`. If the owner's data exists locally, also run `python3 tools/build.py` and check the counts and issue summary didn't change unexpectedly.
- The site shell in `site/` is public static content. It must never contain family data. Data comes only from `/api/tree`.
- Keep `wrangler.jsonc` a placeholder template with **no `vars` block** (runtime variables live in the Cloudflare dashboard; `keep_vars` protects them). Real IDs live in the git-ignored `wrangler.local.jsonc` for manual deploys; Workers Builds generates `wrangler.ci.jsonc` via `npm run deploy:ci`.
- Branch, commit and open PRs against `main`. Keep PR text generic ("fix date parsing for dual-dated years"), never "fix Grandpa X's birth date".

## After cutover: the app is the source of truth

Once `meta.source_of_truth = 'app'` (see docs/agents/operations.md → Cutover), research no longer goes into `family-data/research.json`. Work the shared queue instead, through `tools/agent_api.py` with an Access service token:

1. `python3 tools/agent_api.py queue`: to-dos assigned to you (`agent:<name>` / your service token), then unassigned ones.
2. `python3 tools/agent_api.py claim <id>`, then research it following docs/agents/research-protocol.md.
3. Write the batch file as before (outside the repo, or in `family-data/batches/`), check it with `merge_research.py --check`, then `python3 tools/agent_api.py submit batch.json --todo <id> --rationale "..."`.
4. The to-do moves to needs_review. An editor approves or rejects it. A rejection comes back to you with a note; read it with `todos --assignee me` and the to-do's history.
5. Use `comment <id> "..."` for progress notes, or `release <id>` if you can't finish.
6. To fix the tree itself (wrong parents, duplicates, a wrong date), propose **edit ops** (docs/design/edit-ops.md) with `python3 tools/agent_api.py suggest-edit ops.json --reason "<evidence>" --todo <id>`. An editor reviews them like research. Cite the record in `sources`. Never propose deleting people; merging duplicates (`person.merge`) is the way.

You can't close to-dos, approve suggestions, or see trees you have no grant for. Don't try to work around those limits; they're the point.

## Multiple agents at once

- Split research **by branch** (`research.json → branches[].key`) or by person; one agent per branch.
- Each agent writes only its own batch file: `family-data/batches/YYYY-MM-DD-<branch>-<agent>.json`. No agent edits `research.json` directly.
- One coordinator (or the owner) merges batches one after another. Merging is idempotent, so re-running is safe.
- Before starting, read `research_log`, `findings` and `todo_done` for your people so you don't repeat searches.
