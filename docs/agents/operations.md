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

Cloudflare builds and deploys the Worker on every push to `main`; no GitHub Actions. **Status: connected** (trigger on `main` only, build command empty, deploy command `npm run deploy:ci`, `D1_DATABASE_ID` build variable set). Check builds in Workers & Pages → family-tree → Deployments. The repo holds no account IDs, so the build generates its config: `npm run deploy:ci` runs `tools/ci_config.mjs`, which writes `wrangler.ci.jsonc` (git-ignored) from the `wrangler.jsonc` template with your D1 id. It never includes `vars` and always sets `keep_vars`, so **variables you set in the dashboard survive every deploy**. Secrets are never touched by deploys either way.

One-time setup in the dashboard (owner):

1. **Workers & Pages → family-tree → Settings → Variables and Secrets.** Set `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `OWNER_EMAIL` (text), plus `CF_ACCOUNT_ID` and `ACCESS_GROUP_ID` and the `CF_API_TOKEN` secret if you want automatic invites. These are the runtime values; they don't go in any file.
2. **Settings → Builds → Connect.** Pick GitHub, install the Cloudflare app on the `family-tree` repo only, and choose branch `main`.
   - Build command: *(empty)*
   - Deploy command: `npm run deploy:ci`
   - Root directory: `/`
   - **Build variables:** `D1_DATABASE_ID` = the id from `npx wrangler d1 list`
3. **Non-production branches:** turn branch builds off. If you want them, set the command to `npm run upload:ci`; version URLs stay off (`preview_urls: false`), and the Worker still checks Access.

Things to know:

- **Schema migrations are applied by a GitHub Action**, `.github/workflows/d1-migrations.yml`. It runs on any push to `main` that changes `migrations/`, or by hand from the Actions tab. Cloudflare's deploy step (`tools/wait_migrations.mjs`) waits up to 10 minutes for pending migrations to be applied, so code never goes live ahead of its schema. If the Action fails, the deploy fails too; fix it, re-run the Action, then retry the build. The Action needs three repository secrets:
  - `CLOUDFLARE_API_TOKEN`: create it under My Profile → API Tokens → Create Token → Custom, with **Account → D1 → Edit** on this account only, and nothing else.
  - `CLOUDFLARE_ACCOUNT_ID`.
  - `D1_DATABASE_ID`.

  Set them with `gh secret set NAME`, which prompts for the value. Optionally add a required reviewer to the `production` environment so every migration waits for your approval. Write migrations so the *current* code still works after they run (add columns or tables first, remove old ones in a later change); then the order of the two never matters.
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

## Cloud research agents (agents/)

Editors can hand a to-do or a person to a research agent that runs in Cloudflare, not on anyone's laptop. It reads the tree, searches and reads the web, and files its results as a **suggestion**. Nothing reaches the tree until an editor approves it, exactly as with research from people. A weekly job also keeps **AI profiles** (short biographies of people who have died) and **stories** in step with the facts.

**How it's built.** A second, private Worker, `family-tree-agents`, in `agents/`:

- **[Flue](https://flueframework.com/)** agents on its Cloudflare target. Each run is one Flue conversation: a Durable Object on Cloudflare's **Agents SDK**, with **Pi** running the loop (model turns, tool calls, retries, compaction). If the object is evicted or crashes mid-run, Flue resumes from its durable records. It never re-runs a model call or tool call whose result was already recorded.
- **The model runs on Workers AI by default.** The model is `cloudflare/<AI_MODEL>`, called through the Workers AI binding and your AI Gateway. The default, `@cf/moonshotai/kimi-k2.6`, is a strong tool-using model hosted on Workers AI. It's billed to your Workers plan, with a daily free allocation, and needs no AI Gateway credits or provider key.
  - To use Claude, set `AI_MODEL=anthropic/claude-opus-5-5` and load AI Gateway credits, or store an Anthropic key on the gateway.
  - With a zero credit balance, gateway models fail with error 2002, "Model execution failed".
- **Cloudflare's agent tools:** `web_search` (Cloudflare Web Search API) and `web_fetch` (pages and PDFs to Markdown) from the Agents SDK.
  - Web search bills to AI Gateway credits, or to a search provider key you store on the gateway. Set its alias as `WEB_SEARCH_BYOK_ALIAS`.
  - Without either, the agent is told search is unavailable and works from record sites' own search pages through `web_fetch`, which needs neither.
- **The site's own code for everything that matters.** Scoping (`worker/bundle.js`, `worker/scope.js`), submission checks (`worker/agent/tools.js`, `worker/research.js`, the edit-ops dry run) and filing suggestions (`worker/agent/runs.js`) are the same modules the site uses, imported into the agents Worker. The Flue files (`agents/src/`) only declare tools and wiring.

**Who sees what.**

- An agent sees the tree **exactly as the editor who started the run sees it**. It re-checks that before every tool call, so revoking their grant or cancelling the run stops it.
- Living people reach the model as an id and a name only, so it can walk through the family. No dates, places, notes or events.
- Findings about living people are rejected.
- Profiles are written only for people who have died. Their facts name a living relative only as "a living son".
- The agents Worker has no public URL (`workers_dev` and preview URLs off, no routes). Only the site Worker reaches it, over a service binding. Set `AGENTS_TOKEN` as a secret on both Workers for a second check.
- AI Gateway keeps **no logs** of these requests unless `AI_GATEWAY_LOGS=true`, because prompts contain family data. Token use is still recorded in D1 (`agent_runs`, `ai_usage`). Workers Traces get spans without content.
- This does send family data (the people being researched, and their deceased relatives' facts) to Anthropic through Cloudflare. Leave the feature off if that isn't acceptable for your family.

**Budgets** (dashboard variables on the agents Worker; the first two also on the site Worker, which enforces them when starting runs):

| Variable | Default | |
|---|---|---|
| `AGENT_MAX_RUNS_PER_DAY` | 10 | research runs per day |
| `AI_DAILY_TOKEN_BUDGET` | 4,000,000 | all AI work together; tools stop when it's used up |
| `AGENT_MAX_SEARCHES` / `AGENT_MAX_FETCHES` | 25 / 40 | per run |
| `AGENT_MAX_MINUTES` | 45 | per run (Flue's durability timeout); stale runs are closed on the next read |
| `CONTENT_MAX_PER_RUN` | 50 | profiles and story checks per weekly job; for the first backfill, run it on demand a few times |

Also set a **spend limit and rate limit on the AI Gateway itself** (dashboard → AI → AI Gateway → your gateway → Settings). That is the hard stop if anything here misbehaves. Other variables: `AI_MODEL` (`@cf/moonshotai/kimi-k2.6`), `WEB_SEARCH_BYOK_ALIAS`, `AI_EFFORT` (`high`), `AI_CONTENT_EFFORT` (`medium`), `AI_GATEWAY_ID` (`default`), `WEB_SEARCH_PROVIDER` (`exa`), `CONTENT_JOB_ENABLED` (`false`).

**One-time setup (owner):**

1. **AI Gateway:** use `default` or create a gateway, and set a spend limit. Credits (or stored provider keys) are only needed for web search and for gateway models such as Claude.
2. **Deploy the agents Worker.** Workers & Pages → Create → connect the same repo again as a second Worker named `family-tree-agents`:
   - Root directory: `agents`
   - Build command: *(empty)*
   - Deploy command: `npm run deploy:ci`
   - Build variable: `D1_DATABASE_ID`
   - Install: Workers Builds runs `npm ci` in `agents/`, which has its own lockfile.
3. **Variables on `family-tree-agents`:** the budgets above if you want other values, `AI_GATEWAY_ID` if not `default`, and later `CONTENT_JOB_ENABLED=true`.
4. **Connect the site to it:** nothing to set. On each build, `tools/ci_config.mjs` checks with the Workers Builds token whether a Worker named `family-tree-agents` exists, and adds the `AGENTS` service binding if it does. A binding to a missing Worker would fail the deploy, so it's skipped until then. To choose explicitly, set the build variable `AGENTS_SERVICE` to another Worker name, or to `off`.
5. Redeploy the site (or push to `main`). Editors now see **Research with AI** on to-dos and person pages, and the **Agent runs** tab under Research.

**Using it.**

- **Start a run** from a to-do ("Research with AI"), a person page, or Research → Agent runs. A run started from a to-do assigns it to `agent:cloud`. On submission the to-do moves to `needs_review` with the suggestion linked. If the run fails or is stopped, the to-do goes back to the list with a note.
- **Watch** progress in Agent runs: status, the searches and pages it read, tokens, and the resulting suggestion. **Stop** aborts the Flue conversation.
- **Content job:** weekly, Sundays at 03:23 UTC, when `CONTENT_JOB_ENABLED=true`, or on demand (owner) with `POST /api/content/refresh`.
  - It rewrites profiles whose facts changed, direct ancestors first. Profiles are labelled as AI-written on the page, hidden from views without notes, and editors can "Rewrite now".
  - It re-checks stories whose people's facts changed. An out-of-date story becomes a **story revision** suggestion: the editor sees the reason and the revised text, and approving replaces the story (history keeps the old version).

**Developing.**

```bash
cd agents
npm install
npm run check
npm run dev
```

- `npm run check` builds against the template config. `npm run dev` runs the Worker locally in workerd, but its AI binding calls the real Cloudflare account, so model calls cost money even in development.
- The site-side logic is tested in `tests/agents.test.mjs` against the example family, with a fake agents Worker.
- Version pins, with their reasons in `agents/package.json`: Flue 2.3.0 needs Pi 1.4.x, and the Agents SDK web tools need `agents` ≥ 0.28, which Flue accepts as a project-level override. Remove the pins when Flue catches up.

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
