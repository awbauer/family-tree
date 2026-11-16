import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { Marked } from "marked";
import { S } from "../../../../strings/index.ts";
import { useData } from "../../data";
import { documentType, documentUrl } from "../../documents";
import { PersonLink, isUnknown } from "../../lib";
import { reloadPage, usePerson } from "./context";

const T = S.person.attachments;
type DocumentType = NonNullable<ReturnType<typeof documentType>>;
type DocumentItem = { file: string; caption: string; source?: string };

const markdown = new Marked({
  async: false,
  renderer: {
    html() { return ""; },
    image({ tokens }) { return this.parser.parseInline(tokens, this.parser.textRenderer); },
    link({ tokens }) { return this.parser.parseInline(tokens); },
  },
});

function Report({ url, title }: { url: string; title: string }) {
  const [result, setResult] = useState<{ html?: string; error?: boolean }>({});
  useEffect(() => {
    const request = new AbortController();
    async function load() {
      const response = await fetch(url, { signal: request.signal, credentials: "same-origin" });
      if (!response.ok || !response.headers.has("Content-Disposition")) throw new Error(T.loadError);
      const html = await markdown.parse(await response.text());
      if (!request.signal.aborted) setResult({ html });
    }
    load().catch(() => { if (!request.signal.aborted) setResult({ error: true }); });
    return () => request.abort();
  }, [url]);
  if (result.error) return <p role="alert">{T.loadError}</p>;
  if (result.html === undefined) return <p role="status">{T.loading}</p>;
  // The sandbox and CSP also apply if a future Markdown renderer emits active markup.
  const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <style>:root{color-scheme:light dark}body{font:1rem/1.55 system-ui;margin:1rem;overflow-wrap:anywhere}
    pre{overflow:auto;background:color-mix(in srgb,CanvasText 7%,Canvas);padding:.75rem}table{border-collapse:collapse}
    td,th{border:1px solid GrayText;padding:.35rem .55rem}blockquote{border-inline-start:3px solid GrayText;padding-inline-start:1rem;margin-inline-start:0}</style>
    <main>${result.html}</main>`;
  return <iframe className="report-viewer" sandbox="" title={title} srcDoc={page} />;
}

export function DocumentLinks({ item, proposal }: { item: DocumentItem; proposal?: number }) {
  const { D, tree } = useData();
  const url = documentUrl(item.file, tree, D.previewView, proposal);
  const target = useSearchParams()[0].get("attachment");
  const linked = !proposal && target === item.file;
  const [reading, setReading] = useState(linked);
  useEffect(() => { setReading(linked); }, [linked]);
  const report = documentType(item.file) === "report";
  return <>
    <div className="btn-row">
      {report && <button className="btn" aria-expanded={reading} onClick={() => setReading(!reading)}>{reading ? S.person.photos.close : T.read}</button>}
      <a className="btn" href={url} download>{T.download}</a>
    </div>
    {reading && report && <Report key={url} url={url} title={item.caption} />}
  </>;
}

/** Choose several people from the tree (not private, not "Unknown"), shown as removable chips. */
function PeoplePicker({ chosen, setChosen, exclude, name }: { chosen: string[]; setChosen: (ids: string[]) => void; exclude: string[]; name: string }) {
  const { D, people } = useData();
  const [pick, setPick] = useState("");
  const add = (value: string) => {
    const id = (value.match(/\(([^)]+)\)\s*$/) || [])[1];
    if (id && D.people[id] && !D.people[id].private && !chosen.includes(id) && !exclude.includes(id)) setChosen([...chosen, id]);
    setPick("");
  };
  const list = `${name}-people`;
  return <div>
    <div className="filters">
      <input list={list} name={name} placeholder={T.pickPerson} value={pick} aria-label={T.pickPerson}
        onChange={(e) => { setPick(e.target.value); if (/\([^)]+\)\s*$/.test(e.target.value)) add(e.target.value); }} />
      <button type="button" className="btn" onClick={() => add(pick)}>{T.add}</button>
    </div>
    <datalist id={list}>{people.filter((p) => !isUnknown(p) && !p.private && !exclude.includes(p.id)).map((p) => <option key={p.id} value={`${p.name} (${p.id})`} />)}</datalist>
    {chosen.length > 0 && <div className="small">{chosen.map((id) => (
      <span key={id} className="badge">{D.people[id].name} <button type="button" className="linklike" aria-label={T.removePerson} onClick={() => setChosen(chosen.filter((x) => x !== id))}>✕</button> </span>
    ))}</div>}
  </div>;
}

/** Link a document already on this person to more people. */
function LinkMore({ item, others }: { item: DocumentItem; others: string[] }) {
  const { editor } = useData();
  const { id, change } = usePerson();
  const [open, setOpen] = useState(false), [chosen, setChosen] = useState<string[]>([]), [sent, setSent] = useState(false);
  if (!open) return <>{sent && <p role="status" className="small">{T.linkSent}</p>}<button className="btn" onClick={() => { setOpen(true); setSent(false); }}>{T.linkMore}</button></>;
  return <div className="filters">
    <PeoplePicker chosen={chosen} setChosen={setChosen} exclude={[id, ...others]} name={`link-${item.file.replace(/\W/g, "-")}`} />
    <button className="btn primary" disabled={!chosen.length} onClick={async () => {
      const ops = chosen.map((person) => ({ op: "media.attach", person, file: item.file, caption: item.caption, ...(item.source ? { source: item.source } : {}) }));
      if (await change(ops, { reason: T.linkReason(item.caption) })) { setOpen(false); setChosen([]); if (!editor) setSent(true); }
    }}>{editor ? T.link : T.suggestLink}</button>
    <button className="btn" type="button" onClick={() => { setOpen(false); setChosen([]); }}>{T.cancel}</button>
  </div>;
}

export function Attachments() {
  const { D, live, editor, tree } = useData();
  const { id, p, change } = usePerson();
  const list: DocumentItem[] = (((D.research as any).media || {})[id] || []).filter((m: DocumentItem) => documentType(m.file));
  const [kind, setKind] = useState<DocumentType | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [also, setAlso] = useState<string[]>([]);
  // everyone else in this view the same file is attached to
  const linkedTo = (file: string) => Object.entries(((D.research as any).media || {}) as Record<string, DocumentItem[]>)
    .filter(([pid, items]) => pid !== id && D.people[pid] && !D.people[pid].private && items.some((m) => m.file === file)).map(([pid]) => pid);
  if (!live || p.private || D.scope?.view.media === false) return null;
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const file = data.get("file");
    if (!kind || !(file instanceof File) || busy) return;
    const params = new URLSearchParams({ person: [id, ...also].join(","), type: kind });
    if (tree) params.set("tree", tree);
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`api/attachments?${params}`, {
        method: "POST", credentials: "same-origin", body: file,
        headers: {
          "X-Document-Name": encodeURIComponent(file.name),
          "X-Document-Title": encodeURIComponent(String(data.get("title") || "")),
        },
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || T.uploadError);
      if (result.proposal) { setKind(null); setAlso([]); setSent(true); }
      else reloadPage();
    } catch (e) {
      setError(e instanceof Error ? e.message : T.uploadError);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card" id="w-attachments" style={{ marginTop: 20 }}>
      <h2>{T.title}</h2>
      {list.length ? <ul className="attachment-list">{list.map((item) => (
        <li key={item.file} id={item.file}>
          <strong>{item.caption}</strong> <span className="muted small">{documentType(item.file) === "report" ? T.report : T.attachment}</span>
          {item.source && D.sources[item.source] != null && (
            <div className="small"><Link to={`/source/${encodeURIComponent(item.source)}`}>{T.source((D.sources[item.source] as { title?: string }).title || item.source)}</Link></div>
          )}
          {linkedTo(item.file).length > 0 && <div className="small">{T.alsoOn} {linkedTo(item.file).map((pid, i) => <span key={pid}>{i > 0 && ", "}<PersonLink id={pid} /></span>)}</div>}
          <DocumentLinks item={item} />
          {!D.previewView && <div className="btn-row">
            <LinkMore item={item} others={linkedTo(item.file)} />
            <button className="btn" onClick={() => {
              const shared = linkedTo(item.file).length > 0;
              if (confirm(shared ? T.removeHereConfirm : T.removeConfirm)) void change([{ op: "media.detach", person: id, file: item.file }], { reason: T.removeReason });
            }}>{linkedTo(item.file).length ? (editor ? T.removeHere : T.suggestRemoveHere) : (editor ? T.remove : T.suggestRemove)}</button>
          </div>}
        </li>
      ))}</ul> : <p className="muted small">{T.none}</p>}
      {!D.previewView && <div className="btn-row">
        <button className="btn" disabled={busy} aria-expanded={kind === "attachment"} onClick={() => { setKind("attachment"); setError(""); setSent(false); }}>{T.addAttachment}</button>
        <button className="btn" disabled={busy} aria-expanded={kind === "report"} onClick={() => { setKind("report"); setError(""); setSent(false); }}>{T.addReport}</button>
      </div>}
      {kind && <form key={kind} className="filters" onSubmit={upload}>
        <label>{kind === "report" ? T.markdownFile : T.chooseFile} <input type="file" name="file" accept={kind === "report" ? ".md,.markdown" : undefined} required disabled={busy} /></label>
        <label>{T.documentTitle} <input name="title" maxLength={1000} disabled={busy} /></label>
        <div><span className="small">{T.alsoAttach}</span><PeoplePicker chosen={also} setChosen={setAlso} exclude={[id]} name={`also-${kind}`} /></div>
        <button className="btn primary" disabled={busy}>{editor ? T.upload : T.suggest}</button>
        <button className="btn" type="button" disabled={busy} onClick={() => { setKind(null); setAlso([]); setError(""); }}>{T.cancel}</button>
      </form>}
      {error && <p role="alert">{error}</p>}
      {sent && <p role="status">{T.sent}</p>}
    </section>
  );
}
