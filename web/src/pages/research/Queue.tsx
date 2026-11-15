// The suggestions queue (/api/proposals): research and edits from relatives and agents, waiting for an editor.
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ApiError, useData } from "../../data";
import { PersonLink } from "../../lib";
import { Diff, OpText } from "../../ops";
import { Inline } from "../../StoryText";
import { Finding, useWho } from "../../ui";
import { StoryDiff } from "./storyDiff";

const FILTERS: [string, string][] = [["open", "Waiting"], ["approved", "Approved"], ["rejected", "Rejected"], ["all", "All"]];

/** "What changes": the edit's effect, previewed against the tree when first opened. */
function EditPreview({ ops }: { ops: any[] }) {
  const { api } = useData();
  const [res, setRes] = useState<{ touched?: any[]; error?: string } | null>(null);
  const started = useRef(false);
  async function toggle(open: boolean) {
    if (!open || started.current) return;
    started.current = true;
    try { setRes({ touched: (await api("POST", "edit/preview", { ops })).touched }); }
    catch (e) { setRes({ error: (e as Error).message }); }
  }
  return (
    <details onToggle={(e) => toggle((e.currentTarget as HTMLDetailsElement).open)}><summary className="small">What changes</summary>
      <div className="small muted">{!res ? "Loading…" : res.error ? <span className="sev-error">No longer applies: {res.error}</span> : <Diff changes={res.touched} />}</div>
    </details>
  );
}

function Card({ pr, onDecide }: { pr: any; onDecide: (id: number, action: string) => void }) {
  const { D, editor } = useData();
  const who = useWho();
  const me = D.me || null;
  const b = pr.payload || {};
  const pl = (id: string) => (D.people[id] ? <PersonLink id={id} /> : <>{id}</>);
  return (
    <section className="card" style={{ marginBottom: 14 }}>
      <div className="eyebrow">Suggestion #{pr.id} · {who(pr.author)} · {pr.created_at.slice(0, 10)}{pr.todo_id ? ` · for to-do #${pr.todo_id}` : ""}</div>
      {pr.rationale && <p>{pr.rationale}</p>}
      {pr.kind === "edit" && <>
        <h4>Proposed changes{b.origin && <> <span className="small muted">({b.origin})</span></>}</h4>
        <ol>{(b.ops || []).map((o: any, i: number) => <li key={i}><OpText o={o} /></li>)}</ol>
        {b.reason && <p className="small"><b>Why:</b> {b.reason}</p>}
        {(b.sources || []).map((s: any, i: number) => <p key={i} className="small">Source: {s.url ? <a href={s.url} target="_blank" rel="noopener">{s.title}</a> : s.title}</p>)}
        {(b.resolves || []).length > 0 && <p className="small">Resolves finding {b.resolves.map((x: any) => `#${x}`).join(", ")}.</p>}
        {pr.status === "open" && <EditPreview ops={b.ops || []} />}
      </>}
      {(b.findings || []).length > 0 && <><h4>Findings</h4>{b.findings.map((f: any, i: number) => <Finding key={i} f={{ ...f, branch: f.branch || b.branch }} />)}</>}
      {Object.keys(b.people_status || {}).length > 0 && <><h4>Status changes</h4><ul>{Object.entries(b.people_status).map(([id, s]: [string, any]) => <li key={id}>{pl(id)}: <b>{s.status}</b> {s.note || ""}</li>)}</ul></>}
      {(b.story_updates || []).length > 0 && <><h4>Story revisions</h4>{b.story_updates.map((u: any, i: number) => {
        const cur = (D.research.stories || []).find((x) => x.slug === u.slug);
        return (
          <Fragment key={i}>
            <p><b>{u.title}</b>{u.reason ? ` · ${u.reason}` : ""} <Link className="small" to={`/story/${u.slug}`}>current version</Link></p>
            {(u.changes || []).length > 0 && <ul className="small">{u.changes.map((c: any, j: number) => <li key={j}>{c.change} <span className="muted">— {c.reason}{(c.facts || []).length ? ` (${c.facts.join(", ")})` : ""}</span></li>)}</ul>}
            <details open={pr.status === "open" || undefined}><summary>What changes in the text</summary>
              {cur ? <StoryDiff a={cur.body} b={u.body} /> : <div className="prose small">{String(u.body || "").split(/\n\n+/).map((t, j) => <Fragment key={j}>{j > 0 && <><br /><br /></>}{t}</Fragment>)}</div>}
            </details>
          </Fragment>
        );
      })}</>}
      {(b.stories || []).length > 0 && <>
        <h4>New {b.stories.length > 1 ? "stories" : "story"}</h4>
        {b.stories.map((x: any, i: number) => (
          <Fragment key={i}>
            <p><b>{x.title}</b>{x.era ? ` · ${x.era}` : ""}{(x.people || []).length > 0 && <> · {x.people.filter((id: string) => D.people[id]).map((id: string, j: number) => <span key={id}>{j > 0 && ", "}<PersonLink id={id} /></span>)}</>}</p>
            <details><summary>Read it</summary>
              <div className="prose small">{(x.body || "").split(/\n\n+/).map((t: string, j: number) => t.startsWith("## ") ? <h4 key={j}>{t.slice(3)}</h4> : <p key={j}><Inline text={t} /></p>)}</div>
              {(x.sources || []).length > 0 && <p className="small"><b>Sources:</b> {x.sources.map((y: any, j: number) => <span key={j}>{j > 0 && "; "}{y.title}{y.note && <> <span className="muted">({y.note})</span></>}</span>)}</p>}
            </details>
          </Fragment>
        ))}
        {(b.story_notes || []).length > 0 && <details><summary className="small">Which facts support each paragraph</summary><ul className="small">{b.story_notes.map((n: any, i: number) => <li key={i}>{n.paragraph} <span className="muted">{(n.facts || []).join(", ")}</span></li>)}</ul></details>}
      </>}
      {(b.todo || []).length > 0 && <><h4>New to-dos</h4><ul>{b.todo.map((t: any, i: number) => <li key={i}>[{t.priority}] {t.person && D.people[t.person] && <><PersonLink id={t.person} />: </>}{t.task}</li>)}</ul></>}
      {(b.todo_done || []).length > 0 && <><h4>Closes</h4><ul>{b.todo_done.map((t: any, i: number) => <li key={i}>{t.task || `to-do #${t.id}`}: {t.outcome || ""}</li>)}</ul></>}
      {(b.log || []).length > 0 && <details><summary>{b.log.length} searches logged</summary><ul>{b.log.map((l: any, i: number) => <li key={i}>{l.result}: {l.searched}{l.note && <> <span className="muted">({l.note})</span></>}</li>)}</ul></details>}
      <div className="btn-row" style={{ marginTop: 10 }}>
        {pr.status === "open" ? <>
          {editor && <><button className="btn primary" data-pa="approve" onClick={() => onDecide(pr.id, "approve")}>Approve</button><button className="btn" data-pa="reject" onClick={() => onDecide(pr.id, "reject")}>Reject…</button></>}
          {me && pr.author === me.principal && <button className="btn" data-pa="withdraw" onClick={() => onDecide(pr.id, "withdraw")}>Withdraw</button>}
        </> : <span className="small muted">{pr.status} by {who(pr.reviewed_by)}{pr.review_note ? `: ${pr.review_note}` : ""}</span>}
      </div>
    </section>
  );
}

export function Queue() {
  const { api } = useData();
  const [status, setStatus] = useState("open");
  const [state, setState] = useState<{ loading?: boolean; proposals?: any[]; error?: string }>({ loading: true });
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = useCallback(async () => {
    setState({ loading: true });
    try { const { proposals } = await api("GET", `proposals?status=${status}`); if (alive.current) setState({ proposals }); }
    catch (e) { if (alive.current) setState({ error: (e as Error).message }); }
  }, [api, status]);
  useEffect(() => { load(); }, [load]);

  async function decide(id: number, action: string) {
    let note: string | null | undefined;
    if (action === "reject") { note = prompt("Why? (the author sees this)"); if (note === null) return; }
    try { await api("POST", `proposals/${id}/${action}`, { note }); if (action === "approve") location.reload(); else load(); }
    catch (e) {
      const err = e as ApiError, data = (err.data || {}) as { can_skip?: boolean };
      // items about people removed since the suggestion was written: offer to approve the rest
      if (action === "approve" && data.can_skip && confirm(`${err.message}\n\nApprove the rest of this suggestion without those items?`)) {
        try { await api("POST", `proposals/${id}/approve`, { skip_missing: true }); location.reload(); }
        catch (e2) { alert((e2 as Error).message); }
        return;
      }
      alert(err.message);
    }
  }

  return (
    <>
      <p className="muted">Research from relatives and AI agents waits here until an editor approves it. Approved findings, log entries and to-dos are added to the tree; nothing is applied without review.</p>
      <div className="filters">{FILTERS.map(([k, l]) => <button key={k} className={`btn${k === status ? " primary" : ""}`} data-q={k} onClick={() => (k === status ? load() : setStatus(k))}>{l}</button>)}</div>
      <div id="q-out">
        {state.loading ? <p className="muted">Loading…</p>
          : state.error ? <div className="empty">{state.error}</div>
          : state.proposals!.length ? state.proposals!.map((pr) => <Card key={pr.id} pr={pr} onDecide={decide} />)
          : <div className="empty">Nothing {status === "open" ? "waiting for review" : "here"}.</div>}
      </div>
    </>
  );
}
