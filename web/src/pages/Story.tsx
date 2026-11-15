import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useData } from "../data";
import { branchColor, PersonLink, useTitle } from "../lib";
import { StoryBody } from "../StoryText";
import { NotFound } from "./NotFound";
import { S } from "../../../strings/index.ts";

const T = S.browse.story;

/** Editors with the agents set up: have the stories agent check the story against the records. */
function ReviewForm({ slug }: { slug: string }) {
  const { api } = useData();
  const [instructions, setInstructions] = useState(""), [msg, setMsg] = useState("");
  const navigate = useNavigate();
  async function submit(e: FormEvent) {
    e.preventDefault();
    try { await api("POST", "agent/runs", { kind: "story", mode: "review", slug, instructions: instructions || undefined }); navigate("/research/agents"); }
    catch (err) { setMsg((err as Error).message); }
  }
  return (
    <details className="card sub">
      <summary><b>{T.review.summary}</b> <span className="small muted">{T.review.hint}</span></summary>
      <form id="sr-form" className="stack" style={{ marginTop: 10 }} onSubmit={submit}>
        <textarea name="instructions" rows={2} placeholder={T.review.instructions} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        <div className="filters"><button className="btn primary">{T.review.start}</button><span id="sr-msg" className="small muted">{msg}</span></div>
      </form>
    </details>
  );
}

export function Story() {
  const { slug } = useParams();
  const { D, ai, branches } = useData();
  const s = (D.research.stories || []).find((x) => x.slug === slug);
  useTitle(s ? s.title : S.browse.notFound.title);
  if (!s) return <NotFound />;
  return (
    <div className="wrap page">
      <article style={{ maxWidth: 760, margin: "0 auto" }}>
        <div className="eyebrow" style={{ color: branchColor(s.branch || "other", branches) }}>{(branches[s.branch || ""] || {}).label || S.browse.stories.family}{s.era ? ` · ${s.era}` : ""}</div>
        <h1>{s.title}</h1>
        {(s.people || []).length > 0 && <p className="small">{T.people}{s.people!.filter((x) => D.people[x]).map((x, i) => <span key={x}>{i ? " · " : ""}<PersonLink id={x} /></span>)}</p>}
        <div className="prose"><StoryBody body={s.body || ""} /></div>
        {(s.sources || []).length > 0 && <>
          <h3>{T.sources}</h3>
          <ol className="sources-list">{s.sources!.map((x, i) => (
            <li key={i}>{x.url ? <a href={x.url} target="_blank" rel="noopener">{x.title || x.url}</a> : x.title}{x.note && <span className="pg">{x.note}</span>}</li>
          ))}</ol>
        </>}
        {ai && <ReviewForm slug={s.slug} />}
        <p><Link to="/stories">{T.back}</Link></p>
      </article>
    </div>
  );
}
