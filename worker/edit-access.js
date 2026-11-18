// A scoped family can contain a reduced set of people. Editing its underlying row requires the full family.
import { S } from "../strings/index.ts";
import { canReadDisclosure } from "./bundle.js";
import { parse } from "./db.js";
import { followAlias } from "./scope.js";
import { storyPeople } from "./stories.js";

export const detailsVisible = (bundle, id) => Object.hasOwn(bundle.people, id) && !bundle.people[id].private;
export const familyPeople = (family) => [family?.husband, family?.wife, ...(family?.children || [])].filter(Boolean);
export const familyVisible = (bundle, family, visible = (id) => detailsVisible(bundle, id)) =>
  familyPeople(family).every(visible);

export function editScopeError(bundle, result) {
  const created = new Set(result.touched.filter((x) => x.type === "person" && x.before == null).map((x) => x.id));
  const person = (id) => detailsVisible(bundle, id) || created.has(id);
  for (const x of result.touched) {
    if ((x.type === "person" || x.type === "media_map") && x.before != null && !person(x.id)) return S.api.edit.sourceCitedOutsidePeople;
    if (x.type === "source" && x.before != null && !Object.hasOwn(bundle.sources, x.id)) return S.api.edit.sourceNotVisible(x.id);
    if (x.type === "family" && (!familyVisible(bundle, x.before, person) || !familyVisible(bundle, x.after, person))) {
      return S.api.edit.sourceCitedOutsideFamilies;
    }
  }
  return null;
}

export async function batchVisible(env, bundle, batchId) {
  const rows = (await env.DB.prepare("SELECT entity_type, entity_id, before, after FROM changes WHERE batch_id = ?").bind(batchId).all()).results;
  const person = (id) => detailsVisible(bundle, followAlias(bundle.aliases, id));
  const family = (raw) => familyVisible(bundle, parse(raw), person);
  const canRestoreSource = rows.some((row) => row.entity_type === "source" && row.after == null) &&
    await canReadDisclosure(env, bundle, null);
  return rows.every((row) => {
    const { entity_type: type, entity_id: id } = row;
    if (type === "person") return person(id);
    if (type === "status") return bundle.scope.view.research && person(id);
    if (type === "family") return family(row.before) && family(row.after);
    if (type === "source") return bundle.scope.view.sources &&
      (Object.hasOwn(bundle.sources, id) || (row.after == null && canRestoreSource));
    if (type === "story") return [row.before, row.after].every((v) => storyPeople(parse(v)).every(person));
    if (type === "finding") return (bundle.research.findings || []).some((f) => String(f.id) === id);
    if (type === "config" && id === "media_map") {
      return bundle.scope.view.media && [row.before, row.after].every((value) => Object.keys(parse(value) || {}).every(person));
    }
    if (type === "config" && id === "aliases") {
      const before = parse(row.before)?.["*"] || {}, after = parse(row.after)?.["*"] || {};
      return [...new Set([...Object.keys(before), ...Object.keys(after)])].every((from) =>
        before[from] === after[from] || (
          person(from) && (!before[from] || person(before[from])) && (!after[from] || person(after[from]))
        ));
    }
    return false;
  });
}
