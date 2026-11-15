// Identity (Cloudflare Access JWT, verified here as defense in depth) and per-tree grants.
// Why not ctx.access: Static Assets don't pass it through; see docs/agents/operations.md.
import { S } from "../strings/index.ts";

const ROLE_RANK = { agent: 1, member: 1, editor: 2, owner: 3 };

let jwksCache = { at: 0, keys: null, team: null };

/** Returns {ok, principal, kind, email} or {ok:false, error}. */
export async function identify(request, env) {
  if (env.ALLOW_UNAUTHENTICATED === "true") {
    // Local development only. DEV_PRINCIPAL lets you test as someone else (e.g. "agent:test" or a member's email).
    const p = (request.headers.get("X-Dev-Principal") || env.DEV_PRINCIPAL || env.OWNER_EMAIL || "dev@localhost").toLowerCase();
    return { ok: true, principal: p, kind: p.startsWith("service:") || p.startsWith("agent:") ? "agent" : "person", email: p };
  }
  const team = (env.ACCESS_TEAM_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const aud = env.ACCESS_AUD;
  if (!team || !aud) return { ok: false, error: S.api.auth.accessNotConfigured };
  const token = request.headers.get("Cf-Access-Jwt-Assertion") || cookie(request, "CF_Authorization");
  if (!token) return { ok: false, error: S.api.auth.notSignedIn };
  try {
    const [h64, p64, s64] = token.split(".");
    const header = JSON.parse(b64text(h64));
    const payload = JSON.parse(b64text(p64));
    const t = Math.floor(Date.now() / 1000);
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(aud)) throw new Error("audience mismatch");
    if (payload.iss !== `https://${team}`) throw new Error("issuer mismatch");
    if (payload.exp && payload.exp < t) throw new Error("expired");
    if (payload.nbf && payload.nbf > t + 60) throw new Error("not yet valid");
    const key = await accessKey(team, header.kid);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64bytes(s64), new TextEncoder().encode(`${h64}.${p64}`));
    if (!ok) throw new Error("bad signature");
    if (payload.email) return { ok: true, principal: payload.email.toLowerCase(), kind: "person", email: payload.email };
    if (payload.common_name) return { ok: true, principal: `service:${payload.common_name}`, kind: "agent" };
    throw new Error("token has neither an email nor a service-token name");
  } catch (e) {
    return { ok: false, error: S.api.auth.invalidToken(e.message) };
  }
}

/** Everything the app needs to know about the caller. No grant and not the owner means no trees. */
export async function resolveAccess(env, ident) {
  const principal = ident.principal;
  const member = await env.DB.prepare("SELECT * FROM members WHERE principal = ?").bind(principal).first();
  const ownerEmails = (env.OWNER_EMAIL || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  const isOwner = ownerEmails.includes(principal) || !!(member && member.is_owner);
  const kind = member ? member.kind : ident.kind;
  const trees = (await env.DB.prepare("SELECT id, name, definition FROM trees ORDER BY rowid").all()).results;
  let grants;
  if (isOwner) {
    grants = trees.map((t) => ({ tree_id: t.id, role: "owner", view_id: null }));
  } else {
    grants = (await env.DB.prepare("SELECT tree_id, role, view_id FROM grants WHERE principal = ?").bind(principal).all()).results
      .filter((g) => trees.some((t) => t.id === g.tree_id));
  }
  const treeById = Object.fromEntries(trees.map((t) => [t.id, t]));
  return {
    principal, kind, isOwner,
    displayName: (member && member.display_name) || ident.email || principal,
    personId: (member && member.person_id) || null,
    grants: grants.map((g) => ({ ...g, tree_name: treeById[g.tree_id].name })),
    treeById,
  };
}

/** Pick the grant for ?tree= (or the first one). */
export function grantFor(access, treeId) {
  if (!access.grants.length) return null;
  return treeId ? access.grants.find((g) => g.tree_id === treeId) || null : access.grants[0];
}

export const can = {
  view: (g) => !!g,
  editTodos: (g) => g && ROLE_RANK[g.role] >= ROLE_RANK.editor,
  review: (g) => g && ROLE_RANK[g.role] >= ROLE_RANK.editor,
  propose: (g) => !!g,
  createTodo: (g) => !!g,
  admin: (access) => access.isOwner,
};

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
