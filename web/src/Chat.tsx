// The page assistant: a chat panel on every page, for editors when the agents Worker is set up.
// Each message carries the page you're on. The assistant drafts changes; each shows as a card with exactly what would
// change, and nothing happens until you press Apply. Holds no family data: everything comes from /api.
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { ApiError, store, useData } from "./data";
import { Diff, OpText } from "./ops";
import type { Tree } from "./types";

const POLL_MS = 1000;
const TOOL: Record<string, string> = { get_person: "Read", search_people: "Searched for", relationship_path: "Traced", person_history: "Read the history of", propose_change: "Drafted a change" };
const HEAD: Record<string, string> = { pending: "Proposed change", applied: "Applied", dismissed: "Dismissed", superseded: "Replaced by a newer draft", failed: "Couldn't apply", undone: "Undone" };

interface Change { id: number; status: string; summary: string; reason: string; sources?: { title?: string; url?: string }[]; ops: any[]; error?: string }
interface Msg { role: "user" | "assistant" | "notice"; text?: string; parts?: any[] }
interface State { messages: Msg[]; changes: Change[]; busy: boolean }
const EMPTY: State = { messages: [], changes: [], busy: false };

/** Person IDs (I12) in text become links to their page. */
function LinkIds({ text, D }: { text: string; D: Tree }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/\b(I\d+)\b/g)) {
    if (!D.people[m[1]]) continue;
    out.push(text.slice(last, m.index), <Link key={m.index} to={`/person/${m[1]}`}>{m[1]}</Link>);
    last = m.index! + m[0].length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}
/** **bold**, *italic* and `code`, with person IDs linked. */
function Inline({ text, D }: { text: string; D: Tree }) {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|(^|[^*])\*([^*\n]+)\*|`([^`]+)`/g;
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(text))) {
    const start = m.index + (m[2] != null ? m[2].length : 0);
    out.push(<LinkIds key={k++} text={text.slice(last, start)} D={D} />);
    if (m[1] != null) out.push(<b key={k++}><LinkIds text={m[1]} D={D} /></b>);
    else if (m[3] != null) out.push(<i key={k++}><LinkIds text={m[3]} D={D} /></i>);
    else out.push(<code key={k++}>{m[4]}</code>);
    last = m.index + m[0].length;
  }
  out.push(<LinkIds key={k} text={text.slice(last)} D={D} />);
  return <>{out}</>;
}
/** A little markdown: paragraphs, line breaks and simple lists. */
function Md({ text, D }: { text: string; D: Tree }) {
  return <>{String(text || "").split(/\n{2,}/).map((b, i) => {
    const lines = b.split("\n");
    if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l))) return <ul key={i}>{lines.map((l, j) => <li key={j}><Inline text={l.replace(/^\s*([-*]|\d+\.)\s+/, "")} D={D} /></li>)}</ul>;
    return <p key={i}>{lines.map((l, j) => <Fragment key={j}>{j > 0 && <br />}<Inline text={l} D={D} /></Fragment>)}</p>;
  })}</>;
}

export function Chat() {
  const { D, ai, live, api, tree } = useData();
  if (!ai || !live || D.previewView) return null;
  return <ChatPanel key={tree || ""} D={D} api={api} tree={tree} />;
}

function ChatPanel({ D, api, tree }: { D: Tree; api: ReturnType<typeof useData>["api"]; tree: string | null }) {
  const key = `chat:${tree || ""}`;
  const loc = useLocation();
  const [open, setOpen] = useState(() => !!store.get("chat:open", sessionStorage));
  const [state, setState] = useState<State>(EMPTY);
  const [previews, setPreviews] = useState<Record<number, ReactNode>>({});
  const [draft, setDraft] = useState(() => store.get(`${key}:draft`, sessionStorage) || "");
  const [deciding, setDeciding] = useState<number | null>(null);
  const chatId = useRef<string | null>(store.get(key));
  const stateRef = useRef(state); stateRef.current = state;
  const sending = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const openRef = useRef(open); openRef.current = open;
  const asked = useRef(new Set<number>());
  const log = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);

  const note = (text: string) => setState((s) => ({ ...s, messages: [...s.messages, { role: "notice", text }] }));

  const load = useCallback(async () => {
    clearTimeout(timer.current);
    if (!chatId.current) { setState(EMPTY); return; }
    let next: State = stateRef.current;
    try {
      const r = await api<State>("GET", `chat/${chatId.current}`);
      const cur = stateRef.current;
      // never let a reply that went missing wipe what the editor just sent
      const lost = !r.busy && cur.messages.length > r.messages.length && !r.messages.some((m) => m.role !== "user");
      next = { messages: lost ? [...cur.messages.filter((m) => m.role === "user"), { role: "notice", text: "The assistant didn't reply. Try again in a moment." }] : r.messages, changes: r.changes, busy: r.busy };
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 404 || err.status === 403) { chatId.current = null; store.set(key, null); next = EMPTY; }
      else next = { ...stateRef.current, messages: [...stateRef.current.messages, { role: "notice", text: `Couldn't reach the assistant: ${err.message}` }] };
    }
    setState(next);
    if (next.busy && openRef.current) timer.current = window.setTimeout(load, POLL_MS);
  }, [api, key]);

  useEffect(() => {
    store.set("chat:open", open ? "1" : null, sessionStorage);
    if (open) { ta.current?.focus(); load(); } else clearTimeout(timer.current);
    return () => clearTimeout(timer.current);
  }, [open, load]);

  // work out what each pending draft would change
  useEffect(() => {
    for (const ch of state.changes) {
      if (ch.status !== "pending" || asked.current.has(ch.id)) continue;
      asked.current.add(ch.id);
      api<{ touched: any[] }>("POST", "edit/preview", { ops: ch.ops }).then(
        (r) => setPreviews((p) => ({ ...p, [ch.id]: <Diff changes={r.touched} /> })),
        (e) => setPreviews((p) => ({ ...p, [ch.id]: <><span className="sev-error">This can't be applied as it stands: {e.message}</span><ol>{ch.ops.map((o, i) => <li key={i}><OpText o={o} /></li>)}</ol></> })),
      );
    }
  }, [state.changes, api]);

  // keep the log scrolled to the end unless the editor scrolled up
  useEffect(() => { const el = log.current; if (el && (stick.current || sending.current)) el.scrollTop = el.scrollHeight; });

  async function send(text: string) {
    sending.current = true;
    try {
      if (!chatId.current) { chatId.current = (await api<{ chat: { id: string } }>("POST", "chat", {})).chat.id; store.set(key, chatId.current); }
      setState((s) => ({ ...s, messages: [...s.messages, { role: "user", text }], busy: true }));
      const main = document.getElementById("app");
      await api("POST", `chat/${chatId.current}/messages`, { text, page: { path: location.hash.replace(/^#\/?/, ""), title: document.title, text: main ? main.innerText.slice(0, 4000) : "" } });
      setDraft(""); store.set(`${key}:draft`, null, sessionStorage);
    } catch (e) {
      setState((s) => ({ ...s, busy: false })); note((e as Error).message);
      return;
    } finally { sending.current = false; }
    timer.current = window.setTimeout(load, 400);
  }

  async function decide(id: number, action: "apply" | "dismiss" | "undo") {
    setDeciding(id);
    try {
      await api("POST", `chat/changes/${id}/${action}`, {});
      // the page's data was loaded before the change: reload it to show the result (the panel reopens as it was)
      if (action !== "dismiss") { location.reload(); return; }
    } catch (e) { note((e as Error).message); }
    setDeciding(null);
    await load();
    setTimeout(load, 1500); // the outcome goes to the assistant, which replies briefly
  }

  const m = loc.pathname.match(/^\/(person|tree)\/([^/?]+)/);
  const here = m && D.people[decodeURIComponent(m[2])];

  function changeCard(ch?: Change) {
    if (!ch) return null;
    const st = ch.status, off = deciding === ch.id;
    return (
      <div key={`c${ch.id}`} className={`chat-change st-${st}`} data-change={ch.id}>
        <div className="small chat-change-head"><b>{HEAD[st] || st}</b> <span className="muted">#{ch.id}</span></div>
        <div className="chat-change-sum"><LinkIds text={ch.summary || ""} D={D} /></div>
        <div className="small muted">Why: <LinkIds text={ch.reason || ""} D={D} />
          {(ch.sources || []).length > 0 && <><br />Source: {(ch.sources || []).map((s, i) => <Fragment key={i}>{i > 0 && " · "}{s.url ? <a href={s.url} target="_blank" rel="noopener">{s.title || s.url}</a> : s.title}</Fragment>)}</>}</div>
        {st === "pending" && <div className="chat-diff small">{previews[ch.id] ?? <span className="muted">Working out what would change…</span>}</div>}
        {ch.error && <div className="small sev-error">{ch.error}</div>}
        {st === "pending" && <div className="btn-row"><button className="btn primary" disabled={off} onClick={() => decide(ch.id, "apply")}>Apply</button><button className="btn" disabled={off} onClick={() => decide(ch.id, "dismiss")}>Dismiss</button></div>}
        {st === "applied" && <div className="btn-row"><button className="btn" disabled={off} onClick={() => decide(ch.id, "undo")}>Undo</button></div>}
      </div>
    );
  }

  const byId = Object.fromEntries(state.changes.map((x) => [x.id, x]));
  const shown = new Set<number>();
  const items: ReactNode[] = [];
  state.messages.forEach((msg, i) => {
    if (msg.role === "user") items.push(<div key={i} className="chat-msg me"><Md text={msg.text || ""} D={D} /></div>);
    else if (msg.role === "notice") items.push(<div key={i} className="chat-note small muted">{msg.text}</div>);
    else (msg.parts || []).forEach((p, j) => {
      const k = `${i}.${j}`;
      if (p.type === "text") items.push(<div key={k} className="chat-msg bot"><Md text={p.text} D={D} /></div>);
      else if (p.change) { shown.add(p.change); items.push(<Fragment key={k}>{changeCard(byId[p.change])}</Fragment>); }
      else items.push(<div key={k} className="chat-tool small muted">{p.state === "running" ? "…" : p.state === "error" ? "⚠" : "·"} {TOOL[p.tool] || p.tool}{p.about && <> <LinkIds text={p.about} D={D} /></>}</div>);
    });
  });
  // drafts whose message has scrolled out of the window still need an answer
  for (const ch of state.changes) if (!shown.has(ch.id) && ch.status === "pending") items.push(changeCard(ch));

  if (!open) return <button type="button" className="chat-fab" aria-label="Ask the assistant" onClick={() => setOpen(true)}><span aria-hidden="true">✦</span> Ask</button>;
  return (
    <section className="chat-panel" aria-label="Assistant">
      <header className="chat-head">
        <b>Assistant</b>
        <span className="small muted chat-where">{here ? `· on ${here.name}` : ""}</span>
        <button type="button" className="icon-btn chat-new" title="Start a new conversation" onClick={() => { chatId.current = null; store.set(key, null); load(); ta.current?.focus(); }}>New</button>
        <button type="button" className="icon-btn chat-close" aria-label="Close" onClick={() => setOpen(false)}>✕</button>
      </header>
      <div className="chat-log" aria-live="polite" ref={log} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}>
        {items}
        {state.busy && <div className="chat-typing small muted" aria-label="The assistant is replying"><span></span><span></span><span></span></div>}
        {!items.length && !state.busy && (
          <div className="chat-empty small muted"><p>Ask about the page you're on, or describe something that needs updating. For example:</p>
            <ul><li>“What do we know about this person's parents?”</li><li>“She was a schoolteacher from about 1920; add that.”</li><li>“Make the second photo the main one.”</li></ul>
            <p>The assistant drafts changes; you check each one and press Apply.</p></div>
        )}
      </div>
      <form className="chat-form" onSubmit={(ev) => { ev.preventDefault(); const text = draft.trim(); if (text && !state.busy && !sending.current) send(text); }}>
        <textarea ref={ta} name="text" rows={2} placeholder="Ask about this page, or describe a change…" aria-label="Message" value={draft}
          onChange={(e) => { setDraft(e.target.value); store.set(`${key}:draft`, e.target.value || null, sessionStorage); }}
          onKeyDown={(ev) => {
            if (ev.key === "Enter" && !ev.shiftKey && !ev.nativeEvent.isComposing) { ev.preventDefault(); ev.currentTarget.form?.requestSubmit(); }
            if (ev.key === "Escape") setOpen(false);
          }} />
        <div className="chat-actions">
          <span className="small muted">Changes wait for your OK.</span>
          {state.busy ? <button type="button" className="btn chat-stop" onClick={() => chatId.current && api("POST", `chat/${chatId.current}/abort`, {}).then(load, load)}>Stop</button>
            : <button className="btn primary chat-send">Send</button>}
        </div>
      </form>
    </section>
  );
}
