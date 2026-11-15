// The research sites list (Admin → Research sites) and its credentials: owner-only changes recorded in the audit
// history, encryption at rest, values never returned, a clear error when the key is missing, the compact summary the
// agents get, and how web_fetch applies a credential (matching https hosts only, dropped on a cross-host redirect).
// Fictional sites only (example.org / example.test).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEnv, client, migrate } from "./helpers/fake-env.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "owner@example.test", EDITOR = "editor@example.test", MEMBER = "member@example.test", AGENT = "agent:helper";
const KEY = Buffer.alloc(32, 7).toString("base64"); // a fixed test key
const SECRET = "test-value-do-not-leak-1234";
let env, call, Sites, Secrets;

before(async () => {
  env = makeEnv({ SITE_CREDENTIALS_KEY: KEY });
  migrate(env.DB, ROOT);
  env.DB.exec("INSERT INTO trees (id, name, definition, created_at, updated_at) VALUES ('all', 'Everyone', '{\"branches\":[\"*\"]}', 'x', 'x')");
  call = client((await import("../worker/index.js")).default, env);
  await call("PUT", "/api/admin/grants", { body: { principal: EDITOR, tree_id: "all", role: "editor" } });
  await call("PUT", "/api/admin/grants", { body: { principal: MEMBER, tree_id: "all", role: "member" } });
  await call("PUT", "/api/admin/members/agent%3Ahelper", { body: { kind: "agent", display_name: AGENT } });
  await call("PUT", "/api/admin/grants", { body: { principal: AGENT, tree_id: "all", role: "agent" } });
  Sites = await import("../worker/agent/sites.js");
  Secrets = await import("../worker/secrets.js");
});

const SITE = { name: "Example Records", url: "https://records.example.org/", domains: "records.example.org, example.test", coverage: "Exampleton parish registers, 1700–1900", record_types: "church, vital", access: "subscription", source_quality: "original-images", api: "JSON API with a key", agent_notes: "Search by surname first. Dates are in the old style." };
const auditRows = (id) => env.DB.prepare("SELECT * FROM changes WHERE entity_type = 'research_site' AND entity_id = ? ORDER BY id").bind(id).all().then((r) => r.results);

test("the migration seeds a broad list; editors and agents can read it, members can't", async () => {
  const r = await call("GET", "/api/research-sites", { as: EDITOR });
  assert.equal(r.status, 200);
  assert.ok(r.data.sites.length >= 30, `seeded ${r.data.sites.length}`);
  for (const s of r.data.sites) {
    assert.match(s.url, /^https:\/\//, s.id);
    assert.ok(Sites.ACCESS.includes(s.access) && Sites.QUALITY.includes(s.source_quality), s.id);
    assert.ok(s.domains.length && s.coverage && s.agent_notes, s.id);
    if (s.search_url) assert.match(s.search_url, /\{(given|surname|birth_year|place)\}/, s.id);
  }
  for (const id of ["ancestry", "myheritage", "findmypast", "newspapers-com", "fold3"]) assert.equal(r.data.sites.find((s) => s.id === id).access, "subscription", id);
  assert.equal(r.data.key_configured, undefined, "only the owner sees the key status");
  assert.equal((await call("GET", "/api/research-sites", { as: AGENT })).status, 200);
  assert.equal((await call("GET", "/api/research-sites", { as: MEMBER })).status, 403);
  assert.equal((await call("GET", "/api/research-sites", { as: OWNER })).data.key_configured, true);
});

test("only the owner adds, edits, switches and removes sites; each change is in the audit history", async () => {
  assert.equal((await call("POST", "/api/research-sites", { as: EDITOR, body: SITE })).status, 403);
  assert.equal((await call("POST", "/api/research-sites", { as: OWNER, body: { ...SITE, url: "records.example.org" } })).status, 400);
  assert.equal((await call("POST", "/api/research-sites", { as: OWNER, body: { ...SITE, access: "maybe" } })).status, 400);
  const c = await call("POST", "/api/research-sites", { as: OWNER, body: SITE });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const id = c.data.site.id;
  assert.equal(id, "example-records");
  assert.deepEqual(c.data.site.domains, ["records.example.org", "example.test"]);
  assert.deepEqual(c.data.site.record_types, ["church", "vital"]);
  assert.equal(c.data.site.has_credential, false);
  assert.equal((await call("POST", "/api/research-sites", { as: OWNER, body: SITE })).status, 409);

  assert.equal((await call("PUT", `/api/research-sites/${id}`, { as: EDITOR, body: { enabled: false } })).status, 403);
  const e = await call("PUT", `/api/research-sites/${id}`, { as: OWNER, body: { agent_notes: "Search by surname, then filter by parish.", search_url: "https://records.example.org/search?surname={surname}&given={given}" } });
  assert.equal(e.status, 200, JSON.stringify(e.data));
  assert.equal(e.data.site.search_url, "https://records.example.org/search?surname={surname}&given={given}");
  assert.equal((await call("PUT", `/api/research-sites/${id}`, { as: OWNER, body: { search_url: "https://records.example.org/search" } })).status, 400, "a template needs a placeholder");
  assert.equal((await call("PUT", `/api/research-sites/${id}`, { as: OWNER, body: { enabled: false } })).data.site.enabled, false);
  assert.equal((await call("PUT", `/api/research-sites/${id}`, { as: OWNER, body: { enabled: true } })).data.site.enabled, true);

  const ops = (await auditRows(id)).map((r) => r.op);
  assert.deepEqual(ops, ["create", "update", "disable", "enable"]);
  const audit = await call("GET", "/api/admin/audit?type=research_site", { as: OWNER });
  assert.equal(audit.status, 200);
  assert.ok(audit.data.batches.some((b) => b.entities.some((x) => x.id === id && x.label === "Example Records")));

  assert.equal((await call("DELETE", `/api/research-sites/${id}`, { as: EDITOR })).status, 403);
  assert.equal((await call("DELETE", `/api/research-sites/${id}`, { as: OWNER })).status, 200);
  assert.equal((await call("GET", "/api/research-sites", { as: OWNER })).data.sites.find((s) => s.id === id), undefined);
  assert.equal((await auditRows(id)).at(-1).op, "delete");
});

test("credentials: encrypted at rest, never returned or logged, owner only, and replaceable and removable", async () => {
  const id = (await call("POST", "/api/research-sites", { as: OWNER, body: { ...SITE, name: "Example Archive", domains: "archive.example.org" } })).data.site.id;
  assert.equal((await call("PUT", `/api/research-sites/${id}/credential`, { as: EDITOR, body: { kind: "header", name: "X-Api-Key", value: SECRET } })).status, 403);
  assert.equal((await call("PUT", `/api/research-sites/${id}/credential`, { as: OWNER, body: { kind: "form", username: "a", password: "b" } })).status, 400, "no form logins");
  assert.equal((await call("PUT", `/api/research-sites/${id}/credential`, { as: OWNER, body: { kind: "header", name: "Cookie", value: "session=1" } })).status, 400, "no cookies");
  const r = await call("PUT", `/api/research-sites/${id}/credential`, { as: OWNER, body: { kind: "header", name: "X-Api-Key", value: SECRET } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.site.has_credential, true);
  assert.equal(r.data.site.credential.kind, "header");
  assert.equal(r.data.site.credential.updated_by, OWNER);

  // at rest: ciphertext only, and it decrypts back (bound to the site id)
  const row = await env.DB.prepare("SELECT * FROM research_site_credentials WHERE site_id = ?").bind(id).first();
  assert.ok(!row.secret.includes(SECRET) && !Buffer.from(row.secret, "base64").toString("latin1").includes(SECRET));
  assert.deepEqual(await Secrets.decryptSecret(env, id, row.secret), { name: "X-Api-Key", value: SECRET });
  await assert.rejects(Secrets.decryptSecret(env, "another-site", row.secret));
  await assert.rejects(Secrets.decryptSecret({ SITE_CREDENTIALS_KEY: Buffer.alloc(32, 9).toString("base64") }, id, row.secret));

  // nowhere in any API answer or the change log
  for (const as of [OWNER, EDITOR, AGENT]) assert.ok(!JSON.stringify((await call("GET", "/api/research-sites", { as })).data).includes(SECRET), as);
  const all = JSON.stringify((await env.DB.prepare("SELECT * FROM changes").all()).results);
  assert.ok(!all.includes(SECRET));
  const audit = await call("GET", "/api/admin/audit?type=research_site", { as: OWNER });
  assert.ok(!JSON.stringify(audit.data).includes(SECRET));

  // replace (basic), then remove
  const rb = await call("PUT", `/api/research-sites/${id}/credential`, { as: OWNER, body: { kind: "basic", username: "example", password: SECRET } });
  assert.equal(rb.data.site.credential.kind, "basic");
  assert.equal((await call("DELETE", `/api/research-sites/${id}/credential`, { as: EDITOR })).status, 403);
  const rm = await call("DELETE", `/api/research-sites/${id}/credential`, { as: OWNER });
  assert.equal(rm.data.site.has_credential, false);
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM research_site_credentials WHERE site_id = ?").bind(id).first("n"), 0);
  assert.deepEqual((await auditRows(id)).map((x) => x.op), ["create", "credential-set", "credential-replace", "credential-remove"]);
  assert.ok(!JSON.stringify((await auditRows(id))).includes(SECRET));
});

test("without SITE_CREDENTIALS_KEY, saving a credential fails with the setup commands; everything else works", async () => {
  const off = makeEnv();
  migrate(off.DB, ROOT);
  const c2 = client((await import("../worker/index.js")).default, off);
  const list = await c2("GET", "/api/research-sites", { as: OWNER });
  assert.equal(list.data.key_configured, false);
  assert.match(list.data.key_help, /wrangler secret put SITE_CREDENTIALS_KEY --name family-tree$/);
  const id = (await c2("POST", "/api/research-sites", { as: OWNER, body: { ...SITE, name: "Example Keyless" } })).data.site.id;
  const r = await c2("PUT", `/api/research-sites/${id}/credential`, { as: OWNER, body: { kind: "query", name: "api_key", value: SECRET } });
  assert.equal(r.status, 503);
  assert.match(r.data.error, /SITE_CREDENTIALS_KEY isn't set/);
  assert.match(r.data.error, /wrangler secret put SITE_CREDENTIALS_KEY --name family-tree/);
  assert.doesNotMatch(r.data.error, /family-tree-agents/, "one Worker, one secret");
  assert.equal((await c2("PUT", `/api/research-sites/${id}`, { as: OWNER, body: { enabled: false } })).status, 200);
  await assert.rejects(Secrets.encryptSecret(off, id, { a: 1 }), Secrets.KeyMissingError);
  await assert.rejects(Secrets.encryptSecret({ SITE_CREDENTIALS_KEY: "dG9vIHNob3J0" }, id, { a: 1 }), /32 bytes/);
});

test("the agents' summary stays under the size cap, however long the list", async () => {
  const sites = (await call("GET", "/api/research-sites", { as: EDITOR })).data.sites;
  const s = Sites.sitesSummary(sites);
  assert.ok(s.length <= Sites.SUMMARY_MAX, `${s.length} chars`);
  assert.match(s, /Free account:\n(- .*\n)*- FamilySearch · familysearch\.org · no · /);
  assert.match(s, /Subscription:\n(- .*\n)*- Ancestry · ancestry\.com · no · /);
  assert.match(Sites.sitesSummary(sites.map((x) => (x.id === "ancestry" ? { ...x, has_credential: true } : x))), /- Ancestry · ancestry\.com · credential: yes/);
  const many = Array.from({ length: 300 }, (_, i) => ({ ...sites[i % sites.length], name: `Example Site ${i} with a long name`, agent_notes: "x ".repeat(400), enabled: true }));
  const big = Sites.sitesSummary(many);
  assert.ok(big.length <= Sites.SUMMARY_MAX, `${big.length} chars`);
  assert.match(big, /more: call research_sites/);
  // disabled sites are left out; full details come from the tool, filtered
  assert.ok(!Sites.sitesSummary([{ ...sites[0], enabled: false }]).includes(sites[0].name));
  const d = Sites.sitesDetail(sites, { record_type: "graves" });
  assert.ok(d.sites.length >= 2 && d.sites.every((x) => x.record_types.includes("graves")));
  assert.ok(!JSON.stringify(d).includes("secret"));
});

test("web_fetch's credential: added only for the site's own https hosts, and dropped on a redirect to another host", async () => {
  const creds = [
    { id: "ex", name: "Example Records", domains: ["records.example.org"], kind: "header", secret: { name: "X-Api-Key", value: SECRET } },
    { id: "eq", name: "Example Query", domains: ["query.example.test"], kind: "query", secret: { name: "key", value: SECRET } },
    { id: "eb", name: "Example Basic", domains: ["basic.example.test"], kind: "basic", secret: { username: "example", password: SECRET } },
  ];
  const seen = [];
  const mock = async (url, init = {}) => { seen.push({ url, headers: Object.fromEntries(new Headers(init.headers || {})) }); return new Response("ok"); };
  const run = async (requested, hops) => {
    seen.length = 0;
    const used = [];
    const f = Sites.credentialedFetch({ requested, creds, baseFetch: mock, onUse: (s) => used.push(s.id) });
    for (const h of hops) await f(h, { method: "GET", redirect: "manual", headers: { accept: "text/html" } });
    return used;
  };
  // header on the matching https host (subdomains too)
  assert.deepEqual(await run("https://records.example.org/a", ["https://records.example.org/a", "https://img.records.example.org/b"]), ["ex", "ex"]);
  assert.equal(seen[0].headers["x-api-key"], SECRET);
  assert.equal(seen[0].headers.accept, "text/html");
  // a redirect to another host is followed without it, even back on an https page
  await run("https://records.example.org/a", ["https://records.example.org/a", "https://elsewhere.example.net/landing"]);
  assert.equal(seen[1].headers["x-api-key"], undefined);
  // never over http, and never for a look-alike host
  assert.deepEqual(await run("http://records.example.org/a", ["http://records.example.org/a"]), []);
  assert.equal(seen[0].headers["x-api-key"], undefined);
  assert.deepEqual(await run("https://records.example.org.evil.example.net/", ["https://records.example.org.evil.example.net/"]), []);
  assert.deepEqual(await run("https://notrecords.example.org/", ["https://notrecords.example.org/"]), []);
  // a page on another site that redirects onto a credentialed host doesn't pick the credential up
  assert.deepEqual(await run("https://elsewhere.example.net/", ["https://elsewhere.example.net/", "https://records.example.org/a"]), []);
  // query parameter and Basic auth
  await run("https://query.example.test/s?q=1", ["https://query.example.test/s?q=1"]);
  assert.equal(new URL(seen[0].url).searchParams.get("key"), SECRET);
  assert.equal(new URL(seen[0].url).searchParams.get("q"), "1");
  await run("https://basic.example.test/", ["https://basic.example.test/"]);
  assert.equal(seen[0].headers.authorization, `Basic ${Buffer.from(`example:${SECRET}`).toString("base64")}`);
});

test("credentials load decrypted for enabled sites only, for the agents", async () => {
  const id = (await call("POST", "/api/research-sites", { as: OWNER, body: { ...SITE, name: "Example Loader", domains: "loader.example.org" } })).data.site.id;
  await call("PUT", `/api/research-sites/${id}/credential`, { as: OWNER, body: { kind: "query", name: "api_key", value: SECRET } });
  let got = (await Sites.loadCredentials(env)).find((x) => x.id === id);
  assert.deepEqual(got.secret, { name: "api_key", value: SECRET });
  assert.deepEqual(got.domains, ["loader.example.org"]);
  await call("PUT", `/api/research-sites/${id}`, { as: OWNER, body: { enabled: false } });
  assert.equal((await Sites.loadCredentials(env)).find((x) => x.id === id), undefined);
  // without the key, nothing is applied (and nothing breaks)
  await call("PUT", `/api/research-sites/${id}`, { as: OWNER, body: { enabled: true } });
  const errs = [];
  assert.deepEqual(await Sites.loadCredentials({ DB: env.DB }, { onError: (r) => errs.push(r.id) }), []);
  assert.ok(errs.includes(id));
});

test("a credential echoed back by a site is scrubbed before the model or the logs see it", async () => {
  const { scrubSecrets } = await import("../worker/agent/sites.js");
  const cred = { kind: "query", secret: { name: "key", value: "s3cret/key+value" } };
  const page = { finalUrl: "https://query.example.test/r?key=s3cret%2Fkey%2Bvalue", content: "Your key is s3cret/key+value." };
  const out = JSON.parse(scrubSecrets(JSON.stringify(page), cred));
  assert.ok(!JSON.stringify(out).includes("s3cret"), "no trace of the value");
  assert.match(out.content, /\[credential\]/);
  const basic = { kind: "basic", secret: { username: "example", password: "hunter22" } };
  assert.equal(scrubSecrets(`pw hunter22 auth ${btoa("example:hunter22")}`, basic), "pw [credential] auth [credential]");
  assert.equal(scrubSecrets("short values aren't scrubbed: abc", { secret: { value: "abc" } }), "short values aren't scrubbed: abc");
});
