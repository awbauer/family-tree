// The Places page: every place on the map with what happened there, who was there and the photos and documents that
// show or name it. A side panel lists and filters the places (name, branch, direct line, years) and opens one; the
// map follows. Places in the tree that aren't on the map yet are listed too, to be put on it.
// A "By place" tab browses the places as a hierarchy (country › city › street › building).
// URL: ?place=&q=&branch=&direct=1&from=&to=&tab=tree|unplaced&fix=<place text>
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useData } from "../data";
import { PersonLink, norm, useTitle } from "../lib";
import { eventLabel, mediaUrl } from "../tree";
import { attachmentImageUrl, documentType, documentUrl } from "../documents";
import { enclosing, isPhoto, placeIndex, rollup, yearOf, type Visit } from "../places";
import { useBrowse } from "./browse/shared";
import { PlaceForm } from "./browse/PlaceForm";
import { cssVar, el, useLeaflet } from "./browse/useLeaflet";
import { S } from "../../../strings/index.ts";

const T = S.places.map;

const mediaYear = (m: any) => { const y = String(m.date || "").match(/\b(1[0-9]{3}|20[0-9]{2})\b/); return y ? +y[1] : null; };

export function Places() {
  useTitle(T.title);
  const { D, people } = useBrowse();
  const { live, tree } = useData();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const nav = useRef(navigate);
  nav.current = navigate;
  const get = (k: string) => params.get(k) || "";
  const set = (patch: Record<string, string | null>) => {
    const ps = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) if (v) ps.set(k, v); else ps.delete(k);
    setParams(ps, { replace: true });
  };
  const sel = get("place"), q = get("q"), branch = get("branch"), direct = get("direct") === "1", tab = get("tab") === "unplaced" ? "unplaced" : get("tab") === "tree" ? "tree" : "places";
  const fix = get("fix");
  const [journeys, setJourneys] = useState(false);
  const built = placeIndex(D, people);
  const { index, unplaced } = built;
  const places = D.places || {};
  const all = useMemo(() => Object.values(index), [index]);
  const span = useMemo(() => {
    const ys = all.flatMap((p) => [p.from, p.to]).filter((y): y is number => y != null);
    return ys.length ? [Math.min(...ys), Math.max(...ys)] : null;
  }, [all]);
  const from = +get("from") || null, to = +get("to") || null;

  // what's shown: each place with only the events and documents that pass the filters
  const shown = useMemo(() => {
    const okPerson = (v: Visit) => (!branch || v.p.branch === branch) && (!direct || v.p.direct);
    const okYear = (y: number | null) => (!from || (y != null && y >= from)) && (!to || (y != null && y <= to));
    const words = norm(q).trim();
    return all.map((pl) => {
      const visits = pl.visits.filter((v) => okPerson(v) && okYear(yearOf(v.e)));
      const artifacts = pl.artifacts.filter((a) => (!branch || D.people[a.pid]?.branch === branch) && (!direct || (D.people[a.pid] as any)?.direct) && (!(from || to) || okYear(mediaYear(a.m))));
      return { pl, visits, artifacts, people: [...new Set(visits.map((v) => v.p.id))] };
    }).filter((x) => (x.visits.length || x.artifacts.length) && (!words || norm([x.pl.name, ...x.pl.texts].join(" ")).includes(words)))
      .sort((a, b) => b.people.length - a.people.length || b.artifacts.length - a.artifacts.length || a.pl.name.localeCompare(b.pl.name));
  }, [all, branch, direct, from, to, q, D]);
  // the chosen place, with everything inside it
  const current = sel && places[sel] ? { key: sel, ...rollup(built, sel) } : null;
  // a place without a point of its own (a street, say) is shown on its enclosing place's marker
  const anchor = (k: string) => { let at = k; for (let i = 0; i < 20 && places[at]?.approx && places[at].parent; i++) at = places[at].parent!; return at; };
  const groups = useMemo(() => {
    const g = new Map<string, { key: string; visits: Visit[]; artifacts: any[]; people: Set<string>; keys: string[] }>();
    for (const x of shown) {
      const k = anchor(x.pl.key);
      const e = g.get(k) || { key: k, visits: [], artifacts: [], people: new Set<string>(), keys: [] };
      e.visits.push(...x.visits); e.artifacts.push(...x.artifacts); x.people.forEach((id) => e.people.add(id)); e.keys.push(x.pl.key);
      g.set(k, e);
    }
    return [...g.values()];
  }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps

  const box = useRef<HTMLDivElement>(null);
  const { M, status } = useLeaflet(box);
  const markers = useRef<Record<string, any>>({});
  const fitted = useRef(false);

  useEffect(() => {
    if (!M) return;
    const { L, layer } = M;
    layer.clearLayers();
    markers.current = {};
    const pts: [number, number][] = [];
    for (const x of groups) {
      const pl = places[x.key];
      if (!pl) continue;
      const counts: Record<string, number> = {};
      x.visits.forEach((v) => { counts[String(v.p.branch)] = (counts[String(v.p.branch)] || 0) + 1; });
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "other";
      const col = cssVar(`--b-${top}`);
      const on = x.keys.includes(sel) || x.key === sel;
      const docsOnly = !x.visits.length;
      const m = L.circleMarker([pl.lat, pl.lng], {
        radius: 5 + Math.sqrt(Math.max(x.people.size, docsOnly ? 1 : 0)) * 2.4 + (on ? 3 : 0), color: on ? cssVar("--ink", "#222") : col, weight: on ? 3 : 2,
        fillColor: col, fillOpacity: docsOnly ? 0.15 : 0.45, dashArray: docsOnly ? "3 3" : undefined,
      });
      const also = x.keys.filter((k) => k !== x.key).length;
      m.bindTooltip(el("span", {}, `${pl.name} · ${T.counts(x.people.size, x.visits.filter((v) => !v.again).length, x.artifacts.length)}${also ? ` · ${T.alsoInside(also)}` : ""}`));
      m.on("click", () => set({ place: x.keys.length === 1 ? x.keys[0] : x.key }));
      m.addTo(layer);
      for (const k of [x.key, ...x.keys]) markers.current[k] = m;
      pts.push([pl.lat, pl.lng]);
    }
    if (journeys) for (const p of people) {
      if ((branch && p.branch !== branch) || (direct && !p.direct)) continue;
      const bE = p.events.find((e) => e.type === "Birth" && e.placeKey), dE = p.events.find((e) => (e.type === "Death" || e.type === "Burial") && e.placeKey && !e.misfiled);
      if (!bE || !dE || bE.placeKey === dE.placeKey) continue;
      const a = index[bE.placeKey!], c = index[dE.placeKey!];
      if (!a || !c) continue;
      const dist = Math.hypot(a.lat - c.lat, a.lng - c.lng);
      if (dist < 1.5) continue;
      const mid = [(a.lat + c.lat) / 2 + dist * 0.12, (a.lng + c.lng) / 2];
      const arc: [number, number][] = [];
      for (let i = 0; i <= 24; i++) { const t = i / 24; arc.push([(1 - t) * (1 - t) * a.lat + 2 * (1 - t) * t * mid[0] + t * t * c.lat, (1 - t) * (1 - t) * a.lng + 2 * (1 - t) * t * mid[1] + t * t * c.lng]); }
      L.polyline(arc, { color: cssVar(`--b-${p.branch}`), weight: 1.6, opacity: 0.55, dashArray: "4 5", interactive: true })
        .bindTooltip(el("span", {}, `${p.name}: ${a.name} → ${c.name}`)).addTo(layer);
    }
    if (!fitted.current && pts.length) {
      fitted.current = true;
      if (sel && places[sel]) M.map.setView([places[sel].lat, places[sel].lng], 11);
      else M.map.fitBounds(pts, { padding: [30, 30], maxZoom: 7 });
    }
  }, [M, groups, sel, journeys]); // eslint-disable-line react-hooks/exhaustive-deps

  // a newly chosen place comes into view (without zooming out of a closer look)
  useEffect(() => {
    if (!M || !sel || !places[sel]) return;
    const pl = places[sel];
    M.map.flyTo([pl.lat, pl.lng], Math.max(M.map.getZoom(), 9), { duration: 0.6 });
  }, [M, sel]); // eslint-disable-line react-hooks/exhaustive-deps

  const fitAll = () => { if (M && shown.length) M.map.fitBounds(shown.map((x) => [x.pl.lat, x.pl.lng]), { padding: [30, 30], maxZoom: 7 }); };
  const branches = D.research.branches || [];
  const filtered = !!(q || branch || direct || from || to);

  return (
    <div className="places-page">
      <aside className="places-side" aria-label={T.panel}>
        {current ? <PlacePanel x={current} onBack={() => set({ place: null })} onPick={(k) => set({ place: k })} tree={tree} preview={D.previewView} /> : <>
          <div className="places-head">
            <h1>{T.heading}</h1>
            <p className="small muted">{T.summary(shown.length, unplaced.length)}</p>
          </div>
          <div className="seg places-tabs" role="tablist">
            <button role="tab" aria-selected={tab === "places"} className={tab === "places" ? "on" : ""} onClick={() => set({ tab: null })}>{T.tabPlaces(shown.length)}</button>
            <button role="tab" aria-selected={tab === "tree"} className={tab === "tree" ? "on" : ""} onClick={() => set({ tab: "tree" })}>{T.tabTree}</button>
            <button role="tab" aria-selected={tab === "unplaced"} className={tab === "unplaced" ? "on" : ""} onClick={() => set({ tab: "unplaced" })}>{T.tabUnplaced(unplaced.length)}</button>
          </div>
          {tab === "tree" ? <PlaceTree onPick={(k) => set({ place: k })} live={live} /> : tab === "places" ? <>
            <div className="places-filters">
              <input type="search" value={q} onChange={(e) => set({ q: e.target.value || null })} placeholder={T.find} aria-label={T.find} />
              <select value={branch} onChange={(e) => set({ branch: e.target.value || null })} aria-label={S.browse.filters.allBranches}>
                <option value="">{S.browse.filters.allBranches}</option>{branches.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
              </select>
              {span && <div className="years">
                <label>{T.from}<input type="number" inputMode="numeric" min={span[0]} max={span[1]} placeholder={String(span[0])} value={from || ""} onChange={(e) => set({ from: e.target.value || null })} /></label>
                <label>{T.to}<input type="number" inputMode="numeric" min={span[0]} max={span[1]} placeholder={String(span[1])} value={to || ""} onChange={(e) => set({ to: e.target.value || null })} /></label>
              </div>}
              <label className="small"><input type="checkbox" checked={direct} onChange={(e) => set({ direct: e.target.checked ? "1" : null })} /> {S.browse.filters.directOnly}</label>
              <label className="small"><input type="checkbox" checked={journeys} onChange={(e) => setJourneys(e.target.checked)} /> {T.journeys}</label>
              {filtered && <button className="linklike small" onClick={() => setParams(new URLSearchParams(), { replace: true })}>{T.clear}</button>}
            </div>
            <ul className="places-list">
              {shown.map((x) => (
                <li key={x.pl.key}><button onClick={() => set({ place: x.pl.key })} onMouseEnter={() => markers.current[x.pl.key]?.openTooltip()} onMouseLeave={() => markers.current[x.pl.key]?.closeTooltip()}>
                  <span className="pl-name">{x.pl.name}</span>
                  <span className="pl-meta">{T.counts(x.people.length, x.visits.filter((v) => !v.again).length, x.artifacts.length)}{x.pl.from ? ` · ${x.pl.from === x.pl.to ? x.pl.from : `${x.pl.from}–${x.pl.to}`}` : ""}</span>
                </button></li>
              ))}
              {!shown.length && <li className="muted small" style={{ padding: 12 }}>{T.noneShown}</li>}
            </ul>
          </> : <Unplaced fix={fix} setFix={(t) => set({ fix: t })} live={live} />}
        </>}
      </aside>
      <div className="places-map">
        <div id="map" ref={box} aria-label={T.mapLabel}>
          {status === "loading" && <div className="empty" style={{ margin: 40 }}>{S.browse.map.loading}</div>}
          {status === "error" && <div className="empty" style={{ margin: 40 }}>{S.browse.map.failed}</div>}
        </div>
        {status === "ready" && <button className="btn sm map-fit" onClick={fitAll}>{T.fit}</button>}
      </div>
    </div>
  );
}

/** One place in the side panel: where it is, what happened there and inside it, who, and the photos and documents. */
function PlacePanel({ x, onBack, onPick, tree, preview }: { x: { key: string } & ReturnType<typeof rollup>; onBack: () => void; onPick: (k: string) => void; tree: string | null; preview?: string | null }) {
  const { D, people } = useBrowse();
  const built = placeIndex(D, people);
  const places = D.places || {};
  const pl = places[x.key];
  const events = x.visits.filter((v) => !v.again);
  const photos = x.artifacts.filter((a) => isPhoto(a.m)).slice(0, 6);
  const docs = x.artifacts.filter((a) => !isPhoto(a.m));
  const up = enclosing(D, x.key);
  const kids = built.kids[x.key] || [];
  const at = (k: string) => (k === x.key ? null : <button className="linklike small" onClick={() => onPick(k)}>{places[k]?.short || places[k]?.name}</button>);
  return (
    <div className="place-panel">
      <button className="linklike small" onClick={onBack}>{T.back}</button>
      {up.length > 0 && <div className="small muted crumbs">{up.map((k, i) => <span key={k}>{i > 0 && " › "}<button className="linklike" onClick={() => onPick(k)}>{places[k].short || places[k].name}</button></span>)}</div>}
      <h2>{pl.short || pl.name}</h2>
      <p className="small muted">{pl.type ? `${S.places.place.types[pl.type as keyof typeof S.places.place.types] || pl.type} · ` : ""}{T.counts(x.people.length, events.length, x.artifacts.length)}{x.from ? ` · ${x.from === x.to ? x.from : `${x.from}–${x.to}`}` : ""}</p>
      <p><Link className="btn sm primary" to={`/place/${x.key}`}>{T.open}</Link></p>
      {kids.length > 0 && <><h4>{T.inside}</h4><ul className="plain">{kids.map((k) => <li key={k}><button className="linklike" onClick={() => onPick(k)}>{places[k].short || places[k].name}</button></li>)}</ul></>}
      {photos.length > 0 && <div className="photo-grid mini">{photos.map((a) => (
        <Link key={a.m.file} to={`/person/${a.pid}?section=w-photos`} className="photo" title={a.m.caption || ""}>
          <img referrerPolicy="no-referrer" loading="lazy" alt={a.m.caption || ""} src={documentType(a.m.file) ? attachmentImageUrl(a.m.file, tree, preview) : mediaUrl(a.m.file, tree, preview)} />
        </Link>))}</div>}
      {docs.length > 0 && <><h4>{T.documents}</h4><ul className="plain">{docs.map((a) => (
        <li key={a.m.file}><a href={documentUrl(a.m.file, tree, preview)} target="_blank" rel="noopener">{a.m.caption || a.m.file.split("/").pop()}</a> <span className="small muted">· <PersonLink id={a.pid} /></span> {at(a.at)}</li>))}</ul></>}
      {events.length > 0 && <><h4>{T.happened}</h4>
        <ol className="plain visits">{events.slice(0, 80).map((v, i) => (
          <li key={i}><span className="small muted v-date">{v.e.dateDisplay || T.undated}</span> <PersonLink id={v.p.id} /> <span className="small">{eventLabel(v.e).toLowerCase()}{v.spouse ? <> {T.with} <PersonLink id={v.spouse} /></> : null}</span> {at(v.at)}</li>
        ))}</ol>
        {events.length > 80 && <p className="small muted">{T.more(events.length - 80)}</p>}</>}
    </div>
  );
}

/** The places as a hierarchy: each with what happened in it and inside it, opened a level at a time. */
function PlaceTree({ onPick, live }: { onPick: (k: string) => void; live: boolean }) {
  const { D, people } = useBrowse();
  const built = placeIndex(D, people);
  const places = D.places || {};
  const [open, setOpen] = useState<Set<string>>(() => new Set(built.roots.length === 1 ? built.roots : []));
  const [adding, setAdding] = useState(false);
  const counts = useMemo(() => Object.fromEntries(Object.keys(places).map((k) => { const r = rollup(built, k); return [k, { people: r.people.length, events: r.visits.filter((v) => !v.again).length, docs: r.artifacts.length }]; })), [built, places]);
  const node = (k: string): any => {
    const kids = built.kids[k] || [], c = counts[k], on = open.has(k);
    return (
      <li key={k}>
        <div className={`pt-row${c.events || c.docs ? "" : " empty-place"}`}>
          {kids.length ? <button className="pt-toggle" aria-expanded={on} aria-label={on ? T.collapse(places[k].short || places[k].name) : T.expand(places[k].short || places[k].name)}
            onClick={() => setOpen((s) => { const n = new Set(s); if (on) n.delete(k); else n.add(k); return n; })}>{on ? "▾" : "▸"}</button> : <span className="pt-toggle" />}
          <button className="pt-name" onClick={() => onPick(k)}><span className="pl-name">{places[k].short || places[k].name}</span>
            <span className="pl-meta">{[places[k].type && S.places.place.types[places[k].type as keyof typeof S.places.place.types], T.counts(c.people, c.events, c.docs), kids.length ? T.placesInside(kids.length) : ""].filter(Boolean).join(" · ")}</span></button>
        </div>
        {on && kids.length > 0 && <ul className="pt">{kids.map(node)}</ul>}
      </li>
    );
  };
  return (
    <div className="place-tree">
      <p className="small muted">{T.treeHelp}</p>
      <ul className="pt pt-root">{built.roots.map(node)}</ul>
      {live && (adding ? <PlaceForm onCancel={() => setAdding(false)} /> : <button className="btn sm" onClick={() => setAdding(true)}>{T.addPlace}</button>)}
    </div>
  );
}

/** Place texts in the tree that aren't on the map, with a form to put one on it. */
function Unplaced({ fix, setFix, live }: { fix: string; setFix: (t: string | null) => void; live: boolean }) {
  const { D, people } = useBrowse();
  const { unplaced } = placeIndex(D, people);
  const [q, setQ] = useState("");
  const list = unplaced.filter((u) => !q || norm(u.text).includes(norm(q)));
  if (!unplaced.length) return <p className="small muted" style={{ padding: "0 16px" }}>{T.allPlaced}</p>;
  return (
    <div className="unplaced">
      <p className="small muted">{live ? T.unplacedHelp : T.unplacedHelpStatic}</p>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={T.findUnplaced} aria-label={T.findUnplaced} />
      <ul className="places-list">
        {list.slice(0, 200).map((u) => (
          <li key={u.text} className={fix === u.text ? "open" : ""}>
            <div className="un-row">
              <span className="pl-name">{u.text}</span>
              <span className="pl-meta">{T.unplacedCounts(u.people.length, u.visits.length)}: {u.people.slice(0, 3).map((id, i) => <span key={id}>{i > 0 && ", "}<PersonLink id={id} /></span>)}{u.people.length > 3 ? "…" : ""}</span>
              {live && fix !== u.text && <button className="btn sm" onClick={() => setFix(u.text)}>{T.putOnMap}</button>}
            </div>
            {fix === u.text && <PlaceForm texts={[u.text]} onCancel={() => setFix(null)} />}
          </li>
        ))}
      </ul>
    </div>
  );
}
