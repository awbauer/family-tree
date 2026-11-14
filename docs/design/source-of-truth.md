# Design: the app as the source of truth

Status: **phase 1 (foundation) built**, plus to-dos with assignees and the research-suggestion queue; cutover not yet run. Phases below are tracked as GitHub issues.

## Decision

Today the pipeline runs one way: tree software → GEDCOM → `tools/build.py` → full replace of D1. Any edit made in the app would be wiped by the next load. From now on:

- **D1 is the source of truth.** The GEDCOM import (including grafts such as a spouse's tree) runs **once** to seed the database.
- **People edit in the app.** Owner and editors change data directly. Other members (and AI agents) **suggest** changes, which an editor reviews.
- **Every change is logged and can be undone.**
- **Sharing is by invite only, per tree.** Everything stays behind Cloudflare Access; there are no public links. Each person invited is granted specific trees, optionally through an admin-defined filtered view.
- **Tree software (Ancestry) stays useful as a source of hints.** A later GEDCOM export can be compared with the database and its differences become *suggestions*. It never overwrites.
- **AI agents and the MCP server ([issue #3](https://github.com/awbauer/family-tree/issues/3)) only suggest.** They use the same review queue as a relative's suggestion.

## Trees, grants and views (who sees what)

One database can hold several **trees**: for example your family and your spouse's family, joined at the couple. Access is granted **per tree**, and the owner can narrow any grant with a **view**.

- **Tree**: a named scope defined by the owner as a set of branch keys plus explicit `include` / `exclude` person IDs. Example: "My spouse's family" = branch `spouse-side` + include the couple and their children. Trees may overlap, and a person in two trees is visible through either.
- **Grant**: `(principal, tree, role, view?)`. A principal can hold different roles on different trees (editor on one, member on another, nothing on a third). **No grant, no data**: signing in through Access only proves who you are; without a grant the app shows nothing.
- **View**: a filter the owner defines once and attaches to grants:

  | option | effect |
  |---|---|
  | `living` | `full` · `names-only` (shown as "Living [surname]", no dates, places or media) · `hidden` |
  | `branches` | subset of the tree's branches |
  | `max_generations` | depth limit from the tree's root |
  | `research` | show or hide findings, to-dos, research log and verification notes |
  | `notes`, `media`, `sources` | show or hide each |
  | `exclude_people` | specific people never shown |

- **Roles per grant:**

  | Role | Can (within the granted tree) |
  |---|---|
  | owner | global: everything, plus define trees and views, manage grants, restore backups, change site settings |
  | editor | edit people in this tree directly, approve or reject suggestions about them, revert changes, review facts |
  | member | view (through the view), suggest changes, comment, upload media as a suggestion |
  | agent | (an Access service token) submit suggestions and findings for people in its granted trees |

**Enforcement is server-side and happens before anything leaves the Worker.** The Worker derives the full tree, then applies `scope(grant)` and returns only the result:

- People outside the scope are dropped. Families and links that point at them are cut.
- `names-only` people are replaced by placeholder records.
- Findings, stories, to-dos, sources and media are dropped if they reference out-of-scope people. Story links to hidden people are unlinked.
- Data-quality issues are regenerated for the scoped tree (their messages embed names).
- Relationship labels are computed relative to the viewer's own person (`members.person_id`) or the tree's root, never relative to the owner.
- `/media/<key>` serves only keys attached to a visible person, fact or source.
- Writes and suggestions are checked against the same scope: you can only edit or suggest for people you can see with the right role.
- The scoped bundle is cached per `(data_version, tree, view)`.

Identity is the Access JWT `email` (or the service token's `common_name` for agents).

## Data model (D1)

Entities stay JSON-per-row (the tree is small, a few hundred people), with a version for optimistic locking:

```
people / families / sources / media / stories / findings / todos (id, data JSON, version, updated_at, updated_by)
meta            (key, value)                      -- site config, data_version (bumped on every write)
members         (principal PK, display_name, person_id, is_owner, invited_by, created_at)
trees           (id, name, root_person, branches JSON, include JSON, exclude JSON)
views           (id, name, filter JSON)
grants          (principal, tree_id, role editor|member|agent, view_id NULL, granted_by, created_at)
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

- **Invite** (owner): enter an email, then pick one or more trees, a role for each, and optionally a view. The app writes the `members` and `grants` rows and adds the email to the Access group that the application's policy allows. That needs a Cloudflare API token, scoped to Access groups only and stored as a Worker secret. Without the token, the app shows the owner the exact dashboard step instead.
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

## To-dos and the work queue (added during phase 1)

To-dos are first-class rows (`todos`, with history in `todo_events`): priority, status (`open`, `in_progress`, `needs_review`, `done`, `wont_do`), assignee (an email or an agent principal), outcome. People and agents share one queue. Agents claim work, submit research as a proposal linked to the to-do, and the to-do waits in `needs_review` until an editor approves (closes it) or rejects (sends it back). See `GET /api/queue`, `POST /api/todos/:id/claim` and `tools/agent_api.py`.

## Phases

| # | Phase | Delivers |
|---|---|---|
| 1 | Foundation | migrations, schema, `derive.js` port with parity tests against `build.py`, Worker reads raw rows and derives, **per-tree grants and views enforced server-side**, `/api/me`, `db:load` lock |
| 2 | Editing | edit person, events, names and relationships; change log with history per person; undo/revert; conflict handling |
| 3 | Review | per-fact review status, suggestions queue (suggest → approve/reject), comments on facts, `merge_research.py --submit` with service tokens |
| 4 | Sources and media | source and citation editor; R2 upload from the browser with EXIF/GPS stripping; attach media to facts; merge-people tool |
| 5 | Backups and export | nightly cron to R2, GEDCOM and JSON export, restore runbook |
| 6 | Sharing | admin UI for trees, views and grants; invites via the Access API (optional token); "link me to my person"; tree switcher |
| 7 | Ancestry hints | `import_hints.py` diff → proposals |

The AI agent and MCP server ([#3](https://github.com/awbauer/family-tree/issues/3)) build on phase 3: its write tools submit proposals.

## Risks

- **Derivation drift** while `build.py` and `derive.js` both exist: covered by parity tests until `build.py` is reduced to the importer.
- **Concurrent edits**: optimistic locking plus a visible 409 "someone changed this, here's the new version".
- **Losing the database**: Time Travel plus nightly R2 exports plus periodic local downloads.
- **An over-broad Access API token** for invites: scope it to groups only, or skip automation.
- **Living people**: everything stays behind Access, views can reduce living people to names-only or hide them, and exports are role-gated and scoped.
- **Scope leaks** (the biggest new risk): derived text such as issue messages, relationship labels and story bodies can mention people outside a viewer's scope. Filtering happens after derivation, on the final payload, and phase 1 includes leak tests: build a scoped bundle and assert that no out-of-scope person ID or name appears anywhere in the JSON.
