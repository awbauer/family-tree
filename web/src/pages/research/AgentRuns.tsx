// Cloud research runs (editors with the agents set up): start a research run, a data quality review or a story
// library review, and follow runs (polled every 8 s while any is queued or running). Sherlock (find relatives) runs
// start from a person page and show here with their report.
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { useData } from "../../data";
import { isUnknown, PersonLink } from "../../lib";
import { useWho } from "../../ui";
import { pickId } from "./Todos";
import { S } from "../../../../strings/index.ts";

const A = S.research.agentRuns, QR = A.quality, LR = A.library, RR = A.relatives;
const RUN_TXT: Record<string, string> = A.runStatus;
const VERDICT_TXT: Record<string, string> = QR.verdict;
const DQ_STATUS: Record<string, string> = QR.status;
const model = (m: string) => String(m || "").replace(/^@cf\/[^/]+\//, "");

function Ref({ x }: { x: string }) {
  const [t, n] = x.split(":");
  return t === "todo" ? <Link to="/research/todo">{A.ref.todo(n)}</Link> : t === "check" ? <>{A.ref.check(n.replace(/-/g, " "))}</> : <Link to="/research/findings">{A.ref.finding(n)}</Link>;
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
      <p className="small">{o.dry_run && <><b>{QR.dryRun}</b>{o.applied_at ? QR.appliedBy(who(o.applied_by), o.applied_at.slice(0, 16).replace("T", " ")) : ""} · </>}{QR.reviewed(rep.length, o.count || "?", Object.entries(counts).map(([k, n]) => `${n} ${(VERDICT_TXT[k] || k).toLowerCase()}`))}</p>
      {r.summary && <p className="small">{r.summary}</p>}
      {rep.length > 0 && (
        <details open={waiting || undefined}><summary className="small">{QR.decisions}</summary><div className="table-wrap"><table className="data small"><thead><tr><th>{QR.head.item}</th><th>{QR.head.verdict}</th><th>{QR.head.action}</th><th>{QR.head.why}</th></tr></thead><tbody>
          {rep.map((d, i) => (
            <tr key={i}>
              <td><Ref x={d.item} />{d.person && D.people[d.person] && <><br /><PersonLink id={d.person} /></>}</td><td>{VERDICT_TXT[d.verdict] || d.verdict}</td>
              <td>{d.detail || ""}<br /><span className="muted">{DQ_STATUS[d.status] || d.status}{d.proposal && <> · <Link to="/research/queue">{A.suggestion(d.proposal)}</Link></>}</span></td>
              <td>{d.note}{(d.evidence || []).length > 0 && <><br /><span className="muted">{d.evidence.join("; ")}</span></>}{d.duplicate_of && <><br /><span className="muted">{QR.sameAs(d.duplicate_of)}</span></>}</td>
            </tr>
          ))}
        </tbody></table></div></details>
      )}
      {waiting && <button className="btn primary" data-apply-run={r.id} onClick={(e) => onApply(r.id, e.currentTarget)}>{QR.apply}</button>}
    </>
  );
}

const LIB_VERDICT: Record<string, string> = LR.verdict;
const FLAG_TXT: Record<string, string> = LR.flag;

function Flag({ f }: { f: any }) {
  const { D } = useData();
  const pl = (id: string) => (D.people[id] ? <PersonLink id={id} /> : id);
  return <><b>{FLAG_TXT[f.kind] || f.kind}</b>{f.text ? LR.flagText(f.text) : ""}{f.tree_says ? LR.flagRecords(f.tree_says) : ""}{f.person ? <> · {pl(f.person)}{f.into ? <> → {pl(f.into)}</> : ""}</> : null}</>;
}

/** A link to another run's card on this page (the site uses hash routing, so not a #fragment). */
function RunLink({ id, children }: { id: string; children: ReactNode }) {
  return <a href="" data-run-link={id} onClick={(e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>{children}</a>;
}

/** A story library review: what it checked and flagged, the candidates, and the story runs it started. */
function LibraryReport({ r, runs }: { r: any; runs: any[] }) {
  const { D } = useData();
  const rep = r.report || {}, o = r.options || {};
  const checked: any[] = rep.checked || [], children: any[] = rep.children || [], planned: any[] = o.stories || [];
  const flagged = planned.filter((s) => (s.flags || []).length).length;
  const byId = Object.fromEntries(runs.map((x) => [x.id, x]));
  const verdictOf = (slug: string) => checked.find((c) => c.slug === slug);
  return (
    <>
      <p className="small">{LR.summary(checked.length, planned.length, flagged, checked.filter((c) => c.proposal).length, children.length, o.n ?? 2)}</p>
      {r.summary && <p className="small">{r.summary}</p>}
      {planned.length > 0 && (
        <details open={flagged > 0 || undefined}><summary className="small">{LR.stories}</summary><div className="table-wrap"><table className="data small"><thead><tr><th>{LR.head.story}</th><th>{LR.head.checks}</th><th>{LR.head.verdict}</th></tr></thead><tbody>
          {planned.map((s) => {
            const v = verdictOf(s.slug);
            return (
              <tr key={s.slug}>
                <td><Link to={`/story/${encodeURIComponent(s.slug)}`}>{s.title || s.slug}</Link>{s.pending && <><br /><span className="muted">{LR.pending.before} <Link to="/research/queue">#{s.pending}</Link> {LR.pending.after}</span></>}</td>
                <td>{(s.flags || []).length ? <ul className="small" style={{ margin: 0, paddingLeft: 16 }}>{s.flags.map((f: any, i: number) => <li key={i}><Flag f={f} /></li>)}</ul> : <span className="muted">{LR.nothing}</span>}</td>
                <td>{v ? <>{LIB_VERDICT[v.verdict] || v.verdict}{v.proposal && <> · <Link to="/research/queue">{A.suggestion(v.proposal)}</Link></>}<br /><span className="muted">{v.note}</span></> : <span className="muted">{LR.notChecked}</span>}</td>
              </tr>
            );
          })}
        </tbody></table></div></details>
      )}
      {(o.candidates || []).length > 0 && (
        <details><summary className="small">{LR.candidates}</summary><ol className="small">
          {o.candidates.map((c: any) => (
            <li key={c.key}>{c.kind === "group" && `${c.label}: `}{c.people.map((id: string, i: number) => <span key={id}>{i > 0 && ", "}{D.people[id] ? <PersonLink id={id} /> : id}</span>)}
              <span className="muted">{LR.score(c.score)}{c.covered_by && c.covered_by.length ? LR.coveredBy(c.covered_by) : ""}</span></li>
          ))}
        </ol></details>
      )}
      {children.length > 0 && (
        <div className="small"><b>{LR.storyRuns}</b><ul className="small">
          {children.map((ch) => {
            const k = byId[ch.run];
            return <li key={ch.run} data-child-run={ch.run}><RunLink id={ch.run}>{ch.run}</RunLink> · {ch.people.map((id: string, i: number) => <span key={id}>{i > 0 && ", "}{D.people[id] ? <PersonLink id={id} /> : id}</span>)} · {ch.length}{k ? <> · {RUN_TXT[k.status] || k.status}{k.proposals.length > 0 && <> · <Link to="/research/queue">{A.suggestion(k.proposals[0])}</Link></>}</> : ""}<br /><span className="muted">{ch.brief}</span></li>;
          })}
        </ul></div>
      )}
    </>
  );
}

const REL_TXT: Record<string, string> = RR.relation;
const LOOK_TXT: Record<string, string> = RR.looking;

/** Sherlock's report: the relatives it suggests (each its own suggestion), those noted as possibly living, and those
 *  it found already in the tree. */
function RelativesReport({ r }: { r: any }) {
  const { D } = useData();
  const rep = r.report || {}, o = r.options || {};
  const pl = (id: string) => (D.people[id] ? <PersonLink id={id} /> : id);
  const life = (c: any) => [c.born && (c.born.date || c.born.place) ? RR.born([c.born.date, c.born.place].filter(Boolean).join(", ")) : "", c.died && (c.died.date || c.died.place) ? RR.died([c.died.date, c.died.place].filter(Boolean).join(", ")) : ""].filter(Boolean).join(" · ");
  return (
    <div data-relatives-report={r.id}>
      <p className="small">{RR.lookingFor(o.looking_for === "named" ? o.named : LOOK_TXT[o.looking_for] || RR.looking.any)} · {o.depth === 2 ? RR.twoGenerations : RR.oneGeneration}{o.hints ? RR.hints(o.hints) : ""}</p>
      {r.summary && <p className="small">{r.summary}</p>}
      {r.status === "succeeded" && <>
        <p className="small"><b>{(rep.candidates || []).length}</b>{RR.counts((rep.living || []).length, (rep.already_in_tree || []).length, rep.searches || 0)}{rep.research ? <> {RR.loggedIn} <Link to="/research/queue">{A.suggestion(rep.research)}</Link></> : ""}</p>
        {(rep.candidates || []).length > 0 && <div className="table-wrap"><table className="data stack small"><thead><tr><th>{RR.head.relative}</th><th>{RR.head.of}</th><th>{RR.head.confidence}</th><th>{RR.head.suggestion}</th></tr></thead><tbody>
          {rep.candidates.map((c: any, i: number) => (
            <tr key={i}><td><b>{c.name}</b>, {REL_TXT[c.relation] || c.relation}{life(c) && <><br /><span className="muted">{life(c)}</span></>}</td><td>{pl(c.of)}</td><td>{c.confidence}</td><td><Link to="/research/queue">#{c.proposal}</Link></td></tr>
          ))}
        </tbody></table></div>}
        {(rep.living || []).length > 0 && <p className="small muted">{RR.living(rep.living.length)}{rep.living.map((x: any, i: number) => <span key={i}>{i > 0 && "; "}{RR.livingItem(REL_TXT[x.relation] || x.relation)}{pl(x.of)}</span>)}.</p>}
        {(rep.already_in_tree || []).length > 0 && <p className="small muted">{RR.already}{rep.already_in_tree.map((x: any, i: number) => <span key={i}>{i > 0 && "; "}{x.name} = {pl(x.id)}</span>)}.</p>}
      </>}
    </div>
  );
}

const KIND_TXT: Record<string, string> = A.kind;

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
    if (!confirm(A.applyConfirm)) return;
    b.disabled = true;
    try { const r = await api("POST", `agent/runs/${id}/apply`); alert(A.applied(r.report.filter((d: any) => d.status === "applied").length, r.report.filter((d: any) => d.status === "skipped").length)); }
    catch (e) { alert((e as Error).message); }
    load();
  }
  async function cancel(id: string) {
    if (!confirm(A.stopConfirm)) return;
    try { await api("POST", `agent/runs/${id}/cancel`); } catch (e) { alert((e as Error).message); }
    load();
  }
  async function startQuality(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const f = ev.currentTarget.elements as any, person = pickId(f.person.value);
    if (!f.dry.checked && !confirm(A.notDryRunConfirm)) return;
    try { await api("POST", "agent/runs", { kind: "quality", scope: f.scope.value, person: person || undefined, limit: +f.limit.value || 10, dry_run: f.dry.checked }); load(); }
    catch (e) { alert((e as Error).message); }
  }
  async function startLibrary(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const form = ev.currentTarget, f = form.elements as any;
    try { await api("POST", "agent/runs", { kind: "library", n: f.n.value === "" ? 2 : +f.n.value, instructions: f.instructions.value || undefined }); form.reset(); load(); }
    catch (e) { alert((e as Error).message); }
  }
  async function startRun(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const form = ev.currentTarget, f = form.elements as any, person = pickId(f.person.value);
    try { await api("POST", "agent/runs", { person: person || undefined, instructions: f.instructions.value || undefined }); form.reset(); load(); }
    catch (e) { alert((e as Error).message); }
  }

  const d = state.data, QF = A.qualityForm, LF = A.libraryForm;
  const mdl = (a: string) => model(((d.limits.agents || {})[a] || {}).model);
  return (
    <>
      <p className="muted">{A.intro}</p>
      <form id="ar-new" className="card filters" style={{ marginBottom: 16 }} onSubmit={startRun}>
        <input name="person" list="ar-people" placeholder={A.newRun.person} style={{ flex: 1, minWidth: 200 }} />
        <datalist id="ar-people">{people.filter((p) => !isUnknown(p) && !p.living).map((p) => <option key={p.id} value={`${p.name} (${p.id})`} />)}</datalist>
        <input name="instructions" placeholder={A.newRun.instructions} style={{ flex: 2, minWidth: 240 }} /><button className="btn primary">{A.newRun.start}</button>
      </form>
      <details className="card" style={{ marginBottom: 16 }}><summary><b>{QF.title}</b> <span className="small muted">{QF.subtitle}</span></summary>
        <p className="small muted">{QF.help}</p>
        <form id="dq-new" className="filters" onSubmit={startQuality}>
          <select name="scope" aria-label={QF.scopeLabel} defaultValue="all"><option value="all">{QF.scope.all}</option><option value="checks">{QF.scope.checks}</option><option value="both">{QF.scope.both}</option><option value="todos">{QF.scope.todos}</option><option value="findings">{QF.scope.findings}</option></select>
          <input name="person" list="dq-people" placeholder={QF.person} style={{ flex: 1, minWidth: 180 }} />
          <datalist id="dq-people">{people.filter((p) => !isUnknown(p)).map((p) => <option key={p.id} value={`${p.name} (${p.id})`} />)}</datalist>
          <label className="small">{QF.limit.before} <input name="limit" type="number" min="1" max="100" defaultValue="10" style={{ width: 64 }} /> {QF.limit.after}</label>
          <label className="small"><input name="dry" type="checkbox" defaultChecked /> {QF.dryRun}</label>
          <button className="btn primary">{QF.start}</button>
        </form>
      </details>
      <details className="card" style={{ marginBottom: 16 }}><summary><b>{LF.title}</b> <span className="small muted">{LF.subtitle}</span></summary>
        <p className="small muted">{LF.help}</p>
        <form id="lib-new" className="filters" onSubmit={startLibrary}>
          <label className="small">{LF.count.before} <input name="n" type="number" min="0" max="5" defaultValue="2" style={{ width: 56 }} /> {LF.count.after}</label>
          <input name="instructions" placeholder={LF.instructions} style={{ flex: 2, minWidth: 240 }} />
          <button className="btn primary">{LF.start}</button>
        </form>
      </details>
      <div id="ar-out">
        {state.error ? <div className="empty">{state.error}</div> : !d ? <p className="muted">{A.loading}</p> : <>
          <p className="small muted">{A.today({
            runs: d.today ? d.today.runs : 0, runsPerDay: d.limits.runs_per_day,
            usd: (d.today ? d.today.usd : 0).toFixed(2), usdPerDay: (+d.limits.usd_per_day).toFixed(2), usdPerRun: (+d.limits.usd_per_run).toFixed(2),
            searches: d.limits.searches_per_run, minutes: d.limits.minutes_per_run,
            models: { research: mdl("research"), quality: mdl("quality"), library: mdl("library"), stories: mdl("stories"), relatives: mdl("relatives") },
          })}</p>
          {d.runs.length ? d.runs.map((r: any) => (
            <section key={r.id} id={r.id} className="card" style={{ marginBottom: 12 }}>
              <div className="eyebrow">{r.created_at.slice(0, 16).replace("T", " ")} · {who(r.started_by)} · {KIND_TXT[r.kind] || ""}{r.options && r.options.parent ? <><RunLink id={r.options.parent}>{A.startedByLibrary}</RunLink> · </> : ""}<span className={`badge st-${r.status === "succeeded" ? "verified" : r.status === "failed" ? "disputed" : "unverified"}`}>{RUN_TXT[r.status]}</span></div>
              <p>{r.todo_id ? A.todo(r.todo_id) : ""}{r.person && D.people[r.person] && <> <PersonLink id={r.person} /></>}{r.instructions ? ` · ${r.instructions}` : ""}</p>
              {r.kind === "quality" && <QualityReport r={r} onApply={apply} />}
              {r.kind === "library" && <LibraryReport r={r} runs={d.runs} />}
              {r.kind === "relatives" && <RelativesReport r={r} />}
              <p className="small muted">{A.usage(r.steps, (r.tokens.input + r.tokens.output).toLocaleString())}{r.usd ? ` · $${r.usd.toFixed(2)}` : ""}{r.model ? ` · ${model(r.model)}` : ""}
                {r.proposals.length > 0 && <> · {A.suggestionLabel} {r.proposals.map((x: any, i: number) => <span key={x}>{i > 0 && ", "}<Link to="/research/queue">#{x}</Link></span>)}</>}{r.error ? ` · ${r.error}` : ""}</p>
              {r.log.length > 0 && <details><summary className="small">{A.steps(r.log.length)}</summary><ul className="small">{r.log.map((l: any, i: number) => <li key={i}>{l.text}</li>)}</ul></details>}
              {["queued", "running"].includes(r.status) && <button className="btn" data-cancel={r.id} onClick={() => cancel(r.id)}>{A.stop}</button>}
            </section>
          )) : <div className="empty">{A.empty}</div>}
        </>}
      </div>
    </>
  );
}
