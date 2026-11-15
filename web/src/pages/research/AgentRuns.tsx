// Cloud research runs (editors with the agents set up): start a research run or a data quality review, and follow
// runs (polled every 8 s while any is queued or running).
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useData } from "../../data";
import { isUnknown, PersonLink } from "../../lib";
import { useWho } from "../../ui";
import { pickId } from "./Todos";

const RUN_TXT: Record<string, string> = { queued: "Queued", running: "Running", succeeded: "Done", failed: "Failed", cancelled: "Cancelled" };
const VERDICT_TXT: Record<string, string> = { still_valid: "Still valid", resolved: "Resolved", obsolete: "Obsolete", duplicate: "Duplicate", needs_human: "Needs a person" };
const DQ_STATUS: Record<string, string> = { would: "would apply", applied: "applied", skipped: "skipped (changed meanwhile)" };
const model = (m: string) => String(m || "").replace(/^@cf\/[^/]+\//, "");

function Ref({ x }: { x: string }) {
  const [t, n] = x.split(":");
  return t === "todo" ? <Link to="/research/todo">to-do #{n}</Link> : t === "check" ? <>check: {n.replace(/-/g, " ")}</> : <Link to="/research/findings">finding #{n}</Link>;
}

/** A data quality review's decisions, and "Apply" for a finished dry run that hasn't been applied. */
function QualityReport({ r, onApply }: { r: any; onApply: (id: string, b: HTMLButtonElement) => void }) {
  const { D } = useData();
  const who = useWho();
  const rep: any[] = r.report || [], o = r.options || {};
  const counts = rep.reduce((a: Record<string, number>, d) => ((a[d.verdict] = (a[d.verdict] || 0) + 1), a), {});
  const waiting = o.dry_run && !o.applied_at && r.status === "succeeded" && rep.some((d) => d.status === "would");
  return (
    <>
      <p className="small">{o.dry_run && <><b>Dry run</b>{o.applied_at ? ` · applied by ${who(o.applied_by)} ${o.applied_at.slice(0, 16).replace("T", " ")}` : ""} · </>}{rep.length} of {o.count || "?"} reviewed{rep.length ? ": " + Object.entries(counts).map(([k, n]) => `${n} ${(VERDICT_TXT[k] || k).toLowerCase()}`).join(", ") : ""}</p>
      {r.summary && <p className="small">{r.summary}</p>}
      {rep.length > 0 && (
        <details open={waiting || undefined}><summary className="small">Decisions</summary><div className="table-wrap"><table className="data small"><thead><tr><th>Item</th><th>Verdict</th><th>Action</th><th>Why</th></tr></thead><tbody>
          {rep.map((d, i) => (
            <tr key={i}>
              <td><Ref x={d.item} />{d.person && D.people[d.person] && <><br /><PersonLink id={d.person} /></>}</td><td>{VERDICT_TXT[d.verdict] || d.verdict}</td>
              <td>{d.detail || ""}<br /><span className="muted">{DQ_STATUS[d.status] || d.status}{d.proposal && <> · <Link to="/research/queue">suggestion #{d.proposal}</Link></>}</span></td>
              <td>{d.note}{(d.evidence || []).length > 0 && <><br /><span className="muted">{d.evidence.join("; ")}</span></>}{d.duplicate_of && <><br /><span className="muted">same as {d.duplicate_of}</span></>}</td>
            </tr>
          ))}
        </tbody></table></div></details>
      )}
      {waiting && <button className="btn primary" data-apply-run={r.id} onClick={(e) => onApply(r.id, e.currentTarget)}>Apply these decisions</button>}
    </>
  );
}

export function AgentRuns() {
  const { D, api, people } = useData();
  const who = useWho();
  const [state, setState] = useState<{ data?: any; error?: string }>({});
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);

  const load = useCallback(async () => {
    clearTimeout(timer.current);
    try {
      const data = await api("GET", "agent/runs");
      if (!alive.current) return;
      setState({ data });
      if (data.runs.some((r: any) => ["queued", "running"].includes(r.status))) timer.current = setTimeout(load, 8000);
    } catch (e) { if (alive.current) setState({ error: (e as Error).message }); }
  }, [api]);
  useEffect(() => {
    alive.current = true;
    load();
    return () => { alive.current = false; clearTimeout(timer.current); };
  }, [load]);

  async function apply(id: string, b: HTMLButtonElement) {
    if (!confirm("Apply this review's decisions? Items changed since the review are skipped; fixes become suggestions.")) return;
    b.disabled = true;
    try { const r = await api("POST", `agent/runs/${id}/apply`); alert(`Applied ${r.report.filter((d: any) => d.status === "applied").length}, skipped ${r.report.filter((d: any) => d.status === "skipped").length}.`); }
    catch (e) { alert((e as Error).message); }
    load();
  }
  async function cancel(id: string) {
    if (!confirm("Stop this run? Its to-do goes back to the list.")) return;
    try { await api("POST", `agent/runs/${id}/cancel`); } catch (e) { alert((e as Error).message); }
    load();
  }
  async function startQuality(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const f = ev.currentTarget.elements as any, person = pickId(f.person.value);
    if (!f.dry.checked && !confirm("Not a dry run: the agent will close, resolve and dismiss items as it goes. Continue?")) return;
    try { await api("POST", "agent/runs", { kind: "quality", scope: f.scope.value, person: person || undefined, limit: +f.limit.value || 10, dry_run: f.dry.checked }); load(); }
    catch (e) { alert((e as Error).message); }
  }
  async function startRun(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const form = ev.currentTarget, f = form.elements as any, person = pickId(f.person.value);
    try { await api("POST", "agent/runs", { person: person || undefined, instructions: f.instructions.value || undefined }); form.reset(); load(); }
    catch (e) { alert((e as Error).message); }
  }

  const d = state.data;
  const mdl = (a: string) => model(((d.limits.agents || {})[a] || {}).model);
  return (
    <>
      <p className="muted">Research agents run in the cloud on Claude, through Cloudflare AI Gateway. Each run works one to-do or person with the tree as the person who started it sees it, searches and reads the web, and files its results as a suggestion. Nothing changes until an editor approves it. Living people are never researched.</p>
      <form id="ar-new" className="card filters" style={{ marginBottom: 16 }} onSubmit={startRun}>
        <input name="person" list="ar-people" placeholder="Person (optional)" style={{ flex: 1, minWidth: 200 }} />
        <datalist id="ar-people">{people.filter((p) => !isUnknown(p) && !p.living).map((p) => <option key={p.id} value={`${p.name} (${p.id})`} />)}</datalist>
        <input name="instructions" placeholder="What should it look for?" style={{ flex: 2, minWidth: 240 }} /><button className="btn primary">Start a run</button>
      </form>
      <details className="card" style={{ marginBottom: 16 }}><summary><b>Data quality review</b> <span className="small muted">· check open to-dos and findings against what the tree now records</span></summary>
        <p className="small muted">The agent reads the tree only (no web). Tree checks look for duplicate people and families, impossible dates and ages, two sets of parents, repeated events, empty or disconnected records, and dates and places not in standard form. It keeps, closes, resolves or dismisses each item, and files any fix to the facts as a suggestion. A dry run changes nothing: you get a report and can apply it afterwards.</p>
        <form id="dq-new" className="filters" onSubmit={startQuality}>
          <select name="scope" aria-label="What to review" defaultValue="all"><option value="all">Everything: tree checks, to-dos and findings</option><option value="checks">Tree checks only</option><option value="both">To-dos and findings</option><option value="todos">To-dos only</option><option value="findings">Findings only</option></select>
          <input name="person" list="dq-people" placeholder="Person (optional)" style={{ flex: 1, minWidth: 180 }} />
          <datalist id="dq-people">{people.filter((p) => !isUnknown(p)).map((p) => <option key={p.id} value={`${p.name} (${p.id})`} />)}</datalist>
          <label className="small">Up to <input name="limit" type="number" min="1" max="100" defaultValue="10" style={{ width: 64 }} /> items</label>
          <label className="small"><input name="dry" type="checkbox" defaultChecked /> Dry run</label>
          <button className="btn primary">Start review</button>
        </form>
      </details>
      <div id="ar-out">
        {state.error ? <div className="empty">{state.error}</div> : !d ? <p className="muted">Loading…</p> : <>
          <p className="small muted">Today: {d.today ? d.today.runs : 0} of {d.limits.runs_per_day} runs, ${(d.today ? d.today.usd : 0).toFixed(2)} of ${(+d.limits.usd_per_day).toFixed(2)} · up to ${(+d.limits.usd_per_run).toFixed(2)}, {d.limits.searches_per_run} searches and {d.limits.minutes_per_run} minutes per run · models: research {mdl("research")}, review {mdl("quality")}</p>
          {d.runs.length ? d.runs.map((r: any) => (
            <section key={r.id} className="card" style={{ marginBottom: 12 }}>
              <div className="eyebrow">{r.created_at.slice(0, 16).replace("T", " ")} · {who(r.started_by)} · {r.kind === "quality" ? "Data quality review · " : ""}<span className={`badge st-${r.status === "succeeded" ? "verified" : r.status === "failed" ? "disputed" : "unverified"}`}>{RUN_TXT[r.status]}</span></div>
              <p>{r.todo_id ? `To-do #${r.todo_id}` : ""}{r.person && D.people[r.person] && <> <PersonLink id={r.person} /></>}{r.instructions ? ` · ${r.instructions}` : ""}</p>
              {r.kind === "quality" && <QualityReport r={r} onApply={apply} />}
              <p className="small muted">{r.steps} model responses · {(r.tokens.input + r.tokens.output).toLocaleString()} tokens{r.usd ? ` · $${r.usd.toFixed(2)}` : ""}{r.model ? ` · ${model(r.model)}` : ""}
                {r.proposals.length > 0 && <> · suggestion {r.proposals.map((x: any, i: number) => <span key={x}>{i > 0 && ", "}<Link to="/research/queue">#{x}</Link></span>)}</>}{r.error ? ` · ${r.error}` : ""}</p>
              {r.log.length > 0 && <details><summary className="small">{r.log.length} steps</summary><ul className="small">{r.log.map((l: any, i: number) => <li key={i}>{l.text}</li>)}</ul></details>}
              {["queued", "running"].includes(r.status) && <button className="btn" data-cancel={r.id} onClick={() => cancel(r.id)}>Stop</button>}
            </section>
          )) : <div className="empty">No runs yet.</div>}
        </>}
      </div>
    </>
  );
}
