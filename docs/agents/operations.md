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
| Local preview | `python3 tools/serve.py` → http://localhost:8000 (after `npm run build:web`) | No Cloudflare needed. |
| Work on the site | `npm run dev:example` and `npm run dev:web` → http://localhost:5173 | The real Worker on the fictional family; Vite reloads as you edit `web/`. |
| Site smoke tests | `npm run build:web && npm run test:e2e` | Every page in a real browser (Playwright); fails on any script error. |
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

If you ever move off Static Assets (for example, the Worker serves the built `dist/site` files itself), you can replace `authorize()` with "no `ctx.access` → 403, and `ctx.access.aud` must equal `ACCESS_AUD`", drop the JWKS code and `ACCESS_TEAM_DOMAIN`, and use Wrangler's `access.dev` block for local testing instead of `ALLOW_UNAUTHENTICATED`.

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

## Audit history

**Admin → Audit history** (owner only) lists every change in the change log, for all trees and for the sharing settings (grants, views, trees, members), newest first and grouped by the edit that made it:
- **Each row** shows when (UTC), who (and on whose behalf, for changes an agent made for someone), what kind of change and which records, and why.
- **Selecting a row** opens the detail:
  - each record's changes as a diff, plus its stored values before and after;
  - the sources cited, the suggestion or agent run it came from, and the edit id;
  - an **Undo** button for edits to the tree.
- **Filters:** by who, by kind of record, or by searching reasons, record ids and edit ids. "Load older changes" pages back.

API: `GET /api/admin/audit?before=&limit=&actor=&type=&q=` and `GET /api/admin/audit/<edit id>` (`worker/audit.js`).

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

Granting someone a tree on the **Admin** page (owner only) also needs them allowed through Cloudflare Access. To have the app do that automatically, create an API token with only *Access: Organizations, Identity Providers, and Groups: Edit*, make an Access group used by the app's policy, then:

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

**How it's built.** The agents live in `agents/` and run inside the site's own Worker: `npm run build:agents` builds them with Vite and Flue, and `worker/main.js` bundles them with the site.

- **[Flue](https://flueframework.com/)** agents on its Cloudflare target. Each run is one Flue conversation: a Durable Object on Cloudflare's **Agents SDK**, with **Pi** running the loop (model turns, tool calls, retries, compaction). If the object is evicted or crashes mid-run, Flue resumes from its durable records. It never re-runs a model call or tool call whose result was already recorded.
- **The models run on Workers AI by default.** Each agent has its own model (`AI_MODEL_<AGENT>`; defaults and reasons in [models.md](models.md)), called through the Workers AI binding and your AI Gateway. The defaults are billed to your Workers plan, with a daily free allocation, and need no AI Gateway credits or provider key.
  - To use Claude, set `AI_MODEL=anthropic/claude-opus-5-5` and load AI Gateway credits, or store an Anthropic key on the gateway.
  - With a zero credit balance, gateway models fail with error 2002, "Model execution failed".
- **Cloudflare's agent tools:** `web_search` (Cloudflare Web Search API) and `web_fetch` (pages and PDFs to Markdown) from the Agents SDK, shared by every agent that reads the web (`agents/src/web.js`), with `research_sites` for the owner's list of sites (see "Research sites" below).
  - Web search bills to AI Gateway credits, or to a search provider key you store on the gateway. Set its alias as `WEB_SEARCH_BYOK_ALIAS`.
  - Without either, the agent is told search is unavailable and works from record sites' own search pages through `web_fetch`, which needs neither.
- **The site's own code for everything that matters.** Scoping (`worker/bundle.js`, `worker/scope.js`), submission checks (`worker/agent/tools.js`, `worker/research.js`, the edit-ops dry run) and filing suggestions (`worker/agent/runs.js`) are the same modules the site uses, imported by the agents. The Flue files (`agents/src/`) only declare tools and wiring.

**Who sees what.**

- An agent sees the tree **exactly as the editor who started the run sees it**. It re-checks that before every tool call, so revoking their grant or cancelling the run stops it.
- Living relatives are researched, written about and profiled like anyone else, as far as the starter's view shows them. People that view keeps private (living people in a `names-only` or `anonymous` view) reach the model as an id and a name only: no dates, places, notes or events, no findings, edits or stories about them.
- Profiles are written for everyone with enough recorded, living relatives included. In someone else's profile, a living relative appears by name only, without dates.
- Views that reduce living people to names (or hide their names) also drop the findings, to-dos, log entries, statuses, photos, profiles and stories about them, and stories that link them (`worker/scope.js`).
- The agents have no URL of their own. Every request from outside goes to the site, which checks Access, the caller's role and the budgets, and only then calls the agents in-process (`env.AGENTS`, set up in `worker/main.js`).
- **AI Gateway logs every request, prompts and responses included.** That means the facts sent to the model are stored in the gateway's logs, which only members of your Cloudflare account can read. Logs are kept per the gateway's retention setting; set `AI_GATEWAY_LOGS=false` to stop logging. Token use is also recorded in D1 (`agent_runs`, `ai_usage`), and Workers Traces get spans without content.
- This does send family data (the people being researched, and their deceased relatives' facts) to Anthropic through Cloudflare. Leave the feature off if that isn't acceptable for your family.

**Budgets** (dashboard variables on the Worker):

| Variable | Default | |
|---|---|---|
| `AGENT_MAX_RUNS_PER_DAY` | 50 | agent runs per day |
| `AI_DAILY_BUDGET_USD` | 5 | agent runs and the weekly content job together, per day, priced per model; tools stop when it's used up |
| `AI_CHAT_DAILY_BUDGET_USD` | 1 | the page assistant's own daily allowance (agent runs can't use it up) |
| `AGENT_MAX_RUN_USD` | 1 | one run; past it, the agent submits what it has |
| `AGENT_MAX_SEARCHES` / `AGENT_MAX_FETCHES` | 25 / 40 | per run |
| `AGENT_MAX_MINUTES` | 45 | per run (Flue's durability timeout); stale runs are closed on the next read |
| `CONTENT_MAX_PER_RUN` | 50 | profiles and story checks per weekly job; for the first backfill, run it on demand a few times |

Spend is priced per model from published rates (`worker/agent/models.js`), so the budgets mean the same whichever models the agents use. Every model call re-sends the whole conversation, so the agents keep it small:
- research agents read pages in 6,000-character windows (with an outline), or only the passages that mention what they're after (`web_fetch` with `find`);
- older steps are summarised once a conversation passes about 48k tokens (32k for the assistant, 40k for data quality).

Each model call logs a `[turn]` line with its model, tokens and cost (no content) to Workers Logs.

**Models:** each agent's model and effort are set separately: `AI_MODEL_<AGENT>` and `AI_EFFORT_<AGENT>`, for `RESEARCH`, `CHAT`, `QUALITY`, `STORIES`, `LIBRARY`, `RELATIVES`, `PROFILES` and `STORY_CHECKS`. [models.md](models.md) has the defaults and why each was chosen.

Also set a **spend limit and rate limit on the AI Gateway itself** (dashboard → AI → AI Gateway → your gateway → Settings). That is the hard stop if anything here misbehaves. Other variables: `AI_MODEL` (overrides every agent's default model; prefer the per-agent ones), `WEB_SEARCH_BYOK_ALIAS`, `AI_GATEWAY_ID` (`default`), `WEB_SEARCH_PROVIDER` (`exa`), `CONTENT_JOB_ENABLED` (`false`).

**One-time setup (owner):**

1. **AI Gateway:** use `default` or create a gateway, and set a spend limit. Credits (or stored provider keys) are only needed for web search and for gateway models such as Claude.
2. **Nothing to deploy separately.** The agents ship with the site: the Worker's build (`npm run deploy:ci`) also builds them (`npm run build:agents`, which installs `agents/`'s own dependencies, from its own lockfile, the first time).
3. **Variables:** the budgets above if you want other values, `AI_GATEWAY_ID` if not `default`, and later `CONTENT_JOB_ENABLED=true`. To let agents sign in to sites with an API key, set the secret `SITE_CREDENTIALS_KEY` (see "Research sites" below).
4. **Moving from a separate agents Worker.** Sites set up before the agents moved into the site's Worker ran them as a second Worker, `family-tree-agents`. On the first deploy, `tools/ci_config.mjs` finds it with the Workers Builds token and turns Durable Object migration `v1` into a transfer, so the agents' Durable Objects (chats, runs in progress) move into this Worker with their data. If it can't tell whether that Worker exists, the build stops: set the build variable `AGENTS_TRANSFER_FROM` to `family-tree-agents` or `off`. Then delete the `family-tree-agents` Worker (its own build fails until you do, without deploying anything), and set on `family-tree` any variable you'd only set there.
5. Redeploy (or push to `main`). Editors now see **Research with AI** on to-dos and person pages, and the **Agent runs** tab under Research.

**Using it.**

- **Start a run** from a to-do ("Research with AI"), a person page, or Research → Agent runs. A run started from a to-do assigns it to `agent:cloud`. On submission the to-do moves to `needs_review` with the suggestion linked. If the run fails or is stopped, the to-do goes back to the list with a note.
- **Watch** progress in Agent runs: status, the searches and pages it read, tokens, and the resulting suggestion. **Stop** aborts the Flue conversation.
- **Content job:** weekly, Sundays at 03:23 UTC, when `CONTENT_JOB_ENABLED=true`, or on demand (owner) with `POST /api/content/refresh`.
  - It rewrites profiles whose facts changed, direct ancestors first. Profiles are labelled as AI-written on the page, hidden from views without notes, and editors can "Rewrite now".
  - It re-checks stories whose people's facts changed. An out-of-date story becomes a **story revision** suggestion: the editor sees the reason and the revised text, and approving replaces the story (history keeps the old version).

**Developing.**

```bash
npm run build:agents
npm run dev
```

- `npm run build:agents` builds the agents into `agents/dist/agents_bundle` (installing `agents/`'s dependencies the first time). `npm run dev` runs the whole Worker locally in workerd from `wrangler.local.jsonc`, but its AI binding calls the real Cloudflare account, so model calls cost money even in development.
- The site-side logic is tested in `tests/agents.test.mjs` against the example family, with a fake `env.AGENTS`.
- Version pins, with their reasons in `agents/package.json`: Flue 2.3.0 needs Pi 1.4.x, and the Agents SDK web tools need `agents` ≥ 0.28, which Flue accepts as a project-level override. Remove the pins when Flue catches up.

## Page assistant (chat on every page)

Editors get an **Ask** button on every page. It opens a chat with an agent (`agents/src/agents/assistant.js`, Flue) that knows the page you're on. When you move to another page, your next message carries a short pointer: the page, the person it's about (id, years, how many events and relatives are recorded). The record itself and the page's visible text aren't sent; the agent fetches what the question needs, with `get_person` and `read_page` (the page snapshot is kept on the chat, `chats.page`). It reads the rest of the tree with tools, always as you see it.

- **It drafts, you decide.** When you describe a change, the assistant checks it against the tree and files a draft. The chat shows it as a card with exactly what would change and **Apply** / **Dismiss** buttons. Nothing changes until you press Apply. **Undo** on the card reverts it. A newer draft replaces one still waiting.
- **Who made the change.** An applied draft is logged as made by `agent:assistant` **on behalf of** the editor who pressed Apply (`changes.actor` / `actor_kind = 'agent'` / `on_behalf_of`, plus `via` = the chat and draft). History shows "🤖 assistant on behalf of …"; PROV-O (`/api/prov`) has the agent with a `prov:qualifiedDelegation` from the editor for that activity. Undo is logged as the editor's own act.
- **Where chats live.** Each conversation is a Flue `FlueAssistantAgent` Durable Object (id = chat id). The chat list (`chats`: owner, tree, title, tokens) and the drafted changes (`chat_changes`) are in D1, so applying a draft marks it applied in the same transaction as the edit. Only the editor who started a chat can read or use it.
- **Who:** editors and the owner, only for trees they edit. Losing editor access stops it.
- **What it sees:** what you see, living relatives included, so it can help keep them current. It has no web access and never deletes people (duplicates are merged).
- **Model and cost:** its own model and effort (`AI_MODEL_CHAT`, `AI_EFFORT_CHAT`; see [models.md](models.md)), counted against its own allowance, `AI_CHAT_DAILY_BUDGET_USD`. With AI Gateway logs on (`AI_GATEWAY_LOGS`), chat messages, page context included, are kept in the gateway's logs like research prompts.
- **Setup:** none beyond the agents. Migration `0006_chat.sql` adds `chats`, `chat_changes` and the attribution columns on `changes`; the agents' Durable Object class is `FlueAssistantAgent`. Routes: `worker/agent/chat-routes.js`.

## MCP server (members' own AI clients)

`POST /mcp` serves the tree to any MCP client (Claude, ChatGPT, Cursor, Claude Code, …) over MCP's Streamable HTTP transport. It's part of the one Worker (`worker/mcp.js`, read helpers in `worker/mcp-views.js`), stateless (no Durable Object, plain JSON responses, no SSE stream), and has no dependencies.

- **Who sees what:** exactly what the site shows the signed-in member. Read tools run over their scoped bundle (their grants and views), so living relatives come through as each member's view shows them (full, names only, anonymous or hidden), like everywhere else. Write tools call the site's own route handlers in-process, so the rules are the same ones: members and agents suggest, editors edit, review and undo, the owner administers. `tools/list` shows each caller only the tools their role can use; the handlers check again, per tree.
- **What it covers:** everything in the database except running the AI agents (research runs, AI profiles, the page assistant), which stay on the site. 62 tools:
  - *Orientation:* `whoami`, `tree_overview`.
  - *People and families:* `search_people` (name, surname, year ranges, place, branch, status, direct line), `get_person` (names and events with fact ids, citations, reviews, photos, findings, searches logged, to-dos, stories, data issues), `get_family` (a family, or a person's parents, full and half siblings, spouses, children), `get_ancestors` (Ahnentafel numbers, pedigree collapse, unknown ancestors), `get_descendants` (d'Aboville numbers), `relationship_between` (label, chain, common ancestors), `get_timeline` (a life in order with ages and family events).
  - *Across the tree:* `search_events`, `list_surnames`, `list_places`, `list_data_issues`, `list_duplicates`, `list_sources`, `get_source` (every fact citing it), `list_stories`, `get_story`, `get_media` (a photo or PDF as an image/resource).
  - *Research:* `list_findings`, `list_research_log`, `list_todos`, `get_my_queue`, `get_todo_history`, `list_suggestions`, `list_comments`, `get_history`, `get_provenance`, `list_research_sites`, `list_agent_runs`, `get_agent_run`.
  - *Changes:* `preview_edit`, `suggest_edit`, `suggest_research`, `withdraw_suggestion`, `create_todo`, `update_todo`, `claim_todo`, `add_comment`, `resolve_comment`, `upload_media`, `link_my_person`; editors also `edit_tree`, `revert_change`, `review_suggestion`, `update_finding`, `apply_quality_review`, `export_tree`.
  - *Owner:* `admin_overview`, `admin_save_tree`, `admin_save_view`, `admin_save_member`, `admin_grant`, `admin_revoke_grant`, `audit_log`, `audit_detail`, `list_hidden_stories`, `save_research_site`, `delete_research_site`, `storage_upgrade`, `import_gedcomx`, `export_database`. Research-site credentials are never set through MCP: a secret would pass through the AI provider.
- **Audit:** every tool call is a row in the change log (`entity_type = 'mcp'`, the tool's name, the actor, the tree, ok or not), never its arguments, which may carry names. Admin → Audit history filters them by type `mcp`. Changes made through tools are logged as the member, like any change on the site.
- **Data leaves Cloudflare:** whatever a tool returns goes to the member's AI provider. That's the member's choice, the same as copying from the site; give a "names only" or "hidden" view to anyone whose AI use shouldn't include living relatives' details.

**Setup (owner; each step is a change to Cloudflare Access, so do it or approve it):**

1. Deploy as usual. `wrangler.jsonc` already sends `/mcp` to the Worker (`assets.run_worker_first`); add `"/mcp"` there in `wrangler.local.jsonc` too if you deploy by hand.
2. Zero Trust → Access controls → Applications → Add → **Self-hosted**, hostname = the site's domain, path `mcp`, with the same policy as the site (the more specific path wins over the site's application). Under **Advanced settings**, turn on **Managed OAuth**: Access becomes the OAuth server, so an MCP client gets a `401` pointing at Access's OAuth discovery, opens the browser, and the member signs in through the family's usual login. Access then forwards each request with `Cf-Access-Jwt-Assertion`, which the Worker verifies as for the site.
3. Copy that application's **AUD tag** into the Worker's variables as `MCP_ACCESS_AUD` (dashboard → Variables, comma-separated if more than one). Requests to `/mcp` are accepted with either `ACCESS_AUD` or `MCP_ACCESS_AUD`; everything else still needs `ACCESS_AUD`. (If you'd rather turn on Managed OAuth on the site's own application, skip this step; that changes its `401` behavior for all non-browser clients.)
4. Optional: list `https://<host>/mcp` in an **MCP server portal** (Access controls → AI controls → MCP portals) so members add one portal URL for everything. Keep the direct URL behind Access as above: the portal alone isn't enough.
5. Optional: `MCP_ALLOWED_ORIGINS` (comma-separated) for browser-based MCP clients. Requests that carry another site's `Origin` are refused (DNS-rebinding protection); server-side clients send none.
6. Test: `curl -X POST https://<host>/mcp` without a token → `401`. In Claude: Settings → Connectors → Add custom connector → `https://<host>/mcp` (or the portal URL), sign in, then ask "who am I in the family tree?".

**Locally:** `npm run dev:example` serves `/mcp` on the fictional family (port 8790), signed in as `DEV_PRINCIPAL` or the `X-Dev-Principal` header; point the MCP Inspector (`npx @modelcontextprotocol/inspector`) at `http://localhost:8790/mcp`. Tests: `tests/mcp.test.mjs` (protocol, roles, views, relationship answers, writes, audit, and output snapshots in `tests/snapshots/`; `UPDATE_SNAPSHOTS=1 npm test` accepts intended changes).

## Data quality review (agent)

Research → Agent runs → **Data quality review** starts an agent (`agents/src/agents/quality.js`, Flue, one Durable Object per run) that works through open items and checks each against what the tree now records. Editors only.

- **Options:** everything, tree checks, to-dos, findings, or to-dos and findings; optionally one person; a limit of 1–100 items (default 10); **dry run** (on by default).
- **Tree checks** (`worker/agent/checks.js`) are found fresh at the start of each run, most serious first:
  - the site's own record checks: impossible dates and ages, two sets of parents, a husband recorded as female, conflicting birth years;
  - possible duplicate people (same name with the same parents, or the same birth year), the same couple recorded twice, and couples recorded the wrong way round;
  - repeated birth, death or burial events;
  - empty records, and people not connected to the home person;
  - dates and places not in standard form ("1 June 1915" → "1 Jun 1915", "Exampleton, E.S." → "Exampleton, Example State, USA", the spelled-out form the tree already uses most).

  Where the fix is mechanical (a merge, a standard date or place), the check carries the edit ops. The agent confirms the problem and files them as a suggestion, or calls it a false alarm, or adds a to-do when it needs your judgement. A decision on a check is applied only while the check still finds the same thing.
- **Items:** open to-dos (open, or in progress and held by nobody else) and open findings the editor can see, oldest-updated first. The plan is fixed when the run starts and kept in `agent_runs.options`.
- **Per item** the agent gives a verdict: still valid, resolved, obsolete, duplicate or needs a person, with a note and the records it relied on. It reads the tree only, with no web access.
  - **To-dos:** resolved → done (the outcome names the evidence); obsolete or duplicate → won't do; otherwise kept, with a comment and perhaps a new priority.
  - **Findings:** resolved → resolved; obsolete or duplicate → dismissed.
  - **Fixes** to the facts are always filed as suggestions. It may add new to-dos for concrete follow-ups.
- **Applying:**
  - Outside a dry run, each decision applies as soon as it is made.
  - A dry run changes nothing and keeps a report (`agent_runs.report`). **Apply these decisions** applies it later without running the model again, once per run.
  - Either way, every write is conditional on the item's version, so an item someone changed meanwhile is skipped, not overwritten.
- **Attribution:** changes are logged as `agent:data-quality` on behalf of the editor who started the run, or who applied the dry run. This shows in to-do history (`on_behalf_of`), on finding resolutions and in the change log (`on_behalf_of`, `via` = the run id).
- **Budget:** one run against `AGENT_MAX_RUNS_PER_DAY`, spend against `AI_DAILY_BUDGET_USD` and `AGENT_MAX_RUN_USD`; model `AI_MODEL_QUALITY`, effort `AI_EFFORT_QUALITY`. Migration `0007_agent_kinds.sql`; Durable Object migration `v3` (`FlueQualityReviewerAgent`).

## Stories agent

Editors can have an agent (`agents/src/agents/stories.js`, Flue, one Durable Object per run) **review** a story or **draft** a new one. Either way the result is a suggestion in Research → Suggestions; nothing is published until an editor approves it.

- **Review:** **Review with AI** on a story page, with optional instructions. The agent checks every claim against the records of the people the story links and either reports the story as up to date (nothing filed) or proposes a revision that changes as little as needed. The queue shows the list of changes (each with its reason and the facts behind it) and a paragraph diff against the current text. Approving keeps the story's citations.
- **Draft:** **Draft a story with AI** on the Stories page. Pick one or more people, an optional angle, and a length (short ~300, medium ~700, long ~1,200 words). The agent writes from the records only, plus the site's context entries. The queue shows the story, its sources, and notes mapping each paragraph to the facts behind it. The notes aren't published.
- **Checks on every submission:**
  - every `[[id|name]]` link is a person in the tree;
  - a draft links each of its subjects and is roughly the requested length;
  - every source is one the tree already cites for those people, or a context entry;
  - people the starter's view keeps private are never a subject, and come to the agent as a name only.
- **No web access**, so nothing in a story can come from outside the tree.
- **Budget:** one run against `AGENT_MAX_RUNS_PER_DAY`, spend against `AI_DAILY_BUDGET_USD` and `AGENT_MAX_RUN_USD`; model `AI_MODEL_STORIES` (default GLM-5.3), effort `AI_EFFORT_STORIES`. Durable Object migration `v4` (`FlueStoryWriterAgent`). The weekly content job's story check (`StoryReviewer`) is separate and unchanged.

## Stories librarian (agent)

Research → Agent runs → **Review the story library** starts an agent (`agents/src/agents/library.js`, Flue, one Durable Object per run; shared logic in `worker/agent/library.js`) that looks after the whole library of stories, where the stories agent works on one at a time. Editors only; started by hand, no schedule.

- **Options:** how many new stories it may start, N (0–5, default 2), and optional instructions.
- **Audit:** every published story (up to 50, flagged ones first) is checked against the tree as it is now, when the run starts and again whenever the agent reads it:
  - links to people who are no longer in the tree, and people who were merged into someone else (followed through the merge);
  - dated claims ("born in 1897", "died in 1950") about the person linked just before them: flagged when the person's records give a different year (two years' leeway for "abt" dates) or record no such event;
  - dated claims about someone the starter's view keeps private.

  The flags are leads. The agent reads the story and the records, then gives each story a verdict: up to date, revised, or needs an editor.
- **Fix:** a revision is checked with the stories agent's own checks (`checkStory`: links, sources, the story's citations kept) and filed as a story revision suggestion, shown as a diff in Research → Suggestions. **Nothing published changes until an editor approves it.** A story that already has a revision waiting gets no second one.
- **Gaps:** candidate subjects for new stories, best first:
  - people with at least one sourced fact or source (living relatives included), scored by sourced facts, distinct sources, facts, notes and findings;
  - events several such people share: the same migration (type, place, decade), war service (place, decade) or trade.

  Anyone covered by a story sorts after everyone who isn't. People the starter's view keeps private are skipped.
- **Commission:** up to N story-writer runs for the best candidates, each with a brief from the librarian. Each is an ordinary stories-agent draft run (`kind: "story"`, the stories agent's model, its own suggestion), started as the editor who started the librarian. Its `options.parent` names the librarian run; the librarian's report (`agent_runs.report.children`) lists it. No migration was needed for the link.
- **Report:** each story's flags and verdict, with links to the suggested revisions; the candidates; and the story runs started, with their status.
- **Budget:** the librarian is one run against `AGENT_MAX_RUNS_PER_DAY`; its own spend is capped by `AGENT_MAX_RUN_USD`. Each child run counts against the daily run and spend budgets as usual, and isn't started once they're used up. Model `AI_MODEL_LIBRARY` (default DeepSeek V4.1 Flash, the quality reviewer's model), effort `AI_EFFORT_LIBRARY`. Durable Object migration `v5` (`FlueStoryLibrarianAgent`). Stopping a librarian run doesn't stop story runs it already started; stop those separately.

## Research sites (the shared list)

Admin → **Research sites** (`#/admin/sites`, owner only) is the list of genealogy sites every research agent works from: the researcher, Sherlock, and Claude Code agents through `python3 tools/agent_api.py sites`. Migration `0010_research_sites.sql` seeds about 40 broadly useful, international resources (free archives, indexes, newspapers, cemeteries, directories, and the major subscription sites marked as such).

- **Each site:** name, home page, an optional search URL template (`{given}`, `{surname}`, `{birth_year}`, `{place}`), the domains it covers, coverage, record types, access (`open`, `free-account`, `subscription`, `institution`), source quality (`original-images`, `indexes`, `compiled`), whether it has an official API, notes for agents, and an on/off switch.
- **What the agents get:** a compact summary of the enabled sites in the first message of every research and Sherlock run (name, domain, access group, credential yes/no, a one-line note; at most 4,000 characters), plus a `research_sites` tool for full details or filtering by record type. They prefer listed sites, follow the notes, and for a subscription or institution site without a credential they log the search as inconclusive and leave the owner a to-do. The other agents (stories, librarian, data quality, assistant) don't read the web, so they don't get the list.
- **API:** `GET /api/research-sites` (editors and agents; `has_credential`, never a value); `POST`, `PUT /:id`, `DELETE /:id`, and `PUT|DELETE /:id/credential` (owner). Code: `worker/sites.js`, `worker/agent/sites.js`.
- **History:** adding, editing, switching on or off and removing a site, and setting, replacing or removing a credential, are all in Admin → Audit history (`entity_type` `research_site`). The log keeps the credential's kind, never its value.

**Credentials (optional).** For sites with an official API key or HTTP sign-in, the owner can save one credential per site:

- **Kinds:** `header` (a header name and value: an API key or a bearer token), `query` (a URL parameter and value), or `basic` (username and password, sent as HTTP Basic auth).
- **No form logins.** Agents never fill in sign-in forms or carry cookies. Ancestry, MyHeritage, Findmypast and similar sites forbid automated access, and trying would put the owner's account at risk; agents leave a to-do for those instead.
- **Storage:** encrypted at rest in D1 (AES-GCM, WebCrypto) in their own table, `research_site_credentials`, which list queries never read. Values are write-only: no API or page shows them, only "credential set (kind, date, by)" with Replace and Remove.
- **Use:** the agents decrypt a credential only inside `web_fetch` (`agents/src/web.js`, shared by every agent that reads the web), and adds it when the requested URL's host is one of that site's domains, over https only. Each redirect hop is checked again: a redirect to a host outside the site's domains is followed without it. The model never sees the value; the run's record of pages read (`agent_runs.used`) marks pages read with a credential.
- **The key:** `SITE_CREDENTIALS_KEY`, 32 random bytes in base64, set as a secret on the Worker. Without it, saving a credential fails with the commands below, and everything else works. Changing the key makes saved credentials unreadable: save them again.

  ```bash
  openssl rand -base64 32
  npx wrangler secret put SITE_CREDENTIALS_KEY --name family-tree
  ```

## Sherlock: find relatives (agent)

**Find relatives** on a person page (editors) starts Sherlock (`agents/src/agents/sherlock.js`, Flue, one Durable Object per run; shared logic in `worker/agent/relatives.js`). It searches records for the person's parents, siblings, spouses and children who aren't in the tree yet, and suggests them. It never adds anyone itself.

- **Options (all optional):** looking for any relative, parents, siblings, a spouse, children, or a named relative ("a brother called Example"); free-text hints; depth one generation (default) or two (also the relatives of the person's immediate family).
- **What it starts with:** the person's full view (names, events with places, sources, findings, the research log, open to-dos), their immediate family already in the tree, and the research sites summary. It fetches anything else with the researcher's tools, under the same lean-context rules, and the same `web_search`, `web_fetch` and `research_sites`.
- **What it files:** each candidate becomes its own **suggestion** in Research → Suggestions: a `new-person` finding (confidence, the records seen) carrying the edit ops that add the person and link them to the family (`person.create` plus `family.set_spouse`, `family.add_child` or `family.create`). Approving it applies both in one step. The change is logged as `agent:sherlock` **on behalf of** the approving editor (`via` = the run), and the finding is recorded on the relative's page as resolved. Rejecting it keeps the finding, dismissed, with the reviewer's note. The searches, negative ones included, and any to-dos for the owner go in one research suggestion.
- **Checks before filing:**
  - **Already in the tree:** a candidate with the same first given name and surname as anyone in the tree (any recorded name, accents and case ignored), and birth and death years within two years where both are known, is dropped and listed as "already in the tree".
  - **Living relatives** are suggested like anyone else. Nobody is attached to a person the starter's view keeps private.
  - Every candidate needs a source with a URL or a note saying where the record is, and its ops must apply to the tree as it is.
- **Report:** Research → Agent runs shows each Sherlock run with what it suggested (and the suggestion numbers), who it found already in the tree, and the searches it logged.
- **Model and budget:** `AI_MODEL_RELATIVES` / `AI_EFFORT_RELATIVES` (default: the researcher's model, DeepSeek V4.1 Flash, high). One run against `AGENT_MAX_RUNS_PER_DAY`, spend against `AI_DAILY_BUDGET_USD` and `AGENT_MAX_RUN_USD`, pages and searches against `AGENT_MAX_FETCHES` and `AGENT_MAX_SEARCHES`. Durable Object migration `v6` (`FlueSherlockAgent`). API: `POST /api/agent/runs {tree, kind: "relatives", person, looking_for?, named?, hints?, depth?}`.

## GEDCOM X storage, export and import

The tree is stored as GEDCOM X (docs/design/standards.md):
- `people` rows hold Persons, and `sources` / `media` rows hold SourceDescriptions;
- families are Couple and ParentChild rows in `relationships`, plus an `ft:FamilyGroup` for a family with one or no known spouse.

**Moving an existing database (one time, owner):**
1. Apply migration 0005.
2. Open **Admin → Access → Data storage → Check**. That's a dry run: it converts every record, proves each converts back exactly, and reports the counts.
3. Then **Move to GEDCOM X storage**, which runs as one transaction. `meta.storage` becomes `gedcomx`.
4. Undo: D1 Time Travel to just before the move. The old `families` rows are cleared by the move.

The code reads both layouts, so deploying it before the move is safe.

**Export:**
- Research → Overview → **Download GEDCOM X**, or `GET /api/export.gedcomx` (editors).
- It contains what the caller can see. Living people are marked private, findings are record personas linked as evidence with an analysis document, and reviewers appear by local part only.
- **Download GEDCOM 5.5.1** stays for Ancestry and older software.

**Import:**
- `POST /api/admin/import.gedcomx` (owner) loads a GEDCOM X JSON document into an **empty** database: another GEDCOM X app, FamilySearch, or our own export.
- Families are rebuilt from Couple and ParentChild relationships.
- The old one-time import (`npm run db:import`) refuses to run against GEDCOM X storage.

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

Photos of living people: the owner decides. Strip location data first, as above.

## Your local files

Until cutover, `family-data/` is the only copy of the import inputs and research. Before any bulk change, copy it somewhere private, never into this repo.

## Checks before any commit or PR

```sh
git status                                     # read it
python3 tools/check_privacy.py                 # also runs automatically as a pre-commit hook
echo "$PR_BODY" | python3 tools/check_privacy.py --file -
```
