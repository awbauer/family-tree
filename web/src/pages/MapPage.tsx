// Where the family lived: every placed event on a Leaflet map (loaded on demand from cdnjs), with birth-to-death
// journeys. Filters ?branch=&direct=1 are kept in the URL; the tiles follow the light/dark theme (the Shell's
// `themechange` event).
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useTitle } from "../lib";
import { eventLabel } from "../tree";
import { useBrowse, type BEvent, type BPerson } from "./browse/shared";
import { loadLeaflet } from "./browse/leaflet";
import { S } from "../../../strings/index.ts";

const T = S.browse.map;

const isDark = () => (document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark"; // strings-ok (a media query)
const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";

/** A DOM element with text (Leaflet popups and tooltips take elements; text is never parsed as HTML). */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

export function MapPage() {
  useTitle(T.title);
  const { D, people } = useBrowse();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [branch, setBranch] = useState(params.get("branch") || "");
  const [direct, setDirect] = useState(params.get("direct") === "1");
  const [journeys, setJourneys] = useState(true);
  const [dark, setDark] = useState(isDark);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<{ L: any; map: any; layer: any; tiles: any } | null>(null);
  const nav = useRef(navigate);
  nav.current = navigate;

  useEffect(() => {
    const on = () => setDark(isDark());
    window.addEventListener("themechange", on);
    return () => window.removeEventListener("themechange", on);
  }, []);

  // Create the map once Leaflet has loaded; remove it when leaving the page.
  useEffect(() => {
    let gone = false;
    loadLeaflet().then((L) => {
      if (gone || !mapEl.current) return;
      const m = L.map(mapEl.current, { worldCopyJump: true }).setView([45, -30], 3);
      map.current = { L, map: m, layer: L.layerGroup().addTo(m), tiles: null };
      setStatus("ready");
    }, () => { if (!gone) setStatus("error"); });
    return () => {
      gone = true;
      if (map.current) { map.current.map.remove(); map.current = null; }
      setStatus("loading");
    };
  }, []);

  // Tiles: inverted in dark mode.
  useEffect(() => {
    const M = map.current;
    if (status !== "ready" || !M) return;
    const tiles = M.L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap contributors", maxZoom: 18, className: dark ? "tiles-dark" : "tiles-light" }).addTo(M.map);
    return () => { tiles.remove(); };
  }, [status, dark]);

  // Keep the URL in step with the filters.
  useEffect(() => {
    const ps = new URLSearchParams();
    if (branch) ps.set("branch", branch);
    if (direct) ps.set("direct", "1");
    if (ps.toString() !== params.toString()) setParams(ps, { replace: true });
  }, [branch, direct]); // eslint-disable-line react-hooks/exhaustive-deps

  // Markers (one per place, sized by people, coloured by the commonest branch) and journeys.
  useEffect(() => {
    const M = map.current;
    if (status !== "ready" || !M) return;
    const { L, layer } = M;
    layer.clearLayers();
    const places = D.places || {};
    const byPlace: Record<string, { p: BPerson; e: BEvent }[]> = {};
    const ps = people.filter((p) => (!branch || p.branch === branch) && (!direct || p.direct));
    for (const p of ps) for (const e of p.events) {
      if (!e.placeKey || e.misfiled || !places[e.placeKey]) continue;
      (byPlace[e.placeKey] = byPlace[e.placeKey] || []).push({ p, e });
    }
    const pts: [number, number][] = [];
    for (const [k, evs] of Object.entries(byPlace)) {
      const pl = places[k];
      const counts: Record<string, number> = {};
      evs.forEach(({ p }) => { counts[String(p.branch)] = (counts[String(p.branch)] || 0) + 1; });
      const top = Object.entries(counts).sort((a, c) => c[1] - a[1])[0][0];
      const col = cssVar(`--b-${top}`);
      const uniq = [...new Set(evs.map((x) => x.p.id))];
      const m = L.circleMarker([pl.lat, pl.lng], { radius: 5 + Math.sqrt(uniq.length) * 2.4, color: col, weight: 2, fillColor: col, fillOpacity: 0.45 });
      const rows = evs.sort((a, c) => (a.e.sort || 0) - (c.e.sort || 0)).slice(0, 60).map(({ p, e }) => {
        const a = el("a", { href: `#/person/${p.id}` }, p.name);
        a.addEventListener("click", (ev) => { ev.preventDefault(); nav.current(`/person/${p.id}`); });
        return el("li", {}, a, ` — ${eventLabel(e).toLowerCase()}${e.dateDisplay ? " " + e.dateDisplay : ""}`);
      });
      m.bindPopup(el("div", {}, el("h4", {}, pl.name), el("div", { className: "small muted" }, T.place(uniq.length, evs.length)), el("ul", {}, ...rows)));
      m.addTo(layer);
      pts.push([pl.lat, pl.lng]);
    }
    if (journeys) for (const p of ps) {
      const bE = p.events.find((e) => e.type === "Birth" && e.placeKey), dE = p.events.find((e) => (e.type === "Death" || e.type === "Burial") && e.placeKey && !e.misfiled);
      if (!bE || !dE || bE.placeKey === dE.placeKey) continue;
      const a = places[bE.placeKey!], c = places[dE.placeKey!];
      if (!a || !c) continue;
      const dist = Math.hypot(a.lat - c.lat, a.lng - c.lng);
      if (dist < 1.5) continue;
      const col = cssVar(`--b-${p.branch}`);
      // gentle arc
      const mid = [(a.lat + c.lat) / 2 + dist * 0.12, (a.lng + c.lng) / 2];
      const arc: [number, number][] = [];
      for (let i = 0; i <= 24; i++) { const t = i / 24; arc.push([(1 - t) * (1 - t) * a.lat + 2 * (1 - t) * t * mid[0] + t * t * c.lat, (1 - t) * (1 - t) * a.lng + 2 * (1 - t) * t * mid[1] + t * t * c.lng]); }
      L.polyline(arc, { color: col, weight: 1.6, opacity: 0.55, dashArray: "4 5" }).bindTooltip(el("span", {}, `${p.name}: ${a.name} → ${c.name}`)).addTo(layer);
    }
    if (pts.length) M.map.fitBounds(pts, { padding: [30, 30], maxZoom: 7 });
  }, [status, branch, direct, journeys, dark, D, people]);

  return (
    <>
      <div className="map-bar">
        <strong style={{ fontFamily: "var(--serif)", fontSize: "1.1rem", marginRight: "auto" }}>{T.heading}</strong>
        <select id="mb" value={branch} onChange={(e) => setBranch(e.target.value)}>
          <option value="">{S.browse.filters.allBranches}</option>{(D.research.branches || []).map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
        </select>
        <label className="small"><input type="checkbox" id="md" checked={direct} onChange={(e) => setDirect(e.target.checked)} /> {S.browse.filters.directOnly}</label>
        <label className="small"><input type="checkbox" id="mj" checked={journeys} onChange={(e) => setJourneys(e.target.checked)} /> {T.journeys}</label>
      </div>
      <div id="map" ref={mapEl}>
        {status === "loading" && <div className="empty" style={{ margin: 40 }}>{T.loading}</div>}
        {status === "error" && <div className="empty" style={{ margin: 40 }}>{T.failed}</div>}
      </div>
    </>
  );
}
