// Put a place on the map, or change one: its own name, what kind of place it is, the place it's inside, a point
// (found on OpenStreetMap, typed, clicked on the small map, or left to the enclosing place), other and historical
// names, and the place texts from the tree that mean it. Editors save it (place.save) or merge it into another
// (place.merge); members suggest it.
import { useEffect, useMemo, useRef, useState } from "react";
import { useData } from "../../data";
import { PLACE_TYPES, placeIndex, placeKeyFor, shortName, within } from "../../places";
import { useBrowse, type Place } from "./shared";
import { useLeaflet } from "./useLeaflet";
import { S } from "../../../../strings/index.ts";

const T = S.places.form;
const TYPES = S.places.place.types;

interface Hit { name: string; lat: number; lng: number }
interface AltName { name: string; from: string; to: string }

/** Search OpenStreetMap's gazetteer (Nominatim) for a place name. Only what the member typed is sent. */
async function geocode(q: string): Promise<Hit[]> {
  const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ format: "jsonv2", limit: "6", q })}`;
  const r = await fetch(url, { headers: { Accept: "application/json" }, referrerPolicy: "no-referrer" });
  if (!r.ok) throw new Error(T.searchFailed);
  return (await r.json()).map((x: any) => ({ name: x.display_name, lat: +x.lat, lng: +x.lon }));
}

/**
 * A place text read against the places there are: the longest tail that is a place's full name is where it's inside,
 * the rest is its own name ("14 Fenwick Row, Leeds, England" → "14 Fenwick Row" inside Leeds, England).
 */
export function splitPlaceText(text: string, places: Record<string, { name: string }>) {
  const parts = text.split(",").map((x) => x.trim()).filter(Boolean);
  const byName = new Map(Object.entries(places).map(([k, v]) => [v.name.toLowerCase(), k]));
  for (let i = 1; i < parts.length; i++) {
    const k = byName.get(parts.slice(i).join(", ").toLowerCase());
    if (k) return { name: parts.slice(0, i).join(", "), parent: k };
  }
  return { name: text.trim(), parent: "" };
}

export function PlaceForm({ texts = [], placeKey, parent: parentIn, onDone, onCancel }: { texts?: string[]; placeKey?: string; parent?: string; onDone?: () => void; onCancel: () => void }) {
  const { D, people } = useBrowse();
  const { editor, api } = useData();
  const places: Record<string, Place> = D.places || {};
  const current = placeKey ? places[placeKey] : null;
  const built = placeIndex(D, people);
  const guess = useMemo(() => (texts[0] && !current ? splitPlaceText(texts[0], places) : null), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [mode, setMode] = useState<"new" | "same" | "merge">("new");
  const [name, setName] = useState(current ? current.short || current.name : guess ? guess.name : "");
  const [type, setType] = useState(current?.type || "");
  const [parent, setParent] = useState(current?.parent || parentIn || guess?.parent || "");
  const own = current && !current.approx;
  const [lat, setLat] = useState(own ? String(current!.lat) : "");
  const [lng, setLng] = useState(own ? String(current!.lng) : "");
  const [names, setNames] = useState<AltName[]>((current?.names || []).map((n) => ({ name: n.name, from: n.from ? String(n.from) : "", to: n.to ? String(n.to) : "" })));
  const [note, setNote] = useState(current?.note || "");
  const [q, setQ] = useState(texts[0] || (current ? current.name : ""));
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [other, setOther] = useState("");
  const [kept, setKept] = useState<string[]>(current ? current.texts || [] : []);

  // a place can't be inside itself or a place inside it
  const mine = useMemo(() => new Set(placeKey ? within(built, placeKey) : []), [built, placeKey]);
  const options = useMemo(() => {
    const words = new Set(texts.join(" ").toLowerCase().split(/[\s,]+/).filter((w) => w.length > 3));
    const score = (n: string) => n.toLowerCase().split(/[\s,]+/).filter((w) => words.has(w)).length;
    return Object.entries(places).filter(([k]) => !mine.has(k)).map(([k, v]) => ({ k, name: v.name, s: score(v.name) }))
      .sort((a, b) => b.s - a.s || a.name.localeCompare(b.name));
  }, [places, texts, mine]);
  const byName = useMemo(() => [...options].sort((a, b) => a.name.localeCompare(b.name)), [options]);

  // the small map: shows the point, and a click (or dragging the pin) moves it
  const box = useRef<HTMLDivElement>(null);
  const { M } = useLeaflet(box, { scrollWheelZoom: false });
  const pin = useRef<any>(null);
  const point = Number.isFinite(parseFloat(lat)) && Number.isFinite(parseFloat(lng)) ? [parseFloat(lat), parseFloat(lng)] as [number, number] : null;
  const fallback = parent && places[parent] ? places[parent] : null;
  useEffect(() => {
    if (!M) return;
    const click = (ev: any) => { setLat(ev.latlng.lat.toFixed(6)); setLng(ev.latlng.lng.toFixed(6)); };
    M.map.on("click", click);
    if (!point && fallback) M.map.setView([fallback.lat, fallback.lng], fallback.type === "country" ? 5 : 12, { animate: false });
    return () => { M.map.off("click", click); };
  }, [M]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!M) return;
    if (!point) { pin.current?.remove(); pin.current = null; return; }
    if (!pin.current) {
      pin.current = M.L.marker(point, { draggable: true, keyboard: true, title: T.pin }).addTo(M.map);
      pin.current.on("dragend", () => { const p = pin.current.getLatLng(); setLat(p.lat.toFixed(6)); setLng(p.lng.toFixed(6)); });
      M.map.setView(point, 14, { animate: false });
    } else {
      pin.current.setLatLng(point);
      if (!M.map.getBounds().contains(point)) M.map.panTo(point);
    }
  }, [M, point?.[0], point?.[1]]); // eslint-disable-line react-hooks/exhaustive-deps

  async function search() {
    setErr(""); setBusy(true);
    try {
      const h = await geocode(q.trim());
      setHits(h);
      if (h.length === 1) pick(h[0]);
    } catch (e: any) { setErr(e.message || T.searchFailed); }
    finally { setBusy(false); }
  }
  const pick = (h: Hit) => {
    setLat(h.lat.toFixed(6)); setLng(h.lng.toFixed(6));
    if (!current && !name.trim()) setName(shortName(h.name));
    M?.map.setView([h.lat, h.lng], 15, { animate: false });
  };

  async function send(ops: any[], reason: string) {
    setBusy(true);
    try {
      if (editor) await api("POST", "edit", { reason, ops });
      else { await api("POST", "proposals", { kind: "edit", payload: { reason, ops }, rationale: reason }); alert(T.suggested); }
      return true;
    } catch (e: any) { setErr(e.message); setBusy(false); return false; }
  }
  const done = (hash?: string) => {
    if (onDone) return onDone();
    if (hash) location.hash = hash;
    location.reload();
  };

  async function save(ev: React.FormEvent) {
    ev.preventDefault();
    setErr("");
    if (mode === "same") {
      if (!other) return setErr(T.pickPlace);
      if (await send([{ op: "place.save", key: other, add_texts: texts }], T.reasonSame(texts.join("; "), places[other].name))) done();
      return;
    }
    if (mode === "merge") {
      if (!other) return setErr(T.pickPlace);
      if (!confirm(T.mergeConfirm(current!.name, places[other].name))) return;
      if (await send([{ op: "place.merge", keep: other, drop: placeKey }], T.reasonMerge(current!.name, places[other].name))) done(`#/place/${other}`);
      return;
    }
    if (!name.trim()) return setErr(T.nameRequired);
    if ((lat.trim() || lng.trim()) && !point) return setErr(T.pointBad);
    if (!point && !parent) return setErr(T.pointRequired);
    const alt: any[] = [];
    for (const n of names) {
      if (!n.name.trim()) continue;
      const from = n.from.trim() ? Number(n.from) : undefined, to = n.to.trim() ? Number(n.to) : undefined;
      if ((from != null && !Number.isInteger(from)) || (to != null && !Number.isInteger(to))) return setErr(T.yearBad);
      alt.push({ name: n.name.trim(), ...(from != null ? { from } : {}), ...(to != null ? { to } : {}) });
    }
    const enclosingName = parent && places[parent] ? places[parent].name : "";
    const full = enclosingName ? `${name.trim()}, ${enclosingName}` : name.trim();
    const key = placeKey || placeKeyFor(enclosingName ? `${name}, ${places[parent].short || enclosingName}` : name, places);
    const op: any = { op: "place.save", key, name: name.trim(), type: type || null, parent: parent || null, lat: point ? point[0] : null, lng: point ? point[1] : null, names: alt, note: note.trim() || null };
    if (current) op.texts = kept; else if (texts.length) op.texts = texts;
    if (await send([op], current ? T.reasonEdit(full) : T.reasonNew(full))) done(!current && !texts.length ? `#/place/${key}` : undefined);
  }

  async function remove() {
    if (!placeKey || !confirm(T.removeConfirm(current!.name))) return;
    if (await send([{ op: "place.delete", key: placeKey }], T.reasonRemove(current!.name))) done("#/places");
  }

  const modes: ["new" | "same" | "merge", string][] = current ? [["new", T.modeEdit], ["merge", T.modeMerge]] : texts.length ? [["new", T.modeNew], ["same", T.modeSame]] : [];
  const setAlt = (i: number, patch: Partial<AltName>) => setNames(names.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <form className="card sub place-form" onSubmit={save}>
      {texts.length > 0 && <p className="small">{T.forTexts}{texts.map((t, i) => <span key={i}>{i > 0 && "; "}<b>{t}</b></span>)}</p>}
      {modes.length > 0 && options.length > 0 && (
        <div className="seg" role="radiogroup" aria-label={T.modeLabel}>
          {modes.map(([m, l]) => <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>{l}</button>)}
        </div>
      )}
      {mode !== "new" ? (
        <label className="field">{mode === "merge" ? T.mergeInto : T.samePlace}
          <select value={other} onChange={(e) => setOther(e.target.value)} required>
            <option value="">{T.choose}</option>
            {(mode === "merge" ? byName : options).filter((o) => o.k !== placeKey).map((o) => <option key={o.k} value={o.k}>{o.name}</option>)}
          </select>
          <span className="small muted">{mode === "merge" ? T.mergeHelp : T.sameHelp}</span>
        </label>
      ) : <>
        <label className="field">{T.name}<input value={name} onChange={(e) => setName(e.target.value)} placeholder={T.namePlaceholder} aria-label={T.name} required />
          <span className="small muted">{T.nameHelp}</span></label>
        <div className="btn-row">
          <label className="field" style={{ flex: "1 1 140px" }}>{T.type}
            <select value={type} onChange={(e) => setType(e.target.value)}><option value="">{T.typeNone}</option>{PLACE_TYPES.map((t) => <option key={t} value={t}>{TYPES[t]}</option>)}</select></label>
          <label className="field" style={{ flex: "2 1 200px" }}>{T.parent}
            <select value={parent} onChange={(e) => setParent(e.target.value)}><option value="">{T.parentNone}</option>{byName.map((o) => <option key={o.k} value={o.k}>{o.name}</option>)}</select></label>
        </div>
        {fallback && <p className="small muted" style={{ margin: 0 }}>{T.fullName(`${name.trim() || "…"}, ${fallback.name}`)}</p>}
        <div className="field">
          <span>{T.find}</span>
          <div className="btn-row" style={{ marginTop: 4 }}>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} aria-label={T.find} style={{ flex: 1, minWidth: 0 }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (q.trim()) search(); } }} />
            <button type="button" className="btn" disabled={busy || !q.trim()} onClick={search}>{T.search}</button>
          </div>
          <span className="small muted">{T.privacy}</span>
        </div>
        {hits && (hits.length ? <ul className="geo-hits">{hits.map((h, i) => <li key={i}><button type="button" className="linklike" onClick={() => pick(h)}>{h.name}</button></li>)}</ul>
          : <p className="small muted">{T.noHits(shortName(q))}</p>)}
        <div className="place-pick" ref={box} aria-label={T.mapLabel} />
        <p className="small muted" style={{ marginTop: 4 }}>{fallback && !point ? T.borrowHelp(fallback.short || fallback.name) : T.mapHelp}</p>
        <div className="btn-row">
          <label className="field small">{T.lat}<input inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} style={{ width: 120 }} /></label>
          <label className="field small">{T.lng}<input inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} style={{ width: 120 }} /></label>
          {point && parent && <button type="button" className="linklike small" onClick={() => { setLat(""); setLng(""); }}>{T.clearPoint}</button>}
        </div>
        <div className="field"><span>{T.names}</span>
          {names.map((n, i) => (
            <div className="btn-row alt-name" key={i}>
              <input value={n.name} aria-label={T.altName} placeholder={T.altName} onChange={(e) => setAlt(i, { name: e.target.value })} style={{ flex: "2 1 140px" }} />
              <input value={n.from} inputMode="numeric" aria-label={T.from} placeholder={T.from} onChange={(e) => setAlt(i, { from: e.target.value })} style={{ width: 72 }} />
              <input value={n.to} inputMode="numeric" aria-label={T.to} placeholder={T.to} onChange={(e) => setAlt(i, { to: e.target.value })} style={{ width: 72 }} />
              <button type="button" className="linklike" aria-label={T.removeName(n.name)} onClick={() => setNames(names.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          <button type="button" className="linklike small" style={{ alignSelf: "flex-start" }} onClick={() => setNames([...names, { name: "", from: "", to: "" }])}>{T.addName}</button>
          <span className="small muted">{T.namesHelp}</span>
        </div>
        <label className="field">{T.note}<textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></label>
        {current && kept.length > 0 && (
          <div className="field"><span>{T.texts}</span>
            <ul className="place-texts">{kept.map((t) => <li key={t}>{t} <button type="button" className="linklike" aria-label={T.removeText(t)} onClick={() => setKept(kept.filter((x) => x !== t))}>×</button></li>)}</ul>
          </div>
        )}
      </>}
      {err && <p className="small sev-error" role="alert">{err}</p>}
      <div className="btn-row">
        <button className="btn primary" disabled={busy}>{editor ? (mode === "merge" ? T.merge : T.save) : T.suggest}</button>
        <button type="button" className="btn" onClick={onCancel}>{T.cancel}</button>
        {current && mode === "new" && <button type="button" className="btn danger" style={{ marginLeft: "auto" }} disabled={busy} onClick={remove}>{T.remove}</button>}
      </div>
    </form>
  );
}
