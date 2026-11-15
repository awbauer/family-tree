import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useData } from "../data";
import { branchColor, isUnknown, useTitle } from "../lib";
import { storyExcerpt } from "../StoryText";
import type { Story } from "../types";

export function StoryCard({ story }: { story: Story }) {
  const { D, branches } = useData();
  const color = branchColor(story.branch || "other", branches);
  return (
    <Link className="card story-card" to={`/story/${story.slug}`} style={{ ["--bc" as string]: color, borderTop: `3px solid ${color}` }}>
      <span className="eyebrow">{(branches[story.branch || ""] || {}).label || "Family"}{story.era ? ` · ${story.era}` : ""}</span>
      <h3>{story.title}</h3>
      <p>{storyExcerpt(story.body, (id) => D.people[id] && D.people[id].name)}</p>
    </Link>
  );
}

/** Editors with the agents set up: draft a new story, which arrives in Suggestions for review. */
function DraftForm() {
  const { D, people, api } = useData();
  const [chosen, setChosen] = useState<string[]>([]), [pick, setPick] = useState(""), [instructions, setInstructions] = useState(""), [length, setLength] = useState("medium");
  const [msg, setMsg] = useState("");
  const navigate = useNavigate();
  const add = (value: string) => {
    const id = (value.match(/\(([^)]+)\)\s*$/) || [])[1];
    if (id && D.people[id] && !D.people[id].living && !chosen.includes(id)) setChosen([...chosen, id]);
    setPick("");
  };
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!chosen.length) { setMsg("Add at least one person."); return; }
    try {
      await api("POST", "agent/runs", { kind: "story", mode: "draft", people: chosen, instructions: instructions || undefined, length });
      navigate("/research/agents");
    } catch (err) { setMsg((err as Error).message); }
  }
  return (
    <details className="card" style={{ marginBottom: 18 }}>
      <summary><b>Draft a story with AI</b> <span className="small muted">· written from the tree's records, sent to Suggestions for review</span></summary>
      <form id="sd-form" className="stack" style={{ marginTop: 10 }} onSubmit={submit}>
        <div className="filters">
          <input id="sd-person" list="sd-people" placeholder="Add a person…" style={{ flex: 1, minWidth: 220 }} value={pick}
            onChange={(e) => { setPick(e.target.value); if (/\([^)]+\)\s*$/.test(e.target.value)) add(e.target.value); }} />
          <button type="button" className="btn" id="sd-add" onClick={() => add(pick)}>Add</button>
        </div>
        <datalist id="sd-people">{people.filter((p) => !isUnknown(p) && !p.living).map((p) => <option key={p.id} value={`${p.name} (${p.id})`} />)}</datalist>
        <div id="sd-chips" className="small muted">
          {chosen.length ? chosen.map((id, i) => (
            <span key={id} className="badge">{D.people[id].name} <button type="button" className="linklike" aria-label="Remove" onClick={() => setChosen(chosen.filter((_, j) => j !== i))}>✕</button> </span>
          )) : "Who is it about? Add one or more people (living people can't be the subject)."}
        </div>
        <textarea name="instructions" rows={2} placeholder="The angle, e.g. “her journey to England after the war” (optional)" value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        <div className="filters">
          <select name="length" aria-label="Length" value={length} onChange={(e) => setLength(e.target.value)}>
            <option value="short">Short (~300 words)</option><option value="medium">Medium (~700 words)</option><option value="long">Long (~1,200 words)</option>
          </select>
          <button className="btn primary">Draft it</button><span id="sd-msg" className="small muted">{msg}</span>
        </div>
      </form>
    </details>
  );
}

export function Stories() {
  const { D, ai } = useData();
  useTitle("Stories");
  const stories = D.research.stories || [];
  return (
    <div className="wrap page">
      <h1>Stories</h1>
      <p className="prose">Narratives drawn from the records. Each story lists its sources; anything uncertain is said to be uncertain.</p>
      {ai && <DraftForm />}
      {stories.length ? <div className="grid g3">{stories.map((s) => <StoryCard key={s.slug} story={s} />)}</div>
        : <div className="empty">No stories written yet.{ai ? " Draft one above, or add" : " Add"} them to <code>research.json</code> → <code>stories</code>.</div>}
    </div>
  );
}
