// The derived tree, cached per data_version, and its per-grant scoped views. Shared by the HTTP routes and by
// background work (agent runs, the content job), which has no request: scopedFor() resolves a principal's access
// the same way a request would, so an agent never sees more than the person who started it.
import * as Derive from "./derive.js";
import { resolveAccess, grantFor } from "./auth.js";
import { scopeBundle } from "./scope.js";
import { now, parse, dataVersion, loadState } from "./db.js";
import { fail } from "./http.js";
import { S } from "../strings/index.ts";

let derivedCache = { version: -1, full: null, db: null };
const scopedCache = new Map();

export async function fullBundle(env) {
  const v = await dataVersion(env);
  if (derivedCache.version !== v || derivedCache.db !== env.DB) { // per database too (one Worker, one DB; tests use many)
    const state = await loadState(env);
    if (!state.research.home_person && !Object.keys(state.raw.people).length) fail(404, S.api.http.emptyDatabase);
    const full = Derive.derive({ raw: state.raw, research: state.research, places: state.places }, { today: now().slice(0, 10) });
    full.aliases = state.aliases;
    // AI-written profiles; scope.js drops them for views that reduce a living person to a name
    for (const r of state.profiles || []) {
      const p = full.people[r.person_id];
      if (p) p.profile = { text: r.text, generated_at: r.generated_at, model: r.model };
    }
    derivedCache = { version: v, full, db: env.DB };
    scopedCache.clear();
  }
  return derivedCache;
}

/** The bundle as `access` sees it under `grant` (cached). */
export async function scopeFor(env, access, grant) {
  const { version, full } = await fullBundle(env);
  const key = `${version}|${derivedCache.db === env.DB ? "" : "x"}|${access.principal}|${grant.tree_id}|${grant.view_id || ""}|${access.personId || ""}|${access.isOwner}|${grant.role}`;
  if (scopedCache.has(key)) return scopedCache.get(key);
  const t = access.treeById[grant.tree_id];
  const tree = { id: t.id, name: t.name, definition: parse(t.definition, { branches: ["*"] }) };
  let view = null;
  if (grant.view_id) {
    const vr = await env.DB.prepare("SELECT filter FROM views WHERE id = ?").bind(grant.view_id).first();
    view = vr ? parse(vr.filter, {}) : { living: "hidden", research: false, notes: false, media: false, sources: false }; // missing view fails closed
  }
  const out = scopeBundle(full, {
    tree, view, viewerPersonId: access.personId, isOwner: access.isOwner,
    helpers: { relationLabels: Derive.relationLabels, checkIssues: Derive.checkIssues },
  });
  out.me = { principal: access.principal, role: grant.role, tree: grant.tree_id, isOwner: access.isOwner };
  if (scopedCache.size > 50) scopedCache.clear();
  scopedCache.set(key, out);
  return out;
}

/** For background work: what `principal` can see of `treeId`, or null if they no longer have access. */
export async function scopedFor(env, principal, treeId) {
  const access = await resolveAccess(env, { principal, kind: "person" });
  const grant = grantFor(access, treeId);
  if (!grant) return null;
  return { access, grant, bundle: await scopeFor(env, access, grant) };
}
