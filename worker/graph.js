// Graph queries over a derived bundle's people and families (issue #15). Dependency-free; runs in the Worker
// and in Node. Works only on what it is given: pass a scoped bundle (worker/scope.js) and every answer stays
// inside that scope, because links to IDs that are not in `people` are dropped when the index is built.

import { relationLabels } from "./derive.js";

const asMap = (x) => (Array.isArray(x) ? Object.fromEntries(x.filter(Boolean).map((v) => [v.id, v])) : x || {});
const gendered = (sex, m, f, n) => (sex === "M" ? m : sex === "F" ? f : n);

/**
 * Adjacency with typed edges. parents/children/spouses: Map id -> [ids], deduplicated, in data order.
 * Links to IDs missing from `people` (cut by scoping) are ignored.
 */
export function buildIndex(people, families) {
  const P = asMap(people), F = asMap(families);
  const ids = Object.keys(P);
  const parents = new Map(), children = new Map(), spouses = new Map();
  for (const id of ids) { parents.set(id, []); children.set(id, []); spouses.set(id, []); }
  const add = (m, from, to) => {
    if (!from || !to || from === to || !P[from] || !P[to]) return;
    const list = m.get(from);
    if (!list.includes(to)) list.push(to);
  };
  for (const f of Object.values(F)) {
    if (!f) continue;
    const h = f.husband, w = f.wife;
    add(spouses, h, w); add(spouses, w, h);
    for (const c of f.children || []) {
      for (const par of [h, w]) { add(parents, c, par); add(children, par, c); }
    }
  }
  return { people: P, families: F, ids, parents, children, spouses };
}

const has = (index, id) => !!id && index.parents.has(id);

function relWord(index, kind, to) {
  const sex = index.people[to]?.sex;
  if (kind === "parent") return gendered(sex, "father", "mother", "parent");
  if (kind === "child") return gendered(sex, "son", "daughter", "child");
  return gendered(sex, "husband", "wife", "spouse");
}
const KIND = { father: "parent", mother: "parent", parent: "parent", son: "child", daughter: "child", child: "child",
  husband: "spouse", wife: "spouse", spouse: "spouse" };

/** Breadth-first walk over one edge map; [{id, generation}] excluding the start, nearest generation wins. */
function walk(index, edges, id, generations = Infinity) {
  if (!has(index, id)) return [];
  const gen = new Map([[id, 0]]);
  const q = [id];
  for (let i = 0; i < q.length; i++) {
    const x = q[i], g = gen.get(x);
    if (g >= generations) continue;
    for (const y of edges.get(x)) if (!gen.has(y)) { gen.set(y, g + 1); q.push(y); }
  }
  gen.delete(id);
  return [...gen].map(([pid, generation]) => ({ id: pid, generation }));
}

export const ancestors = (index, id, generations) => walk(index, index.parents, id, generations ?? Infinity);
export const descendants = (index, id, generations) => walk(index, index.children, id, generations ?? Infinity);

/**
 * Nearest common ancestors of a and b (smallest total generation distance; a person counts as their own
 * ancestor at distance 0, so a parent is the common ancestor of itself and its child).
 * Returns [{id, fromA, fromB}], sorted by id for stability.
 */
export function commonAncestors(index, a, b) {
  if (!has(index, a) || !has(index, b)) return [];
  const up = (id) => new Map([[id, 0], ...walk(index, index.parents, id).map((x) => [x.id, x.generation])]);
  const A = up(a), B = up(b);
  let best = Infinity;
  const out = [];
  for (const [id, da] of A) {
    if (!B.has(id)) continue;
    const t = da + B.get(id);
    if (t < best) { best = t; out.length = 0; }
    if (t === best) out.push({ id, fromA: da, fromB: B.get(id) });
  }
  return out.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/**
 * Shortest path a -> b. Ties in length go to the path with fewer spouse links, then to data order.
 * `rel` names `to` relative to `from` ("from's father is to").
 */
export function relationshipPath(index, a, b, { maxDepth = 40 } = {}) {
  if (!has(index, a) || !has(index, b)) return { found: false };
  if (a === b) return { found: true, steps: [], label: "Self", commonAncestors: [a] };

  // layered BFS with cost (length, spouse links)
  const best = new Map([[a, { d: 0, s: 0, prev: null, kind: null }]]);
  let frontier = [a];
  for (let d = 0; d < maxDepth && frontier.length && !best.has(b); d++) {
    const next = [];
    for (const x of frontier) {
      const cx = best.get(x);
      const edges = [["parent", index.parents.get(x)], ["child", index.children.get(x)], ["spouse", index.spouses.get(x)]];
      for (const [kind, ys] of edges) for (const y of ys) {
        const s = cx.s + (kind === "spouse" ? 1 : 0);
        const cy = best.get(y);
        if (!cy) { best.set(y, { d: d + 1, s, prev: x, kind }); next.push(y); }
        else if (cy.d === d + 1 && s < cy.s) Object.assign(cy, { s, prev: x, kind });
      }
    }
    frontier = next;
  }
  if (!best.has(b)) return { found: false };

  const steps = [];
  for (let y = b; y !== a; y = best.get(y).prev) {
    const c = best.get(y);
    steps.push({ from: c.prev, to: y, rel: relWord(index, c.kind, y) });
  }
  steps.reverse();

  let label = null;
  try { label = relationLabels(index.people, index.families, a)[b]?.relation || null; } catch { label = null; }
  if (!label) label = chain(index, steps).map((t) => t.rel).join("'s ");

  return { found: true, steps, label, commonAncestors: commonAncestors(index, a, b).map((x) => x.id) };
}

/** Collapse parent-then-child pairs into siblings: [{from, to, rel}] with brother/sister/sibling allowed. */
function chain(index, steps) {
  const out = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i], n = steps[i + 1];
    if (n && KIND[s.rel] === "parent" && KIND[n.rel] === "child" && n.to !== s.from) {
      const sex = index ? index.people[n.to]?.sex : SEX_OF[n.rel];
      out.push({ from: s.from, to: n.to, rel: gendered(sex, "brother", "sister", "sibling") });
      i++;
    } else out.push(s);
  }
  return out;
}
const SEX_OF = { son: "M", daughter: "F" };

/** Connected components over all edges, largest first: [[ids]]. Unconnected people come out as small groups. */
export function components(index) {
  const seen = new Set(), out = [];
  for (const id of index.ids) {
    if (seen.has(id)) continue;
    const comp = [id];
    seen.add(id);
    for (let i = 0; i < comp.length; i++) {
      const x = comp[i];
      for (const y of [...index.parents.get(x), ...index.children.get(x), ...index.spouses.get(x)]) {
        if (!seen.has(y)) { seen.add(y); comp.push(y); }
      }
    }
    out.push(comp);
  }
  return out.sort((x, y) => y.length - x.length);
}

/** English sentence for a path: "Alice's father is Bob; Bob's sister is Carol". */
export function explain(path, people) {
  if (!path || !path.found) return "No relationship path found.";
  if (!path.steps.length) return "";
  const P = asMap(people);
  const name = (id) => P[id]?.name || id;
  return chain(null, path.steps).map((s) => `${name(s.from)}'s ${s.rel} is ${name(s.to)}`).join("; ");
}
