// The tree page: someone's ancestors or descendants, in one of four views. Routes /tree and /tree/:id, with
// ?view=chart|family|fan|outline, ?mode=desc and ?g=<generations>. The view last picked with the toggle is remembered
// (a link with ?view= shows that view without changing what's remembered).
//   chart    boxes and lines, a generation per column (pan/zoom)
//   family   the person page's family graph: parents above, children below, siblings and spouses alongside (pan/zoom)
//   fan      rings of ancestors, or a sunburst of descendants (pan/zoom)
//   outline  a numbered list: Ahnentafel for ancestors, d'Aboville for descendants
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { branchColor, isUnknown, useTitle, years } from "../lib";
import { byBirth, homeFirst, spousesOf } from "../tree";
import { edgePath, familyLayout, FH, FW, rels } from "../familyLayout";
import { ancestorFan, descendantFan } from "./browse/FanChart";
import { useBrowse, type BTree } from "./browse/shared";
import { S } from "../../../strings/index.ts";

const T = S.browse.tree;

const BW = 210, BH = 54, HG = 70, VG = 14;
const ST_COLOR: Record<string, string> = { verified: "var(--ok)", "partly-verified": "var(--info)", disputed: "var(--err)", unverified: "var(--line)" };

export type View = "chart" | "family" | "fan" | "outline";
const VIEWS: View[] = ["chart", "family", "fan", "outline"];
const isView = (v: string | null): v is View => !!v && (VIEWS as string[]).includes(v);
function savedView(): View {
  try { const v = localStorage.getItem("treeView"); if (isView(v)) return v; } catch { /* private mode */ }
  return "chart";
}
function saveView(v: View) { try { localStorage.setItem("treeView", v); } catch { /* fine */ } }
/** Generations shown when a view or mode is first picked. Family counts the focus row plus this many up and down. */
const defaultGens = (view: View, mode: "anc" | "desc") => (view === "family" ? 3 : mode === "anc" ? 5 : 4);

interface Node { id: string | null; g: number; x: number; y: number; h?: number; unknown?: boolean; label?: string; spouses?: string[] }

function chartLayout(D: BTree, root: string, mode: "anc" | "desc", gens: number) {
  const P = D.people, F = D.families;
  const nodes: Node[] = [], links: [Node, Node][] = [];
  let next = 0;
  if (mode === "anc") {
    const place = (pid: string | null, g: number, slotName?: string): Node => {
      const n: Node = { id: pid, g, x: g * (BW + HG), y: 0, unknown: !pid, label: slotName };
      nodes.push(n);
      let fa: string | null = null, mo: string | null = null, hasFam = false;
      const fid = pid && P[pid].famc[0];
      if (fid && F[fid] && g < gens - 1) { fa = F[fid].husband || null; mo = F[fid].wife || null; hasFam = true; }
      const kids: Node[] = [];
      if (hasFam) {
        kids.push(fa ? place(fa, g + 1) : place(null, g + 1, T.unknownFather));
        kids.push(mo ? place(mo, g + 1) : place(null, g + 1, T.unknownMother));
      }
      if (kids.length) n.y = (kids[0].y + kids[1].y) / 2;
      else { n.y = next * (BH + VG); next++; }
      kids.forEach((k) => links.push([n, k]));
      return n;
    };
    place(root, 0);
  } else {
    const bb = byBirth(D);
    const place = (pid: string, g: number): Node => {
      const sp = spousesOf(D, pid);
      const n: Node = { id: pid, g, x: g * (BW + HG), y: 0, spouses: sp.map((s) => s.spouse).filter((s): s is string => !!s && !!P[s]) };
      n.h = BH + Math.min(2, n.spouses!.length) * 16;
      nodes.push(n);
      const kids: Node[] = [];
      if (g < gens - 1) sp.forEach((s) => s.children.slice().sort(bb).forEach((c) => { if (P[c]) kids.push(place(c, g + 1)); }));
      if (kids.length) n.y = (kids[0].y + kids[kids.length - 1].y) / 2;
      else { n.y = next; next += n.h + VG; }
      kids.forEach((k) => links.push([n, k]));
      return n;
    };
    place(root, 0);
  }
  const bbox = { w: gens * (BW + HG), h: Math.max(...nodes.map((n) => n.y + (n.h || BH))) };
  return { nodes, links, bbox };
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Pan (drag), zoom (wheel, pinch, buttons), fit on load and resize; a click on anything with data-id calls onPick. */
function usePanZoom(bbox: { w: number; h: number }, onPick: (id: string) => void, active: boolean) {
  const canvasRef = useRef<HTMLDivElement>(null), gRef = useRef<SVGGElement>(null), zoomRef = useRef<HTMLDivElement>(null);
  const ctl = useRef<{ fit(): void; zoom(f: number): void } | null>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current!, g = gRef.current!, zoomEl = zoomRef.current!;
    let t = { x: 0, y: 0, k: 1 };
    const apply = () => g.setAttribute("transform", `translate(${t.x},${t.y}) scale(${t.k})`); // strings-ok (an SVG transform)
    const fit = () => {
      const r = canvas.getBoundingClientRect();
      const k = Math.min(1.15, (r.width - 40) / bbox.w, (r.height - 90) / bbox.h);
      t = { k: Math.max(0.12, k), x: 0, y: 0 };
      t.x = (r.width - bbox.w * t.k) / 2;
      t.y = Math.max(20, (r.height - 60 - bbox.h * t.k) / 2);
      apply();
    };
    const zoomAt = (f: number, cx: number, cy: number) => {
      const k = Math.max(0.1, Math.min(3, t.k * f));
      t.x = cx - ((cx - t.x) * k) / t.k; t.y = cy - ((cy - t.y) * k) / t.k; t.k = k; apply();
    };
    fit();
    ctl.current = { fit, zoom: (f) => { const r = canvas.getBoundingClientRect(); zoomAt(f, r.width / 2, r.height / 2); } };

    const ptrs = new Map<number, PointerEvent>();
    let moved = 0, last = { x: 0, y: 0 }, pinch: number | null = null;
    const down = (e: PointerEvent) => { ptrs.set(e.pointerId, e); moved = 0; last = { x: e.clientX, y: e.clientY }; try { canvas.setPointerCapture(e.pointerId); } catch { /* not an active pointer (synthetic events) */ } canvas.classList.add("dragging"); };
    const move = (e: PointerEvent) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, e);
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        const r = canvas.getBoundingClientRect();
        if (pinch) zoomAt(d / pinch, (a.clientX + b.clientX) / 2 - r.left, (a.clientY + b.clientY) / 2 - r.top);
        pinch = d; moved += 10; return;
      }
      const dx = e.clientX - last.x, dy = e.clientY - last.y;
      moved += Math.abs(dx) + Math.abs(dy);
      t.x += dx; t.y += dy; last = { x: e.clientX, y: e.clientY }; apply();
    };
    const up = (e: PointerEvent) => {
      ptrs.delete(e.pointerId); pinch = null; canvas.classList.remove("dragging");
      if (moved < 6 && e.type === "pointerup") {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const hit = el && (el.closest("[data-id]") as SVGGElement | null);
        if (hit && hit.dataset.id) pick.current(hit.dataset.id);
      }
      if (ptrs.size) { const f = [...ptrs.values()][0]; last = { x: f.clientX, y: f.clientY }; }
    };
    const wheel = (e: WheelEvent) => { e.preventDefault(); const r = canvas.getBoundingClientRect(); zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top); };
    const stop = (e: Event) => e.stopPropagation(); // the zoom buttons don't start a drag
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("wheel", wheel, { passive: false });
    zoomEl.addEventListener("pointerdown", stop);
    window.addEventListener("resize", fit);
    return () => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("wheel", wheel);
      zoomEl.removeEventListener("pointerdown", stop);
      window.removeEventListener("resize", fit);
      canvas.classList.remove("dragging");
      ctl.current = null;
    };
  }, [bbox, active]);
  return { canvasRef, gRef, zoomRef, ctl };
}

/** Chart view: the original boxes-and-lines pedigree or descendant chart. */
function ChartView({ D, L, root, branches }: { D: BTree; L: ReturnType<typeof chartLayout>; root: string; branches: any }) {
  const P = D.people;
  const { nodes, links } = L;
  return <>
    {links.map(([a, b], i) => {
      const x1 = a.x + BW, y1 = a.y + (a.h || BH) / 2, x2 = b.x, y2 = b.y + (b.h || BH) / 2, mx = x1 + HG / 2;
      return <path key={i} className="link" d={`M${x1},${y1} H${mx} V${y2} H${x2}`} />;
    })}
    {nodes.map((n, i) => {
      const h = n.h || BH;
      if (n.unknown) return (
        <g key={i} className="node unknown" transform={`translate(${n.x},${n.y})`}>
          <rect className="box" width={BW} height={h} rx="9" /><text className="nm" x="14" y={h / 2 + 4}>{n.label}</text>
        </g>
      );
      const q = P[n.id!];
      const sp = n.spouses || [];
      const place = q.birth && q.birth.place ? ` · ${q.birth.place.split(",")[0].slice(0, 18)}` : "";
      return (
        <g key={i} className={`node${n.id === root ? " root" : ""}`} data-id={n.id!} transform={`translate(${n.x},${n.y})`}>
          <title>{`${q.name} (${years(q)})${q.relation ? " — " + q.relation : ""}`}</title>
          <rect className="box" width={BW} height={h} rx="9" />
          <rect width="5" height={h - 12} x="0" y="6" rx="2" style={{ fill: branchColor(q.branch, branches) }} />
          <circle cx={BW - 12} cy="12" r="4" style={{ fill: ST_COLOR[q.status || ""] }} />
          <text className="nm" x="14" y="22">{clip(q.name, 26)}</text>
          <text className="yr" x="14" y="39">{(years(q) || S.browse.datesUnknown) + place}</text>
          {sp.slice(0, 2).map((s, j) => <text key={j} className="yr" x="14" y={54 + j * 16}>{clip(T.spouse(P[s].name), 30)}</text>)}
          {sp.length > 2 && <text className="yr" x={BW - 30} y="70">+{sp.length - 2}</text>}
        </g>
      );
    })}
  </>;
}

/** Family view: the person page's family graph, drawn in the pan/zoom canvas. */
function FamilyView({ D, L, root }: { D: BTree; L: ReturnType<typeof familyLayout>; root: string }) {
  const P = D.people;
  return <g className="family-graph">
    {L.edges.map((e) => <path key={`${e.kind}-${e.a}-${e.b}`} className={`g-edge g-${e.kind}`} d={edgePath(L.pos.get(e.a)!, L.pos.get(e.b)!, e.kind)} />)}
    {[...L.placed].map((x) => {
      const p: any = P[x], { x: nx, y: ny } = L.pos.get(x)!;
      const yrs = years(p);
      return (
        <g key={x} className={`g-node${x === root ? " focus" : ""}`} data-id={x} style={{ ["--bc" as any]: `var(--b-${p.branch || "other"}, var(--muted))`, cursor: "pointer" }}>
          <title>{`${p.name}${p.relation ? ` · ${p.relation}` : ""}${yrs ? ` · ${yrs}` : ""}`}</title>
          <rect x={nx} y={ny} width={FW} height={FH} rx={9} /><rect className="g-band" x={nx} y={ny} width={5} height={FH} rx={2} />
          <text x={nx + 13} y={ny + 21} className="g-name">{clip(p.name, 21)}</text>
          <text x={nx + 13} y={ny + 39} className="g-sub">{clip([yrs, x !== root && p.relation].filter(Boolean).join(" · "), 25)}</text>
          {p.status === "verified" && <circle className="g-ok" cx={nx + FW - 11} cy={ny + 11} r={4} />}
        </g>
      );
    })}
  </g>;
}

/** One person's line in the outline. */
function OutlineRow({ D, id, num, branches, recentre, extra }: { D: BTree; id: string; num: string; branches: any; recentre: (id: string) => string; extra?: ReactNode }) {
  const p = D.people[id];
  const place = p.birth && p.birth.place ? p.birth.place.split(",")[0] : "";
  return (
    <div className="ol-row" style={{ ["--bc" as any]: branchColor(p.branch, branches) }}>
      <span className="ol-num">{num}</span>
      <span className="ol-main">
        <Link to={`/person/${id}`} className="ol-name">{p.name}</Link>
        <span className="muted small"> {[years(p) || S.browse.datesUnknown, place].filter(Boolean).join(" · ")}</span>
        {p.status && p.status !== "unverified" && <span className="ol-dot" style={{ background: ST_COLOR[p.status] }} title={S.common.status[p.status as keyof typeof S.common.status] || p.status} />}
        {extra}
      </span>
      <Link className="ol-centre" to={recentre(id)} title={T.recentre(p.name)} aria-label={T.recentre(p.name)}>⌖</Link>
    </div>
  );
}

/** Outline view: ancestors by generation with Ahnentafel numbers, or descendants nested with d'Aboville numbers. */
function OutlineView({ D, root, mode, gens, branches, recentre }: { D: BTree; root: string; mode: "anc" | "desc"; gens: number; branches: any; recentre: (id: string) => string }) {
  const P = D.people, F = D.families;
  if (mode === "anc") {
    const byGen: { n: number; id: string }[][] = [[{ n: 1, id: root }]];
    for (let g = 1; g < gens; g++) {
      byGen[g] = [];
      for (const { n, id } of byGen[g - 1]) {
        const fid = P[id].famc[0], f = fid && F[fid];
        if (!f) continue;
        if (f.husband && P[f.husband] && !isUnknown(P[f.husband])) byGen[g].push({ n: 2 * n, id: f.husband });
        if (f.wife && P[f.wife] && !isUnknown(P[f.wife])) byGen[g].push({ n: 2 * n + 1, id: f.wife });
      }
      if (!byGen[g].length) { byGen.length = g; break; }
    }
    return (
      <div className="tree-outline">
        <p className="small muted">{T.ahnentafel}</p>
        <OutlineRow D={D} id={root} num="1" branches={branches} recentre={recentre} />
        {byGen.length === 1 && <p className="muted">{T.noParents}</p>}
        {byGen.slice(1).map((row, i) => (
          <section key={i}>
            <h3>{T.generation(i + 1)} <span className="muted small">{T.found(row.length, 2 ** (i + 1))}</span></h3>
            {row.map(({ n, id }) => <OutlineRow key={n} D={D} id={id} num={String(n)} branches={branches} recentre={recentre} />)}
          </section>
        ))}
      </div>
    );
  }
  const bb = byBirth(D);
  const kids = (id: string) => spousesOf(D, id).flatMap((s) => s.children.slice().sort(bb)).filter((c, i, a) => P[c] && a.indexOf(c) === i);
  const branch = (id: string, num: string, g: number): ReactNode => {
    const sp = spousesOf(D, id).map((s) => s.spouse).filter((s): s is string => !!s && !!P[s]);
    const k = g < gens - 1 ? kids(id) : [];
    return (
      <li key={num}>
        <OutlineRow D={D} id={id} num={num} branches={branches} recentre={recentre}
          extra={sp.length > 0 && <span className="small ol-spouses">{sp.map((s) => <Link key={s} to={`/person/${s}`}>{T.spouse(P[s].name)}</Link>)}</span>} />
        {k.length > 0 && <ol>{k.map((c, i) => branch(c, `${num}.${i + 1}`, g + 1))}</ol>}
      </li>
    );
  };
  return (
    <div className="tree-outline">
      <p className="small muted">{T.daboville}</p>
      <ol className="ol-desc">{branch(root, "1", 0)}</ol>
      {!kids(root).length && <p className="muted">{T.noChildren}</p>}
    </div>
  );
}

export function TreeChart() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { D, branches } = useBrowse();
  const P = D.people, HOME = D.home;
  const root = id && P[id] ? id : HOME;
  const urlView = params.get("view");
  const view: View = isView(urlView) ? urlView : savedView();
  const mode = params.get("mode") === "desc" ? "desc" : "anc";
  const gens = Math.max(2, Math.min(8, +(params.get("g") || 0) || defaultGens(view, mode)));
  const p = P[root];
  useTitle(T.title(p.name));

  const href = (who: string, v: View = view, m: string = mode, g: number = gens) =>
    `/tree/${who}?view=${v}${m === "desc" ? "&mode=desc" : ""}&g=${g}`;

  // What the canvas views draw, and how big it is.
  const R = useMemo(() => rels(D), [D]);
  const drawn = useMemo(() => {
    if (view === "family") {
      const L = familyLayout(D, R, root, { up: gens - 1, down: gens - 1, sibs: true });
      return { bbox: { w: L.width, h: L.height }, content: <FamilyView D={D} L={L} root={root} /> };
    }
    if (view === "fan") {
      const wrap = (who: string, key: string, shape: ReactNode) => <g key={key} className="fan-cell" data-id={who}>{shape}</g>;
      const fan = (mode === "anc" ? ancestorFan : descendantFan)(D, branches, root, Math.min(gens, 7), wrap);
      return { bbox: { w: fan.width, h: fan.height }, content: <g className="fan-tree">{fan.content}</g> };
    }
    if (view === "chart") {
      const L = chartLayout(D, root, mode, gens);
      return { bbox: L.bbox, content: <ChartView D={D} L={L} root={root} branches={branches} /> };
    }
    return null;
  }, [view, D, R, root, mode, gens, branches]);
  const bbox = useMemo(() => drawn ? drawn.bbox : { w: 1, h: 1 }, [drawn]);
  const { canvasRef, gRef, zoomRef, ctl } = usePanZoom(bbox, (who) => navigate(href(who)), !!drawn);

  return (
    <div className="tree-page">
      <div className="tree-bar">
        <span className="who">{p.name} <span className="muted small">{years(p)}</span></span>
        <div className="seg" role="group" aria-label={T.view}>
          {VIEWS.map((v) => <button key={v} data-view={v} className={v === view ? "on" : ""} title={T.viewHelp[v]} aria-pressed={v === view}
            onClick={() => { saveView(v); navigate(href(root, v, mode, defaultGens(v, mode))); }}>{T.views[v]}</button>)}
        </div>
        {view !== "family" && <div className="seg" role="group" aria-label={T.type}>
          <button data-mode="anc" className={mode === "anc" ? "on" : ""} onClick={() => navigate(href(root, view, "anc", defaultGens(view, "anc")))}>{T.ancestors}</button>
          <button data-mode="desc" className={mode === "desc" ? "on" : ""} onClick={() => navigate(href(root, view, "desc", defaultGens(view, "desc")))}>{T.descendants}</button>
        </div>}
        <div className="seg" role="group" aria-label={T.generations}>
          {(view === "fan" ? [3, 4, 5, 6, 7] : view === "family" ? [2, 3, 4, 5] : [3, 4, 5, 6, 7]).map((g) =>
            <button key={g} data-g={g} className={g === gens ? "on" : ""} onClick={() => navigate(href(root, view, mode, g))}>{g}</button>)}
        </div>
        <Link className="btn" to={`/person/${root}`}>{T.profile}</Link>
        {root !== HOME && <Link className="btn" to={href(HOME)}>↺ {homeFirst(D)}</Link>}
      </div>
      {drawn ? (
        <div className="tree-canvas" id="tc" ref={canvasRef}>
          <svg id="tsvg" className={`tree-${view}`}><g id="tg" ref={gRef}>{drawn.content}</g></svg>
          <div className="tree-zoom" ref={zoomRef}>
            <button data-z="in" aria-label={T.zoomIn} onClick={(e) => { e.stopPropagation(); ctl.current?.zoom(1.25); }}>+</button>
            <button data-z="out" aria-label={T.zoomOut} onClick={(e) => { e.stopPropagation(); ctl.current?.zoom(0.8); }}>−</button>
            <button data-z="fit" aria-label={T.fit} onClick={(e) => { e.stopPropagation(); ctl.current?.fit(); }}>⤢</button>
          </div>
          <div className="tree-legend">{(D.research.branches || []).map((b) => <span key={b.key}><i style={{ background: branchColor(b.key, branches) }} />{b.label}</span>)}
            <span className="muted hint-mouse">{T.hintMouse}</span><span className="muted hint-touch">{T.hintTouch}</span></div>
        </div>
      ) : (
        <div className="tree-scroll"><OutlineView D={D} root={root} mode={mode} gens={gens} branches={branches} recentre={(who) => href(who)} /></div>
      )}
    </div>
  );
}
