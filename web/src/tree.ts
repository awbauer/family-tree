// Pure helpers over the tree data (/api/tree). No React here; components use these through useData().
import type { Family, Person, Story, Tree } from "./types";

export const STATUS_LABEL: Record<string, string> = { verified: "Verified", "partly-verified": "Partly verified", unverified: "Unverified", disputed: "Disputed" };
export const FINDING_KINDS: Record<string, string> = { confirmed: "Confirmed", correction: "Correction", conflict: "Conflict", "new-fact": "New fact", "new-person": "New person", "data-error": "Data error" };

const famOf = (D: Tree, fid: string): Family | undefined => D.families[fid];

export function parentsOf(D: Tree, id: string) {
  return (D.people[id]?.famc || []).map((fid) => famOf(D, fid)).filter(Boolean).map((f) => ({ fam: f!, father: f!.husband || null, mother: f!.wife || null }));
}
export function spousesOf(D: Tree, id: string) {
  return (D.people[id]?.fams || []).map((fid) => famOf(D, fid)).filter(Boolean).map((f) => ({ fam: f!, spouse: (f!.husband === id ? f!.wife : f!.husband) || null, children: f!.children || [] }));
}
export const birthKey = (D: Tree, id: string) => (D.people[id]?.birth as any)?.sort || 99999999;
export const byBirth = (D: Tree) => (a: string, b: string) => birthKey(D, a) - birthKey(D, b);
export function siblingsOf(D: Tree, id: string) {
  const set = new Set<string>();
  for (const fid of D.people[id]?.famc || []) for (const c of famOf(D, fid)?.children || []) if (c !== id) set.add(c);
  return [...set].sort(byBirth(D));
}

const R = (D: Tree) => D.research as any;
export const findingsFor = (D: Tree, id: string): any[] => (R(D).findings || []).filter((f: any) => f.person === id);
export const todosFor = (D: Tree, id: string): any[] => (R(D).todo || []).filter((t: any) => t.person === id);
export const storiesFor = (D: Tree, id: string): Story[] => (D.research.stories || []).filter((s) => (s.people || []).includes(id));
/** People a story links in its text ([[I12|…]]), with merged-away ids followed to the person they became. */
export const linkedIn = (D: Tree, s: Story) => new Set([...String(s.body || "").matchAll(/\[\[(I[\w-]+)/g)].map((m) => (D.aliases || {})[m[1]] || m[1]));
/** Stories that mention this person in their text without being about them. */
export const mentionsFor = (D: Tree, id: string) => (D.research.stories || []).filter((s) => !(s.people || []).includes(id) && linkedIn(D, s).has(id));

/** One fact (or person, or photo) that cites a catalogued source, with the citations of it there. */
export interface SourceUse { person: string; family?: string; fid?: string; fact: string; citations: any[]; file?: string }
/**
 * Every use of every catalogued source, by source id: facts on people (events and names), the person as a whole,
 * family events (listed under each spouse), review evidence and photos. One entry per fact, so a fact that cites a
 * source twice counts once.
 */
export function sourceUses(D: Tree): Record<string, SourceUse[]> {
  const out: Record<string, SourceUse[]> = {};
  const add = (sid: string, u: Omit<SourceUse, "citations">, c: any) => {
    const list = (out[sid] = out[sid] || []);
    let x = list.find((y) => y.person === u.person && y.family === u.family && y.fid === u.fid && y.file === u.file);
    if (!x) list.push((x = { ...u, citations: [] }));
    if (c && !x.citations.some((y) => JSON.stringify(y) === JSON.stringify(c))) x.citations.push(c);
  };
  const fact = (f: any, u: Omit<SourceUse, "citations">) => {
    for (const c of f.citations || []) if (c && c.source) add(c.source, u, c);
    for (const c of (f.review && f.review.evidence) || []) if (c && c.source) add(c.source, u, c);
  };
  const label = (e: any) => [eventLabel(e), e.date].filter(Boolean).join(" ");
  for (const p of Object.values(D.people) as any[]) {
    for (const c of p.citations || []) if (c && c.source) add(c.source, { person: p.id, fact: "the person" }, c);
    for (const n of p.names || []) fact(n, { person: p.id, fid: n.fid, fact: `name ${`${n.given || ""} ${n.surname || ""}`.trim()}` });
    for (const e of p.events || []) fact(e, { person: p.id, fid: e.fid, fact: label(e) });
  }
  for (const f of Object.values(D.families) as any[]) {
    const sp = [f.husband, f.wife].filter((x: string | null | undefined) => x && D.people[x]);
    for (const e of f.events || []) for (const s of sp) fact(e, { person: s, family: f.id, fid: e.fid, fact: label(e) });
  }
  for (const [pid, list] of Object.entries(((D.research as any).media || {}) as Record<string, any[]>)) {
    for (const m of list || []) if (m && m.source && D.people[pid]) add(m.source, { person: pid, file: m.file, fact: `photo: ${m.caption || m.file.split("/").pop()}` }, null);
  }
  return out;
}
/** How many facts, people and photos a source's uses are (a family fact listed under both spouses counts once). */
export const citeCount = (uses: SourceUse[] = []) => new Set(uses.map((u) => (u.family ? `${u.family}/${u.fid}` : `${u.person}/${u.fid || ""}/${u.file || ""}`))).size;

export function apidLink(apid?: string) {
  const m = /^\d+,(\d+)::(\d+)$/.exec(apid || "");
  if (!m || m[2] === "0") return "";
  return `https://www.ancestry.com/discoveryui-content/view/${m[2]}:${m[1]}`;
}
const EVENT_LABEL: Record<string, string> = { Residence: "Lived in", Arrival: "Arrived", Departure: "Departed", Burial: "Buried", Military: "Military service", NaturalizationPetition: "Naturalization petition" };
export const eventLabel = (e: { type: string }) => EVENT_LABEL[e.type] || e.type;
export const mediaUrl = (f: string) => (/^(https?:)?\/\//.test(f) || f.startsWith("/") ? f : "media/" + f.replace(/^media\//, ""));
export const initials = (p: Person) => (p.given[0] || "?") + (p.surname[0] || "");

/** "me", "🤖 researcher" or the part of an email before the @. */
export const whoText = (principal: string | null | undefined, x?: string | null) =>
  !x ? "—" : principal && x === principal ? "me" : x.startsWith("service:") || x.startsWith("agent:") ? "🤖 " + x.replace(/^(service|agent):/, "") : x.split("@")[0];

export function ago(iso?: string | null) {
  if (!iso) return "";
  const d = (Date.now() - Date.parse(iso)) / 86400000;
  return d < 1 ? "today" : d < 2 ? "yesterday" : d < 31 ? `${Math.floor(d)} days ago` : iso.slice(0, 10);
}

/** The first name of the home person, for "<name>'s great-grandfather". */
export const homeFirst = (D: Tree) => (D.people[D.home] && D.people[D.home].given.split(" ")[0]) || "the home person";
