// One place: where it is (with the places near it), who was there and what happened, in date order, the photos and
// documents that show or name it, and the stories that mention it. Editors can move, rename or remove it.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useData } from "../data";
import { PersonLink, useTitle } from "../lib";
import { eventLabel, mediaUrl } from "../tree";
import { attachmentImageUrl, documentType, documentUrl } from "../documents";
import { isPhoto, km, placeIndex, storiesAt } from "../places";
import { PCard, useBrowse } from "./browse/shared";
import { PlaceForm } from "./browse/PlaceForm";
import { cssVar, el, useLeaflet } from "./browse/useLeaflet";
import { StoryCard } from "./Stories";
import { NotFound } from "./NotFound";
import { S } from "../../../strings/index.ts";

const T = S.places.place;
const NEAR_KM = 60;

export function Place() {
  const { key = "" } = useParams();
  const { D, people } = useBrowse();
  const { live, tree } = useData();
  const navigate = useNavigate();
  const base = (D.places || {})[key];
  const { index } = placeIndex(D, people);
  const pl = index[key] || (base ? { key, ...base, visits: [], people: [], artifacts: [], from: null, to: null, texts: [] } : null);
  useTitle(pl ? pl.name : null);
  const [editing, setEditing] = useState(false);
  const near = useMemo(() => pl ? Object.values(index).filter((o) => o.key !== key).map((o) => ({ o, d: km(pl, o) })).filter((x) => x.d <= NEAR_KM).sort((a, b) => a.d - b.d).slice(0, 12) : [], [index, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const box = useRef<HTMLDivElement>(null);
  const { M, status } = useLeaflet(box, { scrollWheelZoom: false });
  const nav = useRef(navigate);
  nav.current = navigate;
  useEffect(() => {
    if (!M || !pl) return;
    const { L, layer } = M;
    layer.clearLayers();
    const ink = cssVar("--accent", "#a33");
    for (const { o } of near) {
      L.circleMarker([o.lat, o.lng], { radius: 5, color: cssVar("--muted"), weight: 1.5, fillOpacity: 0.3 })
        .bindTooltip(el("span", {}, o.name)).on("click", () => nav.current(`/place/${o.key}`)).addTo(layer);
    }
    L.circleMarker([pl.lat, pl.lng], { radius: 9, color: ink, weight: 3, fillColor: ink, fillOpacity: 0.5 }).bindTooltip(el("span", {}, pl.name)).addTo(layer);
    if (near.length) M.map.fitBounds([[pl.lat, pl.lng], ...near.map(({ o }) => [o.lat, o.lng])], { padding: [24, 24], maxZoom: 12, animate: false });
    else M.map.setView([pl.lat, pl.lng], 11, { animate: false });
  }, [M, key, pl?.lat, pl?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!pl) return <NotFound />;
  const photos = pl.artifacts.filter((a) => isPhoto(a.m));
  const docs = pl.artifacts.filter((a) => !isPhoto(a.m));
  const stories = storiesAt(D, pl);
  const events = pl.visits.filter((v) => !v.again);
  const what = (pid: string) => [...new Set(pl.visits.filter((v) => v.p.id === pid).map((v) => eventLabel(v.e).toLowerCase()))].join(", ");

  return (
    <div className="wrap page place-page">
      <div className="eyebrow"><Link to={`/places?place=${encodeURIComponent(key)}`}>{T.eyebrow}</Link></div>
      <h1>{pl.name}</h1>
      <p className="muted">{T.summary(pl.people.length, events.length, pl.artifacts.length)}{pl.from ? ` · ${pl.from === pl.to ? pl.from : `${pl.from}–${pl.to}`}` : ""}</p>
      <div className="place-layout">
        <aside>
          <div className="card side">
            <div className="place-map" ref={box} aria-label={T.mapLabel}>
              {status === "error" && <div className="empty">{S.browse.map.failed}</div>}
            </div>
            <p className="small muted" style={{ marginBottom: 0 }}>{pl.lat.toFixed(4)}, {pl.lng.toFixed(4)} · <Link to={`/places?place=${encodeURIComponent(key)}`}>{T.bigMap}</Link></p>
            {near.length > 0 && <><h4>{T.nearby}</h4><ul className="plain">{near.map(({ o, d }) => (
              <li key={o.key}><Link to={`/place/${o.key}`}>{o.name}</Link> <span className="small muted">{T.km(Math.round(d))} · {T.people(o.people.length)}</span></li>
            ))}</ul></>}
            {pl.texts.length > 0 && <><h4>{T.recordedAs}</h4><ul className="plain small">{pl.texts.map((t) => <li key={t}>{t}</li>)}</ul></>}
            {live && !editing && <div className="btn-row"><button className="btn sm" onClick={() => setEditing(true)}>{T.edit}</button></div>}
          </div>
          {editing && <PlaceForm placeKey={key} onCancel={() => setEditing(false)} />}
        </aside>
        <div className="place-main">
          {pl.people.length > 0 && <section>
            <h2>{T.whoTitle} <span className="count">{pl.people.length}</span></h2>
            <div className="people-grid">{pl.people.map((id) => <div key={id} className="p-where"><PCard p={D.people[id] as any} /><span className="small muted">{what(id)}</span></div>)}</div>
          </section>}
          {(photos.length > 0 || docs.length > 0) && <section>
            <h2>{T.artifactsTitle} <span className="count">{pl.artifacts.length}</span></h2>
            {photos.length > 0 && <div className="photo-grid">{photos.map((a) => (
              <Link key={a.m.file} to={`/person/${a.pid}?section=w-photos`} className="photo">
                <img referrerPolicy="no-referrer" loading="lazy" alt={a.m.caption || ""} src={documentType(a.m.file) ? attachmentImageUrl(a.m.file, tree, D.previewView) : mediaUrl(a.m.file, tree, D.previewView)} />
                <span className="cap">{a.m.caption || ""}{a.m.date ? ` · ${a.m.date}` : ""}<br /><span className="muted">{a.here === "made" ? T.madeHere : T.namesHere} · {D.people[a.pid]?.name}</span></span>
              </Link>))}</div>}
            {docs.length > 0 && <ul className="doc-list">{docs.map((a) => (
              <li key={a.m.file}><a href={documentUrl(a.m.file, tree, D.previewView)} target="_blank" rel="noopener">{a.m.caption || a.m.file.split("/").pop()}</a>
                <span className="small muted"> · {a.m.date ? `${a.m.date} · ` : ""}{a.here === "made" ? T.madeHere : T.namesHere} · <PersonLink id={a.pid} /></span></li>))}</ul>}
          </section>}
          {events.length > 0 && <section>
            <h2>{T.timelineTitle}</h2>
            <ol className="timeline-list place-tl">{events.map((v, i) => (
              <li key={i}><div className="t-date">{v.e.dateDisplay || T.undated}</div><span className="t-dot" style={{ ["--bc" as any]: `var(--b-${v.p.branch || "other"})` }}></span>
                <div className="t-body"><PersonLink id={v.p.id} /> — {eventLabel(v.e).toLowerCase()}{v.spouse ? <> {T.with} <PersonLink id={v.spouse} /></> : null}
                  {v.e.place !== pl.name && <div className="t-note">{v.e.place}</div>}</div></li>
            ))}</ol>
          </section>}
          {stories.length > 0 && <section><h2>{T.storiesTitle}</h2><div className="grid g2">{stories.map((s) => <StoryCard key={s.slug} story={s} />)}</div></section>}
          {!pl.visits.length && !pl.artifacts.length && <p className="empty">{T.nothing}</p>}
        </div>
      </div>
    </div>
  );
}
