// Stories hidden from some or all trees (owner only), and why. A tree shows a story only when everyone the story is
// about (its `people`) is in that tree (worker/scope.js), so a story disappears when one of its people is removed from
// the tree, or sits outside a tree's branches. People merged since the story was written count as who they became.
//
//   GET /api/admin/stories/hidden   [{slug, title, era, branch, body, sources, people: [{id, state, name, into}], trees: [{id, name, hidden, outside}]}]
import { can } from "./auth.js";
import { fail, json } from "./http.js";
import { parse } from "./db.js";
import { fullBundle } from "./bundle.js";
import { treeMembers, followAlias } from "./scope.js";
import { S } from "../strings/index.ts";

/** Each story that some tree doesn't show, with the reasons. Pure, for tests. `removedNames` maps removed ids to names. */
export function hiddenStories(full, trees, removedNames = {}) {
  const members = trees.map((t) => ({ id: t.id, name: t.name, ids: treeMembers(full, parse(t.definition, { branches: ["*"] })) }));
  const out = [];
  for (const s of (full.research && full.research.stories) || []) {
    const people = (s.people || []).map((id) => {
      const to = followAlias(full.aliases, id);
      if (full.people[to]) return to === id ? { id, state: "ok", name: full.people[id].name } : { id, state: "merged", into: to, name: full.people[to].name };
      return { id, state: "removed", name: removedNames[id] || null };
    });
    const inTree = people.filter((p) => p.state !== "removed").map((p) => p.into || p.id);
    const removed = people.some((p) => p.state === "removed");
    const treesOut = members.map((m) => {
      const outside = inTree.filter((id) => !m.ids.has(id));
      return { id: m.id, name: m.name, hidden: removed || outside.length > 0, outside };
    });
    if (!treesOut.some((t) => t.hidden)) continue;
    out.push({ slug: s.slug, title: s.title, era: s.era || null, branch: s.branch || null, body: s.body || "", sources: s.sources || [], people, trees: treesOut });
  }
  return out;
}

export async function listHiddenStories(c) {
  if (!can.admin(c.access)) fail(403, S.api.auth.ownerOnly);
  const { full } = await fullBundle(c.env);
  const trees = (await c.env.DB.prepare("SELECT id, name, definition FROM trees ORDER BY rowid").all()).results;
  let stories = hiddenStories(full, trees);
  // removed people aren't in the tree any more: their names come from the change log's last snapshot of them
  const gone = [...new Set(stories.flatMap((s) => s.people.filter((p) => p.state === "removed").map((p) => p.id)))];
  if (gone.length) {
    const rows = (await c.env.DB.prepare(`SELECT entity_id, trim(coalesce(json_extract(before, '$.names[0].given'), '') || ' ' || coalesce(json_extract(before, '$.names[0].surname'), '')) AS name, at
      FROM changes WHERE entity_type = 'person' AND after IS NULL AND entity_id IN (${gone.map(() => "?").join(",")}) ORDER BY at`).bind(...gone).all()).results;
    const names = Object.fromEntries(rows.filter((r) => r.name).map((r) => [r.entity_id, r.name]));
    stories = hiddenStories(full, trees, names);
  }
  return json({ stories }, 200, { "Cache-Control": "private, no-store" });
}
