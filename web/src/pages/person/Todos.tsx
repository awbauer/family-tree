// Next steps (to-dos) for one person, live from /api/todos: claim, finish with an outcome, change status, hand to a
// research agent, history with comments, and add a new one.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { useData } from "../../data";
import { ago, todosFor } from "../../tree";
import { Linkify, useWho } from "../../ui";
import { usePerson } from "./context";
import { S } from "../../../../strings/index.ts";

const T = S.person.todos;

const STATUS_TXT: Record<string, string> = T.status;
const closedSt = (s: string) => ["done", "wont_do"].includes(s);

export function Todos() {
  const { D, live } = useData();
  const { id } = usePerson();
  if (!live) {
    const todos = todosFor(D, id);
    return <div id="w-todos">{todos.length ? <ul>{todos.map((t, i) => <li key={i}><span className={`prio-${t.priority}`}>[{t.priority}]</span> {t.task}{t.where && <> <span className="muted small">— <Linkify text={t.where} /></span></>}</li>)}</ul> : <p className="muted small">{T.none}</p>}</div>;
  }
  return <div id="w-todos"><LiveTodos /></div>;
}

function LiveTodos() {
  const { api } = useData();
  const { id, p } = usePerson();
  const [state, setState] = useState<{ todos?: any[]; error?: string }>({});
  const load = useCallback(async () => {
    try { setState({ todos: (await api("GET", `todos?person=${encodeURIComponent(id)}`)).todos }); }
    catch (e: any) { setState({ error: e.message }); }
  }, [api, id]);
  useEffect(() => { load(); }, [load]);
  if (state.error) return <p className="muted small">{state.error}</p>;
  if (!state.todos) return null;
  const todos = state.todos;
  const active = todos.filter((t) => !closedSt(t.status)), closed = todos.filter((t) => closedSt(t.status));
  const pr: Record<string, number> = { high: 0, medium: 1, low: 2 };
  active.sort((a, b) => pr[a.priority] - pr[b.priority] || a.id - b.id);
  return (
    <>
      {active.length ? <ul className="todo-list">{active.map((t) => <TodoRow key={t.id} t={t} reload={load} />)}</ul> : <p className="muted small">{T.noneOpen}</p>}
      {closed.length > 0 && <details><summary className="small">{T.finished(closed.length)}</summary><ul className="todo-list">{closed.map((t) => <TodoRow key={t.id} t={t} reload={load} />)}</ul></details>}
      <form className="filters todo-new" onSubmit={async (ev) => {
        ev.preventDefault();
        const f = ev.currentTarget, v = (k: string) => (f.elements.namedItem(k) as HTMLInputElement);
        try { await api("POST", "todos", { person: id, task: v("task").value, where: v("where").value || undefined, priority: v("priority").value, assignee: v("mine").checked ? "me" : undefined }); f.reset(); load(); }
        catch (e: any) { alert(e.message); }
      }}>
        <input name="task" placeholder={T.newTask(p.given || p.name)} required style={{ flex: 2, minWidth: 220 }} />
        <input name="where" placeholder={T.where} style={{ flex: 1, minWidth: 180 }} />
        <select name="priority" defaultValue="medium"><option value="high">{T.priorities.high}</option><option value="medium">{T.priorities.medium}</option><option value="low">{T.priorities.low}</option></select>
        <label className="small"><input type="checkbox" name="mine" /> {T.mine}</label><button className="btn">{T.add}</button>
      </form>
    </>
  );
}

function TodoRow({ t, reload }: { t: any; reload: () => void }) {
  const { D, editor, ai, api } = useData();
  const { p } = usePerson();
  const who = useWho();
  const [hist, setHist] = useState(false);
  const mine = !!D.me && t.assignee === D.me.principal;
  const canStatus = editor || mine;
  async function act(a: string, value?: string) {
    try {
      if (a === "claim") await api("POST", `todos/${t.id}/claim`);
      else if (a === "done" || (a === "status" && closedSt(value!))) {
        const outcome = prompt(T.outcomePrompt, t.outcome || "");
        if (outcome === null) return;
        await api("PATCH", `todos/${t.id}`, { version: t.version, status: a === "done" ? "done" : value, outcome });
      } else if (a === "status") await api("PATCH", `todos/${t.id}`, { version: t.version, status: value });
      else if (a === "ai") {
        const extra = prompt(T.aiPrompt, "");
        if (extra === null) return;
        await api("POST", "agent/runs", { todo_id: t.id, instructions: extra || undefined });
      }
      reload();
    } catch (e: any) { alert(e.status === 409 ? T.conflict : e.message); reload(); }
  }
  const st = t.status === "done" ? "verified" : t.status === "needs_review" ? "partly-verified" : "unverified";
  return (
    <li className={`todo-item prio-b-${t.priority}`} data-id={t.id}>
      <div className="todo-head"><span className={`prio-${t.priority}`}>{t.priority}</span>{" "}
        <span className={`badge st-${st}`}>{STATUS_TXT[t.status]}</span>{" "}
        {t.assignee ? <span className="small">{who(t.assignee)}</span> : <span className="small muted">{T.unassigned}</span>}{" "}
        <span className="small muted">{T.added(ago(t.created_at), who(t.created_by))}</span></div>
      <div>{t.task}</div>
      {t.where && <div className="small">{T.whereToLook} <Linkify text={t.where} /></div>}
      {t.outcome && <div className="small"><b>{T.outcome}</b> {t.outcome}</div>}
      <div className="btn-row todo-acts">
        {!t.assignee && !closedSt(t.status) && <button className="btn" data-a="claim" onClick={() => act("claim")}>{T.claim}</button>}
        {canStatus && t.status !== "done" && <button className="btn" data-a="done" onClick={() => act("done")}>{T.done}</button>}
        {ai && !p.living && !["done", "wont_do", "needs_review"].includes(t.status) && (!t.assignee || mine) && <button className="btn" data-a="ai" title={T.aiTitle} onClick={() => act("ai")}>{T.ai}</button>}
        {canStatus && !closedSt(t.status) && (
          <select data-a="status" aria-label={T.statusLabel} value={t.status} onChange={(e) => act("status", e.target.value)}>
            {Object.entries(STATUS_TXT).filter(([k]) => editor || ["open", "in_progress", "needs_review"].includes(k)).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        )}
        <button className="linklike" data-a="history" onClick={() => setHist((h) => !h)}>{T.history}</button>
      </div>
      <div className="todo-hist small">{hist && <TodoHistory t={t} />}</div>
    </li>
  );
}

function TodoHistory({ t }: { t: any }) {
  const { api } = useData();
  const who = useWho();
  const [events, setEvents] = useState<any[] | null>(null);
  const load = useCallback(async () => {
    try { setEvents((await api("GET", `todos/${t.id}/events`)).events); } catch (e: any) { alert(e.message); }
  }, [api, t.id]);
  useEffect(() => { load(); }, [load]);
  if (!events) return null;
  return (
    <>
      <ul className="history">{events.map((e, i) => {
        const d = e.data || {};
        const what = e.kind === "status" ? `${STATUS_TXT[d.from] || d.from || "?"} → ${STATUS_TXT[d.to] || d.to}${d.note ? `: ${d.note}` : ""}`
          : e.kind === "assigned" ? `${T.events.assignedTo(who(d.to) || T.events.nobody)}${d.run ? T.events.agentRun : ""}`
          : e.kind === "proposal" ? <>{T.events.filed} <Link to="/research/queue">{T.events.suggestion(d.proposal)}</Link></>
          : e.kind === "comment" ? `“${d.text}”` : e.kind === "edited" ? T.events.changed(d.field) : e.kind;
        return <li key={i}>{ago(e.at)} · {who(e.actor)} · {what}</li>;
      })}</ul>
      <form className="filters" onSubmit={async (ev) => {
        ev.preventDefault();
        const f = ev.currentTarget;
        try { await api("PATCH", `todos/${t.id}`, { comment: (f.elements.namedItem("c") as HTMLInputElement).value }); f.reset(); load(); }
        catch (e: any) { alert(e.message); }
      }}><input name="c" placeholder={T.commentPlaceholder} style={{ flex: 1 }} /><button className="btn">{T.comment}</button></form>
    </>
  );
}
