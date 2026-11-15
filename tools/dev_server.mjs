#!/usr/bin/env node
// A local server for working on the site: the real Worker (worker/index.js) over an in-memory database seeded with the
// fictional example family, serving the site's static files. No Cloudflare account, no Access, no private data.
//
//   node tools/dev_server.mjs [--port 8790] [--site dist/site] [--as owner@example.test]
//
// Requests are made as --as (default: the example owner). The agents aren't running: AI features answer that
// they aren't set up. Used by the end-to-end tests (e2e/) and by `npm run dev:example`.
import http from "node:http";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname, dirname, resolve, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const PORT = +arg("port", 8790), SITE = resolve(ROOT, arg("site", "dist/site")), AS = arg("as", "owner@example.test");

export async function startDevServer({ port = PORT, site = SITE, as = AS, quiet = false } = {}) {
  const { makeEnv, migrate } = await import(join(ROOT, "tests/helpers/fake-env.mjs"));
  const dir = mkdtempSync(join(tmpdir(), "ft-dev-"));
  execFileSync("python3", ["tools/build.py", "--data", "example", "--out", dir, "--raw-out", join(dir, "raw.json")], { cwd: ROOT, stdio: quiet ? "ignore" : "inherit" });
  const research = JSON.parse(readFileSync(join(ROOT, "example/research.json"), "utf8"));
  research.trees = research.trees || [{ id: "all", name: "Everyone", definition: { branches: ["*"] } }];
  writeFileSync(join(dir, "research.json"), JSON.stringify(research));
  execFileSync("python3", ["tools/seed_app.py", "--raw", join(dir, "raw.json"), "--bundle", join(dir, "family.json"), "--research", join(dir, "research.json"), "--out", join(dir, "seed.sql"), "--owner", "owner@example.test", "--cutover"], { cwd: ROOT, stdio: quiet ? "ignore" : "inherit" });
  // a throwaway key for research site credentials (the database is in memory and gone when the server stops)
  const env = makeEnv({ DEV_PRINCIPAL: as, SITE_CREDENTIALS_KEY: randomBytes(32).toString("base64") });
  migrate(env.DB, ROOT);
  env.DB.execFile(join(dir, "seed.sql"));
  const worker = (await import(join(ROOT, "worker/index.js"))).default;
  const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon", ".map": "application/json" };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/media/")) {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const headers = { "Content-Type": req.headers["content-type"] || "" };
        if (req.headers["x-dev-principal"]) headers["X-Dev-Principal"] = req.headers["x-dev-principal"];
        const r = await worker.fetch(new Request(url, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), env, { waitUntil() {} });
        res.writeHead(r.status, Object.fromEntries(r.headers));
        res.end(Buffer.from(await r.arrayBuffer()));
        return;
      }
      let f = normalize(join(site, decodeURIComponent(url.pathname)));
      if (!f.startsWith(site)) { res.writeHead(403); res.end(); return; }
      if (!existsSync(f) || statSync(f).isDirectory()) f = join(site, "index.html"); // the app routes itself (#/…)
      res.writeHead(200, { "Content-Type": TYPES[extname(f)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(readFileSync(f));
    } catch (e) {
      res.writeHead(500); res.end(String(e && e.stack || e));
    }
  });
  await new Promise((ok) => server.listen(port, ok));
  if (!quiet) console.log(`Example family site on http://localhost:${port} (serving ${site}, as ${as})`);
  return { server, env, url: `http://localhost:${port}`, close: () => new Promise((ok) => server.close(ok)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startDevServer();
