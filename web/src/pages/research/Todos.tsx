// The live to-do list (/api/todos): filters, a new to-do form, and claim / assign / status / research / history
// actions per row.
import { Fragment, useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { useData } from "../../data";
import { isUnknown, PersonLink } from "../../lib";
import { Linkify, useWho } from "../../ui";
import { S } from "../../../../strings/index.ts";

const T = S.research.todos;
export const STATUS_TXT: Record<string, string> = T.status;
const FILTERS: [string, string][] = (["active", "mine", "unassigned", "needs_review", "done", "all"] as const).map((k) => [k, T.filters[k]]);
const QUERY: Record<string, string> = { active: "status=active", mine: "assignee=me&status=active", unassigned: "assignee=unassigned&status=open", needs_review: "status=needs_review", done: "status=done,wont_do", all: "" };
/** The id in "Name (I12)", as the person pickers fill it. */
export const pickId = (v: string) => (String(v || "").match(/\(([^)]+)\)\s*$/) || [])[1];

function History({ t, events, onComment }: { t: any; events: any[]; onComment: (text: string) => void }) {
  const who = useWho();
  const [c, setC] = useState("");
  return (
    <tr className="td-hist"><td colSpan={6} className="small">
      {events.map((e, i) => (
        <div key={i}>{e.at.slice(0, 16).replace("T", " ")} · {who(e.actor)} · {e.kind} {e.data.text || e.data.outcome || (e.data.to !== undefined ? T.history.assignedTo(e.data.to || T.history.unassigned) : "") || (e.data.proposal ? T.history.suggestion(e.data.proposal) : "")}</div>
      ))}
      <form className="filters" style={{ marginTop: 6 }} onSubmit={(ev) => { ev.preventDefault(); onComment(c); }} data-todo={t.id}>
        <input name="c" placeholder={T.history.commentPlaceholder} style={{ flex: 1 }} value={c} onChange={(e) => setC(e.target.value)} />
        <button className="btn">{T.history.comment}</button>
      </form>
    </td></tr>
  );
}

export function Todos() {
  const { D, api, editor, ai, people } = useData();
  const who = useWho();
  const me = D.me || null;
  const section = useSearchParams()[0].get("section");
  const [filter, setFilter] = useState(() => section?.startsWith("td-") ? "all" : "active");
  useEffect(() => { if (section?.startsWith("td-")) setFilter("all"); }, [section]);
  const [state, setState] = useState<{ loading?: boolean; todos?: any[]; error?: string }>({ loading: true });
  const [hist, setHist] = useState<Record<number, any[]>>({});
  const [formOpen, setFormOpen] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async () => {
    setState({ loading: true });
    setHist({});
    try {
      const { todos } = await api("GET", `todos?${QUERY[filter]}`);
      if (alive.current) setState({ todos });
    } catch (e) { if (alive.current) setState({ error: (e as Error).message }); }
  }, [api, filter]);
  useEffect(() => { load(); }, [load]);

  async function act(kind: string, t: any, el?: HTMLSelectElement) {
    try {
      if (kind === "claim") await api("POST", `todos/${t.id}/claim`);
      else if (kind === "research") {
        const extra = prompt(T.researchPrompt, "");
        if (extra === null) return;
        await api("POST", "agent/runs", { todo_id: t.id, instructions: extra || undefined });
        alert(T.researchStarted);
      } else if (kind === "assign") {
        const a = prompt(T.assignPrompt,t.assignee || "me");
        if (a === null) return;
        await api("PATCH", `todos/${t.id}`, { version: t.version, assignee: a.trim() || null });
      } else if (kind === "status" && el) {
        const body: any = { version: t.version, status: el.value };
        if (["done", "wont_do", "needs_review"].includes(el.value)) {
          const o = prompt(T.outcomePrompt,t.outcome || "");
          if (o === null) { el.value = t.status; return; }
          body.outcome = o;
        }
        await api("PATCH", `todos/${t.id}`, body);
      } else if (kind === "history") {
        if (hist[t.id]) { setHist((h) => { const n = { ...h }; delete n[t.id]; return n; }); return; }
        const { events } = await api("GET", `todos/${t.id}/events`);
        setHist((h) => ({ ...h, [t.id]: events }));
        return;
      }
      load();
    } catch (e: any) { alert(e.status === 409 ? T.conflict : e.message); load(); }
  }
  async function comment(t: any, text: string) {
    try { await api("PATCH", `todos/${t.id}`, { comment: text }); }
    catch (e) { alert((e as Error).message); }
    load();
  }

  async function add(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const form = ev.currentTarget, f = form.elements as any, m = pickId(f.person.value);
    try {
      await api("POST", "todos", { task: f.task.value, person: m || undefined, where: f.where.value || undefined, priority: f.priority.value, assignee: f.mine.checked ? "me" : undefined });
      form.reset(); setFormOpen(false); load();
    } catch (e) { alert((e as Error).message); }
  }

  function Row({ t }: { t: any }) {
    const mine = !!me && t.assignee === me.principal;
    const statuses = editor ? Object.keys(STATUS_TXT) : mine ? ["open", "in_progress", "needs_review"] : [];
    const status = statuses.length && !(statuses.indexOf(t.status) < 0 && !editor)
      ? <select data-status={t.id} defaultValue={t.status} onChange={(e: ChangeEvent<HTMLSelectElement>) => act("status", t, e.target)}>{statuses.map((x) => <option key={x} value={x}>{STATUS_TXT[x]}</option>)}</select>
      : <span className={`badge st-${t.status === "done" ? "verified" : t.status === "needs_review" ? "partly-verified" : "unverified"}`}>{STATUS_TXT[t.status]}</span>;
    const isPrivate = t.person && D.people[t.person] && D.people[t.person].private;
    return (
      <tr id={`td-${t.id}`}><td className={`prio-${t.priority}`}>{t.priority}</td><td>{t.person && D.people[t.person] ? <PersonLink id={t.person} /> : "—"}</td>
        <td>{t.task}{t.where && <><br /><span className="small muted"><Linkify text={t.where} /></span></>}{t.outcome && <><br /><span className="small"><b>{T.outcome}</b> {t.outcome}</span></>}</td>
        <td>{status}</td><td className="small">{who(t.assignee)}</td>
        <td><div className="btn-row">
          {!t.assignee && !["done", "wont_do"].includes(t.status) && <button className="btn" data-act="claim" onClick={() => act("claim", t)}>{T.takeIt}</button>}
          {editor && <button className="btn" data-act="assign" title={T.assignTitle} onClick={() => act("assign", t)}>{T.assign}</button>}
          {ai && !["done", "wont_do", "needs_review"].includes(t.status) && (!t.assignee || mine) && !isPrivate &&
            <button className="btn" data-act="research" title={T.researchTitle} onClick={() => act("research", t)}>{T.research}</button>}
          <button className="btn" data-act="history" onClick={() => act("history", t)}>{T.historyButton}</button>
        </div></td></tr>
    );
  }

  return (
    <>
      <div className="filters" id="td-filters">
        {FILTERS.map(([k, l]) => <button key={k} className={`btn${k === filter ? " primary" : ""}`} data-f={k} onClick={() => (k === filter ? load() : setFilter(k))}>{l}</button>)}
        <button className="btn" id="td-new" style={{ marginLeft: "auto" }} onClick={() => setFormOpen((x) => !x)}>{T.newTodo}</button>
      </div>
      <form id="td-form" className="card" hidden={!formOpen} style={{ marginBottom: 16 }} onSubmit={add}><div className="filters">
        <input name="task" placeholder={T.form.task} required style={{ flex: 2, minWidth: 240 }} />
        <input name="person" list="td-people" placeholder={T.form.person} style={{ flex: 1, minWidth: 180 }} />
        <datalist id="td-people">{people.filter((p) => !isUnknown(p)).map((p) => <option key={p.id} value={`${p.name} (${p.id})`} />)}</datalist>
        <input name="where" placeholder={T.form.where} style={{ flex: 1, minWidth: 180 }} />
        <select name="priority" defaultValue="medium"><option value="high">{T.form.priority.high}</option><option value="medium">{T.form.priority.medium}</option><option value="low">{T.form.priority.low}</option></select>
        <label className="small"><input type="checkbox" name="mine" defaultChecked /> {T.form.assignToMe}</label>
        <button className="btn primary">{T.form.add}</button></div></form>
      <div id="td-out">
        {state.loading ? <p className="muted">{T.loading}</p>
          : state.error ? <div className="empty">{state.error}</div>
          : state.todos!.length ? (
            <div className="table-wrap"><table className="data stack"><thead><tr><th>{T.head.priority}</th><th>{T.head.person}</th><th>{T.head.task}</th><th>{T.head.status}</th><th>{T.head.assigned}</th><th></th></tr></thead>
              <tbody>{state.todos!.map((t) => <Fragment key={t.id}>{Row({ t })}{hist[t.id] && <History t={t} events={hist[t.id]} onComment={(text) => comment(t, text)} />}</Fragment>)}</tbody></table></div>
          ) : <div className="empty">{T.empty}</div>}
      </div>
    </>
  );
}
