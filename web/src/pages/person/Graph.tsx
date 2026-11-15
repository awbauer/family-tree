// The parent/child/spouse graph around a person, drawn from the scoped bundle already in the page (so it shows exactly
// what this viewer may see). Solid lines: parent → child. Dashed: couples. A relationship path found by "How are we
// related?" is highlighted.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useData } from "../../data";
import { isUnknown } from "../../lib";
import type { Tree } from "../../types";
import { usePerson } from "./context";
import { S } from "../../../../strings/index.ts";

const T = S.person.graph;

const W = 168, H = 52, GX = 14, GY = 48, PAD = 10;
const edgeKey = (a: string, b: string) => [a, b].sort().join("~");
const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + "…" : t);

function rels(D: Tree) {
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

function loadView() {
  const st = { up: 2, down: 2, sibs: true };
  try { Object.assign(st, JSON.parse(sessionStorage.getItem("graphView") || "{}")); } catch { /* defaults */ }
  return st;
}

/** Pedigree completeness and connectedness: graph facts worth seeing at a glance. */
function Insights({ id }: { id: string }) {
  const { D } = useData();
  const { parents, children, spouses } = rels(D);
  const P = D.people;
  const gens: { g: number; found: number; possible: number }[] = [];
  let row = [id];
  for (let g = 1; g <= 5; g++) {
    row = row.flatMap(parents);
    gens.push({ g, found: new Set(row).size, possible: 2 ** g });
    if (!row.length) break;
  }
  const seen = new Set([id]), q = [id];
  while (q.length) { const x = q.shift()!; for (const y of [...parents(x), ...children(x), ...spouses(x)]) if (!seen.has(y)) { seen.add(y); q.push(y); } }
  const total = Object.values(P).filter((p) => !isUnknown(p)).length;
  const names = T.ancestors;
  return (
    <p className="small graph-stats">
      {gens.filter((x) => x.possible).map((x, i) => <Fragment key={x.g}>{i > 0 && " · "}<span title={T.recorded(names[x.g - 1])}>{T.found(x.found, x.possible, names[x.g - 1])}</span></Fragment>)/* the " · " stays outside the no-wrap spans, so the line can break there */}<br />
      {T.connected(seen.size - 1, total - 1)}{seen.size < total && <> <span className="muted">{T.notLinked(total - seen.size, P[id].given || P[id].name)}</span></>}.
    </p>
  );
}

export function Graph() {
  const { D } = useData();
  const { id, path, setPath } = usePerson();
  const P = D.people;
  const R = useMemo(() => rels(D), [D]);
  const [st, setSt] = useState(loadView);
  const save = (s: typeof st) => { try { sessionStorage.setItem("graphView", JSON.stringify({ up: s.up, down: s.down, sibs: s.sibs })); } catch { /* fine */ } };
  const update = (k: "up" | "down" | "sibs", v: number | boolean) => setSt((cur) => { const next = { ...cur, [k]: v }; save(next); return next; });

  const pathSet = useMemo(() => new Set<string>(path && path.found ? [path.steps.length ? path.steps[0].from : id, ...path.steps.map((s: any) => s.to)] : []), [path, id]);
  const pathEdges = useMemo(() => new Set<string>(path && path.found ? path.steps.map((s: any) => edgeKey(s.from, s.to)) : []), [path]);

  // widen the view so a newly highlighted path fits, within limits
  useEffect(() => {
    if (!path || !path.found) return;
    const depthUp = (x: string) => { // how many generations above `id` this person sits, if they're a direct ancestor
      let row = [id];
      for (let g = 1; g <= 4; g++) { row = row.flatMap(R.parents); if (row.includes(x)) return g; }
      return 0;
    };
    setSt((cur) => ({ ...cur, up: Math.min(4, Math.max(cur.up, ...[...pathSet].map(depthUp))) }));
  }, [path, pathSet, id, R]);

  const { rows, placed } = useMemo(() => {
    const rows = new Map<number, string[]>(), placed = new Set<string>();
    const put = (g: number, xs: string[]) => { const r = rows.get(g) || []; for (const x of xs) if (!placed.has(x)) { placed.add(x); r.push(x); } rows.set(g, r); };
    put(0, [...(st.sibs ? R.siblings(id) : []), id, ...R.spouses(id)]);
    let up = [id];
    for (let g = 1; g <= st.up; g++) { up = up.flatMap(R.parents); put(-g, up); up = rows.get(-g) || []; if (!up.length) break; }
    let down = [id];
    for (let g = 1; g <= st.down; g++) { down = down.flatMap(R.children); put(g, down); down = rows.get(g) || []; if (!down.length) break; }
    // a highlighted path may run through people outside this neighbourhood (in-laws, cousins' lines): bring each in
    // next to the relative it connects to, one step at a time
    const genOf = new Map<string, number>();
    for (const [g, r] of rows) for (const x of r) genOf.set(x, g);
    for (let changed = true; changed;) {
      changed = false;
      for (const x of pathSet) {
        if (placed.has(x) || !P[x]) continue;
        const pa = R.parents(x).find((y) => genOf.has(y)), ch = R.children(x).find((y) => genOf.has(y)), sp = R.spouses(x).find((y) => genOf.has(y));
        const g = pa ? genOf.get(pa)! + 1 : ch ? genOf.get(ch)! - 1 : sp ? genOf.get(sp)! : null;
        if (g == null) continue;
        put(g, [x]); genOf.set(x, g); changed = true;
      }
    }
    return { rows, placed };
  }, [st, id, R, pathSet, P]);

  const gens = [...rows.keys()].filter((g) => rows.get(g)!.length).sort((a, b) => a - b);
  const maxN = Math.max(...gens.map((g) => rows.get(g)!.length));
  const width = Math.max(maxN * (W + GX) - GX + PAD * 2, W + PAD * 2);
  const pos = new Map<string, { x: number; y: number }>();
  gens.forEach((g, gi) => {
    const r = rows.get(g)!, rw = r.length * (W + GX) - GX, x0 = (width - rw) / 2;
    r.forEach((x, i) => pos.set(x, { x: x0 + i * (W + GX), y: PAD + gi * (H + GY) }));
  });
  const height = PAD * 2 + gens.length * (H + GY) - GY;
  const edges: { a: string; b: string; kind: "pc" | "sp" }[] = [];
  for (const x of placed) {
    for (const p of R.parents(x)) if (pos.has(p)) edges.push({ a: p, b: x, kind: "pc" });
    for (const s of R.spouses(x)) if (pos.has(s) && x < s) edges.push({ a: x, b: s, kind: "sp" });
  }

  // keep the focus person in view
  const wrap = useRef<HTMLDivElement>(null), focus = useRef<SVGAElement>(null);
  useLayoutEffect(() => {
    if (!wrap.current || !focus.current) return;
    const r = focus.current.getBBox();
    wrap.current.scrollLeft = Math.max(0, r.x + r.width / 2 - wrap.current.clientWidth / 2);
  }, [width, rows]);

  const opt = (n: number) => Array.from({ length: n + 1 }, (_, i) => <option key={i} value={i}>{i}</option>);
  return (
    <section className="card" id="w-graph" style={{ marginBottom: 20 }}>
      <h2>{T.title}</h2>
      <Insights id={id} />
      <div className="filters graph-ctl">
        <label className="small">{T.generationsUp} <select data-k="up" value={st.up} onChange={(e) => update("up", +e.target.value)}>{opt(4)}</select></label>
        <label className="small">{T.down} <select data-k="down" value={st.down} onChange={(e) => update("down", +e.target.value)}>{opt(4)}</select></label>
        <label className="small"><input type="checkbox" data-k="sibs" checked={st.sibs} onChange={(e) => update("sibs", e.target.checked)} /> {T.siblings}</label>
        {pathSet.size > 0 && <button className="linklike" data-k="clear" onClick={() => setPath(null)}>{T.clearPath}</button>}
        <span className="small muted g-legend"><svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" className="g-edge g-pc" /></svg> {T.legend.parentChild} <svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" className="g-edge g-sp" /></svg> {T.legend.couple} <span className="g-dot"></span> {T.legend.verified}</span>
      </div>
      <div className="graph-wrap" ref={wrap}>
        <svg className="family-graph" viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={T.ariaLabel(P[id].name)}>
          {edges.map((e) => {
            const A = pos.get(e.a)!, B = pos.get(e.b)!, on = pathEdges.has(edgeKey(e.a, e.b));
            const k = `${e.kind}-${e.a}-${e.b}`;
            if (e.kind === "sp") {
              const [L, Rt] = A.x < B.x ? [A, B] : [B, A];
              const d = `M${L.x + W},${L.y + H / 2} ${L.y === Rt.y ? `L${Rt.x},${Rt.y + H / 2}` : `C${L.x + W + 30},${L.y + H / 2} ${Rt.x - 30},${Rt.y + H / 2} ${Rt.x},${Rt.y + H / 2}`}`;
              return <path key={k} className={`g-edge g-sp${on ? " on" : ""}`} d={d} />;
            }
            const x1 = A.x + W / 2, y1 = A.y + H, x2 = B.x + W / 2, y2 = B.y, my = (y1 + y2) / 2;
            return <path key={k} className={`g-edge g-pc${on ? " on" : ""}`} d={`M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`} />;
          })}
          {[...placed].map((x) => {
            const p: any = P[x], { x: nx, y: ny } = pos.get(x)!;
            const yrs = p.living ? T.living : [p.birth && p.birth.year, p.death && p.death.year].some(Boolean) ? `${(p.birth && p.birth.year) || "?"}–${(p.death && p.death.year) || "?"}` : "";
            const cls = ["g-node", x === id ? "focus" : "", pathSet.has(x) ? "on" : "", p.status === "verified" ? "verified" : ""].filter(Boolean).join(" ");
            return (
              <Link key={x} to={`/person/${x}`} className={cls} style={{ ["--bc" as any]: `var(--b-${p.branch || "other"}, var(--muted))` }} ref={x === id ? (focus as any) : undefined}>
                <title>{`${p.name}${p.relation ? ` · ${p.relation}` : ""}${yrs ? ` · ${yrs}` : ""}${p.status ? ` · ${p.status}` : ""}`}</title>
                <rect x={nx} y={ny} width={W} height={H} rx={9} /><rect className="g-band" x={nx} y={ny} width={5} height={H} rx={2} />
                <text x={nx + 13} y={ny + 21} className="g-name">{clip(p.name, 21)}</text>
                <text x={nx + 13} y={ny + 39} className="g-sub">{clip([yrs, x !== id && p.relation].filter(Boolean).join(" · "), 25)}</text>
                {p.status === "verified" && <circle className="g-ok" cx={nx + W - 11} cy={ny + 11} r={4} />}
              </Link>
            );
          })}
        </svg>
      </div>
      {pathSet.size > 0 && [...pathSet].some((x) => !placed.has(x)) && <p className="small muted">{T.pathOutside}</p>}
    </section>
  );
}

/** A relationship path as a chain: A —father→ B —son→ C. */
export function PathChain({ path, from }: { path: any; from: string }) {
  const { D } = useData();
  if (!path || !path.found || !path.steps.length) return null;
  const chip = (x: string) => <Link className="chip" to={`/person/${x}`}>{D.people[x] ? D.people[x].name : x}</Link>;
  return <div className="path-chain">{chip(path.steps[0].from || from)}{path.steps.map((s: any, i: number) => <Fragment key={i}><span className="path-rel">{s.rel || ""} →</span>{chip(s.to)}</Fragment>)}</div>;
}
