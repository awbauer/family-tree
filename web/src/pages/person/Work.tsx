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
import { S } from "../../../../strings/index.ts";

const T = S.person.work;

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
      {ai && !p.living && <FindRelatives />}
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
      if (from === target) { setOut(<p>{T.related.thatsYou}</p>); return; }
      const r = await api("GET", `graph/path?from=${encodeURIComponent(from)}&to=${encodeURIComponent(target)}`);
      setOut(r.found ? <>
        <p><b>{r.label || ""}</b>{r.label ? " · " : ""}{r.sentence || ""}</p>
        <PathChain path={r} from={from} />
        {(r.commonAncestors || []).length > 0 && <p className="muted">{T.related.commonAncestors} {r.commonAncestors.map((a: any, i: number) => <span key={i}>{i > 0 && ", "}<PersonLink id={a.id || a} /></span>)}</p>}
        <button className="linklike" id="w-rel-show" onClick={() => { setPath(r); document.getElementById("w-graph")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>{T.related.showInGraph}</button>
      </> : <p className="muted">{T.related.noConnection}</p>);
    } catch (e: any) { setOut(<p className="muted">{e.message}</p>); }
  }, [id, account, D.home, api, setPath]);
  useEffect(() => { rel(null); }, [rel]);
  return (
    <section className="card" id="w-rel"><h2>{T.related.title}</h2>
      <form className="filters" id="w-rel-f" onSubmit={(ev) => { ev.preventDefault(); rel(pickId(val(ev.currentTarget, "to"))); }}>
        <input name="to" list="w-people" placeholder={T.related.pick} style={{ flex: 1, minWidth: 200 }} /><button className="btn">{T.related.show}</button>
        {D.me && account && account.personId !== id && <button type="button" className="btn" id="w-me" title={T.related.thisIsMeTitle} onClick={async () => {
          if (!confirm(T.related.thisIsMeConfirm(p.name))) return;
          try { await api("PUT", "me/person", { person_id: id }); reloadPage(); } catch (e: any) { alert(e.message); }
        }}>{T.related.thisIsMe}</button>}
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
  const verb = canEdit ? T.editor.edit : T.editor.suggest;
  const A = T.editor.actions;
  const ACTIONS: [string, string][] = [["event", A.event], ["name", A.name], ["sex", A.sex], ["parent", A.parent], ["spouse", A.spouse], ["child", A.child], ["photo", A.photo], ["merge", A.merge], ...(editor ? [["review", A.review] as [string, string]] : [])];
  return (
    <section className="card" id="w-edit"><h2>{verb}</h2>
      <p className="small muted">{canEdit ? T.editor.editorHelp : T.editor.memberHelp}</p>
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
    if (!given && !surname) throw new Error(T.form.needPerson);
    const tmp = `$n${++tmpN.current}`;
    return { pid: tmp, ops: [{ op: "person.create", id: tmp, names: [{ given, surname }], sex: val(f, "sex") || undefined, events: val(f, "born") ? [{ type: "Birth", date: val(f, "born") }] : [] }] };
  };
  const add = (...ops: any[]) => { setPending((cur) => [...cur, ...ops]); openForm(null); };
  const newPerson = <><input name="given" placeholder={T.form.given} /><input name="surname" placeholder={T.form.surname} /><select name="sex" defaultValue=""><option value="">{T.form.sexBlank}</option><option value="M">{T.form.male}</option><option value="F">{T.form.female}</option></select><input name="born" placeholder={T.form.born} style={{ maxWidth: 130 }} /></>;
  const existing = (ph: string = T.form.existing, w = 220, required = false) => <input name="existing" list="w-people" placeholder={ph} style={{ minWidth: w }} required={required} />;

  let fields: ReactNode, submit: (f: HTMLFormElement) => void;
  switch (kind) {
    case "event":
      fields = <>
        <select name="fid" defaultValue=""><option value="">{T.form.newFact}</option>{facts.map((e: any) => <option key={e.fid} value={e.fid}>{T.form.correct} {e.type} {e.date || ""} {e.place || ""}</option>)}</select>
        <select name="type">{EVENT_TYPES.map((t) => <option key={t}>{t}</option>)}</select><input name="date" placeholder={T.form.date} /><input name="place" placeholder={T.form.place} /><input name="value" placeholder={T.form.detail} /><input name="note" placeholder={T.form.note} /><label className="small"><input type="checkbox" name="remove" /> {T.form.removeFact}</label>
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
      fields = <><input name="given" placeholder={T.form.given} /><input name="surname" placeholder={T.form.surname} /><select name="type" defaultValue=""><option value="">{T.form.nameKind}</option><option value="birth">{T.form.nameKinds.birth}</option><option value="married">{T.form.nameKinds.married}</option><option value="also known as">{T.form.nameKinds.aka}</option><option value="immigrant">{T.form.nameKinds.immigrant}</option></select></>;
      submit = (f) => add({ op: "name.add", person: id, name: { given: val(f, "given"), surname: val(f, "surname"), type: val(f, "type") } });
      break;
    case "sex":
      fields = <select name="sex"><option value="M">{T.form.male}</option><option value="F">{T.form.female}</option><option value="U">{T.form.unknown}</option></select>;
      submit = (f) => add({ op: "person.update", id, set: { sex: val(f, "sex") } });
      break;
    case "parent":
      fields = <>{existing()} {T.form.orNew} {newPerson}</>;
      submit = (f) => {
        const { pid, ops } = personOrNew(f);
        const sex = pid.startsWith("$") ? val(f, "sex") : (D.people[pid] || ({} as any)).sex;
        const role = sex === "F" ? "wife" : "husband";
        const fam = (p.famc || [])[0];
        if (fam && !(F[fam] as any)[role]) add(...ops, { op: "family.set_spouse", family: fam, role, person: pid });
        else if (fam) throw new Error(role === "wife" ? T.form.hasMother : T.form.hasFather);
        else add(...ops, { op: "family.create", [role]: pid, children: [id] });
      };
      break;
    case "spouse":
      fields = <>{existing()} {T.form.orNew} {newPerson}<input name="married" placeholder={T.form.married} style={{ maxWidth: 140 }} /></>;
      submit = (f) => {
        const { pid, ops } = personOrNew(f);
        const meH = p.sex !== "F";
        add(...ops, { op: "family.create", husband: meH ? id : pid, wife: meH ? pid : id, events: val(f, "married") ? [{ type: "Marriage", date: val(f, "married") }] : [] });
      };
      break;
    case "child":
      fields = <>
        <select name="fam">{(p.fams || []).map((fid: string) => { const fm = F[fid]; const sp = fm.husband === id ? fm.wife : fm.husband; return <option key={fid} value={fid}>{T.form.withPartner(sp && D.people[sp] ? D.people[sp].name : T.form.unknownPartner)}</option>; })}<option value="">{T.form.newFamily}</option></select>
        {existing()} {T.form.orNew} {newPerson}
      </>;
      submit = (f) => {
        const { pid, ops } = personOrNew(f);
        if (val(f, "fam")) add(...ops, { op: "family.add_child", family: val(f, "fam"), person: pid });
        else add(...ops, { op: "family.create", [p.sex === "F" ? "wife" : "husband"]: id, children: [pid] });
      };
      break;
    case "merge":
      fields = existing(T.form.duplicate, 260, true);
      submit = (f) => {
        const d = pickId(val(f, "existing"));
        if (!d || d === id) throw new Error(T.form.pickDuplicate);
        if (!confirm(T.form.mergeConfirm(D.people[d].name, p.name))) return;
        add({ op: "person.merge", keep: id, drop: d });
      };
      break;
    case "review":
      fields = <>
        <select name="fid">{facts.map((e: any) => <option key={e.fid} value={e.fid}>{e.type} {e.date || ""} {e.place || ""}{e.review ? ` · ${e.review.status}` : ""}</option>)}</select>
        <select name="status"><option value="verified">{T.form.statuses.verified}</option><option value="disputed">{T.form.statuses.disputed}</option><option value="unverified">{T.form.statuses.unverified}</option></select><input name="note" placeholder={T.form.howChecked} style={{ flex: 1 }} /><input name="url" placeholder={T.form.recordLink} />
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
      {fields}<button className="btn primary">{T.form.addToList}</button><button type="button" className="btn" data-cancel onClick={() => openForm(null)}>{T.form.cancel}</button>
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
        if (!r.ok) throw new Error(d.error || T.photo.failed(r.status));
        setPending((cur) => [...cur, { op: "media.attach", person: id, file: d.key, caption: val(f, "caption") || undefined, type: val(f, "type") || undefined, date: val(f, "date") || undefined, place: val(f, "place") || undefined, portrait: el(f, "portrait")!.checked || undefined }]);
        openForm(null);
      } catch (e: any) { alert(e.message); }
    }}>
      <input type="file" name="file" accept="image/jpeg,image/png,image/webp,application/pdf" required /><input name="caption" placeholder={T.photo.caption} style={{ flex: 1, minWidth: 200 }} />
      <select name="type">{Object.entries(MEDIA_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      <input name="date" placeholder={T.photo.date} style={{ maxWidth: 130 }} /><input name="place" placeholder={T.photo.place} style={{ maxWidth: 180 }} />
      <label className="small"><input type="checkbox" name="portrait" /> {T.photo.main}</label><button className="btn primary">{T.photo.upload}</button>
    </form>
    <p className="small muted">{T.photo.privacy}</p>
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
      <div className="pending"><h3>{canEdit ? T.pending.toSave(pending.length) : T.pending.toSuggest(pending.length)}</h3>
        <ol>{pending.map((o, i) => <li key={i}><OpText o={o} /> <button className="linklike" data-undo={i} onClick={() => setPending((cur) => cur.filter((_, j) => j !== i))}>{T.pending.remove}</button></li>)}</ol>
        {meta.resolves.size > 0 && <p className="small">{T.pending.resolves([...meta.resolves].map((x) => `#${x}`).join(", "))}</p>}
        <details open><summary className="small">{T.pending.whatWillChange}</summary>
          <div id="w-diff" className="small muted">{!diff ? T.pending.working : diff.error ? <span className="sev-error">{T.pending.cantApply(diff.error)}</span> : <Diff changes={diff.touched} />}</div></details>
        <form id="w-save" className="filters" onSubmit={async (ev) => {
          ev.preventDefault();
          const sources = src.title || src.url ? [{ title: src.title || src.url, url: src.url || undefined }, ...meta.sources.slice(1)] : meta.sources.length ? meta.sources : undefined;
          const resolves = meta.resolves.size ? [...meta.resolves] : undefined;
          try {
            if (canEdit) await api("POST", "edit", { reason, sources, ops: pending, resolves });
            else await api("POST", "proposals", { kind: "edit", payload: { reason, sources, ops: pending, resolves }, rationale: reason });
            if (!canEdit) alert(T.pending.thanks);
            reloadPage();
          } catch (e: any) { alert(e.status === 409 ? T.pending.conflict : e.message); }
        }}>
          <input name="reason" required placeholder={T.pending.reason} value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: 2, minWidth: 220 }} />
          <input name="src" placeholder={T.pending.sourceTitle} value={src.title} onChange={(e) => setSrc({ ...src, title: e.target.value })} style={{ flex: 1, minWidth: 160 }} />
          <input name="url" placeholder={T.pending.link} value={src.url} onChange={(e) => setSrc({ ...src, url: e.target.value })} style={{ flex: 1, minWidth: 160 }} />
          <button className="btn primary">{canEdit ? T.pending.save : T.pending.send}</button>
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
    <section className="card" id="w-comments"><h2>{T.comments.title}</h2>
      <div id="w-c-out" className="small">
        {state.error ? <p className="muted">{state.error}</p> : !state.comments ? null : state.comments.length ? state.comments.map((m) => (
          <div key={m.id} className={`comment${m.resolved_at ? " resolved" : ""}`}><span className="muted">{who(m.author)} · {m.created_at.slice(0, 10)}{m.fid ? T.comments.on(factName(m.fid)) : ""}</span><div>{m.body}</div>
            {!m.resolved_at && (editor || (D.me && m.author === D.me.principal)) ? <button className="linklike" data-resolve={m.id} onClick={async () => { try { await api("POST", `comments/${m.id}/resolve`); } catch (e: any) { alert(e.message); } load(); }}>{T.comments.resolve}</button> : m.resolved_at ? <span className="muted">{T.comments.resolved}</span> : null}</div>
        )) : <p className="muted">{T.comments.none}</p>}
      </div>
      <form id="w-c-f" className="filters" style={{ marginTop: 8 }} onSubmit={async (ev) => {
        ev.preventDefault();
        const f = ev.currentTarget;
        try { await api("POST", "comments", { type: "person", id, fid: val(f, "fid") || undefined, body: val(f, "body") }); f.reset(); load(); } catch (e: any) { alert(e.message); }
      }}>
        <select name="fid" defaultValue=""><option value="">{T.comments.aboutPerson}</option>{(p.events || []).filter((e: any) => e.fid).map((e: any) => <option key={e.fid} value={e.fid}>{e.type} {e.dateDisplay || e.date || ""}</option>)}</select>
        <input name="body" ref={commentBox} placeholder={T.comments.placeholder} style={{ flex: 1, minWidth: 200 }} /><button className="btn">{T.comments.post}</button>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------- history
const OPS: Record<string, string> = T.history.ops;
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
    <section className="card" id="w-history"><h2>{T.history.title}</h2>
      <div id="w-h-out" className="small">
        {state.error ? <p className="muted">{state.error}</p> : !h ? <p className="muted">{T.history.loading}</p> : h.length ? <ul className="history">{h.map((b, i) => (
          <li key={i}><div><span className="muted">{b.at.slice(0, 16).replace("T", " ")} · {who(b.actor)}{b.on_behalf_of ? T.history.onBehalfOf(who(b.on_behalf_of)) : ""}{b.proposal ? T.history.suggestion(b.proposal) : ""}</span> <b>{OPS[b.op] || b.op}</b>{b.reason ? `: ${b.reason}` : ""}
            {editor && b.batch && b.op !== "revert" && b.op !== "import" && <> <button className="linklike" data-revert={b.batch} onClick={async () => {
              if (!confirm(T.history.undoConfirm)) return;
              try { await api("POST", `changes/${b.batch}/revert`); reloadPage(); }
              catch (e: any) { alert(e.status === 409 ? T.history.undoConflict : e.message); }
            }}>{T.history.undo}</button></>}</div>
            <details><summary className="small">{T.history.details}</summary>{b.entities.some((e: any) => e.before !== undefined || e.after !== undefined)
              ? <Diff changes={b.entities.map((e: any) => ({ type: e.type, id: e.id, before: e.before, after: e.after }))} />
              : <span className="muted">({b.entities.map((e: any) => `${e.change} ${e.type}`).join(", ")})</span>}</details></li>
        ))}</ul> : <p className="muted">{T.history.none}</p>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- cloud research runs for this person
const STATE: Record<string, string> = T.runStates;
function AiResearch() {
  const { api } = useData();
  const { id, p } = usePerson();
  const [state, setState] = useState<{ runs?: any[]; error?: string }>({});
  const load = useCallback(async () => {
    try { setState({ runs: (await api("GET", `agent/runs?person=${encodeURIComponent(id)}`)).runs }); } catch (e: any) { setState({ error: e.message }); }
  }, [api, id]);
  useEffect(() => { load(); }, [load]);
  return (
    <section className="card" id="w-ai"><h2>{T.ai.title}</h2>
      <p className="small muted">{T.ai.intro(p.name)}</p>
      <form id="w-ai-f" className="filters" onSubmit={async (ev) => {
        ev.preventDefault();
        const f = ev.currentTarget;
        try { await api("POST", "agent/runs", { person: id, instructions: val(f, "instructions") || undefined }); f.reset(); load(); } catch (e: any) { alert(e.message); }
      }}><input name="instructions" placeholder={T.ai.placeholder} style={{ flex: 1, minWidth: 220 }} /><button className="btn primary">{T.ai.start}</button></form>
      <div id="w-ai-out" className="small">{state.error ? state.error : state.runs && state.runs.length > 0 && <>
        <ul>{state.runs.slice(0, 5).map((r, i) => <li key={i}>{r.created_at.slice(0, 10)} · {STATE[r.status]}{r.proposals.length > 0 && <> · <Link to="/research/queue">{T.suggestions(r.proposals)}</Link></>}{r.error && <> · <span className="muted">{r.error}</span></>}</li>)}</ul>
        <Link to="/research/agents">{T.allRuns}</Link></>}</div>
    </section>
  );
}

// ---------------------------------------------------------------- Sherlock: relatives not yet in the tree (#44)
const LOOKING: [string, string][] = Object.entries(T.relatives.looking);
function FindRelatives() {
  const { api } = useData();
  const { id, p } = usePerson();
  const [looking, setLooking] = useState("any");
  const [state, setState] = useState<{ runs?: any[]; error?: string }>({});
  const load = useCallback(async () => {
    try { setState({ runs: (await api("GET", `agent/runs?person=${encodeURIComponent(id)}`)).runs.filter((r: any) => r.kind === "relatives") }); } catch (e: any) { setState({ error: e.message }); }
  }, [api, id]);
  useEffect(() => { load(); }, [load]);
  return (
    <section className="card" id="w-relatives"><h2>{T.relatives.title}</h2>
      <p className="small muted">{T.relatives.intro(p.name)}</p>
      <form id="w-relatives-f" className="filters" onSubmit={async (ev) => {
        ev.preventDefault();
        const f = ev.currentTarget;
        try {
          await api("POST", "agent/runs", { kind: "relatives", person: id, looking_for: looking, named: looking === "named" ? val(f, "named") : undefined, hints: val(f, "hints") || undefined, depth: +val(f, "depth") || 1 });
          f.reset(); setLooking("any"); load();
        } catch (e: any) { alert(e.message); }
      }}>
        <label className="small">{T.relatives.lookingFor} <select name="looking_for" value={looking} onChange={(e) => setLooking(e.target.value)}>{LOOKING.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        {looking === "named" && <input name="named" required placeholder={T.relatives.named} style={{ flex: "1 1 180px" }} />}
        <input name="hints" placeholder={T.relatives.hints} style={{ flex: "2 1 220px" }} />
        <label className="small">{T.relatives.depth} <select name="depth" defaultValue="1"><option value="1">{T.relatives.oneGeneration}</option><option value="2">{T.relatives.twoGenerations}</option></select></label>
        <button className="btn primary">{T.relatives.submit}</button>
      </form>
      <div id="w-relatives-out" className="small">{state.error ? state.error : state.runs && state.runs.length > 0 && <>
        <ul>{state.runs.slice(0, 5).map((r, i) => <li key={i}>{r.created_at.slice(0, 10)} · {STATE[r.status]}{r.report && r.report.candidates ? T.relatives.found(r.report.candidates.length) : ""}{r.proposals.length > 0 && <> · <Link to="/research/queue">{T.suggestions(r.proposals)}</Link></>}{r.error && <> · <span className="muted">{r.error}</span></>}</li>)}</ul>
        <Link to="/research/agents">{T.allRuns}</Link></>}</div>
    </section>
  );
}
