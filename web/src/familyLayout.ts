// The "family graph" layout: generations as rows (parents above, children below), with the focus person's siblings
// and spouses on their row. Used by the graph on each person page and by the Family view of the tree page.
import type { Tree } from "./types";

export const FW = 168, FH = 52, FGX = 14, FGY = 48, FPAD = 10;

export function rels(D: Tree) {
  const P = D.people, F = D.families;
  const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x && !!P[x]))];
  const birth = (x: string) => ((P[x] && (P[x].birth as any) && (P[x].birth as any).sort) || 99999999);
  const parents = (x: string) => uniq((P[x].famc || []).flatMap((f) => (F[f] ? [F[f].husband, F[f].wife] : [])));
  const couples = (x: string) => (P[x].fams || []).map((f) => F[f]).filter(Boolean);
  const spouses = (x: string) => uniq(couples(x).map((f) => (f.husband === x ? f.wife : f.husband)));
  const children = (x: string) => uniq(couples(x).flatMap((f) => f.children || []).sort((a, b) => birth(a) - birth(b)));
  const siblings = (x: string) => uniq((P[x].famc || []).flatMap((f) => (F[f] ? F[f].children || [] : []))).filter((y) => y !== x).sort((a, b) => birth(a) - birth(b));
  return { parents, spouses, children, siblings };
}
export type Rels = ReturnType<typeof rels>;

export interface FamilyLayout {
  placed: Set<string>;
  pos: Map<string, { x: number; y: number }>;
  edges: { a: string; b: string; kind: "pc" | "sp" }[];
  width: number;
  height: number;
}

/**
 * Place `id`'s family: `up` generations of ancestors, `down` of descendants, siblings and spouses on the focus row.
 * `extra` people (a highlighted relationship path) are brought in next to the relative they connect to.
 */
export function familyLayout(D: Tree, R: Rels, id: string, view: { up: number; down: number; sibs: boolean }, extra: Set<string> = new Set()): FamilyLayout {
  const P = D.people;
  const rows = new Map<number, string[]>(), placed = new Set<string>();
  const put = (g: number, xs: string[]) => { const r = rows.get(g) || []; for (const x of xs) if (!placed.has(x)) { placed.add(x); r.push(x); } rows.set(g, r); };
  put(0, [...(view.sibs ? R.siblings(id) : []), id, ...R.spouses(id)]);
  let up = [id];
  for (let g = 1; g <= view.up; g++) { up = up.flatMap(R.parents); put(-g, up); up = rows.get(-g) || []; if (!up.length) break; }
  let down = [id];
  for (let g = 1; g <= view.down; g++) { down = down.flatMap(R.children); put(g, down); down = rows.get(g) || []; if (!down.length) break; }
  const genOf = new Map<string, number>();
  for (const [g, r] of rows) for (const x of r) genOf.set(x, g);
  for (let changed = true; changed;) {
    changed = false;
    for (const x of extra) {
      if (placed.has(x) || !P[x]) continue;
      const pa = R.parents(x).find((y) => genOf.has(y)), ch = R.children(x).find((y) => genOf.has(y)), sp = R.spouses(x).find((y) => genOf.has(y));
      const g = pa ? genOf.get(pa)! + 1 : ch ? genOf.get(ch)! - 1 : sp ? genOf.get(sp)! : null;
      if (g == null) continue;
      put(g, [x]); genOf.set(x, g); changed = true;
    }
  }

  const gens = [...rows.keys()].filter((g) => rows.get(g)!.length).sort((a, b) => a - b);
  const maxN = Math.max(...gens.map((g) => rows.get(g)!.length));
  const width = Math.max(maxN * (FW + FGX) - FGX + FPAD * 2, FW + FPAD * 2);
  const pos = new Map<string, { x: number; y: number }>();
  gens.forEach((g, gi) => {
    const r = rows.get(g)!, rw = r.length * (FW + FGX) - FGX, x0 = (width - rw) / 2;
    r.forEach((x, i) => pos.set(x, { x: x0 + i * (FW + FGX), y: FPAD + gi * (FH + FGY) }));
  });
  const height = FPAD * 2 + gens.length * (FH + FGY) - FGY;
  const edges: FamilyLayout["edges"] = [];
  for (const x of placed) {
    for (const p of R.parents(x)) if (pos.has(p)) edges.push({ a: p, b: x, kind: "pc" });
    for (const s of R.spouses(x)) if (pos.has(s) && x < s) edges.push({ a: x, b: s, kind: "sp" });
  }
  return { placed, pos, edges, width, height };
}

/** SVG path for an edge: a curve from parent to child, or a dashed link between spouses. */
export function edgePath(A: { x: number; y: number }, B: { x: number; y: number }, kind: "pc" | "sp") {
  if (kind === "sp") {
    const [L, Rt] = A.x < B.x ? [A, B] : [B, A];
    return `M${L.x + FW},${L.y + FH / 2} ${L.y === Rt.y ? `L${Rt.x},${Rt.y + FH / 2}` : `C${L.x + FW + 30},${L.y + FH / 2} ${Rt.x - 30},${Rt.y + FH / 2} ${Rt.x},${Rt.y + FH / 2}`}`;
  }
  const x1 = A.x + FW / 2, y1 = A.y + FH, x2 = B.x + FW / 2, y2 = B.y, my = (y1 + y2) / 2;
  return `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
}
