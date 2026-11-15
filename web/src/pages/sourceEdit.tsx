// Changing catalogued sources, shared by the sources list and a source page: the edit form, and saving a change
// (editors directly, with a reason; members as a suggestion, the same way the person editor does).
import { useCallback } from "react";
import { S } from "../../../strings/index.ts";
import { useData } from "../data";
import { Options, SOURCE_KINDS } from "../ops";

const T = S.admin.sources.edit;

/** Save source ops: editors change the tree directly (with a reason), members file a suggestion. Null when nothing was sent. */
export function useSourceChange() {
  const { editor, api } = useData();
  return useCallback(async (ops: any[], reason: string): Promise<any> => {
    if (!reason.trim()) { alert(T.reasonRequired); return null; }
    try {
      if (editor) return await api("POST", "edit", { reason, ops });
      await api("POST", "proposals", { kind: "edit", payload: { reason, ops }, rationale: reason });
      alert(T.suggested);
      return { suggested: true };
    } catch (e: any) {
      alert(e.status === 409 ? T.conflict : e.message);
      return null;
    }
  }, [editor, api]);
}

const FIELDS: [string, string][] = [["author", T.fields.author], ["publication", T.fields.publication], ["repository", T.fields.repository], ["url", T.fields.url], ["apid", T.fields.apid]];

/** The fields of a source record and a reason; calls onSave(data, reason). Empty fields remove what was there. */
export function SourceForm({ s = {}, onSave, onCancel, submit }: { s?: any; onSave: (data: any, reason: string) => void; onCancel?: () => void; submit: string }) {
  return (
    <form className="card sub source-form" onSubmit={(ev) => {
      ev.preventDefault();
      const f = ev.currentTarget, v = (k: string) => String(((f.elements.namedItem(k) as HTMLInputElement | null)?.value) || "").trim();
      const data: any = {};
      for (const k of ["title", "type", ...FIELDS.map(([k]) => k), "note", "text"]) data[k] = v(k);
      if (!data.title) return alert(T.needsTitle);
      if (data.url && !/^https?:\/\//i.test(data.url)) return alert(T.badLink);
      onSave(data, v("reason"));
    }}>
      <div className="filters">
        <input name="title" required defaultValue={s.title || ""} placeholder={T.title} style={{ flex: 2, minWidth: 260 }} />
        <select name="type" defaultValue={s.type || ""}><Options map={SOURCE_KINDS} blank={T.kind} /></select>
      </div>
      <div className="filters">{FIELDS.map(([k, l]) => <input key={k} name={k} defaultValue={s[k] || ""} placeholder={l} style={{ flex: 1, minWidth: 200 }} />)}</div>
      <textarea name="note" rows={2} defaultValue={s.note || ""} placeholder={T.note} style={{ width: "100%" }} />
      <textarea name="text" rows={4} defaultValue={s.text || ""} placeholder={T.text} style={{ width: "100%" }} />
      <div className="filters">
        <input name="reason" required placeholder={T.reason} style={{ flex: 2, minWidth: 220 }} />
        <button className="btn primary">{submit}</button>
        {onCancel && <button type="button" className="btn" onClick={onCancel}>{T.cancel}</button>}
      </div>
    </form>
  );
}
