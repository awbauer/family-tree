---
name: publish
description: Rebuild the site data and push it to Cloudflare (D1 load, Worker deploy, R2 photo upload). Use when the owner asks to update the live site, load the database, deploy, or upload photos.
---

Follow `docs/agents/operations.md`. Steps:

1. `npx wrangler whoami` shows the expected account, and `wrangler.local.jsonc` exists. Never use the placeholder `wrangler.jsonc` for remote commands.
2. `python3 tools/build.py`. Report people/families/findings counts and any new errors versus the previous build. Stop if the people count dropped unexpectedly.
3. Ask the owner, stating counts: "Load N people / M families / K findings into remote D1 (full replace)?" Only on a yes: `npm run db:load -- --yes`, then `npm run db:counts` and compare.
4. Deploy only if code changed and the owner says so: `npm run deploy`. Access must be configured (`ACCESS_AUD`, `ACCESS_TEAM_DOMAIN` set in `wrangler.local.jsonc`).
5. Photos: strip EXIF/GPS, upload with `-c wrangler.local.jsonc --remote`, wire up via a batch `media` entry, then rebuild and load.

Touch only the family-tree Worker, the family-tree D1 database and the family-tree-media bucket. The account has other projects.
