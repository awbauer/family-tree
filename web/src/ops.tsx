// How edits read to people: op descriptions (the queue, chat, history), citations, and before/after diffs.
// Vocabularies mirror worker/ops.js.
import { Fragment, type ReactNode } from "react";
import { useData } from "./data";
import { PersonLink } from "./lib";
import type { Tree } from "./types";

export const SOURCE_TYPES: Record<string, string> = { original: "Original record", derivative: "Derivative (index, transcript, abstract)", authored: "Authored work (tree, book, compiled)" };
export const INFORMATION: Record<string, string> = { primary: "Primary: from someone with first-hand knowledge, near the time", secondary: "Secondary: second-hand or recorded later", undetermined: "Undetermined" };
export const EVIDENCE: Record<string, string> = { direct: "Direct: answers the question by itself", indirect: "Indirect: answers it only combined with other evidence", negative: "Negative: an absence that tells something" };
export const QUALITY: Record<string, string> = { 3: "3 · Direct and primary evidence", 2: "2 · Secondary evidence, officially recorded later", 1: "1 · Questionable reliability", 0: "0 · Unreliable or estimated" };
export const MEDIA_TYPES: Record<string, string> = { photo: "Photo", tombstone: "Headstone", newspaper: "Newspaper", manuscript: "Document or letter", card: "Card", map: "Map", book: "Book page", electronic: "Digital record", film: "Film", fiche: "Microfiche", magazine: "Magazine", audio: "Audio", video: "Video", other: "Other" };

/** <option>s for a vocabulary, with an optional blank first option. */
export function Options({ map, blank }: { map: Record<string, string>; blank?: string }) {
  return <>{blank != null && <option value="">{blank}</option>}{Object.entries(map).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</>;
}

// ---------------------------------------------------------------- citations
export function citeLabel(D: Tree, cit: any) {
  if (!cit) return "";
  const s = cit.source && (D.sources as any)[cit.source];
  const title = (s && s.title) || cit.title || cit.url || cit.note || cit.source || "source";
  return `${title}${cit.page ? `, ${cit.page}` : ""}`;
}
export function Cite({ cit }: { cit: any }) {
  const { D } = useData();
  const label = citeLabel(D, cit);
  const meta = [cit.source_type && SOURCE_TYPES[cit.source_type] && cit.source_type, cit.information && `${cit.information} info`, cit.evidence && `${cit.evidence} evidence`, cit.quality != null && `QUAY ${cit.quality}`].filter(Boolean);
  return <>{cit.url ? <a href={cit.url} target="_blank" rel="noopener">{label}</a> : label}{meta.length > 0 && <span className="muted small"> ({meta.join(" · ")})</span>}</>;
}
/** Form fields for one structured citation; read them back with readCitation(form, prefix). */
export function CitationFields({ prefix = "c" }: { prefix?: string }) {
  return (
    <fieldset className="cite-fields"><legend className="small">Source</legend>
      <input name={`${prefix}_title`} placeholder="Record or collection (e.g. Exampleton parish burials)" style={{ flex: 2, minWidth: 220 }} />
      <input name={`${prefix}_url`} placeholder="Link to the record (https://…)" style={{ flex: 2, minWidth: 200 }} />
      <input name={`${prefix}_page`} placeholder="Where in it (volume, page, entry, image)" style={{ flex: 1, minWidth: 180 }} />
      <select name={`${prefix}_source_type`} title="What kind of source" defaultValue=""><Options map={SOURCE_TYPES} blank="Kind of source…" /></select>
      <select name={`${prefix}_information`} title="Quality of the information" defaultValue=""><Options map={INFORMATION} blank="Information…" /></select>
      <select name={`${prefix}_evidence`} title="How it answers the question" defaultValue=""><Options map={EVIDENCE} blank="Evidence…" /></select>
      <select name={`${prefix}_quality`} title="GEDCOM quality (QUAY)" defaultValue=""><Options map={QUALITY} blank="Quality…" /></select>
      <textarea name={`${prefix}_text`} rows={2} placeholder="Transcription: what the record actually says (optional)" style={{ flexBasis: "100%" }} />
    </fieldset>
  );
}
/** The citation typed into <CitationFields>, or null when it was left empty. Throws on a bad link. */
export function readCitation(form: HTMLFormElement, prefix = "c") {
  const v = (k: string) => String(((form.elements.namedItem(`${prefix}_${k}`) as HTMLInputElement | null)?.value) || "").trim();
  if (!v("title") && !v("url")) return null;
  const cit: any = { title: v("title") || undefined, url: v("url") || undefined, page: v("page") || undefined, text: v("text") || undefined, accessed: new Date().toISOString().slice(0, 10) };
  for (const k of ["source_type", "information", "evidence", "quality"]) if (v(k)) cit[k] = v(k);
  if (cit.url && !/^https?:\/\//i.test(cit.url)) throw new Error("The link must start with http:// or https://");
  return cit;
}
/** A research finding's sources as structured citations (their analysis is unknown until someone assesses it). */
export const findingCitations = (f: any) => (f.sources || []).filter((s: any) => s.title || s.url).map((s: any) => ({ title: s.title || undefined, url: /^https?:\/\//i.test(s.url || "") ? s.url : undefined, note: s.note || undefined, accessed: f.date || undefined }));

// ---------------------------------------------------------------- op descriptions
export function factName(D: Tree, pid: string, fid: string) {
  const p: any = D.people[pid];
  const e = p && [...(p.events || []), ...(p.names || [])].find((x: any) => x.fid === fid);
  return e ? (e.type ? [e.type, e.date].filter(Boolean).join(" ") : `name ${`${e.given || ""} ${e.surname || ""}`.trim()}`) : fid;
}
function WhoLink({ id }: { id?: string | null }) {
  const { D } = useData();
  if (!id) return <>—</>;
  if (String(id).startsWith("$")) return <>the new person</>;
  return D.people[id] ? <PersonLink id={id} /> : <>{id}</>;
}
const join = (xs: ReactNode[], sep: string) => xs.map((x, i) => <span key={i}>{i > 0 && sep}{x}</span>);

/** One edit op in plain words, e.g. "add Birth 1890, Exampleton to Example Name". */
export function OpText({ o }: { o: any }) {
  const { D } = useData();
  const W = (id?: string | null) => <WhoLink id={id} />;
  const onWhom = o.entity === "person" ? W(o.id) : <>family {o.id}</>;
  const fact = (fid: string) => (o.entity === "person" ? factName(D, o.id, fid) : fid);
  switch (o.op) {
    case "person.create": return <>add a new person: {(o.names || []).map((n: any) => `${n.given} ${n.surname}`).join(" / ")}</>;
    case "person.update": return <>set {Object.keys(o.set || {}).join(", ")} on {W(o.id)}</>;
    case "person.delete": return <>delete {W(o.id)}</>;
    case "person.merge": return <>merge {W(o.drop)} into {W(o.keep)}</>;
    case "name.add": return <>add the name “{`${o.name.given} ${o.name.surname}`}” to {W(o.person)}</>;
    case "name.update": return <>change name {o.fid} of {W(o.person)}</>;
    case "name.remove": return <>remove name {o.fid} from {W(o.person)}</>;
    case "event.add": return <>add {o.event.type}{o.event.date ? ` ${o.event.date}` : ""}{o.event.place ? `, ${o.event.place}` : ""}{o.event.value ? ` (${o.event.value})` : ""} to {onWhom}</>;
    case "event.update": return <>{o.conflict && <><b>conflict</b>: </>}change {fact(o.fid)} of {onWhom}: {Object.entries(o.set || {}).filter(([, v]) => v !== "").map(([k, v]) => `${k} → “${v}”`).join(", ")}</>;
    case "event.remove": return <>remove {fact(o.fid)} from {onWhom}</>;
    case "fact.review": return <>mark {factName(D, o.id, o.fid)} of {W(o.id)} as <b>{o.status}</b>{o.note ? `: ${o.note}` : ""}{(o.evidence || []).length > 0 && <span className="muted"> ({o.evidence.length} source{o.evidence.length > 1 ? "s" : ""})</span>}</>;
    case "citation.add": return <>cite {o.citation.title || o.citation.url || o.citation.note || ((D.sources as any)[o.citation.source] || {}).title || o.citation.source} on {o.fid ? <>{factName(D, o.id, o.fid)} of </> : null}{W(o.id)}</>;
    case "citation.remove": return <>remove a citation from {W(o.id)}</>;
    case "family.create": {
      const sp = [o.husband, o.wife].filter(Boolean);
      return <>create a family: {sp.length ? join(sp.map((x: string) => W(x)), " & ") : "(no spouses)"}{(o.children || []).length > 0 && <>, children {join(o.children.map((x: string) => W(x)), ", ")}</>}</>;
    }
    case "family.set_spouse": return <>set {o.role} of family {o.family} to {o.person ? W(o.person) : "nobody"}</>;
    case "family.swap_spouses": return <>swap husband and wife in family {o.family}</>;
    case "family.add_child": return <>add {W(o.person)} as a child of family {o.family}</>;
    case "family.remove_child": return <>remove {W(o.person)} from family {o.family}</>;
    case "family.delete": return <>delete family {o.family}</>;
    case "family.merge": return <>merge family {o.drop} into {o.keep}</>;
    case "source.upsert": return <>add/update source “{o.data.title}”</>;
    case "media.attach": return <>attach a photo/document to {W(o.person)}{o.caption ? `: ${o.caption}` : ""}</>;
    case "media.detach": return <>detach a photo/document from {W(o.person)}</>;
    case "media.update": return <>update photo details on {W(o.person)}: {Object.entries(o.set || {}).filter(([, v]) => v).map(([k, v]) => `${k} “${v}”`).join(", ") || "clear details"}</>;
    case "media.set_primary": return <>make a photo the main photo of {W(o.person)}</>;
    default: return <>{o.op}</>;
  }
}

// ---------------------------------------------------------------- diffs
const evText = (e: any) => [e.type, e.date, e.place, e.value].filter(Boolean).join(", ");
const nameText = (n: any) => `${n.given || ""} ${n.surname || ""}`.trim() + (n.type ? ` (${n.type})` : "");
const keyOf = (x: unknown) => JSON.stringify(x);
const listDiff = (a: any[] = [], b: any[] = []) => ({ added: b.filter((x) => !a.some((y) => keyOf(y) === keyOf(x))), removed: a.filter((x) => !b.some((y) => keyOf(y) === keyOf(x))) });
const whoName = (D: Tree, id?: string | null) => (id && D.people[id] ? D.people[id].name : id || "nobody");
const Chg = ({ label, from, to }: { label: string; from?: string; to?: string }) => <li className="d-chg"><b>{label}</b>: <del>{from || "(none)"}</del> → <ins>{to || "(none)"}</ins></li>;
const Add = ({ label, children }: { label: string; children: ReactNode }) => <li className="d-add">+ <b>{label}</b> {children}</li>;
const Del = ({ label, children }: { label: string; children: ReactNode }) => <li className="d-del">− <b>{label}</b> {children}</li>;

function factDiffs(D: Tree, label: string, a: any, b: any): ReactNode[] {
  const out: ReactNode[] = [];
  for (const k of ["date", "place", "value", "note", "age", "address", "type"]) if ((a[k] || "") !== (b[k] || "")) out.push(<Chg label={`${label} · ${k}`} from={a[k]} to={b[k]} />);
  const ra = a.review || {}, rb = b.review || {};
  if ((ra.status || "unverified") !== (rb.status || "unverified") || (ra.note || "") !== (rb.note || "")) {
    const st = rb.status === "verified" ? "verified" : rb.status === "disputed" ? "disputed" : "unverified";
    out.push(<li className="d-chg"><b>{label}</b>: marked <span className={`badge st-${st}`}>{rb.status || "unverified"}</span>{rb.note ? ` — ${rb.note}` : ""}{(rb.evidence || []).length > 0 && <span className="muted small"> (evidence: {rb.evidence.map((x: any) => citeLabel(D, x)).join("; ")})</span>}</li>);
  }
  const cd = listDiff(a.citations, b.citations);
  for (const x of cd.added) out.push(<Add label={`${label} · source`}><Cite cit={x} /></Add>);
  for (const x of cd.removed) out.push(<Del label={`${label} · source`}>{citeLabel(D, x)}</Del>);
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
  for (const [f, m] of B) if (!A.has(f)) out.push(<Add label="Photo">{label(m) + (m.portrait ? " (main photo)" : "")}</Add>);
  for (const [f, m] of A) if (!B.has(f)) out.push(<Del label="Photo">{label(m)}</Del>);
  for (const [f, m] of B) {
    const o = A.get(f);
    if (!o) continue;
    if (!o.portrait && m.portrait) out.push(<li className="d-chg"><b>Main photo</b> → {label(m)}</li>);
    for (const k of ["caption", "date", "place", "type", "note", "source"]) if ((o[k] || "") !== (m[k] || "")) out.push(<Chg label={`Photo · ${k}`} from={o[k]} to={m[k]} />);
  }
  return out;
}
/** One changed record as a list of differences. `ch` is {type, id, before, after}. */
export function diffItems(D: Tree, ch: any): ReactNode[] {
  const a = ch.before, b = ch.after, t = ch.type;
  if (t === "media" || t === "media_map") return mediaDiff(a, b);
  if (t === "finding") return [b ? <li className="d-chg"><b>Finding</b> {b.status}{b.note ? ` — ${b.note}` : ""}</li> : <li className="d-chg"><b>Finding</b> reopened</li>];
  if (t === "status") return [<Chg label="Research status" from={a && a.status} to={b && b.status} />];
  if (!a && b) return [<Add label={t === "family" ? "Family" : "Person"}>{t === "family" ? [b.husband, b.wife].filter(Boolean).map((x: string) => whoName(D, x)).join(" & ") : (b.names || []).map(nameText).join(" / ")}</Add>];
  if (a && !b) return [<Del label={t === "family" ? "Family" : "Person"}>{t === "family" ? ch.id : (a.names || []).map(nameText).join(" / ")}</Del>];
  if (!a || !b) return [];
  const out: ReactNode[] = [];
  if (t === "person") {
    if ((a.sex || "") !== (b.sex || "")) out.push(<Chg label="Sex" from={a.sex} to={b.sex} />);
    out.push(...factsDiff(D, a.names, b.names, nameText, () => "Name"));
    out.push(...factsDiff(D, a.events, b.events, evText, (e) => e.type));
    if (keyOf(a.notes || []) !== keyOf(b.notes || [])) out.push(<Chg label="Notes" from={(a.notes || []).join(" / ")} to={(b.notes || []).join(" / ")} />);
    const cd = listDiff(a.citations, b.citations);
    for (const x of cd.added) out.push(<Add label="Source"><Cite cit={x} /></Add>);
    for (const x of cd.removed) out.push(<Del label="Source">{citeLabel(D, x)}</Del>);
    for (const k of ["famc", "fams"]) {
      const d = listDiff(a[k], b[k]), l = k === "famc" ? "Parents' family" : "Own family";
      for (const f of d.added) out.push(<Add label={l}>{f}</Add>);
      for (const f of d.removed) out.push(<Del label={l}>{f}</Del>);
    }
  } else if (t === "family") {
    for (const r of ["husband", "wife"]) if ((a[r] || null) !== (b[r] || null)) out.push(<Chg label={r === "husband" ? "Husband" : "Wife"} from={whoName(D, a[r])} to={whoName(D, b[r])} />);
    const d = listDiff(a.children, b.children);
    for (const x of d.added) out.push(<Add label="Child">{whoName(D, x)}</Add>);
    for (const x of d.removed) out.push(<Del label="Child">{whoName(D, x)}</Del>);
    out.push(...factsDiff(D, a.events, b.events, evText, (e) => e.type));
  } else if (t === "source") {
    for (const k of ["title", "author", "publication", "url", "repository"]) if ((a[k] || "") !== (b[k] || "")) out.push(<Chg label={`Source · ${k}`} from={a[k]} to={b[k]} />);
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
    const title = t === "person" ? w : t === "family" ? `Family ${ch.id}` : t === "media" || t === "media_map" ? `Photos of ${w}` : t === "finding" ? `Finding #${ch.id}` : t === "status" ? `Status of ${w}` : `${t} ${ch.id}`;
    return <div className="diff" key={i}><div className="small muted">{title}</div><ul>{items.map((x, j) => <Fragment key={j}>{x}</Fragment>)}</ul></div>;
  }).filter(Boolean);
  return blocks.length ? <>{blocks}</> : <p className="small muted">No visible differences.</p>;
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
