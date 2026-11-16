// Admin → Audit history (owner only): every change, newest first, with filters, paging, and rows that open to the
// full detail (diffs, stored values, linked suggestions and runs) and an undo.
import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { S } from "../../../../strings/index.ts";
import { useData } from "../../data";
import { PersonLink } from "../../lib";
import { Diff, diffItems } from "../../ops";
import { useWho } from "../../ui";

const T = S.admin.audit;
const AUDIT_OPS: Record<string, string> = T.ops;
const AUDIT_TYPES: Record<string, [string, string]> = T.types;
const typeName = (t: string, n: number) => { const x = AUDIT_TYPES[t] || [t, `${t}s`]; return n === 1 ? x[0] : x[1]; };
const fmt = (iso?: string) => (iso ? iso.slice(0, 16).replace("T", " ") : "");
const short = (v: unknown) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s == null ? "—" : s.length > 140 ? s.slice(0, 137) + "…" : s; };
const DIFF_TYPES = ["person", "family", "source", "media", "finding", "status"];

function EntityLink({ e }: { e: any }) {
  const { D } = useData();
  if (e.type === "person" && D.people[e.id]) return <PersonLink id={e.id}>{e.label || undefined}</PersonLink>;
  if (e.type === "story") return <Link to={`/story/${e.id}`}>{e.label || e.id}</Link>;
  return <>{e.label || e.id}</>;
}

function Summary({ b }: { b: any }) {
  const parts = Object.entries(b.types).map(([t, n]) => `${n} ${typeName(t, n as number)}`);
  const names = b.entities.filter((e: any) => e.label || ["person", "family", "story", "grant", "tree", "view"].includes(e.type)).slice(0, 4);
  return <><span className="badge">{AUDIT_OPS[b.op] || b.op}</span> {parts.join(", ")}{names.length > 0 && <><br /><span className="small">{names.map((e: any, i: number) => <span key={i}>{i > 0 && ", "}<EntityLink e={e} /></span>)}{b.count > names.length ? ", …" : ""}</span></>}</>;
}

function FieldDiff({ a, b }: { a: any; b: any }) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  return <ul className="diff-fields">{keys.map((k) => <li key={k}><b>{k}</b>: <span className="d-from">{short(a[k])}</span> → <span className="d-to">{short(b[k])}</span></li>)}</ul>;
}
const hasFieldDiff = (a: any, b: any) => a != null && b != null && typeof a === "object" && typeof b === "object" &&
  [...new Set([...Object.keys(a), ...Object.keys(b)])].some((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));

function RowDetail({ r }: { r: any }) {
  const { D } = useData();
  const ch = { type: r.type, id: r.entity, before: r.before, after: r.after };
  const canDiff = DIFF_TYPES.includes(r.type);
  let visible = false;
  if (canDiff) { try { visible = diffItems(D, ch).length > 0; } catch { visible = false; } }
  const body = visible ? <Diff changes={[ch]} />
    : r.change === "updated" && hasFieldDiff(r.before, r.after) ? <FieldDiff a={r.before} b={r.after} />
    : canDiff ? <p className="small muted">{T.row.noDifferences}</p> : null;
  return (
    <div className="audit-entity">
      <div className="small"><b>{typeName(r.type, 1)}</b> {r.type === "person" && D.people[r.entity] ? <PersonLink id={r.entity} /> : r.entity} · {r.change}{r.op !== "edit" ? ` (${AUDIT_OPS[r.op] || r.op})` : ""}{r.version_after ? T.row.version(r.version_after) : ""}</div>
      {body}
      <details className="small"><summary>{T.row.storedValues}</summary><div className="audit-raw">
        <div><b>{T.row.before}</b><pre>{JSON.stringify(r.before, null, 1) || "—"}</pre></div>
        <div><b>{T.row.after}</b><pre>{JSON.stringify(r.after, null, 1) || "—"}</pre></div>
      </div></details>
    </div>
  );
}

function Detail({ d, onUndone }: { d: any; onUndone: () => void }) {
  const X = T.detail;
  const { api } = useData();
  const who = useWho();
  const [undone, setUndone] = useState(false);
  const first = d.rows[0];
  const sources = first.sources || (d.rows.find((r: any) => r.sources) || {}).sources;
  const reasons = [...new Set<string>(d.rows.map((r: any) => r.reason).filter(Boolean))];
  const undoable = d.batch && !d.rows.some((r: any) => r.op === "revert") && d.rows.some((r: any) => ["person", "family", "source", "config", "finding"].includes(r.type));
  async function undo() {
    if (!confirm(T.detail.confirmUndo)) return;
    try { await api("POST", `changes/${encodeURIComponent(d.batch)}/revert`, {}); setUndone(true); onUndone(); }
    catch (e) { alert((e as Error).message); }
  }
  return (
    <div className="audit-detail">
      <dl className="audit-meta small">
        <dt>{X.when}</dt><dd>{X.utc(fmt(first.at))}</dd>
        <dt>{X.who}</dt><dd>{who(first.actor)}{first.actor_kind === "agent" ? X.agent : ""}{first.on_behalf_of ? X.onBehalfOf(who(first.on_behalf_of)) : ""}</dd>
        {first.via && <><dt>{X.via}</dt><dd>{/^run-/.test(first.via) ? <Link to="/research/agents">{X.agentRun(first.via)}</Link> : first.via}</dd></>}
        {d.batch && <><dt>{X.editId}</dt><dd><code>{d.batch}</code></dd></>}
        {reasons.length > 0 && <><dt>{X.why}</dt><dd>{reasons.map((x, i) => <Fragment key={i}>{i > 0 && <br />}{x}</Fragment>)}</dd></>}
        {(sources || []).length > 0 && <><dt>{X.sources}</dt><dd>{sources.map((s: any, i: number) => <Fragment key={i}>{i > 0 && "; "}{s.url ? <a href={s.url} target="_blank" rel="noopener">{s.title || s.url}</a> : s.title || ""}</Fragment>)}</dd></>}
        {d.proposals.map((p: any) => <Fragment key={`p${p.id}`}><dt>{X.suggestion}</dt><dd><Link to="/research/queue">#{p.id}</Link>{X.suggestionBy(p.kind, who(p.author), p.status)}{p.reviewed_by ? X.reviewedBy(who(p.reviewed_by)) : ""}{p.rationale && <><br /><span className="muted">{p.rationale.slice(0, 300)}</span></>}</dd></Fragment>)}
        {d.runs.map((r: any, i: number) => <Fragment key={`r${i}`}><dt>{X.run}</dt><dd>{X.runBy(r.kind || X.runKind, who(r.started_by), r.instructions, r.status)}</dd></Fragment>)}
      </dl>
      <div>{d.rows.map((r: any, i: number) => <RowDetail key={i} r={r} />)}</div>
      {undoable && <p>{undone ? <span className="small">{X.undone}</span>
        : <><button className="btn" data-undo={d.batch} onClick={undo}>{X.undo}</button> <span className="small muted">{X.undoHelp}</span></>}</p>}
    </div>
  );
}

function Batch({ b, open, onToggle, onUndone }: { b: any; open: boolean; onToggle: () => void; onUndone: () => void }) {
  const { api } = useData();
  const who = useWho();
  const [d, setD] = useState<{ data?: any; error?: string } | null>(null);
  useEffect(() => {
    if (!open) { setD(null); return; }
    let live = true;
    api("GET", `admin/audit/${encodeURIComponent(b.key)}`).then((data) => live && setD({ data }), (e) => live && setD({ error: e.message }));
    return () => { live = false; };
  }, [open, api, b.key]);
  const click = (ev: MouseEvent) => { if (!(ev.target as HTMLElement).closest("a")) onToggle(); };
  const key = (ev: KeyboardEvent) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onToggle(); } };
  return (
    <>
      <tr className={`audit-row${open ? " open" : ""}`} data-key={b.key} tabIndex={0} aria-expanded={open} onClick={click} onKeyDown={key}>
        <td className="small nowrap">{fmt(b.at)}</td>
        <td className="small">{who(b.actor)}{b.on_behalf_of && <><br /><span className="muted">{T.forWhom(who(b.on_behalf_of))}</span></>}</td>
        <td><Summary b={b} /></td>
        <td className="small">{(b.reason || "").slice(0, 160)}{(b.reason || "").length > 160 ? "…" : ""}</td>
        <td className="small muted audit-caret" aria-hidden="true">{open ? "▾" : "▸"}</td>
      </tr>
      {open && <tr className="audit-detail-row"><td colSpan={5}>
        {!d ? <p className="small muted">{T.loading}</p> : d.error ? <p className="small">{d.error}</p> : <Detail d={d.data} onUndone={onUndone} />}
      </td></tr>}
    </>
  );
}

export function Audit() {
  const linkedQuery = useSearchParams()[0].get("q") || "";
  const { api } = useData();
  const who = useWho();
  const [st, setSt] = useState<{ actor: string; type: string; q: string; rows: any[]; next: any; actors: any[]; types: any[] }>({ actor: "", type: "", q: linkedQuery, rows: [], next: null, actors: [], types: [] });
  const [loaded, setLoaded] = useState(false), [error, setError] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set(linkedQuery ? [linkedQuery] : []));
  const alive = useRef(true);
  const stRef = useRef(st);
  stRef.current = st;

  const load = useCallback(async (reset: boolean, filters?: { actor: string; type: string; q: string }) => {
    const s = { ...stRef.current, ...(filters || {}) };
    const qs = new URLSearchParams({ limit: "40" });
    if (s.actor) qs.set("actor", s.actor);
    if (s.type) qs.set("type", s.type);
    if (s.q) qs.set("q", s.q);
    if (!reset && s.next) qs.set("before", String(s.next));
    try {
      const r = await api("GET", `admin/audit?${qs}`);
      if (!alive.current) return;
      setSt((x) => ({ ...x, ...(filters || {}), actors: r.actors || x.actors, types: r.types || x.types, rows: reset ? r.batches : [...x.rows, ...r.batches], next: r.next }));
      setError(""); setLoaded(true);
    } catch (e) { if (alive.current) setError((e as Error).message); }
  }, [api]);
  useEffect(() => { alive.current = true; load(true); return () => { alive.current = false; }; }, [load]);

  function filter(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const f = ev.currentTarget.elements as any;
    setOpen(new Set());
    load(true, { actor: f.actor.value, type: f.type.value, q: f.q.value.trim() });
  }
  const toggle = (k: string) => setOpen((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  if (error) return <div id="audit"><div className="empty">{error}</div></div>;
  if (!loaded) return <div id="audit"><p className="muted">{T.loading}</p></div>;
  const F = T.filters, C = T.columns;
  return (
    <div id="audit">
      <form className="filters" id="au-f" onSubmit={filter}>
        <select name="actor" aria-label={F.who} defaultValue={st.actor}><option value="">{F.anyone}</option>{st.actors.map((a) => <option key={a.v} value={a.v}>{who(a.v)} ({a.n})</option>)}</select>
        <select name="type" aria-label={F.what} defaultValue={st.type}><option value="">{F.anyRecord}</option>{st.types.map((t) => <option key={t.v} value={t.v}>{typeName(t.v, 2)} ({t.n})</option>)}</select>
        <input name="q" type="search" placeholder={F.search} defaultValue={st.q} style={{ flex: 1, minWidth: 180 }} /><button className="btn">{F.submit}</button>
      </form>
      {st.rows.length ? (
        <div className="table-wrap"><table className="data stack audit"><thead><tr><th>{C.when}</th><th>{C.who}</th><th>{C.what}</th><th>{C.why}</th><th></th></tr></thead>
          <tbody>{st.rows.map((b) => <Batch key={b.key} b={b} open={open.has(b.key)} onToggle={() => toggle(b.key)} onUndone={() => load(true)} />)}</tbody></table></div>
      ) : <div className="empty">{T.noMatch}</div>}
      {st.next && <p><button className="btn" id="au-more" onClick={() => load(false)}>{T.loadOlder}</button></p>}
    </div>
  );
}
