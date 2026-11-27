// Photos and documents, with a lightbox to view one, make it the main photo, edit its details or remove it.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useData } from "../../data";
import { MEDIA_TYPES, Options } from "../../ops";
import { mediaUrl } from "../../tree";
import { attachmentImageUrl, documentType, documentUrl } from "../../documents";
import { LinkMore } from "./Attachments";
import { usePerson } from "./context";
import { S } from "../../../../strings/index.ts";

const T = S.person.photos;

const isPdf = (f: string) => /\.pdf$/i.test(f);
const label = (m: any) => m.caption || MEDIA_TYPES[m.type] || T.photo;
const metaLine = (m: any) => [MEDIA_TYPES[m.type], m.date, m.place].filter(Boolean).join(" · ");
/** Photos, and attachments that are images (uploaded as files, e.g. by an AI client): both belong in the gallery. */
export const inGallery = (m: { file: string; image?: boolean }) => !documentType(m.file) || !!m.image;
const src = (m: any, tree: string | null, preview?: string | null) => m.image && documentType(m.file) ? attachmentImageUrl(m.file, tree, preview) : mediaUrl(m.file, tree, preview);

export function Photos() {
  const { D, live, editor, tree } = useData();
  const { id, p, openForm } = usePerson();
  const list: any[] = (((D.research as any).media || {})[id] || []).filter(inGallery);
  const [open, setOpen] = useState<any | null>(null);
  if (!live) return ( // the static preview (tools/serve.py): no API, nothing to change
    <section className="card side side-photos" id="w-photos">
      <h2>{T.title}</h2>
      {list.length ? <div className="photo-grid">{list.map((m, i) => (
        <figure key={i} className={`photo${m.portrait ? " main" : ""}`}>{isPdf(m.file) ? <div className="doc">{T.pdf}</div> : <img referrerPolicy="no-referrer" loading="lazy" src={src(m, tree, D.previewView)} alt={m.caption || p.name} />}<figcaption>{m.caption || ""}</figcaption></figure>
      ))}</div> : <p className="muted small">{T.none}</p>}
    </section>
  );
  const gedcomOnly = (p.media || []).length;
  return (
    <section className="card side side-photos" id="w-photos">
      <h2>{T.title}{list.length > 0 && <> <span className="count">{list.length}</span></>}</h2>
      {list.length ? <div className="photo-grid">{list.map((m, i) => (
        <figure key={i} className={`photo${m.portrait ? " main" : ""}`} data-i={i} tabIndex={0} role="button" aria-label={T.open(label(m))}
          onClick={() => setOpen(m)} onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setOpen(m); } }}>
          {isPdf(m.file) ? <div className="doc">{T.pdf}</div> : <img referrerPolicy="no-referrer" loading="lazy" src={src(m, tree, D.previewView)} alt={label(m)} />}
          <figcaption>{m.portrait && <><span className="badge st-verified">{T.mainPhoto}</span> </>}{label(m)}<br /><span className="muted small">{metaLine(m)}</span></figcaption>
        </figure>
      ))}</div> : <p className="muted small">{T.none}</p>}
      {gedcomOnly > 0 && <p className="small muted">{T.notUploaded(gedcomOnly)}</p>}
      <div className="btn-row"><button className="btn" id="ph-add" onClick={() => { openForm("photo"); requestAnimationFrame(() => document.getElementById("w-edit")?.scrollIntoView({ behavior: "smooth", block: "start" })); }}>{editor ? T.add : T.suggestAdd}</button></div>
      {open && <Lightbox m={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

/** Everyone else in this view the same file is attached to. */
const linkedTo = (D: any, id: string, file: string) => Object.entries((D.research.media || {}) as Record<string, { file: string }[]>)
  .filter(([pid, items]) => pid !== id && D.people[pid] && !D.people[pid].private && items.some((x) => x.file === file)).map(([pid]) => pid);

function Lightbox({ m, onClose }: { m: any; onClose: () => void }) {
  const { D, editor, tree } = useData();
  const { id, change } = usePerson();
  const dlg = useRef<HTMLDialogElement>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    const d = dlg.current!;
    if (!d.open) d.showModal();
  }, []);
  const done = () => dlg.current?.close();
  const pdf = isPdf(m.file);
  const attached = !!documentType(m.file); // an image attachment: downloadable and linkable, but not a main photo
  return createPortal(
    <dialog className="lightbox" ref={dlg} onClose={onClose}>
      <form method="dialog" className="lb-close"><button className="icon-btn" aria-label={T.close}>✕</button></form>
      {pdf ? <p><a className="btn" href={mediaUrl(m.file, tree, D.previewView)} target="_blank" rel="noopener">{T.openPdf}</a></p> : <img referrerPolicy="no-referrer" src={src(m, tree, D.previewView)} alt={m.caption || ""} />}
      <div className="lb-meta"><b>{m.caption || T.untitled}</b>{m.portrait && <> <span className="badge st-verified">{T.mainPhoto}</span></>}
        <div className="small muted">{metaLine(m)}</div>
        {m.note && <p className="small">{m.note}</p>}{m.source && <p className="small">{T.source(((D.sources as any)[m.source] || {}).title || m.source)}</p>}
        <div className="btn-row">
          {attached && <a className="btn" href={documentUrl(m.file, tree, D.previewView)} download>{S.person.attachments.download}</a>}
          {attached && !D.previewView && <LinkMore item={m} others={linkedTo(D, id, m.file)} />}
          {!m.portrait && !pdf && !attached && <button className="btn primary" data-a="main" onClick={async () => { if (await change([{ op: "media.set_primary", person: id, file: m.file }], { reason: T.makeMainReason })) done(); }}>{editor ? T.makeMain : T.suggestMain}</button>}
          <button className="btn" data-a="edit" onClick={() => setEditing((x) => !x)}>{T.editDetails}</button>
          <button className="btn" data-a="remove" onClick={async () => {
            if (!confirm(T.removeConfirm)) return;
            if (await change([{ op: "media.detach", person: id, file: m.file }], { reason: T.removeReason })) done();
          }}>{editor ? T.remove : T.suggestRemove}</button>
        </div>
        <form className="filters lb-edit" hidden={!editing} onSubmit={async (ev) => {
          ev.preventDefault();
          const form = ev.currentTarget, set: Record<string, string> = {};
          for (const k of ["caption", "type", "date", "place", "note"]) set[k] = String((form.elements.namedItem(k) as HTMLInputElement).value).trim();
          if (await change([{ op: "media.update", person: id, file: m.file, set }], { reason: T.updateReason })) done();
        }}>
          <input name="caption" defaultValue={m.caption || ""} placeholder={T.caption} style={{ flex: 2, minWidth: 200 }} />
          <select name="type" defaultValue={m.type || ""}><Options map={MEDIA_TYPES} blank={T.kind} /></select>
          <input name="date" defaultValue={m.date || ""} placeholder={T.date} style={{ maxWidth: 170 }} />
          <input name="place" defaultValue={m.place || ""} placeholder={T.place} style={{ flex: 1, minWidth: 160 }} />
          <input name="note" defaultValue={m.note || ""} placeholder={T.note} style={{ flexBasis: "100%" }} />
          <button className="btn primary">{editor ? T.save : T.suggest}</button>
        </form>
      </div>
    </dialog>,
    document.body,
  );
}
