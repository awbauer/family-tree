import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { Marked } from "marked";
import { S } from "../../../../strings/index.ts";
import { useData } from "../../data";
import { documentType, documentUrl } from "../../documents";
import { reloadPage, usePerson } from "./context";

const T = S.person.attachments;
type DocumentType = NonNullable<ReturnType<typeof documentType>>;
type DocumentItem = { file: string; caption: string };

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

export function Attachments() {
  const { D, live, editor, tree } = useData();
  const { id, p, change } = usePerson();
  const list: DocumentItem[] = (((D.research as any).media || {})[id] || []).filter((m: DocumentItem) => documentType(m.file));
  const [kind, setKind] = useState<DocumentType | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  if (!live || p.private || D.scope?.view.media === false) return null;
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const file = data.get("file");
    if (!kind || !(file instanceof File) || busy) return;
    const params = new URLSearchParams({ person: id, type: kind });
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
      if (result.proposal) { setKind(null); setSent(true); }
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
          <DocumentLinks item={item} />
          {!D.previewView && <button className="btn" onClick={() => {
            if (confirm(T.removeConfirm)) void change([{ op: "media.detach", person: id, file: item.file }], { reason: T.removeReason });
          }}>{editor ? T.remove : T.suggestRemove}</button>}
        </li>
      ))}</ul> : <p className="muted small">{T.none}</p>}
      {!D.previewView && <div className="btn-row">
        <button className="btn" disabled={busy} aria-expanded={kind === "attachment"} onClick={() => { setKind("attachment"); setError(""); setSent(false); }}>{T.addAttachment}</button>
        <button className="btn" disabled={busy} aria-expanded={kind === "report"} onClick={() => { setKind("report"); setError(""); setSent(false); }}>{T.addReport}</button>
      </div>}
      {kind && <form key={kind} className="filters" onSubmit={upload}>
        <label>{kind === "report" ? T.markdownFile : T.chooseFile} <input type="file" name="file" accept={kind === "report" ? ".md,.markdown" : undefined} required disabled={busy} /></label>
        <label>{T.documentTitle} <input name="title" maxLength={1000} disabled={busy} /></label>
        <button className="btn primary" disabled={busy}>{editor ? T.upload : T.suggest}</button>
        <button className="btn" type="button" disabled={busy} onClick={() => { setKind(null); setError(""); }}>{T.cancel}</button>
      </form>}
      {error && <p role="alert">{error}</p>}
      {sent && <p role="status">{T.sent}</p>}
    </section>
  );
}
