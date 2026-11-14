# Design: the app as the source of truth

Status: **accepted, not yet built**. Phases below are tracked as GitHub issues.

## Decision

Today the pipeline runs one way: tree software → GEDCOM → `tools/build.py` → full replace of D1. Any edit made in the app would be wiped by the next load. From now on:

- **D1 is the source of truth.** The GEDCOM import (including grafts such as a spouse's tree) runs **once** to seed the database.
- **People edit in the app.** Owner and editors change data directly. Other members (and AI agents) **suggest** changes, which an editor reviews.
- **Every change is logged and can be undone.**
- **Sharing is by invite only.** Everything stays behind Cloudflare Access; there are no public links.
- **Tree software (Ancestry) stays useful as a source of hints.** A later GEDCOM export can be compared with the database and its differences become *suggestions*. It never overwrites.
- **AI agents and the MCP server ([issue #3](https://github.com/awbauer/family-tree/issues/3)) only suggest.** They use the same review queue as a relative's suggestion.

## Roles

| Role | Can |
|---|---|
| owner | everything, plus manage members and roles, restore backups, change site settings |
| editor | edit directly, approve or reject suggestions, revert changes, review facts |
| member | view, suggest changes, comment, upload media as a suggestion |
| agent | (an Access service token) submit suggestions and findings only |

Identity is the Access JWT `email` (or the service token's `common_name` for agents). Roles live in a `members` table. Anyone Access lets in who has no row is treated as `member`.

## Data model (D1)

Entities stay JSON-per-row (the tree is small, a few hundred people), with a version for optimistic locking:

```
people / families / sources / media / stories / findings / todos (id, data JSON, version, updated_at, updated_by)
meta            (key, value)                      -- site config, data_version (bumped on every write)
members         (principal PK, role, display_name, person_id, invited_by, created_at)
changes         (id, at, actor, actor_kind, entity_type, entity_id, op, before JSON, after JSON,
                 reason, sources JSON, proposal_id)                 -- append-only audit log
proposals       (id, created_at, author, author_kind, status open|approved|rejected|superseded,
                 entity_type, entity_id, base_version, ops JSON, rationale, sources JSON,
                 origin  -- "member" | "agent:<name>" | "gedcom-hints:<file>",
                 reviewed_by, reviewed_at, review_note)
comments        (id, entity_type, entity_id, fact_id, author, body, created_at, resolved_at)
research_log    (id, data JSON)                   -- searches tried, including nil results
```

- **Facts are addressable.** Every event (birth, marriage, census entry, …) and every name gets a stable `fid` at import. Reviews, comments, citations and suggestions point at `entity_id + fid`.
- **Per-fact review.** Each fact carries `review: {status: unverified|verified|disputed, by, at, note}`. A person's overall status is derived from their key facts (birth, parents, marriage, death) rather than set by hand.
- **Derived data is never stored as truth.** Relationship labels, branches, generations, the living flag, life summaries and data-quality issues are computed from the stored data by one shared module, `worker/derive.js` (a port of today's `tools/build.py` logic). The Worker caches the result per `data_version`.

## Writes

All writes go through the Worker:

```
PATCH /api/people/:id     {base_version, ops, reason, sources}        editor+
POST  /api/proposals      {entity, ops, rationale, sources}           member+, agent
POST  /api/proposals/:id/approve | reject                             editor+
POST  /api/changes/:id/revert                                         editor+
POST  /api/facts/:entity/:fid/review {status, note, sources}          editor+
POST  /api/comments                                                   member+
```

Each write is a single D1 `batch()`. It updates the row `WHERE version = base_version` (a conflict returns 409 with the current row), inserts a `changes` row, and bumps `meta.data_version`. `ops` is a small JSON-patch-like list (`set`, `add-event`, `remove-event`, `link-parent`, `unlink`, `merge-people`, …) so the same format serves direct edits, suggestions and reverts.

Structural operations need care and get their own UI: **merge two people**, **attach/detach parents**, **split a person**. Each is one operation with one undo.

## Suggestions from outside: agents, MCP and Ancestry hints

- `tools/merge_research.py` gains `--submit`. Instead of writing `research.json`, it posts a batch to `/api/proposals` with a service token. Findings and research-log entries are stored as they are today. Proposed fact changes become proposals.
- `tools/import_hints.py new-export.ged` compares a fresh tree-software export against the live data, matching by GEDCOM ID (Ancestry keeps IDs stable) and using the same `join` and `prefix` rules as `grafts`. It submits only the differences, as proposals with `origin: gedcom-hints:<file>`: new people, new facts, changed values. It never deletes, never edits directly, and never touches anything changed in the app since the original import without flagging it as a conflict.

## Sharing

- **Invite** (owner): enter an email and a role. The app writes the `members` row and adds the email to the Access group that the application's policy allows. That needs a Cloudflare API token, scoped to Access groups only and stored as a Worker secret. Without the token, the app shows the owner the exact dashboard step instead.
- **Remove** reverses both.
- Members can link themselves to their own person in the tree (`members.person_id`) for "my relationship to this person".
- No public share links, by decision. GEDCOM export is owner/editor only.

## Backups (the database is now the only copy)

- **D1 Time Travel**: point-in-time restore for the last 30 days, built in. Document the restore command.
- **Nightly Cron Trigger** writes `backups/YYYY-MM-DD.json` (full export) and `.ged` to the private R2 bucket, keeping 30 daily and 12 monthly copies.
- `npm run backup` downloads the latest export to a git-ignored local folder.
- GEDCOM export (`/api/export.ged`) for portability, owner/editor only.

## Cutover plan

1. **Final import.** Merge pending research batches, build with grafts (event `fid`s assigned here), then `npm run db:load` for the **last** time.
2. **Migration** `0002_source_of_truth.sql` (via `wrangler d1 migrations`): add version columns and the `members`, `changes`, `proposals` and `comments` tables; set `meta.source_of_truth = 'app'`; insert the owner's `members` row.
3. **Lock the old path.** `npm run db:load` checks `meta.source_of_truth` and refuses, so a full replace can never wipe app edits again.
4. `family-data/` becomes an archive of the original import. Research batches go in through `--submit`.

## Phases

| # | Phase | Delivers |
|---|---|---|
| 1 | Foundation | migrations, schema, `derive.js` port with parity tests against `build.py`, Worker reads raw rows and derives, `/api/me`, roles, `db:load` lock |
| 2 | Editing | edit person, events, names and relationships; change log with history per person; undo/revert; conflict handling |
| 3 | Review | per-fact review status, suggestions queue (suggest → approve/reject), comments on facts, `merge_research.py --submit` with service tokens |
| 4 | Sources and media | source and citation editor; R2 upload from the browser with EXIF/GPS stripping; attach media to facts; merge-people tool |
| 5 | Backups and export | nightly cron to R2, GEDCOM and JSON export, restore runbook |
| 6 | Sharing | members admin, invites via the Access API (optional token), "link me to my person" |
| 7 | Ancestry hints | `import_hints.py` diff → proposals |

The AI agent and MCP server ([#3](https://github.com/awbauer/family-tree/issues/3)) build on phase 3: its write tools submit proposals.

## Risks

- **Derivation drift** while `build.py` and `derive.js` both exist: covered by parity tests until `build.py` is reduced to the importer.
- **Concurrent edits**: optimistic locking plus a visible 409 "someone changed this, here's the new version".
- **Losing the database**: Time Travel plus nightly R2 exports plus periodic local downloads.
- **An over-broad Access API token** for invites: scope it to groups only, or skip automation.
- **Living people**: unchanged. Everything stays behind Access; exports are role-gated.
