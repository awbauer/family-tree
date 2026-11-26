// Fan charts. Ancestors: a half circle, parents outside their child. Descendants: a full circle (sunburst), each
// person's slice sized by how many descendants it holds. The home page shows the ancestor fan with links to each
// person's page; the tree page's Fan view draws the same shapes inside its pan/zoom canvas.
import { Fragment, type ReactNode } from "react";
import { Link } from "react-router";
import { branchColor, isUnknown, years } from "../../lib";
import { byBirth, spousesOf } from "../../tree";
import { useBrowse, type BTree } from "./shared";

type Branches = Parameters<typeof branchColor>[1];
import { S } from "../../../../strings/index.ts";

const R0 = 58;
const RING = [0, 62, 62, 62, 70, 74, 78, 82];

/** How a slice is wrapped: a link on the home page, a clickable group (data-id) on the tree page. */
export type Wrap = (id: string, key: string, shape: ReactNode) => ReactNode;
export interface Fan { content: ReactNode; width: number; height: number }

const pt = (cx: number, cy: number, r: number, a: number) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
function wedge(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number) {
  // A whole ring (an only child in the sunburst): an arc whose ends meet isn't drawn, so each circle is two half
  // arcs, the inner one the other way round so it cuts a hole.
  if (a1 - a0 >= 2 * Math.PI - 1e-6) {
    return `M${cx + r1},${cy} A${r1},${r1} 0 1 1 ${cx - r1},${cy} A${r1},${r1} 0 1 1 ${cx + r1},${cy} Z ` +
      `M${cx + r0},${cy} A${r0},${r0} 0 1 0 ${cx - r0},${cy} A${r0},${r0} 0 1 0 ${cx + r0},${cy} Z`;
  }
  const [x0, y0] = pt(cx, cy, r0, a0), [x1, y1] = pt(cx, cy, r1, a0), [x2, y2] = pt(cx, cy, r1, a1), [x3, y3] = pt(cx, cy, r0, a1);
  const big = a1 - a0 > Math.PI ? 1 : 0;
  return `M${x0},${y0} L${x1},${y1} A${r1},${r1} 0 ${big} 1 ${x2},${y2} L${x3},${y3} A${r0},${r0} 0 ${big} 0 ${x0},${y0} Z`;
}
const clipTo = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + "…" : t);

/**
 * A label sized to its slice. Near the middle: two centred lines. In a wide slice: one line along the curve. Otherwise
 * along the radius, as much of the name as the ring's width holds (the first name alone if the whole doesn't fit).
 * A slice too thin for text gets none; its tooltip still names them.
 */
function label(p: { given: string; surname: string }, g: number, cx: number, cy: number, r0: number, r1: number, am: number, span: number): ReactNode {
  const fs = g <= 2 ? 12 : g === 3 ? 10.5 : 9.5;
  const fill = g <= 3 ? "#fff" : "var(--ink)";
  const rm = (r0 + r1) / 2, ring = r1 - r0, arc = span * rm;
  const [tx, ty] = pt(cx, cy, rm, am);
  const given = p.given.split(" ")[0], full = `${given} ${p.surname}`.trim();
  const fits = (room: number, size: number) => Math.max(0, Math.floor(room / (size * 0.58)));
  const deg = ((am * 180) / Math.PI + 360) % 360;
  if (g <= 2 && arc > 70) {
    const n = fits(arc * 0.8, fs);
    return <>
      <text x={tx} y={ty - 4} textAnchor="middle" fontSize={fs} fontWeight="600" style={{ fill }}>{clipTo(given, n)}</text>
      <text x={tx} y={ty + 10} textAnchor="middle" fontSize={fs - 1.5} style={{ fill }} opacity=".9">{clipTo(p.surname, fits(arc * 0.8, fs - 1.5))}</text>
    </>;
  }
  if (arc >= ring * 1.4) { // along the curve, kept upright
    let rot = (deg + 90) % 360;
    if (rot > 90 && rot < 270) rot -= 180;
    return <text x={tx} y={ty} transform={`rotate(${rot} ${tx} ${ty})`} textAnchor="middle" dominantBaseline="middle" fontSize={fs} fontWeight="500" style={{ fill }}>
      {clipTo(full, fits(arc * 0.85, fs))}</text>;
  }
  if (arc < fs * 0.9) return null;
  const n = fits(ring - 8, fs);
  const rot = deg > 90 && deg < 270 ? deg + 180 : deg; // along the radius, kept upright
  return <text x={tx} y={ty} transform={`rotate(${rot} ${tx} ${ty})`} textAnchor="middle" dominantBaseline="middle" fontSize={fs} fontWeight="500" style={{ fill }}>
    {clipTo(full.length <= n ? full : given, n)}</text>;
}

/** The root person in the middle. `dy` lifts the name into the visible top half of the ancestor fan. */
function centre(D: BTree, rootId: string, cx: number, cy: number, wrap: Wrap, dy = 0) {
  const root = D.people[rootId];
  return wrap(rootId, "root", <>
    <circle cx={cx} cy={cy} r={R0} style={{ fill: "var(--accent)" }}><title>{`${root.name} (${years(root)})`}</title></circle>
    <text x={cx} y={cy - 4 + dy} textAnchor="middle" fontSize="15" fontWeight="600" style={{ fill: "var(--accent-ink)", fontFamily: "var(--serif)" }}>{clipTo(root.given.split(" ")[0], 10)}</text>
    <text x={cx} y={cy + 12 + dy} textAnchor="middle" fontSize="12" style={{ fill: "var(--accent-ink)" }} opacity=".9">{clipTo(root.surname, 12)}</text>
  </>);
}

/** Ancestors as a half circle: the root at the bottom centre, each ring a generation, father left of mother. */
export function ancestorFan(D: BTree, branches: Branches, rootId: string, gens: number, wrap: Wrap): Fan {
  const P = D.people, F = D.families;
  const radii = [R0];
  for (let g = 1; g <= gens; g++) radii[g] = radii[g - 1] + (RING[g] || RING[RING.length - 1]);
  const size = radii[gens] + 6;
  const slots: (string | null)[][] = [[rootId]];
  for (let g = 1; g <= gens; g++) {
    slots[g] = [];
    for (const id of slots[g - 1]) {
      const fid = id && P[id] && P[id].famc[0];
      slots[g].push(fid && F[fid] ? F[fid].husband || null : null, fid && F[fid] ? F[fid].wife || null : null);
    }
  }
  const out: ReactNode[] = [];
  for (let g = 1; g <= gens; g++) {
    const n = slots[g].length, span = Math.PI / n;
    slots[g].forEach((id, i) => {
      const a0 = Math.PI + i * span, a1 = a0 + span, r0 = radii[g - 1] + 2, r1 = radii[g];
      const p = id ? P[id] : undefined;
      const known = !!p && !isUnknown(p);
      const fill = known ? `color-mix(in srgb, ${branchColor(p!.branch, branches)} ${Math.max(20, 92 - g * 12)}%, var(--card))` : "var(--paper-2)"; // strings-ok (CSS)
      const shape = <>
        <path d={wedge(size, size, r0, r1, a0, a1)} style={{ fill }} stroke="var(--card)" strokeWidth="1.5"><title>{known ? `${p!.name} (${years(p)})` : S.browse.fan.unknown}</title></path>
        {known && label(p!, g, size, size, r0, r1, (a0 + a1) / 2, span)}
      </>;
      const key = `${g}-${i}`;
      out.push(known ? wrap(id!, key, shape) : <Fragment key={key}>{shape}</Fragment>);
    });
  }
  out.push(centre(D, rootId, size, size, wrap, -14));
  return { content: <>{out}</>, width: size * 2, height: size + 4 };
}

/** Descendants as a full circle: each child's slice sits outside its parent's, sized by its own descendants. */
export function descendantFan(D: BTree, branches: Branches, rootId: string, gens: number, wrap: Wrap): Fan {
  const P = D.people, bb = byBirth(D);
  const kids = (id: string) => spousesOf(D, id).flatMap((s) => s.children.slice().sort(bb)).filter((c, i, a) => P[c] && a.indexOf(c) === i);
  const weight = new Map<string, number>();
  const leaves = (id: string, g: number): number => {
    const k = g < gens ? kids(id) : [];
    const w = k.length ? k.reduce((s, c) => s + leaves(c, g + 1), 0) : 1;
    weight.set(`${g}:${id}`, w);
    return w;
  };
  leaves(rootId, 0);
  const radii = [R0];
  for (let g = 1; g <= gens; g++) radii[g] = radii[g - 1] + (RING[g] || RING[RING.length - 1]);
  const size = radii[gens] + 6;
  const out: ReactNode[] = [];
  const draw = (id: string, g: number, a0: number, a1: number) => {
    if (g >= gens) return;
    const k = kids(id), total = weight.get(`${g}:${id}`) || 1;
    let a = a0;
    k.forEach((c, i) => {
      const span = ((a1 - a0) * (weight.get(`${g + 1}:${c}`) || 1)) / total, b = a + span;
      const p = P[c], r0 = radii[g] + 2, r1 = radii[g + 1];
      const fill = `color-mix(in srgb, ${branchColor(p.branch, branches)} ${Math.max(20, 92 - (g + 1) * 12)}%, var(--card))`; // strings-ok (CSS)
      out.push(wrap(c, `${g + 1}-${c}-${i}`, <>
        <path d={wedge(size, size, r0, r1, a, b)} style={{ fill }} stroke="var(--card)" strokeWidth="1.5"><title>{`${p.name} (${years(p)})`}</title></path>
        {label(p, g + 1, size, size, r0, r1, (a + b) / 2, span)}
      </>));
      draw(c, g + 1, a, b);
      a = b;
    });
  };
  draw(rootId, 0, -Math.PI / 2, (3 * Math.PI) / 2); // start at the top, clockwise
  out.push(centre(D, rootId, size, size, wrap));
  return { content: <>{out}</>, width: size * 2, height: size * 2 };
}

/** The home page's fan: five generations of ancestors, each linking to their page. */
export function FanChart({ rootId, gens }: { rootId: string; gens: number }) {
  const { D, branches } = useBrowse();
  if (!D.people[rootId]) return null;
  const fan = ancestorFan(D, branches, rootId, gens, (id, key, shape) => <Link key={key} to={`/person/${id}`}>{shape}</Link>);
  return (
    <svg viewBox={`0 0 ${fan.width} ${fan.height}`} role="img" aria-label={S.browse.fan.label(D.people[rootId].name)} fontFamily="Inter, system-ui, sans-serif">
      {fan.content}
    </svg>
  );
}
