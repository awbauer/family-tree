# Operations: build, load, deploy, photos

Everything here runs from the repo root. Commands marked **⚠ ask** change shared state, so get the owner's explicit OK first.

## One-time setup (per machine)

```sh
npm install                       # installs wrangler and enables the privacy git hooks
npx wrangler login
npx wrangler whoami               # confirm the right Cloudflare account
cp wrangler.jsonc wrangler.local.jsonc
```

Fill in `wrangler.local.jsonc` (git-ignored) with the `database_id` from `npx wrangler d1 list`. Don't add a `vars` block: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and `OWNER_EMAIL` are set in the dashboard (see Automatic deploys), and local development reads `.dev.vars`. Every npm script passes `-c wrangler.local.jsonc`; running bare `npx wrangler …` without `-c` uses the placeholder template and will fail or hit the wrong thing.

Why a separate file: the tracked `wrangler.jsonc` stays a clean template for anyone who forks the repo. Strictly speaking a D1 ID and an AUD tag aren't secrets (they're useless without your Cloudflare credentials or an Access login), but they identify your account and don't belong in a public template.

## Data pipeline

```
family-data/*.ged  ─┐
research.json      ─┼─ tools/build.py ─▶ build/family.json  (local preview)
places.json        ─┘                 └▶ build/seed.sql   ─▶ D1 (npm run db:load)
```

| Step | Command | Notes |
|---|---|---|
| Build | `python3 tools/build.py` | Prints counts, unmatched places and a data-issue summary. Compare with the last build; a big drop in people means a bad export. |
| Local preview | `python3 tools/serve.py` → http://localhost:8000 | No Cloudflare needed. |
| Local Worker | `npm run db:load:local && npm run dev` | Needs `.dev.vars` with `ALLOW_UNAUTHENTICATED=true` (local only, never production). |
| Load remote D1 **⚠ ask** | `npm run db:load` | Full replace of every table. Run `npm run db:counts` afterwards and compare with the build output. |
| Deploy Worker **⚠ ask** | `npm run deploy` | Only after Access is configured (otherwise the Worker refuses every request, which is safe but useless). |

After a new GEDCOM export: replace the `.ged` in `family-data/`, build, check whether any IDs that have research disappeared (people merged in the tree software; move their research to the surviving ID via a batch), then load.

## Cloudflare Access (one time, owner does it or approves each step)

1. Zero Trust → Access → Applications → Add → Self-hosted. Hostname: the custom domain for the site.
2. Policy: allow the family's email addresses (or an email list). Prefer one-time PIN or a social login.
3. Copy the **Application Audience (AUD) tag** and the **team domain** into `wrangler.local.jsonc`.
4. Workers → family-tree → Settings → Domains: add the same hostname. `workers_dev` stays `false`.
5. Deploy, then test: signed out → Access login page; signed in → site loads; `curl https://<host>/api/tree` without a cookie → redirected or 403.

## Deployment considerations: how the Worker checks Access

**Current design (deliberate):** the Worker verifies the Access JWT itself in `worker/index.js` (`authorize()`). It reads `Cf-Access-Jwt-Assertion` (falling back to the `CF_Authorization` cookie), checks the RS256 signature against `https://<team>/cdn-cgi/access/certs`, and checks audience, issuer, expiry and not-before. If `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is unset, every `/api/*` and `/media/*` request gets a 403. It fails closed, so a forgotten route or a misconfigured policy publishes nothing.

**Why not `ctx.access`?** Since August 2026, Workers protected by Access receive `ctx.access` (and `ctx.access.getIdentity()`), which removes the need to parse JWTs. It doesn't work here as built: this Worker serves `site/` as **Static Assets**, and Cloudflare documents that Workers with Static Assets run behind an internal router that **does not pass `ctx.access` to the user Worker**. Switching to it without other changes would make `ctx.access` always `undefined` and lock everyone out. See [ctx.access limitations](https://developers.cloudflare.com/workers/configuration/cloudflare-access/#ctxaccess-limitations).

If you ever move off Static Assets (for example, the Worker serves the three `site/` files itself), you can replace `authorize()` with "no `ctx.access` → 403, and `ctx.access.aud` must equal `ACCESS_AUD`", drop the JWKS code and `ACCESS_TEAM_DOMAIN`, and use Wrangler's `access.dev` block for local testing instead of `ALLOW_UNAUTHENTICATED`.

**Which Access setup:**

- **Worker-level Access** (Workers & Pages → family-tree → **Access**, available since August 2026) attaches the policy to the Worker, so every route, custom domain, `workers.dev` and preview URL is covered, including ones added later. This is the better default. Use that application's AUD tag for `ACCESS_AUD`.
- **Hostname-based Access** (Zero Trust → Access → Applications → Self-hosted) protects only the hostnames you list. Use it if you need WebSockets: Worker-level policies currently reject WebSocket upgrades with 403, which matters if you later add a live agent chat to the site.
- Either way, keep the JWT check in the Worker. Access at the edge is the gate, and the Worker's own check is defense in depth that fails closed.

## Automatic deploys from GitHub (Workers Builds)

Cloudflare builds and deploys the Worker on every push to `main`; no GitHub Actions. The repo holds no account IDs, so the build generates its config: `npm run deploy:ci` runs `tools/ci_config.mjs`, which writes `wrangler.ci.jsonc` (git-ignored) from the `wrangler.jsonc` template with your D1 id. It never includes `vars` and always sets `keep_vars`, so **variables you set in the dashboard survive every deploy**. Secrets are never touched by deploys either way.

One-time setup in the dashboard (owner):

1. **Workers & Pages → family-tree → Settings → Variables and Secrets.** Set `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `OWNER_EMAIL` (text), plus `CF_ACCOUNT_ID` and `ACCESS_GROUP_ID` and the `CF_API_TOKEN` secret if you want automatic invites. These are the runtime values; they don't go in any file.
2. **Settings → Builds → Connect.** Pick GitHub, install the Cloudflare app on the `family-tree` repo only, and choose branch `main`.
   - Build command: *(empty)*
   - Deploy command: `npm run deploy:ci`
   - Root directory: `/`
   - **Build variables:** `D1_DATABASE_ID` = the id from `npx wrangler d1 list`
3. **Non-production branches:** turn branch builds off. If you want them, set the command to `npm run upload:ci`; version URLs stay off (`preview_urls: false`), and the Worker still checks Access.

Things to know:

- **Schema migrations are not applied by the build.** Before merging code that needs a new file in `migrations/`, run `npm run db:migrate` ⚠ ask. Otherwise the new code deploys against the old schema.
- **The build deploys `main` as-is.** Merging is deploying, so review PRs accordingly.
- **Never add a `vars` block** to `wrangler.jsonc` or `wrangler.local.jsonc`; listed variables overwrite dashboard values on deploy. Local development uses `.dev.vars`.
- Manual deploys (`npm run deploy`) use `wrangler.local.jsonc`, which also has `keep_vars` and no vars, so they're safe too.

## Cutover: the app becomes the source of truth (one time)

After this, nobody edits the GEDCOM-and-rebuild pipeline any more; changes happen in the app or arrive as suggestions.

```sh
python3 tools/build.py --raw-out build/raw.json          # final import: grafts + edits applied
python3 tools/seed_app.py --owner you@example.com --assign-open-to owner --cutover
npm run db:migrate                                        # migrations/0001_app_schema.sql (replaces the legacy tables)  ⚠ ask
npm run db:import                                         # loads build/seed-app.sql; the guard refuses once cut over  ⚠ ask
npm run deploy                                            # the Worker that reads raw rows and derives  ⚠ ask
```

Set `OWNER_EMAIL` (and the Access values) in the dashboard under Variables and Secrets before deploying; they are not kept in any config file. Trees come from `research.json → "trees"`. After `--cutover`, `npm run db:load` and `npm run db:import` refuse (`tools/guard_load.py`), so a full replace can't wipe app edits.

Test the whole thing locally first: put `ALLOW_UNAUTHENTICATED=true` and `DEV_PRINCIPAL=you@example.com` in `.dev.vars`, then run `npm run db:migrate:local && npm run db:import:local && npm run dev`. Local D1 lives in `.wrangler/`, so delete `.wrangler/state` to start over.

## Who can see what (trees, views, grants)

Owners (`OWNER_EMAIL`, or `members.is_owner`) see every tree. Everyone else needs a **grant**: principal + tree + role (`editor`, `member` or `agent`) + optional **view** (a filter: living people `full`/`names-only`/`anonymous`/`hidden`, branch subset, generation limit, research/notes/media/sources on or off). No grant means no data. The admin UI is phase 6 (#9). Until then, use the API as the owner:

```sh
curl -X PUT $SITE/api/admin/views/cousins  -d '{"name":"Cousins","filter":{"living":"names-only","research":false}}'
curl -X PUT $SITE/api/admin/grants         -d '{"principal":"cousin@example.com","tree_id":"spouse","role":"member","view_id":"cousins"}'
curl -X PUT $SITE/api/admin/members/agent%3Aresearch -d '{"kind":"agent","display_name":"Research agent"}'
```

The person must also be allowed through the Access policy. A grant without Access gets nothing, and Access without a grant gets an empty "no trees shared with you" page.

## Editing, history and undo

Editors edit people and families on each person's page (facts, names, parents, spouses, children, photos, merging duplicates, reviewing facts). Every save needs a reason, is recorded in `changes` with before and after snapshots, and can be undone from the page's History. An undo is refused if later changes touched the same records; undo those first. Members and agents see "Suggest a change": the same tools, but the result goes to Research → Suggestions for an editor. All of these use one op format (docs/design/edit-ops.md).

Photos and documents uploaded in the app go to R2 under `uploads/`, after the browser strips location and camera data from images. They're only served once attached to someone the viewer can see.

## Invites

Granting someone a tree on the **Sharing** page (owner only) also needs them allowed through Cloudflare Access. To have the app do that automatically, create an API token with only *Access: Organizations, Identity Providers, and Groups: Edit*, make an Access group used by the app's policy, then:

```sh
npx wrangler secret put CF_API_TOKEN -c wrangler.local.jsonc     # ⚠ ask
```

and set `CF_ACCOUNT_ID` and `ACCESS_GROUP_ID` as variables in the dashboard. Without them, the app tells you the manual step after each grant.

## Export

- **GEDCOM** (editors and owner): Research → "Download GEDCOM" exports exactly what you can see, with living people as your view shows them.
- **JSON** (owner): everything, in the `family-tree-export/1` format that `tools/import_hints.py` reads.

## Ancestry hints (after cutover)

When you've added things in Ancestry, export a fresh GEDCOM and run:

```sh
python3 tools/import_hints.py new-export.ged --dry-run hints.json   # look first
python3 tools/import_hints.py new-export.ged --submit               # ⚠ ask: sends suggestions to the review queue
```

It applies the same `grafts` and `edits` as the original import. It suggests only additions (new people, facts, names, citations, sources) and flags conflicting dates or places as CONFLICT. It never deletes. Already-submitted suggestions are remembered in `family-data/hints-ledger.json`.

## To-dos and the review queue

To-dos live in D1 (`/api/todos`). Each has a priority, a status (`open → in_progress → needs_review → done` or `wont_do`), an assignee (a person's email, or `agent:<name>` / `service:<token>`), an outcome and a history. Anyone with a grant can add to-dos and take unassigned ones. Editors assign, close and edit them. Agents can't close their own work: submitting research moves the to-do to **needs_review**, and an editor approves the suggestion (Research → Suggestions). Approving applies the findings, log, statuses and new to-dos and closes the to-do. Rejecting sends it back to the assignee.

## Restore (D1 Time Travel)

D1 keeps point-in-time recovery automatically: 30 days on Workers Paid, 7 on Free. There is no other copy.

```sh
npx wrangler d1 time-travel info family-tree -c wrangler.local.jsonc                       # current bookmark
npx wrangler d1 time-travel restore family-tree -c wrangler.local.jsonc --timestamp <ISO>   # ⚠ ask
```

Every write is also recorded in the `changes` table (who, when, before and after), so a single bad change can be traced and undone without restoring the whole database.

## Photos (R2)

1. **Strip metadata first.** Phone photos carry GPS coordinates (a living relative's home). Use `exiftool -all= file.jpg` or `sips` re-export on macOS, and check with `exiftool file.jpg`.
2. Name objects `photos/<surname>-<given>-<year-or-subject>.jpg` (lowercase, hyphens). The bucket is private; keys are only visible to signed-in viewers.
3. Upload **⚠ ask** (first time per batch): `npx wrangler r2 object put family-tree-media/photos/<name>.jpg --file <path> --remote -c wrangler.local.jsonc`
4. Copy the same file to `family-data/media/photos/` for local preview.
5. Wire it up through a batch's `media` key: `{"media": {"<ID>": [{"file": "photos/<name>.jpg", "portrait": true, "caption": "…", "date": "c. 1925", "source": "Family collection, held by …"}]}}`. Then merge, build and load.

Photos of living people: only with their consent, and only if the owner says so.

## Your local files

Until cutover, `family-data/` is the only copy of the import inputs and research. Before any bulk change, copy it somewhere private, never into this repo.

## Checks before any commit or PR

```sh
git status                                     # read it
python3 tools/check_privacy.py                 # also runs automatically as a pre-commit hook
echo "$PR_BODY" | python3 tools/check_privacy.py --file -
```
