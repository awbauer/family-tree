// The research section: overview, data problems, findings, to-dos, suggestions, agent runs and verification, with a
// link to the sources list (#/sources).
import { useState } from "react";
import { Link, Navigate, useParams } from "react-router";
import { useData } from "../../data";
import { isUnknown, PersonLink, useTitle, years } from "../../lib";
import { Inline } from "../../StoryText";
import { byBirth, findingsFor } from "../../tree";
import { Finding, Issue, Linkify, StatusBadge } from "../../ui";
import { AgentRuns } from "./AgentRuns";
import { Queue } from "./Queue";
import { Todos } from "./Todos";
import { S } from "../../../../strings/index.ts";

const R_ = S.research;
const ISSUE_LABELS: Record<string, string> = R_.review.issueLabels;
const SEVERITY = ["error", "warn", "info"];
const PRIORITY: Record<string, number> = { high: 0, medium: 1, low: 2 };
const KIND_ORDER: Record<string, number> = { correction: 0, "data-error": 0, conflict: 1, "new-person": 2, "new-fact": 3, confirmed: 4 };

const O = R_.overview;

function Overview() {
  const { D, live, editor, tree, account } = useData();
  const R: any = D.research, findings: any[] = R.findings || [], todos: any[] = R.todo || [], issues: any[] = (D as any).issues || [];
  const k: Record<string, number> = {};
  findings.forEach((f) => (k[f.kind] = (k[f.kind] || 0) + 1));
  return (
    <>
      <div className="prose"><p>{O.intro}</p></div>
      <div className="grid g4">
        <div className="card"><div className="eyebrow">{O.findings.title}</div><div className="stat"><b>{findings.length}</b></div><p className="small">{Object.entries(k).map(([a, b]) => `${b} ${a}`).join(" · ") || O.findings.none}</p><Link className="small" to="/research/findings">{O.findings.link}</Link></div>
        <div className="card"><div className="eyebrow">{O.problems.title}</div><div className="stat"><b>{issues.filter((i) => i.severity === "error").length}</b></div><p className="small">{O.problems.detail(issues.filter((i) => i.severity === "warn").length)}</p><Link className="small" to="/research/review">{O.problems.link}</Link></div>
        <div className="card"><div className="eyebrow">{O.tasks.title}</div><div className="stat"><b>{todos.length}</b></div><p className="small">{O.tasks.high(todos.filter((t) => t.priority === "high").length)}</p><Link className="small" to="/research/todo">{O.tasks.link}</Link></div>
        <div className="card"><div className="eyebrow">{O.sources.title}</div><div className="stat"><b>{Object.keys(D.sources).length}</b></div><p className="small">{O.sources.detail}</p><Link className="small" to="/sources">{O.sources.link}</Link></div>
      </div>
      {live && editor && (
        <p className="btn-row" style={{ marginTop: 14 }}>
          <a className="btn" href={`api/export.gedcomx?tree=${encodeURIComponent(tree || "")}`} download title={O.download.gedcomxTitle}>{O.download.gedcomx}</a>
          <a className="btn" href={`api/export.ged?tree=${encodeURIComponent(tree || "")}`} download title={O.download.gedTitle}>{O.download.ged}</a>
          {account && account.isOwner && <a className="btn" href="api/export.json" download>{O.download.everything}</a>}
        </p>
      )}
      {R.methodology && <section className="section prose">{String(R.methodology).split(/\n\n+/).map((t, i) => <p key={i}><Inline text={t} /></p>)}</section>}
    </>
  );
}

function Review() {
  const { D } = useData();
  const issues: any[] = (D as any).issues || [];
  const groups: Record<string, any[]> = {};
  issues.forEach((i) => (groups[i.kind] = groups[i.kind] || []).push(i));
  return (
    <>
      <p className="muted">{R_.review.intro.before} <code>{R_.review.intro.code}</code> {R_.review.intro.after}</p>
      {Object.entries(groups).sort((a, b) => SEVERITY.indexOf(a[1][0].severity) - SEVERITY.indexOf(b[1][0].severity)).map(([k, list]) => (
        <section key={k} className="card" style={{ marginBottom: 14 }}><h3>{ISSUE_LABELS[k] || k} <span className="count">{list.length}</span></h3>{list.map((i, j) => <Issue key={j} i={i} />)}</section>
      ))}
    </>
  );
}

const F = R_.findings;

function Findings() {
  const { D } = useData();
  const R: any = D.research, findings: any[] = R.findings || [];
  const [k, setK] = useState(""), [b, setB] = useState(""), [c, setC] = useState("");
  const list = findings.filter((f) => (!k || f.kind === k) && (!c || f.confidence === c) && (!b || (f.person && D.people[f.person] && D.people[f.person].branch === b) || (!f.person && f.branch === b)))
    .sort((x, y) => (KIND_ORDER[x.kind] ?? 5) - (KIND_ORDER[y.kind] ?? 5));
  return (
    <>
      <div className="filters">
        <select id="ff-k" value={k} onChange={(e) => setK(e.target.value)}><option value="">{F.allKinds}</option>{[...new Set(findings.map((f) => f.kind))].map((x) => <option key={x}>{x}</option>)}</select>
        <select id="ff-b" value={b} onChange={(e) => setB(e.target.value)}><option value="">{F.allBranches}</option>{(R.branches || []).map((x: any) => <option key={x.key} value={x.key}>{x.label}</option>)}</select>
        <select id="ff-c" value={c} onChange={(e) => setC(e.target.value)}><option value="">{F.anyConfidence}</option><option value="high">{F.confidence.high}</option><option value="medium">{F.confidence.medium}</option><option value="low">{F.confidence.low}</option></select>
      </div>
      <div id="ff-out">{list.length ? list.map((f, i) => <Finding key={f.id ?? i} f={f} />) : <div className="empty">{F.noMatch}</div>}</div>
    </>
  );
}

/** The to-do list on the static preview (no API): the to-dos in the tree. */
function StaticTodos() {
  const { D } = useData();
  const todos: any[] = (D.research as any).todo || [];
  const T = R_.staticTodos;
  if (!todos.length) return <div className="empty">{T.empty}</div>;
  return (
    <div className="table-wrap"><table className="data stack"><thead><tr><th>{T.head.priority}</th><th>{T.head.person}</th><th>{T.head.task}</th><th>{T.head.where}</th></tr></thead><tbody>
      {todos.slice().sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority]).map((t, i) => (
        <tr key={t.id ?? i}><td className={`prio-${t.priority}`}>{t.priority}</td><td>{t.person && D.people[t.person] ? <PersonLink id={t.person} /> : "—"}</td><td>{t.task}</td><td className="small"><Linkify text={t.where || ""} /></td></tr>
      ))}
    </tbody></table></div>
  );
}

function Verification() {
  const { D, people } = useData();
  const V = R_.verification;
  const list = people.filter((p: any) => !isUnknown(p) && p.direct).sort((a: any, b: any) => a.generation - b.generation || byBirth(D)(a.id, b.id));
  return (
    <>
      <p className="muted">{V.intro.before} <code>{V.intro.code}</code>.</p>
      <div className="table-wrap"><table className="data"><thead><tr><th>{V.head.gen}</th><th>{V.head.person}</th><th>{V.head.status}</th><th>{V.head.note}</th><th>{V.head.findings}</th></tr></thead><tbody>
        {list.map((p: any) => (
          <tr key={p.id}><td>{p.generation}</td><td><PersonLink id={p.id} /><br /><span className="small muted">{years(p)} · {p.relation || ""}</span></td>
            <td><StatusBadge status={p.status} note={p.statusNote} /></td><td className="small">{p.statusNote}</td><td>{findingsFor(D, p.id).length || ""}</td></tr>
        ))}
      </tbody></table></div>
    </>
  );
}

export function Research() {
  const { tab: t } = useParams();
  const tab = t || "overview";
  const { D, live, ai } = useData();
  useTitle(R_.title);
  const R: any = D.research, issues: any[] = (D as any).issues || [], L = R_.tabs;
  const tabs: [string, string, number | null][] = [
    ["overview", L.overview, null], ["review", L.review, issues.filter((i) => i.severity !== "info").length],
    ["findings", L.findings, (R.findings || []).length], ["todo", L.todo, (R.todo || []).length],
    ...(live ? [["queue", L.queue, null] as [string, string, null]] : []), ...(ai ? [["agents", L.agents, null] as [string, string, null]] : []),
    ["status", L.status, null], ["sources", L.sources, Object.keys(D.sources).length],
  ];
  let body = null;
  if (tab === "overview") body = <Overview />;
  else if (tab === "review") body = <Review />;
  else if (tab === "findings") body = <Findings />;
  else if (tab === "todo") body = live ? <Todos /> : <StaticTodos />;
  else if (tab === "queue" && live) body = <Queue />;
  else if (tab === "agents" && ai) body = <AgentRuns />;
  else if (tab === "status") body = <Verification />;
  else if (tab === "sources") return <Navigate to="/sources" replace />; // the old tab: the list has its own page now
  return (
    <div className="wrap page">
      <h1>{R_.title}</h1>
      <nav className="tabs">{tabs.map(([k, l, n]) => <Link key={k} to={k === "sources" ? "/sources" : `/research/${k}`} className={k === tab ? "on" : ""}>{l}{n != null && <span className="count">{n}</span>}</Link>)}</nav>
      {body}
    </div>
  );
}
