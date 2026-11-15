// How edits read to people: op descriptions (the queue, chat, history), citations, and before/after diffs.
// Vocabularies mirror worker/ops.js.
import { Fragment, type ReactNode } from "react";
import { Link } from "react-router";
import { useData } from "./data";
import { PersonLink } from "./lib";
import type { Tree } from "./types";
import { S } from "../../strings/index.ts";

const C = S.common.citations, O = S.common.ops, X = S.common.diff;

export const SOURCE_TYPES: Record<string, string> = C.sourceTypes;
export const INFORMATION: Record<string, string> = C.information;
export const EVIDENCE: Record<string, string> = C.evidence;
export const QUALITY: Record<string, string> = C.quality;
/** What a catalogued source record is (source.upsert `type`). */
export const SOURCE_KINDS: Record<string, string> = C.sourceKinds;
export const MEDIA_TYPES: Record<string, string> = C.mediaTypes;

/** <option>s for a vocabulary, with an optional blank first option. */
export function Options({ map, blank }: { map: Record<string, string>; blank?: string }) {
  return <>{blank != null && <option value="">{blank}</option>}{Object.entries(map).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</>;
}

// ---------------------------------------------------------------- citations
export function citeLabel(D: Tree, cit: any) {
  if (!cit) return "";
  const s = cit.source && (D.sources as any)[cit.source];
  const title = (s && s.title) || cit.title || cit.url || cit.note || cit.source || C.untitled;
  return cit.page ? C.page(title, cit.page) : title;
}
export function Cite({ cit }: { cit: any }) {
  const { D } = useData();
  const label = citeLabel(D, cit);
  const meta = [cit.source_type && SOURCE_TYPES[cit.source_type] && cit.source_type, cit.information && C.meta.information(cit.information), cit.evidence && C.meta.evidence(cit.evidence), cit.quality != null && C.meta.quality(cit.quality)].filter(Boolean);
  return <>{cit.url ? <a href={cit.url} target="_blank" rel="noopener">{label}</a> : label}{meta.length > 0 && <span className="muted small"> ({meta.join(" · ")})</span>}</>;
}
/** "Title (S12)", the text a source picker shows for a catalogued source; pickedSource reads the id back. */
export const sourceOption = (s: any) => `${s.title || s.id} (${s.id})`;
export const pickedSource = (v: string | null | undefined) => (String(v || "").match(/\(([^()\s]+)\)\s*$/) || [])[1] || null;
/** A <datalist> of the tree's catalogued sources, for inputs with list={id}. */
export function SourceList({ id, except }: { id: string; except?: string }) {
  const { D } = useData();
  const list = Object.values(D.sources as Record<string, any>).filter((s) => s.id !== except).sort((a, b) => String(a.title || "").localeCompare(String(b.title || "")));
  return <datalist id={id}>{list.map((s) => <option key={s.id} value={sourceOption(s)} />)}</datalist>;
}

/** Form fields for one structured citation; read them back with readCitation(form, prefix). */
export function CitationFields({ prefix = "c" }: { prefix?: string }) {
  return (
    <fieldset className="cite-fields"><legend className="small">{C.fields.legend}</legend>
      <input name={`${prefix}_source`} list={`${prefix}-sources`} placeholder={C.fields.source.placeholder} title={C.fields.source.title} style={{ flex: 2, minWidth: 220 }} />
      <SourceList id={`${prefix}-sources`} />
      <input name={`${prefix}_title`} placeholder={C.fields.title} style={{ flex: 2, minWidth: 220 }} />
      <input name={`${prefix}_url`} placeholder={C.fields.url} style={{ flex: 2, minWidth: 200 }} />
      <input name={`${prefix}_page`} placeholder={C.fields.page} style={{ flex: 1, minWidth: 180 }} />
      <select name={`${prefix}_source_type`} title={C.fields.sourceType.title} defaultValue=""><Options map={SOURCE_TYPES} blank={C.fields.sourceType.blank} /></select>
      <select name={`${prefix}_information`} title={C.fields.information.title} defaultValue=""><Options map={INFORMATION} blank={C.fields.information.blank} /></select>
      <select name={`${prefix}_evidence`} title={C.fields.evidence.title} defaultValue=""><Options map={EVIDENCE} blank={C.fields.evidence.blank} /></select>
      <select name={`${prefix}_quality`} title={C.fields.quality.title} defaultValue=""><Options map={QUALITY} blank={C.fields.quality.blank} /></select>
      <textarea name={`${prefix}_text`} rows={2} placeholder={C.fields.text} style={{ flexBasis: "100%" }} />
    </fieldset>
  );
}
/** The citation typed into <CitationFields>, or null when it was left empty. Throws on a bad link. */
export function readCitation(form: HTMLFormElement, prefix = "c") {
  const v = (k: string) => String(((form.elements.namedItem(`${prefix}_${k}`) as HTMLInputElement | null)?.value) || "").trim();
  // a picked catalogued source cites it by id; text typed into the search that matches none is taken as a title
  const source = pickedSource(v("source")) || undefined;
  const title = v("title") || (!source && v("source")) || "";
  if (!source && !title && !v("url")) return null;
  const cit: any = { source, title: title || undefined, url: v("url") || undefined, page: v("page") || undefined, text: v("text") || undefined, accessed: new Date().toISOString().slice(0, 10) };
  for (const k of ["source_type", "information", "evidence", "quality"]) if (v(k)) cit[k] = v(k);
  if (cit.url && !/^https?:\/\//i.test(cit.url)) throw new Error(C.badLink);
  return cit;
}
/** Prefill <CitationFields> from a citation (a catalogued source shows as "Title (S12)" in the picker). */
export function fillCitation(D: Tree, form: HTMLFormElement, prefix: string, cit: any) {
  for (const [k, v] of Object.entries(cit || {})) {
    const el = form.elements.namedItem(`${prefix}_${k}`) as HTMLInputElement | null;
    if (!el || v == null || v === "") continue;
    const s = k === "source" && (D.sources as any)[String(v)];
    el.value = s ? sourceOption(s) : String(v);
  }
}
/** A research finding's sources as structured citations (their analysis is unknown until someone assesses it). */
export const findingCitations = (f: any) => (f.sources || []).filter((s: any) => s.title || s.url).map((s: any) => ({ title: s.title || undefined, url: /^https?:\/\//i.test(s.url || "") ? s.url : undefined, note: s.note || undefined, accessed: f.date || undefined }));

// ---------------------------------------------------------------- op descriptions
export function factName(D: Tree, pid: string, fid: string) {
  const p: any = D.people[pid];
  const e = p && [...(p.events || []), ...(p.names || [])].find((x: any) => x.fid === fid);
  return e ? (e.type ? [e.type, e.date].filter(Boolean).join(" ") : S.common.facts.name(`${e.given || ""} ${e.surname || ""}`.trim())) : fid;
}
function WhoLink({ id }: { id?: string | null }) {
  const { D } = useData();
  if (!id) return <>{S.common.who.none}</>;
  if (String(id).startsWith("$")) return <>{O.newPerson}</>;
  return D.people[id] ? <PersonLink id={id} /> : <>{id}</>;
}
/** A link to a catalogued source's page, by title (plain text when it isn't in the tree, e.g. merged away). */
export function SourceLink({ id, children }: { id?: string | null; children?: ReactNode }) {
  const { D } = useData();
  if (!id) return <>{S.common.who.none}</>;
  const s = (D.sources as any)[id];
  return s ? <Link to={`/source/${encodeURIComponent(id)}`}>{children ?? C.quoted(s.title || id)}</Link> : <>{children ?? id}</>;
}
const join = (xs: ReactNode[], sep: string) => xs.map((x, i) => <span key={i}>{i > 0 && sep}{x}</span>);
/** A catalog entry's parts (its text and the links passed into it), keyed for React. */
const parts = (xs: ReactNode[]) => <>{xs.map((x, i) => <Fragment key={i}>{x}</Fragment>)}</>;

/** One edit op in plain words, e.g. "add Birth 1890, Exampleton to Example Name". */
export function OpText({ o }: { o: any }) {
  const { D } = useData();
  const W = (id?: string | null) => <WhoLink id={id} />;
  const onWhom = o.entity === "person" ? W(o.id) : <>{O.family(o.id)}</>;
  const fact = (fid: string) => (o.entity === "person" ? factName(D, o.id, fid) : fid);
  switch (o.op) {
    case "person.create": return <>{O.personCreate((o.names || []).map((n: any) => `${n.given} ${n.surname}`).join(" / "))}</>;
    case "person.update": return parts(O.personUpdate(Object.keys(o.set || {}).join(", "), W(o.id)));
    case "person.delete": return parts(O.personDelete(W(o.id)));
    case "person.merge": return parts(O.personMerge(W(o.drop), W(o.keep)));
    case "name.add": return parts(O.nameAdd(`${o.name.given} ${o.name.surname}`, W(o.person)));
    case "name.update": return parts(O.nameUpdate(o.fid, W(o.person)));
    case "name.remove": return parts(O.nameRemove(o.fid, W(o.person)));
    case "event.add": return parts(O.eventAdd(o.event, onWhom));
    case "event.update": return <>{o.conflict && <><b>{O.conflict}</b>: </>}{parts(O.eventUpdate(fact(o.fid), onWhom, Object.entries(o.set || {}).filter(([, v]) => v !== "").map(([k, v]) => O.setTo(k, String(v))).join(", ")))}</>;
    case "event.remove": return parts(O.eventRemove(fact(o.fid), onWhom));
    case "fact.review": return <>{parts(O.factReview(factName(D, o.id, o.fid), W(o.id), <b>{o.status}</b>))}{o.note ? O.reviewNote(o.note) : ""}{(o.evidence || []).length > 0 && <span className="muted">{O.reviewSources(o.evidence.length)}</span>}</>;
    case "citation.add": return parts(O.citationAdd(o.citation.title || o.citation.url || o.citation.note || ((D.sources as any)[o.citation.source] || {}).title || o.citation.source, <>{o.fid ? O.factOf(factName(D, o.id, o.fid)) : null}{W(o.id)}</>));
    case "citation.remove": return parts(O.citationRemove(W(o.id)));
    case "family.create": {
      const sp = [o.husband, o.wife].filter(Boolean);
      return <>{parts(O.familyCreate(sp.length ? join(sp.map((x: string) => W(x)), O.spouseSep) : O.noSpouses))}{(o.children || []).length > 0 && parts(O.children(join(o.children.map((x: string) => W(x)), O.childSep)))}</>;
    }
    case "family.set_spouse": return parts(O.familySetSpouse(o.role, o.family, o.person ? W(o.person) : O.nobody));
    case "family.swap_spouses": return <>{O.familySwapSpouses(o.family)}</>;
    case "family.add_child": return parts(O.familyAddChild(W(o.person), o.family));
    case "family.remove_child": return parts(O.familyRemoveChild(W(o.person), o.family));
    case "family.delete": return <>{O.familyDelete(o.family)}</>;
    case "family.merge": return <>{O.familyMerge(o.drop, o.keep)}</>;
    case "source.upsert": {
      const s = o.id && (D.sources as any)[o.id];
      return s ? <>{parts(O.sourceUpdate(<SourceLink id={o.id} />))}{Object.keys(o.data || {}).length > 0 && <span className="muted">{O.sourceFields(Object.keys(o.data).join(", "))}</span>}</> : <>{O.sourceAdd((o.data || {}).title)}</>;
    }
    case "source.merge": return parts(O.sourceMerge(<SourceLink id={o.drop} />, <SourceLink id={o.keep} />));
    case "source.delete": return parts(O.sourceDelete(<SourceLink id={o.id} />));
    case "media.attach": return parts(O.mediaAttach(W(o.person), o.caption));
    case "media.detach": return parts(O.mediaDetach(W(o.person)));
    case "media.update": return parts(O.mediaUpdate(W(o.person), Object.entries(o.set || {}).filter(([, v]) => v).map(([k, v]) => O.mediaSet(k, String(v))).join(", ") || O.clearDetails));
    case "media.set_primary": return parts(O.mediaSetPrimary(W(o.person)));
    default: return <>{o.op}</>;
  }
}

// ---------------------------------------------------------------- diffs
const evText = (e: any) => [e.type, e.date, e.place, e.value].filter(Boolean).join(", ");
const nameText = (n: any) => `${n.given || ""} ${n.surname || ""}`.trim() + (n.type ? ` (${n.type})` : "");
const keyOf = (x: unknown) => JSON.stringify(x);
const listDiff = (a: any[] = [], b: any[] = []) => ({ added: b.filter((x) => !a.some((y) => keyOf(y) === keyOf(x))), removed: a.filter((x) => !b.some((y) => keyOf(y) === keyOf(x))) });
const whoName = (D: Tree, id?: string | null) => (id && D.people[id] ? D.people[id].name : id || X.nobody);
const Chg = ({ label, from, to }: { label: string; from?: string; to?: string }) => <li className="d-chg"><b>{label}</b>: <del>{from || X.none}</del> → <ins>{to || X.none}</ins></li>;
const Add = ({ label, children }: { label: string; children: ReactNode }) => <li className="d-add">+ <b>{label}</b> {children}</li>;
const Del = ({ label, children }: { label: string; children: ReactNode }) => <li className="d-del">− <b>{label}</b> {children}</li>;

function factDiffs(D: Tree, label: string, a: any, b: any): ReactNode[] {
  const out: ReactNode[] = [];
  for (const k of ["date", "place", "value", "note", "age", "address", "type"]) if ((a[k] || "") !== (b[k] || "")) out.push(<Chg label={X.field(label, k)} from={a[k]} to={b[k]} />);
  const ra = a.review || {}, rb = b.review || {};
  if ((ra.status || "unverified") !== (rb.status || "unverified") || (ra.note || "") !== (rb.note || "")) {
    const st = rb.status === "verified" ? "verified" : rb.status === "disputed" ? "disputed" : "unverified";
    out.push(<li className="d-chg"><b>{label}</b>: {X.marked} <span className={`badge st-${st}`}>{rb.status || "unverified"}</span>{rb.note ? X.note(rb.note) : ""}{(rb.evidence || []).length > 0 && <span className="muted small">{X.evidence(rb.evidence.map((x: any) => citeLabel(D, x)).join("; "))}</span>}</li>);
  }
  const cd = listDiff(a.citations, b.citations);
  for (const x of cd.added) out.push(<Add label={X.field(label, X.source)}><Cite cit={x} /></Add>);
  for (const x of cd.removed) out.push(<Del label={X.field(label, X.source)}>{citeLabel(D, x)}</Del>);
  return out;
}
function factsDiff(D: Tree, a: any[] = [], b: any[] = [], text: (x: any) => string, label: (x: any) => string) {
  const out: ReactNode[] = [], A = new Map(a.map((x) => [x.fid, x])), B = new Map(b.map((x) => [x.fid, x]));
  for (const [fid, x] of B) if (!A.has(fid)) out.push(<Add label={label(x)}>{text(x)}</Add>);
  for (const [fid, x] of A) if (!B.has(fid)) out.push(<Del label={label(x)}>{text(x)}</Del>);
  for (const [fid, x] of B) if (A.has(fid)) out.push(...factDiffs(D, label(x), A.get(fid), x));
  return out;
}
function mediaDiff(a: any[] = [], b: any[] = []) {
  const out: ReactNode[] = [], A = new Map((a || []).map((m) => [m.file, m])), B = new Map((b || []).map((m) => [m.file, m]));
  const label = (m: any) => m.caption || m.file.split("/").pop();
  for (const [f, m] of B) if (!A.has(f)) out.push(<Add label={X.photo}>{label(m) + (m.portrait ? X.mainPhotoSuffix : "")}</Add>);
  for (const [f, m] of A) if (!B.has(f)) out.push(<Del label={X.photo}>{label(m)}</Del>);
  for (const [f, m] of B) {
    const o = A.get(f);
    if (!o) continue;
    if (!o.portrait && m.portrait) out.push(<li className="d-chg"><b>{X.mainPhoto}</b> → {label(m)}</li>);
    for (const k of ["caption", "date", "place", "type", "note", "source"]) if ((o[k] || "") !== (m[k] || "")) out.push(<Chg label={X.field(X.photo, k)} from={o[k]} to={m[k]} />);
  }
  return out;
}
/** One changed record as a list of differences. `ch` is {type, id, before, after}. */
export function diffItems(D: Tree, ch: any): ReactNode[] {
  const a = ch.before, b = ch.after, t = ch.type;
  if (t === "media" || t === "media_map") return mediaDiff(a, b);
  if (t === "finding") return [b ? <li className="d-chg"><b>{X.finding}</b> {b.status}{b.note ? X.note(b.note) : ""}</li> : <li className="d-chg"><b>{X.finding}</b> {X.reopened}</li>];
  if (t === "status") return [<Chg label={X.researchStatus} from={a && a.status} to={b && b.status} />];
  if (t === "source" && !(a && b)) return [b ? <Add label={X.sourceLabel}>{b.title || ch.id}</Add> : <Del label={X.sourceLabel}>{(a && a.title) || ch.id}</Del>];
  if (!a && b) return [<Add label={t === "family" ? X.family : X.person}>{t === "family" ? [b.husband, b.wife].filter(Boolean).map((x: string) => whoName(D, x)).join(" & ") : (b.names || []).map(nameText).join(" / ")}</Add>];
  if (a && !b) return [<Del label={t === "family" ? X.family : X.person}>{t === "family" ? ch.id : (a.names || []).map(nameText).join(" / ")}</Del>];
  if (!a || !b) return [];
  const out: ReactNode[] = [];
  if (t === "person") {
    if ((a.sex || "") !== (b.sex || "")) out.push(<Chg label={X.sex} from={a.sex} to={b.sex} />);
    out.push(...factsDiff(D, a.names, b.names, nameText, () => X.name));
    out.push(...factsDiff(D, a.events, b.events, evText, (e) => e.type));
    if (keyOf(a.notes || []) !== keyOf(b.notes || [])) out.push(<Chg label={X.notes} from={(a.notes || []).join(" / ")} to={(b.notes || []).join(" / ")} />);
    const cd = listDiff(a.citations, b.citations);
    for (const x of cd.added) out.push(<Add label={X.sourceLabel}><Cite cit={x} /></Add>);
    for (const x of cd.removed) out.push(<Del label={X.sourceLabel}>{citeLabel(D, x)}</Del>);
    for (const k of ["famc", "fams"]) {
      const d = listDiff(a[k], b[k]), l = k === "famc" ? X.parentsFamily : X.ownFamily;
      for (const f of d.added) out.push(<Add label={l}>{f}</Add>);
      for (const f of d.removed) out.push(<Del label={l}>{f}</Del>);
    }
  } else if (t === "family") {
    for (const r of ["husband", "wife"]) if ((a[r] || null) !== (b[r] || null)) out.push(<Chg label={r === "husband" ? X.husband : X.wife} from={whoName(D, a[r])} to={whoName(D, b[r])} />);
    const d = listDiff(a.children, b.children);
    for (const x of d.added) out.push(<Add label={X.child}>{whoName(D, x)}</Add>);
    for (const x of d.removed) out.push(<Del label={X.child}>{whoName(D, x)}</Del>);
    out.push(...factsDiff(D, a.events, b.events, evText, (e) => e.type));
  } else if (t === "source") {
    for (const k of ["title", "type", "author", "publication", "url", "repository", "apid", "note", "text"]) if ((a[k] || "") !== (b[k] || "")) out.push(<Chg label={X.field(X.sourceLabel, k === "text" ? X.transcription : k)} from={k === "type" ? SOURCE_KINDS[a[k]] || a[k] : a[k]} to={k === "type" ? SOURCE_KINDS[b[k]] || b[k] : b[k]} />);
  }
  return out;
}
/** A list of changed records ({type, id, before, after}) as before → after differences. */
export function Diff({ changes }: { changes?: any[] }) {
  const { D } = useData();
  const blocks = (changes || []).map((ch, i) => {
    const items = diffItems(D, ch);
    if (!items.length) return null;
    const t = ch.type, w = whoName(D, ch.id);
    const title = t === "person" ? w : t === "family" ? X.titles.family(ch.id) : t === "media" || t === "media_map" ? X.titles.photos(w) : t === "finding" ? X.titles.finding(ch.id) : t === "status" ? X.titles.status(w) : t === "source" ? X.titles.source(ch.id) : `${t} ${ch.id}`;
    return <div className="diff" key={i}><div className="small muted">{title}</div><ul>{items.map((x, j) => <Fragment key={j}>{x}</Fragment>)}</ul></div>;
  }).filter(Boolean);
  return blocks.length ? <>{blocks}</> : <p className="small muted">{X.empty}</p>;
}

/** Strip metadata (GPS, camera, dates) by re-encoding an image in the browser before upload. */
export async function stripImage(file: File): Promise<File> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  const bmp = await createImageBitmap(file);
  const cv = document.createElement("canvas");
  cv.width = bmp.width; cv.height = bmp.height;
  cv.getContext("2d")!.drawImage(bmp, 0, 0);
  const type = file.type === "image/png" ? "image/png" : "image/jpeg";
  return await new Promise((res) => cv.toBlob((b) => res(new File([b!], file.name, { type })), type, 0.92));
}
