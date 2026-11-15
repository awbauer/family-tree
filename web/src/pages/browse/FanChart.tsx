// A half-circle fan chart of someone's ancestors. Each known ancestor links to their page.
import { Fragment, type ReactNode } from "react";
import { Link } from "react-router";
import { branchColor, isUnknown, years } from "../../lib";
import { useBrowse } from "./shared";

const R0 = 58, W = [0, 62, 62, 62, 70, 74];

export function FanChart({ rootId, gens }: { rootId: string; gens: number }) {
  const { D, branches } = useBrowse();
  const P = D.people, F = D.families;
  const radii = [R0];
  for (let g = 1; g <= gens; g++) radii[g] = radii[g - 1] + W[g];
  const size = radii[gens] + 6;
  const slots: (string | null)[][] = [[rootId]];
  for (let g = 1; g <= gens; g++) {
    slots[g] = [];
    for (const id of slots[g - 1]) {
      let fa: string | null = null, mo: string | null = null;
      const fid = id && P[id] && P[id].famc[0];
      if (fid && F[fid]) { fa = F[fid].husband || null; mo = F[fid].wife || null; }
      slots[g].push(fa, mo);
    }
  }
  const A0 = Math.PI, A1 = 2 * Math.PI; // top half, left -> right
  const pt = (r: number, a: number) => [size + r * Math.cos(a), size + r * Math.sin(a)];
  const out: ReactNode[] = [];
  for (let g = 1; g <= gens; g++) {
    const n = slots[g].length, span = (A1 - A0) / n;
    slots[g].forEach((id, i) => {
      const a0 = A0 + i * span, a1 = a0 + span, r0 = radii[g - 1] + 2, r1 = radii[g];
      const [x0, y0] = pt(r0, a0), [x1, y1] = pt(r1, a0), [x2, y2] = pt(r1, a1), [x3, y3] = pt(r0, a1);
      const d = `M${x0},${y0} L${x1},${y1} A${r1},${r1} 0 0 1 ${x2},${y2} L${x3},${y3} A${r0},${r0} 0 0 0 ${x0},${y0} Z`;
      const p = id ? P[id] : undefined;
      const known = !!p && !isUnknown(p);
      const fill = known ? `color-mix(in srgb, ${branchColor(p!.branch, branches)} ${92 - g * 12}%, var(--card))` : "var(--paper-2)";
      const am = (a0 + a1) / 2, rm = (r0 + r1) / 2;
      let label: ReactNode = null;
      if (known) {
        const fs = g <= 2 ? 12 : g === 3 ? 10.5 : 9.5;
        const txtFill = g <= 3 ? "#fff" : "var(--ink)";
        const [tx, ty] = pt(rm, am);
        if (g <= 2) {
          label = <>
            <text x={tx} y={ty - 4} textAnchor="middle" fontSize={fs} fontWeight="600" style={{ fill: txtFill }}>{p!.given.split(" ")[0]}</text>
            <text x={tx} y={ty + 10} textAnchor="middle" fontSize={fs - 1.5} style={{ fill: txtFill }} opacity=".9">{p!.surname}</text>
          </>;
        } else {
          const deg = (am * 180) / Math.PI;
          const rot = deg > 270 ? deg : deg + 180;
          const txt = g === 3 ? `${p!.given.split(" ")[0]} ${p!.surname}` : p!.given.split(" ")[0];
          const max = g === 3 ? 15 : 11;
          label = <text x={tx} y={ty} transform={`rotate(${rot} ${tx} ${ty})`} textAnchor="middle" dominantBaseline="middle" fontSize={fs} fontWeight="500" style={{ fill: txtFill }}>
            {txt.length > max ? txt.slice(0, max - 1) + "…" : txt}</text>;
        }
      }
      const title = known ? `${p!.name} (${years(p)})` : "Unknown — research opportunity";
      const shape = <><path d={d} style={{ fill }} stroke="var(--card)" strokeWidth="1.5"><title>{title}</title></path>{label}</>;
      const key = `${g}-${i}`;
      out.push(known ? <Link key={key} to={`/person/${id}`}>{shape}</Link> : <Fragment key={key}>{shape}</Fragment>);
    });
  }
  const root = P[rootId];
  if (!root) return null;
  return (
    <svg viewBox={`0 0 ${size * 2} ${size + 4}`} role="img" aria-label={`Fan chart of ${root.name}'s ancestors`} fontFamily="Inter, system-ui, sans-serif">
      {out}
      <Link to={`/person/${rootId}`}>
        <circle cx={size} cy={size} r={R0} style={{ fill: "var(--accent)" }} />
        <text x={size} y={size - 18} textAnchor="middle" fontSize="15" fontWeight="600" style={{ fill: "var(--accent-ink)", fontFamily: "var(--serif)" }}>{root.given.split(" ")[0]}</text>
        <text x={size} y={size - 2} textAnchor="middle" fontSize="12" style={{ fill: "var(--accent-ink)" }} opacity=".9">{root.surname}</text>
      </Link>
    </svg>
  );
}
