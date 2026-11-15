// The interactive tree: someone's ancestors or descendants as a pan/zoom SVG chart. Routes /tree and /tree/:id,
// with ?mode=desc and ?g=<generations>.
import { useEffect, useMemo, useRef } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { branchColor, useTitle, years } from "../lib";
import { byBirth, homeFirst, spousesOf } from "../tree";
import { useBrowse, type BTree } from "./browse/shared";

const BW = 210, BH = 54, HG = 70, VG = 14;
const ST_COLOR: Record<string, string> = { verified: "var(--ok)", "partly-verified": "var(--info)", disputed: "var(--err)", unverified: "var(--line)" };

interface Node { id: string | null; g: number; x: number; y: number; h?: number; unknown?: boolean; label?: string; spouses?: string[] }

function layout(D: BTree, root: string, mode: "anc" | "desc", gens: number) {
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
        kids.push(fa ? place(fa, g + 1) : place(null, g + 1, "Unknown father"));
        kids.push(mo ? place(mo, g + 1) : place(null, g + 1, "Unknown mother"));
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

export function TreeChart() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { D, branches } = useBrowse();
  const P = D.people, HOME = D.home;
  const root = id && P[id] ? id : HOME;
  const mode = params.get("mode") === "desc" ? "desc" : "anc";
  const gens = Math.max(2, Math.min(8, +(params.get("g") || 0) || (mode === "anc" ? 5 : 4)));
  const p = P[root];
  useTitle("Tree · " + p.name);
  const { nodes, links, bbox } = useMemo(() => layout(D, root, mode, gens), [D, root, mode, gens]);

  const canvasRef = useRef<HTMLDivElement>(null), gRef = useRef<SVGGElement>(null), zoomRef = useRef<HTMLDivElement>(null);
  const ctl = useRef<{ fit(): void; zoom(f: number): void } | null>(null);
  const nav = useRef(navigate);
  nav.current = navigate;

  // Pan (drag), zoom (wheel, pinch, buttons), fit on load and resize, click a person to re-centre.
  useEffect(() => {
    const canvas = canvasRef.current!, g = gRef.current!, zoomEl = zoomRef.current!;
    let t = { x: 0, y: 0, k: 1 };
    const apply = () => g.setAttribute("transform", `translate(${t.x},${t.y}) scale(${t.k})`);
    const fit = () => {
      const r = canvas.getBoundingClientRect();
      const k = Math.min(1.15, (r.width - 40) / bbox.w, (r.height - 90) / bbox.h);
      t = { k: Math.max(0.2, k), x: 0, y: 0 };
      t.x = (r.width - bbox.w * t.k) / 2;
      t.y = Math.max(20, (r.height - 60 - bbox.h * t.k) / 2);
      apply();
    };
    const zoomAt = (f: number, cx: number, cy: number) => {
      const k = Math.max(0.15, Math.min(3, t.k * f));
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
        const node = el && (el.closest(".node[data-id]") as SVGGElement | null);
        if (node) nav.current(`/tree/${node.dataset.id}${mode === "desc" ? "?mode=desc" : ""}`);
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
  }, [bbox, mode]);

  const qs = (m: string, g: number) => `/tree/${root}?${m === "desc" ? "mode=desc&" : ""}g=${g}`;
  return (
    <div className="tree-page">
      <div className="tree-bar">
        <span className="who">{p.name} <span className="muted small">{years(p)}</span></span>
        <div className="seg" role="group" aria-label="Tree type">
          <button data-mode="anc" className={mode === "anc" ? "on" : ""} onClick={() => navigate(qs("anc", 5))}>Ancestors</button>
          <button data-mode="desc" className={mode === "desc" ? "on" : ""} onClick={() => navigate(qs("desc", 4))}>Descendants</button>
        </div>
        <div className="seg" role="group" aria-label="Generations">
          {[3, 4, 5, 6, 7].map((g) => <button key={g} data-g={g} className={g === gens ? "on" : ""} onClick={() => navigate(qs(mode, g))}>{g}</button>)}
        </div>
        <Link className="btn" to={`/person/${root}`}>Profile →</Link>
        {root !== HOME && <Link className="btn" to={`/tree/${HOME}${mode === "desc" ? "?mode=desc" : ""}`}>↺ {homeFirst(D)}</Link>}
      </div>
      <div className="tree-canvas" id="tc" ref={canvasRef}>
        <svg id="tsvg"><g id="tg" ref={gRef}>
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
                <text className="yr" x="14" y="39">{(years(q) || "dates unknown") + place}</text>
                {sp.slice(0, 2).map((s, j) => <text key={j} className="yr" x="14" y={54 + j * 16}>{clip("⚭ " + P[s].name, 30)}</text>)}
                {sp.length > 2 && <text className="yr" x={BW - 30} y="70">+{sp.length - 2}</text>}
              </g>
            );
          })}
        </g></svg>
        <div className="tree-zoom" ref={zoomRef}>
          <button data-z="in" aria-label="Zoom in" onClick={(e) => { e.stopPropagation(); ctl.current?.zoom(1.25); }}>+</button>
          <button data-z="out" aria-label="Zoom out" onClick={(e) => { e.stopPropagation(); ctl.current?.zoom(0.8); }}>−</button>
          <button data-z="fit" aria-label="Fit" onClick={(e) => { e.stopPropagation(); ctl.current?.fit(); }}>⤢</button>
        </div>
        <div className="tree-legend">{(D.research.branches || []).map((b) => <span key={b.key}><i style={{ background: branchColor(b.key, branches) }} />{b.label}</span>)}
          <span className="muted">Click a person to re-centre · drag to pan · scroll to zoom</span></div>
      </div>
    </div>
  );
}
