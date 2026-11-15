// One source (#/source/:id): its details, link, transcription and photos/documents, every fact that cites it grouped
// by person, and for editors (members: as suggestions) editing it, merging it into another source, or deleting it
// once nothing cites it.
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { useData } from "../data";
import { PersonLink, useTitle, years } from "../lib";
import { INFORMATION, EVIDENCE, pickedSource, SOURCE_KINDS, SOURCE_TYPES, SourceList } from "../ops";
import { apidLink, citeCount, mediaUrl, sourceUses, type SourceUse } from "../tree";
import { Linkify } from "../ui";
import { SourceForm, useSourceChange } from "./sourceEdit";

const go = (hash: string) => { location.hash = hash; location.reload(); };

function CitationDetail({ c }: { c: any }) {
  const meta = [c.source_type && SOURCE_TYPES[c.source_type], c.information && INFORMATION[c.information]?.split(":")[0] + " information", c.evidence && EVIDENCE[c.evidence]?.split(":")[0] + " evidence", c.quality != null && `QUAY ${c.quality}`, c.accessed && `viewed ${c.accessed}`].filter(Boolean);
  return (
    <span className="small">
      {c.page && <> · {c.page}</>}
      {c.url && <> · <a href={c.url} target="_blank" rel="noopener">view record</a></>}
      {c.text && <> · “{c.text}”</>}
      {c.note && <span className="muted"> · {c.note}</span>}
      {meta.length > 0 && <span className="muted"> ({meta.join(" · ")})</span>}
    </span>
  );
}

function FactLink({ u }: { u: SourceUse }) {
  const to = u.fid && !u.family ? `/person/${u.person}?fact=${encodeURIComponent(u.fid)}` : `/person/${u.person}`;
  return <Link to={to}>{u.family ? `${u.fact} (family)` : u.fact}</Link>;
}

export function Source() {
  const { id = "" } = useParams();
  const { D, live, editor } = useData();
  const s = (D.sources as any)[id];
  useTitle(s ? s.title || id : "Source");
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
    <div className="wrap page"><h1>Source not found</h1>
      <p>There’s no source <code>{id}</code> in this tree. It may have been merged into another source or removed.</p>
      <p><Link to="/sources">All sources</Link></p></div>
  );
  const n = citeCount(uses), ancestry = apidLink(s.apid);
  return (
    <div className="wrap page source-page">
      <p className="small"><Link to="/sources">← All sources</Link></p>
      <h1>{s.title || id}</h1>
      <div className="card">
        <dl className="source-meta">
          <dt>Kind</dt><dd>{SOURCE_KINDS[s.type] || <span className="muted">not recorded</span>}</dd>
          {s.author && <><dt>Author</dt><dd>{s.author}</dd></>}
          {s.publication && <><dt>Publication</dt><dd>{s.publication}</dd></>}
          <dt>Repository</dt><dd>{s.repository || <span className="muted">not recorded</span>}</dd>
          {s.url && <><dt>Link</dt><dd><a href={s.url} target="_blank" rel="noopener">{s.url}</a></dd></>}
          {ancestry && <><dt>Ancestry</dt><dd><a href={ancestry} target="_blank" rel="noopener">view record on Ancestry</a></dd></>}
          {s.note && <><dt>Note</dt><dd><Linkify text={s.note} /></dd></>}
          <dt>Cited by</dt><dd>{n ? `${n} fact${n > 1 ? "s" : ""} on ${byPerson.length} ${byPerson.length === 1 ? "person" : "people"}` : "nothing yet"}</dd>
          <dt>Id</dt><dd><code>{id}</code></dd>
        </dl>
      </div>

      {s.text && <section className="card" style={{ marginTop: 16 }}><h2>Transcription</h2><p className="source-text">{s.text}</p></section>}

      {photos.length > 0 && (
        <section className="card" style={{ marginTop: 16 }}><h2>Photos and documents</h2>
          <div className="photo-grid">{photos.map((u) => (
            <figure className="photo" key={u.file}>
              {/\.pdf$/i.test(u.file!) ? <div className="doc">PDF</div> : <img loading="lazy" src={mediaUrl(u.file!)} alt={u.fact} />}
              <figcaption>{u.fact.replace(/^photo: /, "")}<br /><span className="small"><PersonLink id={u.person} /></span></figcaption>
            </figure>
          ))}</div>
        </section>
      )}

      <section className="card" style={{ marginTop: 16 }} id="src-citations"><h2>Citations</h2>
        {byPerson.length ? byPerson.map(([pid, list]) => (
          <div key={pid} className="source-person" data-person={pid}>
            <h3><PersonLink id={pid} /> <span className="small muted">{years(D.people[pid])}</span></h3>
            <ul>{list.map((u, i) => (
              <li key={i}><FactLink u={u} />{u.citations.map((c, j) => <CitationDetail key={j} c={c} />)}</li>
            ))}</ul>
          </div>
        )) : <p className="muted small">No fact cites this source.</p>}
      </section>

      {live && (
        <section className="card" style={{ marginTop: 16 }} id="src-tools"><h2>{editor ? "Edit" : "Suggest a change"}</h2>
          <p className="small muted">{editor ? "Changes are saved with a reason and appear in the history; any change can be undone." : "Your suggestion goes to the editors for review."}</p>
          <div className="btn-row">
            <button className="btn" data-a="edit" onClick={() => setMode(mode === "edit" ? "" : "edit")}>{editor ? "Edit this source" : "Suggest a correction"}</button>
            <button className="btn" data-a="merge" onClick={() => setMode(mode === "merge" ? "" : "merge")}>Merge into…</button>
            {n === 0 && <button className="btn" data-a="delete" onClick={async () => {
              const reason = prompt(`Delete “${s.title}”? Nothing cites it. Why?`);
              if (reason == null) return;
              const r = await change([{ op: "source.delete", id }], reason);
              if (r && !r.suggested) go("#/sources");
            }}>{editor ? "Delete" : "Suggest deleting"}</button>}
          </div>
          {mode === "edit" && <SourceForm s={s} submit={editor ? "Save" : "Send suggestion"} onCancel={() => setMode("")} onSave={async (data, reason) => {
            const r = await change([{ op: "source.upsert", id, data }], reason);
            if (r) location.reload();
          }} />}
          {mode === "merge" && (
            <form className="card sub filters" id="src-merge" onSubmit={async (ev) => {
              ev.preventDefault();
              const f = ev.currentTarget, val = (k: string) => String(((f.elements.namedItem(k) as HTMLInputElement).value) || "").trim();
              const keep = pickedSource(val("into"));
              if (!keep || keep === id || !(D.sources as any)[keep]) return alert("Pick the source to keep from the list.");
              if (!confirm(`Merge “${s.title}” into “${(D.sources as any)[keep].title}”? Its ${n} citation${n === 1 ? " moves" : "s move"} there and this source is removed. One undo restores both.`)) return;
              const r = await change([{ op: "source.merge", keep, drop: id }], val("reason"));
              if (r && !r.suggested) go(`#/source/${encodeURIComponent(keep)}`);
              else if (r) setMode("");
            }}>
              <input name="into" list="src-merge-list" required placeholder="The source to keep: search…" style={{ flex: 2, minWidth: 240 }} />
              <SourceList id="src-merge-list" except={id} />
              <input name="reason" required placeholder="Why are they the same?" style={{ flex: 2, minWidth: 200 }} />
              <button className="btn primary">{editor ? "Merge" : "Suggest merging"}</button>
              <button type="button" className="btn" onClick={() => setMode("")}>Cancel</button>
            </form>
          )}
        </section>
      )}
    </div>
  );
}
