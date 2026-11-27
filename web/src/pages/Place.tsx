// One place: where it sits (the places that enclose it, the places inside it, and the places near it on a map), who
// was there and what happened, in date order, inside places included, the photos and documents that show or name it,
// and the stories that mention it. Editors can change it, move it inside another place, merge or remove it, and add a
// place inside it.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useData } from "../data";
import { PersonLink, useTitle } from "../lib";
import { eventLabel, mediaUrl } from "../tree";
import { attachmentImageUrl, documentType, documentUrl } from "../documents";
import { enclosing, isPhoto, km, placeIndex, rollup, storiesAt, within } from "../places";
import { PCard, useBrowse, type Place as PlaceRec } from "./browse/shared";
import { PlaceForm } from "./browse/PlaceForm";
import { cssVar, el, useLeaflet } from "./browse/useLeaflet";
import { StoryCard } from "./Stories";
import { NotFound } from "./NotFound";
import { S } from "../../../strings/index.ts";

const T = S.places.place;
const NEAR_KM: Record<string, number> = { building: 2, street: 3, church: 3, cemetery: 3, landmark: 3, district: 10, city: 60, county: 100, region: 300, country: 800 };
const years = (n: { from?: number; to?: number }) => (n.from && n.to ? `${n.from}–${n.to}` : n.from ? T.since(n.from) : n.to ? T.until(n.to) : "");

export function Place() {
  const { key = "" } = useParams();
  const { D, people } = useBrowse();
  const { live, tree } = useData();
  const navigate = useNavigate();
  const places: Record<string, PlaceRec> = D.places || {};
  const pl = places[key];
  const built = placeIndex(D, people);
  useTitle(pl ? pl.name : null);
  const [form, setForm] = useState<"edit" | "inside" | null>(null);
  useEffect(() => { setForm(null); }, [key]); // a form open on one place never saves onto the next
  const all = useMemo(() => (pl ? rollup(built, key) : null), [built, key, pl]);
  const inside = new Set(pl ? within(built, key) : []);
  // nearby: other places within a distance that suits the kind of place (a building's neighbours are streets away)
  const near = useMemo(() => {
    if (!pl) return [];
    const up = new Set(enclosing(D, key)), radius = NEAR_KM[pl.type || ""] ?? 60;
    return Object.values(built.index).filter((o) => !inside.has(o.key) && !up.has(o.key) && !places[o.key]?.approx).map((o) => ({ o, d: km(pl, o) }))
      .filter((x) => x.d <= radius).sort((a, b) => a.d - b.d).slice(0, 10);
  }, [built, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const box = useRef<HTMLDivElement>(null);
  const { M, status } = useLeaflet(box, { scrollWheelZoom: false });
  const nav = useRef(navigate);
  nav.current = navigate;
  useEffect(() => {
    if (!M || !pl) return;
    const { L, layer } = M;
    layer.clearLayers();
    const ink = cssVar("--accent", "#a33"), muted = cssVar("--muted");
    const pts: [number, number][] = [[pl.lat, pl.lng]];
    for (const { o } of near) {
      L.circleMarker([o.lat, o.lng], { radius: 5, color: muted, weight: 1.5, fillOpacity: 0.3 })
        .bindTooltip(el("span", {}, o.name)).on("click", () => nav.current(`/place/${o.key}`)).addTo(layer);
      pts.push([o.lat, o.lng]);
    }
    for (const k of inside) {
      const c = places[k];
      if (k === key || !c || c.approx) continue;
      L.circleMarker([c.lat, c.lng], { radius: 6, color: ink, weight: 2, fillColor: ink, fillOpacity: 0.25 })
        .bindTooltip(el("span", {}, c.short || c.name)).on("click", () => nav.current(`/place/${k}`)).addTo(layer);
      pts.push([c.lat, c.lng]);
    }
    L.circleMarker([pl.lat, pl.lng], { radius: 9, color: ink, weight: 3, fillColor: ink, fillOpacity: pl.approx ? 0.15 : 0.5, dashArray: pl.approx ? "3 3" : undefined })
      .bindTooltip(el("span", {}, pl.name)).addTo(layer);
    if (pts.length > 1) M.map.fitBounds(pts, { padding: [24, 24], maxZoom: 15, animate: false });
    else M.map.setView([pl.lat, pl.lng], pl.type === "country" ? 5 : pl.type === "region" || pl.type === "county" ? 8 : 12, { animate: false });
  }, [M, key, pl?.lat, pl?.lng, near]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!pl || !all) return <NotFound />;
  const up = enclosing(D, key);
  const kids = built.kids[key] || [];
  const photos = all.artifacts.filter((a) => isPhoto(a.m));
  const docs = all.artifacts.filter((a) => !isPhoto(a.m));
  const stories = storiesAt(D, { name: pl.name, short: pl.short, texts: built.index[key]?.texts || [], names: pl.names });
  const events = all.visits.filter((v) => !v.again);
  const what = (pid: string) => [...new Set(all.visits.filter((v) => v.p.id === pid).map((v) => eventLabel(v.e).toLowerCase()))].join(", ");
  const at = (k: string) => (k === key ? null : <Link className="small" to={`/place/${k}`}>{places[k]?.short || places[k]?.name}</Link>);
  const count = (k: string) => rollup(built, k);
  // the usual wording at each place goes without saying; a different one is shown with its event
  const usual: Record<string, string> = {};
  for (const [k, n] of Object.entries(all.visits.reduce((m: Record<string, Record<string, number>>, v) => { const t = v.e.place || ""; (m[v.at] = m[v.at] || {})[t] = (m[v.at]?.[t] || 0) + 1; return m; }, {})))
    usual[k] = Object.entries(n).sort((a, b) => b[1] - a[1])[0][0];

  return (
    <div className="wrap page place-page">
      <nav className="eyebrow crumbs" aria-label={T.crumbs}>
        <Link to={`/places?place=${encodeURIComponent(key)}`}>{T.eyebrow}</Link>
        {up.map((k) => <span key={k}> › <Link to={`/place/${k}`}>{places[k].short || places[k].name}</Link></span>)}
      </nav>
      <h1>{pl.short || pl.name}</h1>
      <p className="muted">
        {pl.type && <span className="chip">{T.types[pl.type as keyof typeof T.types] || pl.type}</span>} {up.length > 0 && <>{T.inPlace(places[up[up.length - 1]].name)} · </>}
        {T.summary(all.people.length, events.length, all.artifacts.length)}{all.from ? ` · ${all.from === all.to ? all.from : `${all.from}–${all.to}`}` : ""}
      </p>
      {pl.names && pl.names.length > 0 && <p className="small">{T.alsoCalled}{pl.names.map((n, i) => <span key={i}>{i > 0 && "; "}<b>{n.name}</b>{years(n) && <span className="muted"> ({years(n)})</span>}</span>)}</p>}
      {pl.note && <p className="place-note">{pl.note}</p>}
      <div className="place-layout">
        <aside>
          <div className="card side">
            <div className="place-map" ref={box} aria-label={T.mapLabel}>
              {status === "error" && <div className="empty">{S.browse.map.failed}</div>}
            </div>
            <p className="small muted" style={{ marginBottom: 0 }}>{pl.approx ? T.approx(places[pl.parent || ""]?.short || "") : `${pl.lat.toFixed(4)}, ${pl.lng.toFixed(4)}`} · <Link to={`/places?${kids.length ? `in=${encodeURIComponent(key)}&` : ""}place=${encodeURIComponent(key)}`}>{T.bigMap}</Link></p>
            {kids.length > 0 && <><h4>{T.insideTitle}</h4><ul className="plain">{kids.map((k) => {
              const r = count(k);
              return <li key={k}><Link to={`/place/${k}`}>{places[k].short || places[k].name}</Link> <span className="small muted">{[places[k].type && T.types[places[k].type as keyof typeof T.types], r.people.length ? T.people(r.people.length) : ""].filter(Boolean).join(" · ")}</span></li>;
            })}</ul></>}
            {near.length > 0 && <><h4>{T.nearby}</h4><ul className="plain">{near.map(({ o, d }) => (
              <li key={o.key}><Link to={`/place/${o.key}`}>{o.short || o.name}</Link> <span className="small muted">{T.km(d < 10 ? Math.round(d * 10) / 10 : Math.round(d))} · {T.people(o.people.length)}</span></li>
            ))}</ul></>}
            {(built.index[key]?.texts.length || 0) > 0 && <><h4>{T.recordedAs}</h4><ul className="plain small">{built.index[key].texts.map((t) => <li key={t}>{t}</li>)}</ul></>}
            {live && !form && <div className="btn-row">
              <button className="btn sm" onClick={() => setForm("edit")}>{T.edit}</button>
              <button className="btn sm" onClick={() => setForm("inside")}>{T.addInside}</button>
            </div>}
          </div>
          {form === "edit" && <PlaceForm key={`e-${key}`} placeKey={key} onCancel={() => setForm(null)} />}
          {form === "inside" && <PlaceForm key={`i-${key}`} parent={key} onCancel={() => setForm(null)} />}
        </aside>
        <div className="place-main">
          {all.people.length > 0 && <section>
            <h2>{T.whoTitle} <span className="count">{all.people.length}</span></h2>
            <p className="small"><Link to={`/people?place=${encodeURIComponent(key)}`}>{T.inPeople}</Link> · <Link to={`/timeline?scope=all&place=${encodeURIComponent(key)}`}>{T.inTimeline}</Link></p>
            <div className="people-grid">{all.people.map((id) => <div key={id} className="p-where"><PCard p={D.people[id] as any} /><span className="small muted">{what(id)}</span></div>)}</div>
          </section>}
          {(photos.length > 0 || docs.length > 0) && <section>
            <h2>{T.artifactsTitle} <span className="count">{all.artifacts.length}</span></h2>
            {photos.length > 0 && <div className="photo-grid">{photos.map((a) => (
              <Link key={a.m.file} to={`/person/${a.pid}?section=w-photos`} className="photo">
                <img referrerPolicy="no-referrer" loading="lazy" alt={a.m.caption || ""} src={documentType(a.m.file) ? attachmentImageUrl(a.m.file, tree, D.previewView) : mediaUrl(a.m.file, tree, D.previewView)} />
                <span className="cap">{a.m.caption || ""}{a.m.date ? ` · ${a.m.date}` : ""}<br /><span className="muted">{a.here === "made" ? T.madeHere : T.namesHere}{a.at !== key ? ` · ${places[a.at]?.short}` : ""} · {D.people[a.pid]?.name}</span></span>
              </Link>))}</div>}
            {docs.length > 0 && <ul className="doc-list">{docs.map((a) => (
              <li key={a.m.file}><a href={documentUrl(a.m.file, tree, D.previewView)} target="_blank" rel="noopener">{a.m.caption || a.m.file.split("/").pop()}</a>
                <span className="small muted"> · {a.m.date ? `${a.m.date} · ` : ""}{a.here === "made" ? T.madeHere : T.namesHere} · <PersonLink id={a.pid} /></span> {at(a.at)}</li>))}</ul>}
          </section>}
          {events.length > 0 && <section>
            <h2>{T.timelineTitle}</h2>
            <ol className="timeline-list place-tl">{events.map((v, i) => (
              <li key={i}><div className="t-date">{v.e.dateDisplay || T.undated}</div><span className="t-dot" style={{ ["--bc" as any]: `var(--b-${v.p.branch || "other"})` }}></span>
                <div className="t-body"><PersonLink id={v.p.id} /> — {eventLabel(v.e).toLowerCase()}{v.spouse ? <> {T.with} <PersonLink id={v.spouse} /></> : null} {at(v.at)}
                  {v.e.place && v.e.place !== usual[v.at] && v.e.place !== places[v.at]?.name && <div className="t-note">{T.recorded(v.e.place)}</div>}</div></li>
            ))}</ol>
          </section>}
          {stories.length > 0 && <section><h2>{T.storiesTitle}</h2><div className="grid g2">{stories.map((s) => <StoryCard key={s.slug} story={s} />)}</div></section>}
          {!all.visits.length && !all.artifacts.length && <p className="empty">{T.nothing}</p>}
        </div>
      </div>
    </div>
  );
}
