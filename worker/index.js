/**
 * Family-tree Worker.
 *
 *   /api/tree        the whole tree bundle, assembled from D1
 *   /media/<key>     photos and documents from the R2 bucket (optional)
 *   everything else  static app from ./site (contains no family data)
 *
 * Privacy: family data is only served to requests carrying a valid Cloudflare Access
 * JWT for this application (ACCESS_TEAM_DOMAIN + ACCESS_AUD). Without that configuration
 * the API refuses — so a forgotten workers.dev URL or a misconfigured Access policy
 * fails closed instead of publishing living people's details.
 * Set ALLOW_UNAUTHENTICATED = "true" only for local development.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith("/api/");
    const isMedia = url.pathname.startsWith("/media/");
    if (!isApi && !isMedia) return env.ASSETS.fetch(request);

    const auth = await authorize(request, env);
    if (!auth.ok) return json({ error: auth.error }, 403);

    if (url.pathname === "/api/tree" && request.method === "GET") return tree(env);
    if (url.pathname === "/api/whoami") return json({ email: auth.email || null });
    if (isMedia) return media(url, env);
    return json({ error: "Not found" }, 404);
  },
};

async function tree(env) {
  if (!env.DB) return json({ error: "No D1 binding named DB. See README → Deploy." }, 500);
  const rows = (sql) => env.DB.prepare(sql).all().then((r) => r.results);
  const [meta, people, families, sources, media, places, findings, stories, todos, issues] = await Promise.all([
    rows("SELECT key, value FROM meta"),
    rows("SELECT id, data FROM people"),
    rows("SELECT id, data FROM families"),
    rows("SELECT id, data FROM sources"),
    rows("SELECT id, data FROM media"),
    rows("SELECT key AS id, data FROM places"),
    rows("SELECT data FROM findings ORDER BY id"),
    rows("SELECT data FROM stories"),
    rows("SELECT data FROM todos ORDER BY id"),
    rows("SELECT data FROM issues ORDER BY id"),
  ]);
  const m = Object.fromEntries(meta.map((r) => [r.key, JSON.parse(r.value)]));
  if (!m.home) return json({ error: "The database is empty. Load build/seed.sql (see README)." }, 404);
  const byId = (list) => Object.fromEntries(list.map((r) => [r.id, JSON.parse(r.data)]));
  const list = (l) => l.map((r) => JSON.parse(r.data));
  const research = Object.assign({}, m.research, { findings: list(findings), stories: list(stories), todo: list(todos) });
  const body = {
    generated: m.generated, home: m.home,
    people: byId(people), families: byId(families), sources: byId(sources), media: byId(media),
    places: byId(places), issues: list(issues), research,
  };
  return json(body, 200, { "Cache-Control": "private, max-age=60" });
}

async function media(url, env) {
  if (!env.MEDIA) return json({ error: "No R2 binding named MEDIA." }, 404);
  const key = decodeURIComponent(url.pathname.slice("/media/".length));
  if (!key || key.includes("..")) return json({ error: "Bad key" }, 400);
  const obj = await env.MEDIA.get(key);
  if (!obj) return json({ error: "Not found" }, 404);
  const headers = new Headers({ "Cache-Control": "private, max-age=86400" });
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  return new Response(obj.body, { headers });
}

// ---------------------------------------------------------------- Cloudflare Access JWT check
let jwksCache = { at: 0, keys: null, team: null };

async function authorize(request, env) {
  if (env.ALLOW_UNAUTHENTICATED === "true") return { ok: true };
  const team = (env.ACCESS_TEAM_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const aud = env.ACCESS_AUD;
  if (!team || !aud) return { ok: false, error: "Cloudflare Access is not configured (set ACCESS_TEAM_DOMAIN and ACCESS_AUD). Refusing to serve family data." };
  const token = request.headers.get("Cf-Access-Jwt-Assertion") || cookie(request, "CF_Authorization");
  if (!token) return { ok: false, error: "Not signed in through Cloudflare Access." };
  try {
    const [h64, p64, s64] = token.split(".");
    const header = JSON.parse(b64text(h64));
    const payload = JSON.parse(b64text(p64));
    const now = Math.floor(Date.now() / 1000);
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(aud)) throw new Error("audience mismatch");
    if (payload.iss !== `https://${team}`) throw new Error("issuer mismatch");
    if (payload.exp && payload.exp < now) throw new Error("expired");
    if (payload.nbf && payload.nbf > now + 60) throw new Error("not yet valid");
    const key = await accessKey(team, header.kid);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64bytes(s64), new TextEncoder().encode(`${h64}.${p64}`));
    if (!ok) throw new Error("bad signature");
    return { ok: true, email: payload.email };
  } catch (e) {
    return { ok: false, error: "Invalid Access token: " + e.message };
  }
}

async function accessKey(team, kid) {
  if (!jwksCache.keys || jwksCache.team !== team || Date.now() - jwksCache.at > 3600_000 || !jwksCache.keys[kid]) {
    const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
    const { keys } = await res.json();
    const imported = {};
    for (const k of keys) imported[k.kid] = await crypto.subtle.importKey("jwk", k, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    jwksCache = { at: Date.now(), keys: imported, team };
  }
  const k = jwksCache.keys[kid];
  if (!k) throw new Error("unknown signing key");
  return k;
}

function b64bytes(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const b64text = (s) => new TextDecoder().decode(b64bytes(s));
function cookie(request, name) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}
function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: Object.assign({ "Content-Type": "application/json; charset=utf-8", "X-Robots-Tag": "noindex" }, extra) });
}
