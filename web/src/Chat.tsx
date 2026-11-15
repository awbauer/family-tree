// The page assistant: a chat panel on every page, for editors when the agents is set up.
// Each message carries the page you're on. The assistant drafts changes; each shows as a card with exactly what would
// change, and nothing happens until you press Apply. Holds no family data: everything comes from /api.
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { ApiError, store, useData } from "./data";
import { Diff, OpText } from "./ops";
import type { Tree } from "./types";
import { S } from "../../strings/index.ts";

const POLL_MS = 1000;
const T = S.common.chat;
const TOOL: Record<string, string> = T.tools;
const HEAD: Record<string, string> = T.heads;

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
  const panel = useRef<HTMLElement>(null);

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
      next = { messages: lost ? [...cur.messages.filter((m) => m.role === "user"), { role: "notice", text: T.noReply }] : r.messages, changes: r.changes, busy: r.busy };
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 404 || err.status === 403) { chatId.current = null; store.set(key, null); next = EMPTY; }
      else next = { ...stateRef.current, messages: [...stateRef.current.messages, { role: "notice", text: T.unreachable(err.message) }] };
    }
    setState(next);
    if (next.busy && openRef.current) timer.current = window.setTimeout(load, POLL_MS);
  }, [api, key]);

  useEffect(() => {
    store.set("chat:open", open ? "1" : null, sessionStorage);
    if (open) { ta.current?.focus(); load(); } else clearTimeout(timer.current);
    return () => clearTimeout(timer.current);
  }, [open, load]);

  // on phones the panel is a full-screen sheet: keep it to the part of the screen the on-screen keyboard leaves
  // visible, and stop the page behind it from scrolling
  useEffect(() => {
    if (!open) return;
    const root = document.documentElement, vv = window.visualViewport;
    root.classList.add("chat-open");
    const fit = () => {
      const el = panel.current;
      if (!el || !vv) return;
      el.style.setProperty("--chat-top", `${vv.offsetTop}px`);
      el.style.setProperty("--chat-h", `${vv.height}px`);
      if (stick.current && log.current) log.current.scrollTop = log.current.scrollHeight;
    };
    fit();
    vv?.addEventListener("resize", fit);
    vv?.addEventListener("scroll", fit);
    return () => { root.classList.remove("chat-open"); vv?.removeEventListener("resize", fit); vv?.removeEventListener("scroll", fit); };
  }, [open]);

  // work out what each pending draft would change
  useEffect(() => {
    for (const ch of state.changes) {
      if (ch.status !== "pending" || asked.current.has(ch.id)) continue;
      asked.current.add(ch.id);
      api<{ touched: any[] }>("POST", "edit/preview", { ops: ch.ops }).then(
        (r) => setPreviews((p) => ({ ...p, [ch.id]: <Diff changes={r.touched} /> })),
        (e) => setPreviews((p) => ({ ...p, [ch.id]: <><span className="sev-error">{T.cantApply(e.message)}</span><ol>{ch.ops.map((o, i) => <li key={i}><OpText o={o} /></li>)}</ol></> })),
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
        <div className="small muted">{T.why}<LinkIds text={ch.reason || ""} D={D} />
          {(ch.sources || []).length > 0 && <><br />{T.source}{(ch.sources || []).map((s, i) => <Fragment key={i}>{i > 0 && " · "}{s.url ? <a href={s.url} target="_blank" rel="noopener">{s.title || s.url}</a> : s.title}</Fragment>)}</>}</div>
        {st === "pending" && <div className="chat-diff small">{previews[ch.id] ?? <span className="muted">{T.working}</span>}</div>}
        {ch.error && <div className="small sev-error">{ch.error}</div>}
        {st === "pending" && <div className="btn-row"><button className="btn primary" disabled={off} onClick={() => decide(ch.id, "apply")}>{T.apply}</button><button className="btn" disabled={off} onClick={() => decide(ch.id, "dismiss")}>{T.dismiss}</button></div>}
        {st === "applied" && <div className="btn-row"><button className="btn" disabled={off} onClick={() => decide(ch.id, "undo")}>{T.undo}</button></div>}
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

  if (!open) return <button type="button" className="chat-fab" aria-label={T.askLabel} onClick={() => setOpen(true)}><span aria-hidden="true">✦</span> {T.ask}</button>;
  return (
    <section className="chat-panel" aria-label={T.title} ref={panel}>
      <header className="chat-head">
        <b>{T.title}</b>
        <span className="small muted chat-where">{here ? T.on(here.name) : ""}</span>
        <button type="button" className="icon-btn chat-new" title={T.newTitle} onClick={() => { chatId.current = null; store.set(key, null); load(); ta.current?.focus(); }}>{T.new}</button>
        <button type="button" className="icon-btn chat-close" aria-label={T.close} onClick={() => setOpen(false)}>✕</button>
      </header>
      <div className="chat-log" aria-live="polite" ref={log} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}>
        {items}
        {state.busy && <div className="chat-typing small muted" aria-label={T.replying}><span></span><span></span><span></span></div>}
        {!items.length && !state.busy && (
          <div className="chat-empty small muted"><p>{T.empty.intro}</p>
            <ul>{T.empty.examples.map((x) => <li key={x}>{x}</li>)}</ul>
            <p>{T.empty.outro}</p></div>
        )}
      </div>
      <form className="chat-form" onSubmit={(ev) => { ev.preventDefault(); const text = draft.trim(); if (text && !state.busy && !sending.current) send(text); }}>
        <textarea ref={ta} name="text" rows={2} placeholder={T.placeholder} aria-label={T.message} value={draft}
          onChange={(e) => { setDraft(e.target.value); store.set(`${key}:draft`, e.target.value || null, sessionStorage); }}
          onKeyDown={(ev) => {
            if (ev.key === "Enter" && !ev.shiftKey && !ev.nativeEvent.isComposing) { ev.preventDefault(); ev.currentTarget.form?.requestSubmit(); }
            if (ev.key === "Escape") setOpen(false);
          }} />
        <div className="chat-actions">
          <span className="small muted">{T.waits}</span>
          {state.busy ? <button type="button" className="btn chat-stop" onClick={() => chatId.current && api("POST", `chat/${chatId.current}/abort`, {}).then(load, load)}>{T.stop}</button>
            : <button className="btn primary chat-send">{T.send}</button>}
        </div>
      </form>
    </section>
  );
}
