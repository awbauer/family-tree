// The derived tree, cached per data_version, and its per-grant scoped views. Shared by the HTTP routes and by
// background work (agent runs, the content job), which has no request: scopedFor() resolves a principal's access
// the same way a request would, so an agent never sees more than the person who started it.
import * as Derive from "./derive.js";
import { resolveAccess, grantFor, can } from "./auth.js";
import { scopeBundle, validTreeDefinition, validViewFilter } from "./scope.js";
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
  const key = JSON.stringify([version, access.principal, grant.tree_id, grant.view_id, access.personId, access.isOwner, grant.role, access.treeById[grant.tree_id]?.definition]);
  if (scopedCache.has(key)) return scopedCache.get(key);
  const t = access.treeById[grant.tree_id];
  const definition = parse(t.definition);
  if (!validTreeDefinition(definition)) fail(403, S.api.auth.noTreeAccess);
  const tree = { id: t.id, name: t.name, definition };
  let view = null;
  if (grant.view_id) {
    const vr = await env.DB.prepare("SELECT filter FROM views WHERE id = ?").bind(grant.view_id).first();
    const filter = parse(vr?.filter);
    if (!validViewFilter(filter)) fail(403, S.api.auth.noTreeAccess);
    view = filter;
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
  const access = await resolveAccess(env, { principal, kind: /^(service|agent):/.test(principal) ? "agent" : "person" });
  const grant = grantFor(access, treeId);
  if (!grant) return null;
  return { access, grant, bundle: await scopeFor(env, access, grant) };
}


// Conversation and run outputs can contain private free text. Preserve access after a view expands, but only if
// everything the earlier run was permitted to read is still visible now.
const disclosureFields = ["notes", "sources", "research", "media"];
function disclosureLevel(bundle, person) {
  return person.private ? (bundle.scope.view.living === "anonymous" ? 1 : 2) : 3;
}

export function disclosureScope(bundle) {
  return JSON.stringify({
    fields: disclosureFields.filter((field) => bundle.scope.view[field]),
    people: Object.entries(bundle.people).map(([id, person]) => [id, disclosureLevel(bundle, person)]),
  });
}

export async function canReadDisclosure(env, bundle, saved) {
  const before = parse(saved);
  if (!before) {
    // Legacy rows have no record of who could be read. Only a viewer with the full tree can read them.
    const { full } = await fullBundle(env);
    return disclosureFields.every((field) => bundle.scope.view[field]) &&
      Object.keys(full.people).every((id) => Object.hasOwn(bundle.people, id) && !bundle.people[id].private);
  }
  if (!Array.isArray(before.fields) || !Array.isArray(before.people)) return false;
  return before.fields.every((field) => bundle.scope.view[field]) &&
    before.people.every(([id, level]) => Object.hasOwn(bundle.people, id) && disclosureLevel(bundle, bundle.people[id]) >= level);
}

export async function scopedForRun(env, run) {
  const sc = await scopedFor(env, run.started_by, run.tree_id);
  if (!sc || !can.review(sc.grant) || !sc.bundle.scope.view.research || (run.scope_access && !(await canReadDisclosure(env, sc.bundle, run.scope_access)))) return null;
  return sc;
}
