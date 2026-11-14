# Operations: build, load, deploy, photos

Everything here runs from the repo root. Commands marked **⚠ ask** change shared state, so get the owner's explicit OK first.

## One-time setup (per machine)

```sh
npm install                       # installs wrangler and enables the privacy git hooks
npx wrangler login
npx wrangler whoami               # confirm the right Cloudflare account
cp wrangler.jsonc wrangler.local.jsonc
```

Fill in `wrangler.local.jsonc` (git-ignored): `database_id` from `npx wrangler d1 list`, and `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` from the Access application. Every npm script passes `-c wrangler.local.jsonc`; running bare `npx wrangler …` without `-c` uses the placeholder template and will fail or hit the wrong thing.

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

## Photos (R2)

1. **Strip metadata first.** Phone photos carry GPS coordinates (a living relative's home). Use `exiftool -all= file.jpg` or `sips` re-export on macOS, and check with `exiftool file.jpg`.
2. Name objects `photos/<surname>-<given>-<year-or-subject>.jpg` (lowercase, hyphens). The bucket is private; keys are only visible to signed-in viewers.
3. Upload **⚠ ask** (first time per batch): `npx wrangler r2 object put family-tree-media/photos/<name>.jpg --file <path> --remote -c wrangler.local.jsonc`
4. Copy the same file to `family-data/media/photos/` for local preview.
5. Wire it up through a batch's `media` key: `{"media": {"<ID>": [{"file": "photos/<name>.jpg", "portrait": true, "caption": "…", "date": "c. 1925", "source": "Family collection, held by …"}]}}`. Then merge, build and load.

Photos of living people: only with their consent, and only if the owner says so.

## Backups

`family-data/` is the only copy of the research. Before any bulk change (large merges, new GEDCOM), copy it somewhere private: `zip -r ~/Backups/family-data-$(date +%F).zip family-data`. Never into this repo.

## Checks before any commit or PR

```sh
git status                                     # read it
python3 tools/check_privacy.py                 # also runs automatically as a pre-commit hook
echo "$PR_BODY" | python3 tools/check_privacy.py --file -
```
