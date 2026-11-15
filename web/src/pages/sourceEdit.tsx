// Changing catalogued sources, shared by the sources list and a source page: the edit form, and saving a change
// (editors directly, with a reason; members as a suggestion, the same way the person editor does).
import { useCallback } from "react";
import { useData } from "../data";
import { Options, SOURCE_KINDS } from "../ops";

/** Save source ops: editors change the tree directly (with a reason), members file a suggestion. Null when nothing was sent. */
export function useSourceChange() {
  const { editor, api } = useData();
  return useCallback(async (ops: any[], reason: string): Promise<any> => {
    if (!reason.trim()) { alert("Say why: the reason is kept in the history."); return null; }
    try {
      if (editor) return await api("POST", "edit", { reason, ops });
      await api("POST", "proposals", { kind: "edit", payload: { reason, ops }, rationale: reason });
      alert("Thanks. Your suggestion is waiting for an editor.");
      return { suggested: true };
    } catch (e: any) {
      alert(e.status === 409 ? "Someone else changed this meanwhile. Reload and try again." : e.message);
      return null;
    }
  }, [editor, api]);
}

const FIELDS: [string, string][] = [["author", "Author or creator"], ["publication", "Publication (publisher, place, year)"], ["repository", "Repository (where the original is held)"], ["url", "Link (https://…)"], ["apid", "Ancestry record id"]];

/** The fields of a source record and a reason; calls onSave(data, reason). Empty fields remove what was there. */
export function SourceForm({ s = {}, onSave, onCancel, submit }: { s?: any; onSave: (data: any, reason: string) => void; onCancel?: () => void; submit: string }) {
  return (
    <form className="card sub source-form" onSubmit={(ev) => {
      ev.preventDefault();
      const f = ev.currentTarget, v = (k: string) => String(((f.elements.namedItem(k) as HTMLInputElement | null)?.value) || "").trim();
      const data: any = {};
      for (const k of ["title", "type", ...FIELDS.map(([k]) => k), "note", "text"]) data[k] = v(k);
      if (!data.title) return alert("A source needs a title.");
      if (data.url && !/^https?:\/\//i.test(data.url)) return alert("The link must start with http:// or https://");
      onSave(data, v("reason"));
    }}>
      <div className="filters">
        <input name="title" required defaultValue={s.title || ""} placeholder="Title (e.g. Exampleton parish register, baptisms)" style={{ flex: 2, minWidth: 260 }} />
        <select name="type" defaultValue={s.type || ""}><Options map={SOURCE_KINDS} blank="Kind of source…" /></select>
      </div>
      <div className="filters">{FIELDS.map(([k, l]) => <input key={k} name={k} defaultValue={s[k] || ""} placeholder={l} style={{ flex: 1, minWidth: 200 }} />)}</div>
      <textarea name="note" rows={2} defaultValue={s.note || ""} placeholder="Note" style={{ width: "100%" }} />
      <textarea name="text" rows={4} defaultValue={s.text || ""} placeholder="Transcription: what the record says" style={{ width: "100%" }} />
      <div className="filters">
        <input name="reason" required placeholder="Why? What's the evidence?" style={{ flex: 2, minWidth: 220 }} />
        <button className="btn primary">{submit}</button>
        {onCancel && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}
