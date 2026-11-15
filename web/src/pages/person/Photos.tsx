// Photos and documents, with a lightbox to view one, make it the main photo, edit its details or remove it.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useData } from "../../data";
import { MEDIA_TYPES, Options } from "../../ops";
import { mediaUrl } from "../../tree";
import { usePerson } from "./context";

const isPdf = (f: string) => /\.pdf$/i.test(f);
const label = (m: any) => m.caption || MEDIA_TYPES[m.type] || "Photo";
const metaLine = (m: any) => [MEDIA_TYPES[m.type], m.date, m.place].filter(Boolean).join(" · ");

export function Photos() {
  const { D, live, editor } = useData();
  const { id, p, openForm } = usePerson();
  const list: any[] = (((D.research as any).media || {})[id] || []).slice();
  const [open, setOpen] = useState<any | null>(null);
  if (!live) return ( // the static preview (tools/serve.py): no API, nothing to change
    <section className="card" id="w-photos" style={{ marginTop: 20 }}>
      <h2>Photos and documents</h2>
      {list.length ? <div className="photo-grid">{list.map((m, i) => (
        <figure key={i} className={`photo${m.portrait ? " main" : ""}`}>{isPdf(m.file) ? <div className="doc">PDF</div> : <img loading="lazy" src={mediaUrl(m.file)} alt={m.caption || p.name} />}<figcaption>{m.caption || ""}</figcaption></figure>
      ))}</div> : <p className="muted small">No photos or documents yet.</p>}
    </section>
  );
  const gedcomOnly = (p.media || []).length;
  return (
    <section className="card" id="w-photos" style={{ marginTop: 20 }}>
      <h2>Photos and documents{list.length > 0 && <> <span className="count">{list.length}</span></>}</h2>
      {list.length ? <div className="photo-grid">{list.map((m, i) => (
        <figure key={i} className={`photo${m.portrait ? " main" : ""}`} data-i={i} tabIndex={0} role="button" aria-label={`Open ${label(m)}`}
          onClick={() => setOpen(m)} onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setOpen(m); } }}>
          {isPdf(m.file) ? <div className="doc">PDF</div> : <img loading="lazy" src={mediaUrl(m.file)} alt={label(m)} />}
          <figcaption>{m.portrait && <><span className="badge st-verified">Main photo</span> </>}{label(m)}<br /><span className="muted small">{metaLine(m)}</span></figcaption>
        </figure>
      ))}</div> : <p className="muted small">No photos or documents yet.</p>}
      {gedcomOnly > 0 && <p className="small muted">{gedcomOnly} more item{gedcomOnly > 1 ? "s are" : " is"} listed in the Ancestry export but not uploaded here.</p>}
      <div className="btn-row"><button className="btn" id="ph-add" onClick={() => { openForm("photo"); requestAnimationFrame(() => document.getElementById("w-edit")?.scrollIntoView({ behavior: "smooth", block: "start" })); }}>{editor ? "Add a photo or document" : "Suggest a photo or document"}</button></div>
      {open && <Lightbox m={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

function Lightbox({ m, onClose }: { m: any; onClose: () => void }) {
  const { D, editor } = useData();
  const { id, change } = usePerson();
  const dlg = useRef<HTMLDialogElement>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    const d = dlg.current!;
    if (!d.open) d.showModal();
  }, []);
  const done = () => dlg.current?.close();
  const pdf = isPdf(m.file);
  return createPortal(
    <dialog className="lightbox" ref={dlg} onClose={onClose}>
      <form method="dialog" className="lb-close"><button className="icon-btn" aria-label="Close">✕</button></form>
      {pdf ? <p><a className="btn" href={mediaUrl(m.file)} target="_blank" rel="noopener">Open the PDF</a></p> : <img src={mediaUrl(m.file)} alt={m.caption || ""} />}
      <div className="lb-meta"><b>{m.caption || "Untitled"}</b>{m.portrait && <> <span className="badge st-verified">Main photo</span></>}
        <div className="small muted">{metaLine(m)}</div>
        {m.note && <p className="small">{m.note}</p>}{m.source && <p className="small">Source: {((D.sources as any)[m.source] || {}).title || m.source}</p>}
        <div className="btn-row">
          {!m.portrait && !pdf && <button className="btn primary" data-a="main" onClick={async () => { if (await change([{ op: "media.set_primary", person: id, file: m.file }], { reason: "Choose the main photo" })) done(); }}>{editor ? "Make this the main photo" : "Suggest as main photo"}</button>}
          <button className="btn" data-a="edit" onClick={() => setEditing((x) => !x)}>Edit details</button>
          <button className="btn" data-a="remove" onClick={async () => {
            if (!confirm("Remove this from the person? The file stays stored, and the change can be undone from History.")) return;
            if (await change([{ op: "media.detach", person: id, file: m.file }], { reason: "Remove a photo or document" })) done();
          }}>{editor ? "Remove from this person" : "Suggest removing"}</button>
        </div>
        <form className="filters lb-edit" hidden={!editing} onSubmit={async (ev) => {
          ev.preventDefault();
          const form = ev.currentTarget, set: Record<string, string> = {};
          for (const k of ["caption", "type", "date", "place", "note"]) set[k] = String((form.elements.namedItem(k) as HTMLInputElement).value).trim();
          if (await change([{ op: "media.update", person: id, file: m.file, set }], { reason: "Update photo details" })) done();
        }}>
          <input name="caption" defaultValue={m.caption || ""} placeholder="Caption" style={{ flex: 2, minWidth: 200 }} />
          <select name="type" defaultValue={m.type || ""}><Options map={MEDIA_TYPES} blank="Kind…" /></select>
          <input name="date" defaultValue={m.date || ""} placeholder="Date taken (e.g. abt 1925)" style={{ maxWidth: 170 }} />
          <input name="place" defaultValue={m.place || ""} placeholder="Place" style={{ flex: 1, minWidth: 160 }} />
          <input name="note" defaultValue={m.note || ""} placeholder="Note (who is pictured, where it came from)" style={{ flexBasis: "100%" }} />
          <button className="btn primary">{editor ? "Save" : "Suggest"}</button>
        </form>
      </div>
    </dialog>,
    document.body,
  );
}
