// The person page's places: a small map of where their life happened, numbered in date order and joined by a line,
// with each place's events and the photos and documents that show or name it. Places in their facts that aren't on
// the map yet are listed under it, with a link to put them on.
import { useEffect, useMemo, useRef } from "react";
import { Link, useNavigate } from "react-router";
import { useData } from "../../data";
import { eventLabel } from "../../tree";
import { placeIndex, yearOf } from "../../places";
import { useBrowse, type BEvent } from "../browse/shared";
import { cssVar, el, useLeaflet } from "../browse/useLeaflet";
import { usePerson } from "./context";
import { S } from "../../../../strings/index.ts";

const T = S.places.person;

interface Stop { key: string; name: string; lat: number; lng: number; first: number; what: string[]; docs: number }

export function PlacesCard() {
  const { D, people } = useBrowse();
  const { live } = useData();
  const { id, p } = usePerson();
  const navigate = useNavigate();
  const nav = useRef(navigate);
  nav.current = navigate;
  const { index, byText } = placeIndex(D, people);

  const { stops, loose } = useMemo(() => {
    const out = new Map<string, Stop>();
    const loose = new Set<string>();
    const evs: { e: BEvent; with?: string | null }[] = (p.events || []).map((e: BEvent) => ({ e }));
    for (const f of Object.values(D.families || {})) if (f.husband === id || f.wife === id) for (const e of f.events || []) evs.push({ e, with: f.husband === id ? f.wife : f.husband });
    for (const { e } of evs) {
      if (!e.place || e.misfiled) continue;
      const k = e.placeKey && index[e.placeKey] ? e.placeKey : byText.get(e.place);
      if (!k || !index[k]) { loose.add(e.place); continue; }
      const s = out.get(k) || { key: k, name: index[k].name, lat: index[k].lat, lng: index[k].lng, first: Infinity, what: [], docs: 0 };
      s.first = Math.min(s.first, e.sort || Infinity);
      const y = yearOf(e);
      s.what.push(`${eventLabel(e)}${y ? ` ${y}` : ""}`);
      out.set(k, s);
    }
    for (const m of (((D.research as any).media || {})[id] || []) as any[]) for (const k of m.placeKeys || []) {
      if (!index[k]) continue;
      const s = out.get(k) || { key: k, name: index[k].name, lat: index[k].lat, lng: index[k].lng, first: Infinity, what: [], docs: 0 };
      s.docs++;
      out.set(k, s);
    }
    return { stops: [...out.values()].sort((a, b) => a.first - b.first || a.name.localeCompare(b.name)), loose: [...loose] };
  }, [D, id, p, index, byText]);

  const box = useRef<HTMLDivElement>(null);
  const { M, status } = useLeaflet(box, { scrollWheelZoom: false, zoomControl: true, attributionControl: true });
  useEffect(() => {
    if (!M || !stops.length) return;
    const { L, layer } = M;
    layer.clearLayers();
    const col = cssVar(`--b-${p.branch || "other"}`);
    const dated = stops.filter((s) => s.first !== Infinity);
    if (dated.length > 1) L.polyline(dated.map((s) => [s.lat, s.lng]), { color: col, weight: 2, opacity: 0.7, dashArray: "5 5" }).addTo(layer);
    stops.forEach((s, i) => {
      const icon = L.divIcon({ className: "pl-num", html: "", iconSize: [22, 22] });
      const m = L.marker([s.lat, s.lng], { icon, title: s.name, keyboard: false });
      m.on("add", () => { const n = m.getElement(); if (n) { n.textContent = String(i + 1); n.style.setProperty("--bc", col); } });
      m.bindTooltip(el("span", {}, `${i + 1}. ${s.name}`)).on("click", () => nav.current(`/place/${s.key}`)).addTo(layer);
    });
    if (stops.length === 1) M.map.setView([stops[0].lat, stops[0].lng], 8, { animate: false });
    else M.map.fitBounds(stops.map((s) => [s.lat, s.lng]), { padding: [22, 22], maxZoom: 9, animate: false });
  }, [M, stops]); // eslint-disable-line react-hooks/exhaustive-deps

  if (p.private || (!stops.length && !loose.length)) return null;
  return (
    <section className="card side side-places" id="w-places">
      <h2>{T.title}{stops.length > 0 && <> <span className="count">{stops.length}</span></>}</h2>
      {stops.length > 0 && <div className="person-map" ref={box} aria-label={T.mapLabel}>{status === "error" && <div className="empty small">{S.browse.map.failed}</div>}</div>}
      {stops.length > 0 && <ol className="pl-stops">{stops.map((s, i) => (
        <li key={s.key}><span className="pl-num static" style={{ ["--bc" as any]: `var(--b-${p.branch || "other"})` }}>{i + 1}</span>
          <div><Link to={`/place/${s.key}`}>{s.name}</Link>
            <div className="small muted">{[...s.what, ...(s.docs ? [T.docs(s.docs)] : [])].join(" · ")}</div></div></li>
      ))}</ol>}
      {loose.length > 0 && <p className="small muted">{T.notOnMap}{loose.map((t, i) => <span key={t}>{i > 0 && "; "}{live ? <Link to={`/places?tab=unplaced&fix=${encodeURIComponent(t)}`}>{t}</Link> : t}</span>)}</p>}
      {stops.length > 0 && <p className="small" style={{ marginBottom: 0 }}><Link to={`/places${stops.length ? `?place=${stops[0].key}` : ""}`}>{T.bigMap}</Link></p>}
    </section>
  );
}
