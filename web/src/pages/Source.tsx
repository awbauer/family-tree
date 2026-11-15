// One source (#/source/:id): its details, link, transcription and photos/documents, every fact that cites it grouped
// by person, and for editors (members: as suggestions) editing it, merging it into another source, or deleting it
// once nothing cites it.
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { S } from "../../../strings/index.ts";
import { useData } from "../data";
import { PersonLink, useTitle, years } from "../lib";
import { INFORMATION, EVIDENCE, pickedSource, SOURCE_KINDS, SOURCE_TYPES, SourceList } from "../ops";
import { apidLink, citeCount, mediaUrl, sourceUses, type SourceUse } from "../tree";
import { Linkify } from "../ui";
import { SourceForm, useSourceChange } from "./sourceEdit";

const T = S.admin.sources.page;
const go = (hash: string) => { location.hash = hash; location.reload(); };

function CitationDetail({ c }: { c: any }) {
  const C = T.citation;
  const meta = [c.source_type && SOURCE_TYPES[c.source_type], c.information && C.information(INFORMATION[c.information]?.split(":")[0]), c.evidence && C.evidence(EVIDENCE[c.evidence]?.split(":")[0]), c.quality != null && C.quality(c.quality), c.accessed && C.viewed(c.accessed)].filter(Boolean);
  return (
    <span className="small">
      {c.page && <> · {c.page}</>}
      {c.url && <> · <a href={c.url} target="_blank" rel="noopener">{C.viewRecord}</a></>}
      {c.text && <> · “{c.text}”</>}
      {c.note && <span className="muted"> · {c.note}</span>}
      {meta.length > 0 && <span className="muted"> ({meta.join(" · ")})</span>}
    </span>
  );
}

function FactLink({ u }: { u: SourceUse }) {
  const to = u.fid && !u.family ? `/person/${u.person}?fact=${encodeURIComponent(u.fid)}` : `/person/${u.person}`;
  return <Link to={to}>{u.family ? T.citation.family(u.fact) : u.fact}</Link>;
}

export function Source() {
  const M = T.meta, X = T.tools, G = T.merge;
  const { id = "" } = useParams();
  const { D, live, editor } = useData();
  const s = (D.sources as any)[id];
  useTitle(s ? s.title || id : T.title);
  const uses = useMemo(() => sourceUses(D)[id] || [], [D, id]);
  const change = useSourceChange();
  const [mode, setMode] = useState<"" | "edit" | "merge">("");
  const byPerson = useMemo(() => {
    const m = new Map<string, SourceUse[]>();
    for (const u of uses) if (!u.file) m.set(u.person, [...(m.get(u.person) || []), u]);
    return [...m.entries()].sort((a, b) => (D.people[a[0]]?.name || "").localeCompare(D.people[b[0]]?.name || ""));
  }, [uses, D]);
  const photos = uses.filter((u) => u.file);
  if (!s) return (
    <div className="wrap page"><h1>{T.notFound.heading}</h1>
      <p>{T.notFound.before}<code>{id}</code>{T.notFound.after}</p>
      <p><Link to="/sources">{T.notFound.all}</Link></p></div>
  );
  const n = citeCount(uses), ancestry = apidLink(s.apid);
  return (
    <div className="wrap page source-page">
      <p className="small"><Link to="/sources">{T.back}</Link></p>
      <h1>{s.title || id}</h1>
      <div className="card">
        <dl className="source-meta">
          <dt>{M.kind}</dt><dd>{SOURCE_KINDS[s.type] || <span className="muted">{M.notRecorded}</span>}</dd>
          {s.author && <><dt>{M.author}</dt><dd>{s.author}</dd></>}
          {s.publication && <><dt>{M.publication}</dt><dd>{s.publication}</dd></>}
          <dt>{M.repository}</dt><dd>{s.repository || <span className="muted">{M.notRecorded}</span>}</dd>
          {s.url && <><dt>{M.link}</dt><dd><a href={s.url} target="_blank" rel="noopener">{s.url}</a></dd></>}
          {ancestry && <><dt>{M.ancestry}</dt><dd><a href={ancestry} target="_blank" rel="noopener">{M.viewOnAncestry}</a></dd></>}
          {s.note && <><dt>{M.note}</dt><dd><Linkify text={s.note} /></dd></>}
          <dt>{M.citedBy}</dt><dd>{n ? M.citedByCount(n, byPerson.length) : M.nothingYet}</dd>
          <dt>{M.id}</dt><dd><code>{id}</code></dd>
        </dl>
      </div>

      {s.text && <section className="card" style={{ marginTop: 16 }}><h2>{T.transcription}</h2><p className="source-text">{s.text}</p></section>}

      {photos.length > 0 && (
        <section className="card" style={{ marginTop: 16 }}><h2>{T.photos}</h2>
          <div className="photo-grid">{photos.map((u) => (
            <figure className="photo" key={u.file}>
              {/\.pdf$/i.test(u.file!) ? <div className="doc">{T.pdf}</div> : <img loading="lazy" src={mediaUrl(u.file!)} alt={u.fact} />}
              <figcaption>{u.fact.replace(/^photo: /, "")}<br /><span className="small"><PersonLink id={u.person} /></span></figcaption>
            </figure>
          ))}</div>
        </section>
      )}

      <section className="card" style={{ marginTop: 16 }} id="src-citations"><h2>{T.citations}</h2>
        {byPerson.length ? byPerson.map(([pid, list]) => (
          <div key={pid} className="source-person" data-person={pid}>
            <h3><PersonLink id={pid} /> <span className="small muted">{years(D.people[pid])}</span></h3>
            <ul>{list.map((u, i) => (
              <li key={i}><FactLink u={u} />{u.citations.map((c, j) => <CitationDetail key={j} c={c} />)}</li>
            ))}</ul>
          </div>
        )) : <p className="muted small">{T.noCitations}</p>}
      </section>

      {live && (
        <section className="card" style={{ marginTop: 16 }} id="src-tools"><h2>{editor ? X.edit : X.suggest}</h2>
          <p className="small muted">{editor ? X.editHelp : X.suggestHelp}</p>
          <div className="btn-row">
            <button className="btn" data-a="edit" onClick={() => setMode(mode === "edit" ? "" : "edit")}>{editor ? X.editSource : X.suggestCorrection}</button>
            <button className="btn" data-a="merge" onClick={() => setMode(mode === "merge" ? "" : "merge")}>{X.mergeInto}</button>
            {n === 0 && <button className="btn" data-a="delete" onClick={async () => {
              const reason = prompt(X.deletePrompt(s.title));
              if (reason == null) return;
              const r = await change([{ op: "source.delete", id }], reason);
              if (r && !r.suggested) go("#/sources");
            }}>{editor ? X.delete : X.suggestDelete}</button>}
          </div>
          {mode === "edit" && <SourceForm s={s} submit={editor ? X.save : X.sendSuggestion} onCancel={() => setMode("")} onSave={async (data, reason) => {
            const r = await change([{ op: "source.upsert", id, data }], reason);
            if (r) location.reload();
          }} />}
          {mode === "merge" && (
            <form className="card sub filters" id="src-merge" onSubmit={async (ev) => {
              ev.preventDefault();
              const f = ev.currentTarget, val = (k: string) => String(((f.elements.namedItem(k) as HTMLInputElement).value) || "").trim();
              const keep = pickedSource(val("into"));
              if (!keep || keep === id || !(D.sources as any)[keep]) return alert(G.pickKeep);
              if (!confirm(G.confirm(s.title, (D.sources as any)[keep].title, n))) return;
              const r = await change([{ op: "source.merge", keep, drop: id }], val("reason"));
              if (r && !r.suggested) go(`#/source/${encodeURIComponent(keep)}`);
              else if (r) setMode("");
            }}>
              <input name="into" list="src-merge-list" required placeholder={G.into} style={{ flex: 2, minWidth: 240 }} />
              <SourceList id="src-merge-list" except={id} />
              <input name="reason" required placeholder={G.reason} style={{ flex: 2, minWidth: 200 }} />
              <button className="btn primary">{editor ? G.merge : G.suggest}</button>
              <button type="button" className="btn" onClick={() => setMode("")}>{G.cancel}</button>
            </form>
          )}
        </section>
      )}
    </div>
  );
}
