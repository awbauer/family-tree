// The working half of the person page (live API only): how are we related, the editor with its pending changes,
// the discussion, the history and the cloud research agent.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useData } from "../../data";
import { PersonLink, isUnknown } from "../../lib";
import { Diff, MEDIA_TYPES, OpText, stripImage } from "../../ops";
import { useWho } from "../../ui";
import { reloadPage, usePerson } from "./context";
import { PathChain } from "./Graph";

const pickId = (v: string | undefined | null) => (String(v || "").match(/\(([^)]+)\)\s*$/) || [])[1] || null;
type F = HTMLFormElement;
const el = (f: F, k: string) => f.elements.namedItem(k) as HTMLInputElement | null;
const val = (f: F, k: string) => (el(f, k)?.value) || "";

export function Work() {
  const { ai, people } = useData();
  const { p } = usePerson();
  return (
    <div className="work-grid">
      <Related />
      <Editor />
      <Comments />
      <History />
      {ai && !p.living && <AiResearch />}
      <datalist id="w-people">{people.filter((x) => !isUnknown(x)).map((x) => <option key={x.id} value={`${x.name} (${x.id})`} />)}</datalist>
    </div>
  );
}

// ---------------------------------------------------------------- relationships
function Related() {
  const { D, account, api } = useData();
  const { id, p, setPath } = usePerson();
  const [out, setOut] = useState<ReactNode>(null);
  const rel = useCallback(async (to: string | null) => {
    try {
      const from = to ? id : (account && account.personId) || D.home;
      const target = to || id;
      if (from === target) { setOut(<p>That's you.</p>); return; }
      const r = await api("GET", `graph/path?from=${encodeURIComponent(from)}&to=${encodeURIComponent(target)}`);
      setOut(r.found ? <>
        <p><b>{r.label || ""}</b>{r.label ? " · " : ""}{r.sentence || ""}</p>
        <PathChain path={r} from={from} />
        {(r.commonAncestors || []).length > 0 && <p className="muted">Common ancestors: {r.commonAncestors.map((a: any, i: number) => <span key={i}>{i > 0 && ", "}<PersonLink id={a.id || a} /></span>)}</p>}
        <button className="linklike" id="w-rel-show" onClick={() => { setPath(r); document.getElementById("w-graph")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>show it in the family graph</button>
      </> : <p className="muted">No connection found among the people you can see.</p>);
    } catch (e: any) { setOut(<p className="muted">{e.message}</p>); }
  }, [id, account, D.home, api, setPath]);
  useEffect(() => { rel(null); }, [rel]);
  return (
    <section className="card" id="w-rel"><h2>How are we related?</h2>
      <form className="filters" id="w-rel-f" onSubmit={(ev) => { ev.preventDefault(); rel(pickId(val(ev.currentTarget, "to"))); }}>
        <input name="to" list="w-people" placeholder="Pick anyone (default: you)" style={{ flex: 1, minWidth: 200 }} /><button className="btn">Show</button>
        {D.me && account && account.personId !== id && <button type="button" className="btn" id="w-me" title="Link your account to this person" onClick={async () => {
          if (!confirm(`Link your account to ${p.name}? Relationships will then be shown relative to them.`)) return;
          try { await api("PUT", "me/person", { person_id: id }); reloadPage(); } catch (e: any) { alert(e.message); }
        }}>This is me</button>}
      </form>
      <div id="w-rel-out" className="small">{out}</div>
    </section>
  );
}

// ---------------------------------------------------------------- the editor
const EVENT_TYPES = ["Birth", "Baptism", "Christening", "Death", "Burial", "Marriage", "Residence", "Occupation", "Census", "Immigration", "Emigration", "Arrival", "Departure", "Naturalization", "Military", "Education", "Religion", "Event"];

function Editor() {
  const { editor } = useData();
  const { form, openForm, canEdit } = usePerson();
  const verb = canEdit ? "Edit" : "Suggest a change";
  const ACTIONS: [string, string][] = [["event", "Add or correct a fact"], ["name", "Add a name"], ["sex", "Sex"], ["parent", "Add a parent"], ["spouse", "Add a spouse"], ["child", "Add a child"], ["photo", "Add a photo or document"], ["merge", "Merge a duplicate into this person"], ...(editor ? [["review", "Review facts"] as [string, string]] : [])];
  return (
    <section className="card" id="w-edit"><h2>{verb}</h2>
      <p className="small muted">{canEdit ? "Changes are saved with a reason and appear in the history below; any change can be undone." : "Your suggestion goes to the editors for review."}</p>
      <div className="btn-row" id="w-actions">{ACTIONS.map(([k, l]) => <button key={k} className="btn" data-w={k} onClick={() => openForm(k)}>{l}</button>)}</div>
      <div id="w-form">{form && (form === "photo" ? <PhotoUpload key="photo" /> : <EditForm key={form} kind={form} />)}</div>
      <Pending />
    </section>
  );
}

function EditForm({ kind }: { kind: string }) {
  const { D } = useData();
  const { id, p, setPending, openForm } = usePerson();
  const tmpN = useRef(0);
  const F = D.families;
  const facts = (p.events || []).filter((e: any) => e.fid);
  /** The picked existing person, or a new one (its person.create op comes first). */
  const personOrNew = (f: HTMLFormElement): { pid: string; ops: any[] } => {
    const existing = pickId(val(f, "existing"));
    if (existing) return { pid: existing, ops: [] };
    const given = val(f, "given").trim(), surname = val(f, "surname").trim();
    if (!given && !surname) throw new Error("Pick an existing person, or give a name for a new one.");
    const tmp = `$n${++tmpN.current}`;
    return { pid: tmp, ops: [{ op: "person.create", id: tmp, names: [{ given, surname }], sex: val(f, "sex") || undefined, events: val(f, "born") ? [{ type: "Birth", date: val(f, "born") }] : [] }] };
  };
  const add = (...ops: any[]) => { setPending((cur) => [...cur, ...ops]); openForm(null); };
  const newPerson = <><input name="given" placeholder="Given names" /><input name="surname" placeholder="Surname" /><select name="sex" defaultValue=""><option value="">Sex?</option><option value="M">Male</option><option value="F">Female</option></select><input name="born" placeholder="Born (date)" style={{ maxWidth: 130 }} /></>;
  const existing = (ph = "Existing person…", w = 220, required = false) => <input name="existing" list="w-people" placeholder={ph} style={{ minWidth: w }} required={required} />;

  let fields: ReactNode, submit: (f: HTMLFormElement) => void;
  switch (kind) {
    case "event":
      fields = <>
        <select name="fid" defaultValue=""><option value="">New fact</option>{facts.map((e: any) => <option key={e.fid} value={e.fid}>Correct: {e.type} {e.date || ""} {e.place || ""}</option>)}</select>
        <select name="type">{EVENT_TYPES.map((t) => <option key={t}>{t}</option>)}</select><input name="date" placeholder="Date (e.g. 12 Sep 1891, abt 1890)" /><input name="place" placeholder="Place" /><input name="value" placeholder="Detail (occupation, etc.)" /><input name="note" placeholder="Note" /><label className="small"><input type="checkbox" name="remove" /> remove this fact</label>
      </>;
      submit = (f) => {
        const fid = val(f, "fid");
        if (fid && el(f, "remove")!.checked) return add({ op: "event.remove", entity: "person", id, fid });
        const ev = { type: val(f, "type"), date: val(f, "date") || undefined, place: val(f, "place") || undefined, value: val(f, "value") || undefined, note: val(f, "note") || undefined };
        if (fid) { const set = Object.fromEntries(Object.entries(ev).filter(([, v]) => v)); return add({ op: "event.update", entity: "person", id, fid, set }); }
        add({ op: "event.add", entity: "person", id, event: ev });
      };
      break;
    case "name":
      fields = <><input name="given" placeholder="Given names" /><input name="surname" placeholder="Surname" /><select name="type" defaultValue=""><option value="">Kind</option><option>birth</option><option>married</option><option>also known as</option><option>immigrant</option></select></>;
      submit = (f) => add({ op: "name.add", person: id, name: { given: val(f, "given"), surname: val(f, "surname"), type: val(f, "type") } });
      break;
    case "sex":
      fields = <select name="sex"><option value="M">Male</option><option value="F">Female</option><option value="U">Unknown</option></select>;
      submit = (f) => add({ op: "person.update", id, set: { sex: val(f, "sex") } });
      break;
    case "parent":
      fields = <>{existing()} or new: {newPerson}</>;
      submit = (f) => {
        const { pid, ops } = personOrNew(f);
        const sex = pid.startsWith("$") ? val(f, "sex") : (D.people[pid] || ({} as any)).sex;
        const role = sex === "F" ? "wife" : "husband";
        const fam = (p.famc || [])[0];
        if (fam && !(F[fam] as any)[role]) add(...ops, { op: "family.set_spouse", family: fam, role, person: pid });
        else if (fam) throw new Error(`This person already has a ${role === "wife" ? "mother" : "father"} recorded. Correct that first.`);
        else add(...ops, { op: "family.create", [role]: pid, children: [id] });
      };
      break;
    case "spouse":
      fields = <>{existing()} or new: {newPerson}<input name="married" placeholder="Married (date)" style={{ maxWidth: 140 }} /></>;
      submit = (f) => {
        const { pid, ops } = personOrNew(f);
        const meH = p.sex !== "F";
        add(...ops, { op: "family.create", husband: meH ? id : pid, wife: meH ? pid : id, events: val(f, "married") ? [{ type: "Marriage", date: val(f, "married") }] : [] });
      };
      break;
    case "child":
      fields = <>
        <select name="fam">{(p.fams || []).map((fid: string) => { const fm = F[fid]; const sp = fm.husband === id ? fm.wife : fm.husband; return <option key={fid} value={fid}>with {sp && D.people[sp] ? D.people[sp].name : "unknown partner"}</option>; })}<option value="">with an unknown partner (new family)</option></select>
        {existing()} or new: {newPerson}
      </>;
      submit = (f) => {
        const { pid, ops } = personOrNew(f);
        if (val(f, "fam")) add(...ops, { op: "family.add_child", family: val(f, "fam"), person: pid });
        else add(...ops, { op: "family.create", [p.sex === "F" ? "wife" : "husband"]: id, children: [pid] });
      };
      break;
    case "merge":
      fields = existing("The duplicate…", 260, true);
      submit = (f) => {
        const d = pickId(val(f, "existing"));
        if (!d || d === id) throw new Error("Pick the duplicate person.");
        if (!confirm(`Merge ${D.people[d].name} into ${p.name}? Their names, facts and family links move here, and the duplicate is removed.`)) return;
        add({ op: "person.merge", keep: id, drop: d });
      };
      break;
    case "review":
      fields = <>
        <select name="fid">{facts.map((e: any) => <option key={e.fid} value={e.fid}>{e.type} {e.date || ""} {e.place || ""}{e.review ? ` · ${e.review.status}` : ""}</option>)}</select>
        <select name="status"><option value="verified">Verified</option><option value="disputed">Disputed</option><option value="unverified">Unverified</option></select><input name="note" placeholder="How you checked" style={{ flex: 1 }} /><input name="url" placeholder="Record link (optional)" />
      </>;
      submit = (f) => {
        const fid = val(f, "fid"), note = val(f, "note");
        const ops: any[] = [];
        if (val(f, "url")) ops.push({ op: "citation.add", entity: "person", id, fid, citation: { url: val(f, "url"), note: note || undefined } });
        add(...ops, { op: "fact.review", entity: "person", id, fid, status: val(f, "status"), note });
      };
      break;
    default: return null;
  }
  return (
    <form className="card sub filters" onSubmit={(ev) => { ev.preventDefault(); try { submit(ev.currentTarget); } catch (e: any) { alert(e.message); } }}>
      {fields}<button className="btn primary">Add to list</button><button type="button" className="btn" data-cancel onClick={() => openForm(null)}>Cancel</button>
    </form>
  );
}

function PhotoUpload() {
  const { tree } = useData();
  const { id, setPending, openForm } = usePerson();
  return <>
    <form className="card sub filters" onSubmit={async (ev) => {
      ev.preventDefault();
      const f = ev.currentTarget, file = await stripImage(el(f, "file")!.files![0]);
      try {
        const r = await fetch(`api/media/upload?tree=${encodeURIComponent(tree as string)}&name=${encodeURIComponent(file.name)}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": file.type }, body: file });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || `Upload failed (${r.status})`);
        setPending((cur) => [...cur, { op: "media.attach", person: id, file: d.key, caption: val(f, "caption") || undefined, type: val(f, "type") || undefined, date: val(f, "date") || undefined, place: val(f, "place") || undefined, portrait: el(f, "portrait")!.checked || undefined }]);
        openForm(null);
      } catch (e: any) { alert(e.message); }
    }}>
      <input type="file" name="file" accept="image/jpeg,image/png,image/webp,application/pdf" required /><input name="caption" placeholder="Caption: who and what" style={{ flex: 1, minWidth: 200 }} />
      <select name="type">{Object.entries(MEDIA_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      <input name="date" placeholder="Date taken" style={{ maxWidth: 130 }} /><input name="place" placeholder="Place" style={{ maxWidth: 180 }} />
      <label className="small"><input type="checkbox" name="portrait" /> main photo</label><button className="btn primary">Upload</button>
    </form>
    <p className="small muted">Location and camera data are removed from photos in your browser before upload.</p>
  </>;
}

/** The pending changes, previewed as a diff of the records they touch, saved together with a reason. */
function Pending() {
  const { api } = useData();
  const { pending, setPending, meta, reason, setReason, src, setSrc, scrollTick, canEdit } = usePerson();
  const [diff, setDiff] = useState<{ touched?: any[]; error?: string } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { if (scrollTick) box.current?.scrollIntoView({ behavior: "smooth", block: "center" }); }, [scrollTick]);
  useEffect(() => {
    if (!pending.length) return;
    let current = true;
    setDiff(null);
    api("POST", "edit/preview", { ops: pending }).then((r) => { if (current) setDiff({ touched: r.touched }); }, (e) => { if (current) setDiff({ error: e.message }); });
    return () => { current = false; };
  }, [pending, api]);
  if (!pending.length) return <div id="w-pending" ref={box}></div>;
  return (
    <div id="w-pending" ref={box}>
      <div className="pending"><h3>{pending.length} change{pending.length > 1 ? "s" : ""} to {canEdit ? "save" : "suggest"}</h3>
        <ol>{pending.map((o, i) => <li key={i}><OpText o={o} /> <button className="linklike" data-undo={i} onClick={() => setPending((cur) => cur.filter((_, j) => j !== i))}>remove</button></li>)}</ol>
        {meta.resolves.size > 0 && <p className="small">Resolves finding {[...meta.resolves].map((x) => `#${x}`).join(", ")}.</p>}
        <details open><summary className="small">What will change</summary>
          <div id="w-diff" className="small muted">{!diff ? "Working out the differences…" : diff.error ? <span className="sev-error">This can't be applied: {diff.error}</span> : <Diff changes={diff.touched} />}</div></details>
        <form id="w-save" className="filters" onSubmit={async (ev) => {
          ev.preventDefault();
          const sources = src.title || src.url ? [{ title: src.title || src.url, url: src.url || undefined }, ...meta.sources.slice(1)] : meta.sources.length ? meta.sources : undefined;
          const resolves = meta.resolves.size ? [...meta.resolves] : undefined;
          try {
            if (canEdit) await api("POST", "edit", { reason, sources, ops: pending, resolves });
            else await api("POST", "proposals", { kind: "edit", payload: { reason, sources, ops: pending, resolves }, rationale: reason });
            if (!canEdit) alert("Thanks. Your suggestion is waiting for an editor.");
            reloadPage();
          } catch (e: any) { alert(e.status === 409 ? "Someone else changed this person meanwhile. Reload and try again." : e.message); }
        }}>
          <input name="reason" required placeholder="Why? What's the evidence?" value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: 2, minWidth: 220 }} />
          <input name="src" placeholder="Source title (optional)" value={src.title} onChange={(e) => setSrc({ ...src, title: e.target.value })} style={{ flex: 1, minWidth: 160 }} />
          <input name="url" placeholder="Link (optional)" value={src.url} onChange={(e) => setSrc({ ...src, url: e.target.value })} style={{ flex: 1, minWidth: 160 }} />
          <button className="btn primary">{canEdit ? "Save changes" : "Send suggestion"}</button>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- comments
function Comments() {
  const { D, editor, api } = useData();
  const { id, p, commentBox } = usePerson();
  const who = useWho();
  const [state, setState] = useState<{ comments?: any[]; error?: string }>({});
  const load = useCallback(async () => {
    try { setState({ comments: (await api("GET", `comments?type=person&id=${encodeURIComponent(id)}`)).comments }); }
    catch (e: any) { setState({ error: e.message }); }
  }, [api, id]);
  useEffect(() => { load(); }, [load]);
  const factName = (fid: string) => { const e = (p.events || []).find((x: any) => x.fid === fid); return e ? `${e.type} ${e.dateDisplay || e.date || ""}` : fid; };
  return (
    <section className="card" id="w-comments"><h2>Discussion</h2>
      <div id="w-c-out" className="small">
        {state.error ? <p className="muted">{state.error}</p> : !state.comments ? null : state.comments.length ? state.comments.map((m) => (
          <div key={m.id} className={`comment${m.resolved_at ? " resolved" : ""}`}><span className="muted">{who(m.author)} · {m.created_at.slice(0, 10)}{m.fid ? ` · on ${factName(m.fid)}` : ""}</span><div>{m.body}</div>
            {!m.resolved_at && (editor || (D.me && m.author === D.me.principal)) ? <button className="linklike" data-resolve={m.id} onClick={async () => { try { await api("POST", `comments/${m.id}/resolve`); } catch (e: any) { alert(e.message); } load(); }}>resolve</button> : m.resolved_at ? <span className="muted">resolved</span> : null}</div>
        )) : <p className="muted">No comments yet.</p>}
      </div>
      <form id="w-c-f" className="filters" style={{ marginTop: 8 }} onSubmit={async (ev) => {
        ev.preventDefault();
        const f = ev.currentTarget;
        try { await api("POST", "comments", { type: "person", id, fid: val(f, "fid") || undefined, body: val(f, "body") }); f.reset(); load(); } catch (e: any) { alert(e.message); }
      }}>
        <select name="fid" defaultValue=""><option value="">About this person</option>{(p.events || []).filter((e: any) => e.fid).map((e: any) => <option key={e.fid} value={e.fid}>{e.type} {e.dateDisplay || e.date || ""}</option>)}</select>
        <input name="body" ref={commentBox} placeholder="Add a comment, a memory, a question…" style={{ flex: 1, minWidth: 200 }} /><button className="btn">Post</button>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------- history
const OPS: Record<string, string> = { edit: "edited", revert: "undid a change", resolve: "resolved a finding", dismissed: "kept the tree as is", reopen: "reopened a finding", set: "set the research status", import: "imported" };
function History() {
  const { editor, api } = useData();
  const { id } = usePerson();
  const who = useWho();
  const [state, setState] = useState<{ history?: any[]; error?: string }>({});
  useEffect(() => {
    let live = true;
    api("GET", `history?id=${encodeURIComponent(id)}`).then((r) => live && setState({ history: r.history }), (e) => live && setState({ error: e.message }));
    return () => { live = false; };
  }, [api, id]);
  const h = state.history;
  return (
    <section className="card" id="w-history"><h2>History</h2>
      <div id="w-h-out" className="small">
        {state.error ? <p className="muted">{state.error}</p> : !h ? <p className="muted">Loading…</p> : h.length ? <ul className="history">{h.map((b, i) => (
          <li key={i}><div><span className="muted">{b.at.slice(0, 16).replace("T", " ")} · {who(b.actor)}{b.on_behalf_of ? ` on behalf of ${who(b.on_behalf_of)}` : ""}{b.proposal ? ` · suggestion #${b.proposal}` : ""}</span> <b>{OPS[b.op] || b.op}</b>{b.reason ? `: ${b.reason}` : ""}
            {editor && b.batch && b.op !== "revert" && b.op !== "import" && <> <button className="linklike" data-revert={b.batch} onClick={async () => {
              if (!confirm("Undo this change?")) return;
              try { await api("POST", `changes/${b.batch}/revert`); reloadPage(); }
              catch (e: any) { alert(e.status === 409 ? "Later changes touched the same records. Undo those first." : e.message); }
            }}>undo</button></>}</div>
            <details><summary className="small">details</summary>{b.entities.some((e: any) => e.before !== undefined || e.after !== undefined)
              ? <Diff changes={b.entities.map((e: any) => ({ type: e.type, id: e.id, before: e.before, after: e.after }))} />
              : <span className="muted">({b.entities.map((e: any) => `${e.change} ${e.type}`).join(", ")})</span>}</details></li>
        ))}</ul> : <p className="muted">No changes since the import.</p>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- cloud research runs for this person
const STATE: Record<string, string> = { queued: "queued", running: "running", succeeded: "done", failed: "failed", cancelled: "stopped" };
function AiResearch() {
  const { api } = useData();
  const { id, p } = usePerson();
  const [state, setState] = useState<{ runs?: any[]; error?: string }>({});
  const load = useCallback(async () => {
    try { setState({ runs: (await api("GET", `agent/runs?person=${encodeURIComponent(id)}`)).runs }); } catch (e: any) { setState({ error: e.message }); }
  }, [api, id]);
  useEffect(() => { load(); }, [load]);
  return (
    <section className="card" id="w-ai"><h2>Research with AI</h2>
      <p className="small muted">A cloud research agent searches and reads the web for {p.name} and files what it finds as a suggestion for review. It never changes the tree itself.</p>
      <form id="w-ai-f" className="filters" onSubmit={async (ev) => {
        ev.preventDefault();
        const f = ev.currentTarget;
        try { await api("POST", "agent/runs", { person: id, instructions: val(f, "instructions") || undefined }); f.reset(); load(); } catch (e: any) { alert(e.message); }
      }}><input name="instructions" placeholder="What should it look for? (optional)" style={{ flex: 1, minWidth: 220 }} /><button className="btn primary">Start</button></form>
      <div id="w-ai-out" className="small">{state.error ? state.error : state.runs && state.runs.length > 0 && <>
        <ul>{state.runs.slice(0, 5).map((r, i) => <li key={i}>{r.created_at.slice(0, 10)} · {STATE[r.status]}{r.proposals.length > 0 && <> · <Link to="/research/queue">suggestion #{r.proposals.join(", #")}</Link></>}{r.error && <> · <span className="muted">{r.error}</span></>}</li>)}</ul>
        <Link to="/research/agents">All runs →</Link></>}</div>
    </section>
  );
}
