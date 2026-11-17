// Search everything the viewer can see, grouped by kind, with where each record matched.
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useData } from "../data";
import { useTitle } from "../lib";
import { indexFor, hitPath, Marked, search, type Kind } from "../search";
import { S } from "../../../strings/index.ts";

const L = S.browse.search;
const KINDS: Kind[] = ["person", "story", "finding", "todo", "source"];
const PAGE = 50;

export function Search() {
  const { D } = useData();
  useTitle(L.title);
  const [params, setParams] = useSearchParams();
  const q = params.get("q") || "", kind = (params.get("kind") || "") as Kind | "", variants = params.get("variants") !== "0";
  const [shown, setShown] = useState(PAGE);
  const set = (k: string, v: string | null) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p, { replace: true }); setShown(PAGE); };
  const all = useMemo(() => search(indexFor(D), q, { variants }), [D, q, variants]);
  const counts = useMemo(() => Object.fromEntries(KINDS.map((k) => [k, all.filter((h) => h.kind === k).length])), [all]);
  const hits = kind ? all.filter((h) => h.kind === kind) : all;
  return (
    <div className="wrap page">
      <h1>{L.title}</h1>
      <form className="search-page" role="search" onSubmit={(e) => e.preventDefault()}>
        <input id="search-all" type="search" aria-label={L.label} placeholder={L.placeholder} value={q} autoFocus
          onChange={(e) => set("q", e.target.value)} />
        <label className="small"><input type="checkbox" checked={variants} onChange={(e) => set("variants", e.target.checked ? null : "0")} /> {L.variants}</label>
      </form>
      <p className="muted small">{L.hint}</p>
      {q.trim() && <>
        <div className="filters" role="group" aria-label={L.title}>
          <button type="button" className={`btn ${kind ? "" : "primary"}`} aria-pressed={!kind} onClick={() => set("kind", null)}>{L.all} ({all.length})</button>
          {KINDS.filter((k) => counts[k]).map((k) => (
            <button key={k} type="button" className={`btn ${kind === k ? "primary" : ""}`} aria-pressed={kind === k} onClick={() => set("kind", k)}>{L.kinds[k]} ({counts[k]})</button>
          ))}
        </div>
        <p className="muted small" aria-live="polite">{hits.length ? L.count(hits.length) : L.none}</p>
        <ol className="search-hits">
          {hits.slice(0, shown).map((h) => (
            <li key={`${h.kind}:${h.id}`}>
              <div><span className="badge">{L.kind[h.kind]}</span> <Link to={hitPath(h)}><Marked text={h.title || h.id} q={q} /></Link>
                {h.person && h.kind !== "person" && D.people[h.person] && <span className="muted small"> · {L.about} <Link to={`/person/${encodeURIComponent(h.person)}`}>{D.people[h.person].name}</Link></span>}
              </div>
              <ul className="small">
                {h.matches.filter((m) => !(m.field === "name" && m.how === "exact" && m.snippet === h.title) && !(m.field === "title" && m.snippet === h.title)).map((m, i) => (
                  <li key={i}><span className="muted">{L.fields[m.field]}{m.how !== "exact" && m.word ? ` (${L.how[m.how](m.word)})` : ""}:</span> <Marked text={m.snippet} q={q} /></li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
        {hits.length > shown && <button type="button" className="btn" onClick={() => setShown(shown + PAGE)}>{L.more(Math.min(PAGE, hits.length - shown))}</button>}
      </>}
    </div>
  );
}
