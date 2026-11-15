// What the person page's parts share: the pending edit queue (every change is queued, previewed and saved together
// with a reason), which editor form is open, the one open verify/fix form, the highlighted relationship path, and the
// comment box (findings' "Discuss" fills it in).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useData } from "../../data";

/** Reload the page after a write (the tree is loaded once; the hash keeps the route). */
export const reloadPage = () => location.reload();

export const EVENT_TYPE_FOR_FIELD: Record<string, string> = { birth: "Birth", death: "Death", burial: "Burial", baptism: "Baptism", christening: "Christening", residence: "Residence", occupation: "Occupation", immigration: "Immigration", emigration: "Emigration", naturalization: "Naturalization", census: "Census", military: "Military", marriage: "Marriage" };

export interface QueueMeta { resolves?: (number | string)[]; reason?: string; sources?: any[] }
/** One open review form: on a fact row (`at: "fact"`) or under a finding (`at: "finding"`). */
export interface VerifyState { fid: string; at: "fact" | "finding"; finding?: number | string; preset: { status?: string; note?: string; citation?: any; finding?: number | string; resolves?: (number | string)[]; reason?: string } }

interface PersonCtx {
  id: string; p: any;
  canEdit: boolean;
  pending: any[]; setPending: (f: (p: any[]) => any[]) => void;
  meta: { resolves: Set<number | string>; sources: any[] };
  reason: string; setReason: (s: string) => void;
  src: { title: string; url: string }; setSrc: (s: { title: string; url: string }) => void;
  scrollTick: number;
  /** Add ops to the pending list (with what they resolve and the evidence), and show the editor where they are. */
  queue: (ops: any[], m?: QueueMeta) => void;
  /** Save one small change right away (editors), or queue it as a suggestion (members). Resolves true when done. */
  change: (ops: any[], m?: QueueMeta) => Promise<boolean>;
  form: string | null; openForm: (k: string | null) => void;
  verify: VerifyState | null; setVerify: (v: VerifyState | null) => void;
  fix: number | string | null; setFix: (f: number | string | null) => void;
  path: any | null; setPath: (r: any | null) => void;
  commentBox: RefObject<HTMLInputElement | null>;
  provCache: RefObject<any>;
}
const Ctx = createContext<PersonCtx | null>(null);
export const usePerson = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error("usePerson outside <PersonProvider>");
  return c;
};

export function PersonProvider({ id, children }: { id: string; children: ReactNode }) {
  const { D, editor, api } = useData();
  const p = D.people[id] as any;
  const [pending, setPendingRaw] = useState<any[]>([]);
  const [meta, setMeta] = useState<{ resolves: Set<number | string>; sources: any[] }>({ resolves: new Set(), sources: [] });
  const [reason, setReason] = useState("");
  const [src, setSrc] = useState({ title: "", url: "" });
  const [scrollTick, setScrollTick] = useState(0);
  const [form, openForm] = useState<string | null>(null);
  const [verify, setVerify] = useState<VerifyState | null>(null);
  const [fix, setFix] = useState<number | string | null>(null);
  const [path, setPath] = useState<any | null>(null);
  const commentBox = useRef<HTMLInputElement | null>(null);
  const provCache = useRef<any>(null);

  const setPending = setPendingRaw;
  // an empty list forgets what it resolved, its reason and its sources
  useEffect(() => {
    if (pending.length) return;
    setMeta({ resolves: new Set(), sources: [] }); setReason(""); setSrc({ title: "", url: "" });
  }, [pending.length]);

  const queue = useCallback((ops: any[], m: QueueMeta = {}) => {
    setPendingRaw((cur) => [...cur, ...ops]);
    const sources = m.sources ? m.sources.filter((x: any) => x && (x.title || x.url)) : null;
    setMeta((cur) => {
      const resolves = new Set(cur.resolves);
      for (const r of m.resolves || []) resolves.add(r);
      return { resolves, sources: sources || cur.sources };
    });
    if (sources) setSrc({ title: (sources[0] || {}).title || "", url: (sources[0] || {}).url || "" });
    if (m.reason) setReason((r) => r || m.reason!);
    setScrollTick((n) => n + 1);
  }, []);

  const change = useCallback(async (ops: any[], m: QueueMeta = {}) => {
    if (!editor) { queue(ops, m); return true; }
    try { await api("POST", "edit", { reason: m.reason || "Edit", ops }); reloadPage(); return true; }
    catch (e: any) { alert(e.message); return false; }
  }, [editor, api, queue]);

  const value = useMemo<PersonCtx>(() => ({
    id, p, canEdit: editor, pending, setPending, meta, reason, setReason, src, setSrc, scrollTick, queue, change,
    form, openForm, verify, setVerify, fix, setFix, path, setPath, commentBox, provCache,
  }), [id, p, editor, pending, setPending, meta, reason, src, scrollTick, queue, change, form, verify, fix, path]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
