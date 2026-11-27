// Put a place on the map, or change one: a name and a point (found on OpenStreetMap, typed, or clicked on the small
// map), and the place texts from the tree that mean it. Editors save it (place.save); members suggest it.
import { useEffect, useMemo, useRef, useState } from "react";
import { useData } from "../../data";
import { placeIndex, placeKeyFor, shortName } from "../../places";
import { useBrowse } from "./shared";
import { useLeaflet } from "./useLeaflet";
import { S } from "../../../../strings/index.ts";

const T = S.places.form;

interface Hit { name: string; lat: number; lng: number }

/** Search OpenStreetMap's gazetteer (Nominatim) for a place name. Only what the member typed is sent. */
async function geocode(q: string): Promise<Hit[]> {
  const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ format: "jsonv2", limit: "6", q })}`;
  const r = await fetch(url, { headers: { Accept: "application/json" }, referrerPolicy: "no-referrer" });
  if (!r.ok) throw new Error(T.searchFailed);
  return (await r.json()).map((x: any) => ({ name: x.display_name, lat: +x.lat, lng: +x.lon }));
}

export function PlaceForm({ texts = [], placeKey, onDone, onCancel }: { texts?: string[]; placeKey?: string; onDone?: () => void; onCancel: () => void }) {
  const { D, people } = useBrowse();
  const { editor, api } = useData();
  const places = D.places || {};
  const current = placeKey ? places[placeKey] : null;
  const { index } = placeIndex(D, people);
  const [mode, setMode] = useState<"new" | "same">("new");
  const [name, setName] = useState(current ? current.name : texts[0] || "");
  const [lat, setLat] = useState(current ? String(current.lat) : "");
  const [lng, setLng] = useState(current ? String(current.lng) : "");
  const [q, setQ] = useState(current ? current.name : texts[0] || "");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [same, setSame] = useState("");
  const [kept, setKept] = useState<string[]>(current ? current.texts || [] : []);

  // existing places, ones whose name shares a word with the text first
  const options = useMemo(() => {
    const words = new Set(texts.join(" ").toLowerCase().split(/[\s,]+/).filter((w) => w.length > 3));
    const score = (n: string) => n.toLowerCase().split(/[\s,]+/).filter((w) => words.has(w)).length;
    return Object.entries(places).filter(([k]) => k !== placeKey).map(([k, v]) => ({ k, name: v.name, s: score(v.name) }))
      .sort((a, b) => b.s - a.s || a.name.localeCompare(b.name));
  }, [places, texts, placeKey]);

  // the small map: shows the point, and a click (or dragging the pin) moves it
  const box = useRef<HTMLDivElement>(null);
  const { M } = useLeaflet(box, { scrollWheelZoom: false });
  const pin = useRef<any>(null);
  const point = Number.isFinite(parseFloat(lat)) && Number.isFinite(parseFloat(lng)) ? [parseFloat(lat), parseFloat(lng)] as [number, number] : null;
  useEffect(() => {
    if (!M) return;
    const click = (ev: any) => { setLat(ev.latlng.lat.toFixed(6)); setLng(ev.latlng.lng.toFixed(6)); };
    M.map.on("click", click);
    return () => { M.map.off("click", click); };
  }, [M]);
  useEffect(() => {
    if (!M) return;
    if (!point) { pin.current?.remove(); pin.current = null; return; }
    if (!pin.current) {
      pin.current = M.L.marker(point, { draggable: true, keyboard: true, title: T.pin }).addTo(M.map);
      pin.current.on("dragend", () => { const p = pin.current.getLatLng(); setLat(p.lat.toFixed(6)); setLng(p.lng.toFixed(6)); });
      M.map.setView(point, 13, { animate: false });
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
    if (!current && (!name.trim() || name === texts[0])) setName(h.name.split(",").slice(0, 3).map((x) => x.trim()).join(", "));
    M?.map.setView([h.lat, h.lng], 14);
  };

  async function save(ev: React.FormEvent) {
    ev.preventDefault();
    setErr("");
    let ops: any[], reason: string;
    if (mode === "same" && !current) {
      if (!same) return setErr(T.pickPlace);
      ops = [{ op: "place.save", key: same, add_texts: texts }];
      reason = T.reasonSame(texts.join("; "), places[same].name);
    } else {
      if (!name.trim()) return setErr(T.nameRequired);
      if (!point) return setErr(T.pointRequired);
      const key = placeKey || placeKeyFor(name, places);
      const op: any = { op: "place.save", key, name: name.trim(), lat: point[0], lng: point[1] };
      if (current) op.texts = kept; else if (texts.length) op.texts = texts;
      ops = [op];
      reason = current ? T.reasonEdit(name.trim()) : T.reasonNew(name.trim());
    }
    setBusy(true);
    try {
      if (editor) await api("POST", "edit", { reason, ops });
      else await api("POST", "proposals", { kind: "edit", payload: { reason, ops }, rationale: reason });
      if (!editor) alert(T.suggested);
      onDone ? onDone() : location.reload();
    } catch (e: any) { setErr(e.message); setBusy(false); }
  }

  async function remove() {
    if (!placeKey || !confirm(T.removeConfirm(current!.name))) return;
    setBusy(true);
    try {
      const reason = T.reasonRemove(current!.name), ops = [{ op: "place.delete", key: placeKey }];
      if (editor) await api("POST", "edit", { reason, ops });
      else { await api("POST", "proposals", { kind: "edit", payload: { reason, ops }, rationale: reason }); alert(T.suggested); }
      location.hash = "#/places";
      location.reload();
    } catch (e: any) { setErr(e.message); setBusy(false); }
  }

  const there = index[placeKey || ""]?.people.length || 0;
  return (
    <form className="card sub place-form" onSubmit={save}>
      {texts.length > 0 && <p className="small">{T.forTexts}{texts.map((t, i) => <span key={i}>{i > 0 && "; "}<b>{t}</b></span>)}</p>}
      {!current && options.length > 0 && (
        <div className="seg" role="radiogroup" aria-label={T.modeLabel}>
          <button type="button" role="radio" aria-checked={mode === "new"} className={mode === "new" ? "on" : ""} onClick={() => setMode("new")}>{T.modeNew}</button>
          <button type="button" role="radio" aria-checked={mode === "same"} className={mode === "same" ? "on" : ""} onClick={() => setMode("same")}>{T.modeSame}</button>
        </div>
      )}
      {mode === "same" && !current ? (
        <label className="field">{T.samePlace}
          <select value={same} onChange={(e) => setSame(e.target.value)} required>
            <option value="">{T.choose}</option>
            {options.map((o) => <option key={o.k} value={o.k}>{o.name}</option>)}
          </select>
          <span className="small muted">{T.sameHelp}</span>
        </label>
      ) : <>
        <label className="field">{T.name}<input value={name} onChange={(e) => setName(e.target.value)} placeholder={T.namePlaceholder} required /></label>
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
        <p className="small muted" style={{ marginTop: 4 }}>{T.mapHelp}</p>
        <div className="btn-row">
          <label className="field small">{T.lat}<input inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} style={{ width: 120 }} /></label>
          <label className="field small">{T.lng}<input inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} style={{ width: 120 }} /></label>
        </div>
        {current && kept.length > 0 && (
          <div className="field"><span>{T.texts}</span>
            <ul className="place-texts">{kept.map((t) => <li key={t}>{t} <button type="button" className="linklike" aria-label={T.removeText(t)} onClick={() => setKept(kept.filter((x) => x !== t))}>×</button></li>)}</ul>
          </div>
        )}
      </>}
      {err && <p className="small sev-error" role="alert">{err}</p>}
      <div className="btn-row">
        <button className="btn primary" disabled={busy}>{editor ? T.save : T.suggest}</button>
        <button type="button" className="btn" onClick={onCancel}>{T.cancel}</button>
        {current && <button type="button" className="btn danger" style={{ marginLeft: "auto" }} disabled={busy} onClick={remove}>{T.remove(there)}</button>}
      </div>
    </form>
  );
}
