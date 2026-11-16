import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useData } from "../data";
import { branchColor, isUnknown, useTitle } from "../lib";
import { storyExcerpt } from "../StoryText";
import type { Story } from "../types";
import { S } from "../../../strings/index.ts";

const T = S.browse.stories, DR = T.draft;

export function StoryCard({ story }: { story: Story }) {
  const { D, branches } = useData();
  const color = branchColor(story.branch || "other", branches);
  return (
    <Link className="card story-card" to={`/story/${story.slug}`} style={{ ["--bc" as string]: color, borderTop: `3px solid ${color}` }}>
      <span className="eyebrow">{(branches[story.branch || ""] || {}).label || T.family}{story.era ? ` · ${story.era}` : ""}</span>
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
    if (id && D.people[id] && !D.people[id].private && !chosen.includes(id)) setChosen([...chosen, id]);
    setPick("");
  };
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!chosen.length) { setMsg(DR.needPerson); return; }
    try {
      await api("POST", "agent/runs", { kind: "story", mode: "draft", people: chosen, instructions: instructions || undefined, length });
      navigate("/research/agents");
    } catch (err) { setMsg((err as Error).message); }
  }
  return (
    <details className="card" style={{ marginBottom: 18 }}>
      <summary><b>{DR.summary}</b> <span className="small muted">{DR.hint}</span></summary>
      <form id="sd-form" className="stack" style={{ marginTop: 10 }} onSubmit={submit}>
        <div className="filters">
          <input id="sd-person" list="sd-people" placeholder={DR.person} style={{ flex: 1, minWidth: 220 }} value={pick}
            onChange={(e) => { setPick(e.target.value); if (/\([^)]+\)\s*$/.test(e.target.value)) add(e.target.value); }} />
          <button type="button" className="btn" id="sd-add" onClick={() => add(pick)}>{DR.add}</button>
        </div>
        <datalist id="sd-people">{people.filter((p) => !isUnknown(p) && !p.private).map((p) => <option key={p.id} value={`${p.name} (${p.id})`} />)}</datalist>
        <div id="sd-chips" className="small muted">
          {chosen.length ? chosen.map((id, i) => (
            <span key={id} className="badge">{D.people[id].name} <button type="button" className="linklike" aria-label={DR.remove} onClick={() => setChosen(chosen.filter((_, j) => j !== i))}>✕</button> </span>
          )) : DR.who}
        </div>
        <textarea name="instructions" rows={2} placeholder={DR.instructions} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        <div className="filters">
          <select name="length" aria-label={DR.length} value={length} onChange={(e) => setLength(e.target.value)}>
            <option value="short">{DR.lengths.short}</option><option value="medium">{DR.lengths.medium}</option><option value="long">{DR.lengths.long}</option>
          </select>
          <button className="btn primary">{DR.submit}</button><span id="sd-msg" className="small muted">{msg}</span>
        </div>
      </form>
    </details>
  );
}

export function Stories() {
  const { D, ai } = useData();
  useTitle(T.title);
  const stories = D.research.stories || [];
  return (
    <div className="wrap page">
      <h1>{T.title}</h1>
      <p className="prose">{T.intro}</p>
      {ai && <DraftForm />}
      {stories.length ? <div className="grid g3">{stories.map((s) => <StoryCard key={s.slug} story={s} />)}</div>
        : <div className="empty">{T.empty.none}{ai ? T.empty.aiAdd : T.empty.add}{T.empty.rest.map((t, i) => (i % 2 ? <code key={i}>{t}</code> : t))}</div>}
    </div>
  );
}
