// Close-family events for a person's life events timeline: births, deaths and marriages of their parents, siblings
// (full and half), spouses and children that happened during the person's lifetime. Pure: no React, no runtime
// imports, so tests/family-events.test.mjs can load this file directly with Node's type stripping.
import type { Tree } from "./types";

export interface FamilyEvent {
  /** "Sister born", "Husband died", "Son married", "Parents married". */
  label: string;
  /** The relative the row is about (linked after the label), or null for "Parents married". */
  who: string | null;
  /** For a marriage, the relative's partner (when visible), shown as "to …". */
  partner?: string | null;
  dateDisplay: string;
  place?: string;
  sort: number;
}

type Role = "parent" | "sibling" | "half-sibling" | "spouse" | "child";

const WORDS: Record<Role, [string, string, string]> = {
  parent: ["Father", "Mother", "Parent"],
  sibling: ["Brother", "Sister", "Sibling"],
  "half-sibling": ["Half-brother", "Half-sister", "Half-sibling"],
  spouse: ["Husband", "Wife", "Spouse"],
  child: ["Son", "Daughter", "Child"],
};
/** The relation word, by the relative's recorded sex. */
export const relationWord = (role: Role, sex?: string) => WORDS[role][sex === "M" ? 0 : sex === "F" ? 1 : 2];

const todayKey = (now: Date) => now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
const sortOf = (x: any): number | null => (x && typeof x.sort === "number" && x.sort > 0 ? x.sort : null);

/**
 * The person's lifetime as [from, to] sort keys (inclusive), or null when it can't be told without guessing.
 * From: their birth. To: their death; today if they're living; otherwise their last dated event (they were alive then).
 */
export function lifeWindow(D: Tree, id: string, now = new Date()): [number, number] | null {
  const p: any = D.people[id];
  const from = p && sortOf(p.birth);
  if (!from) return null;
  let to = sortOf(p.death);
  if (!to && p.living) to = todayKey(now);
  if (!to) to = Math.max(from, ...(p.events || []).map(sortOf).filter((s: number | null): s is number => s != null));
  return [from, to];
}

/** Close-family events within the person's lifetime, sorted by date. Undated events and hidden or private people are left out. */
export function familyEvents(D: Tree, id: string, now = new Date()): FamilyEvent[] {
  const P = D.people as Record<string, any>, F = D.families as Record<string, any>;
  const me = P[id];
  const win = me && lifeWindow(D, id, now);
  if (!win) return [];
  // only people the viewer can see in full: hidden people aren't in the tree at all; "names-only" ones are private
  const visible = (x?: string | null): x is string => !!x && x !== id && !!P[x] && !P[x].private;

  // who's who, closest relation first (a person is listed once)
  const role = new Map<string, Role>();
  const add = (x: string | null | undefined, r: Role) => { if (visible(x) && !role.has(x)) role.set(x, r); };
  const parents: string[] = [];
  for (const fid of me.famc || []) { const f = F[fid]; if (!f) continue; for (const x of [f.husband, f.wife]) if (x) { add(x, "parent"); parents.push(x); } }
  for (const fid of me.fams || []) { const f = F[fid]; if (!f) continue; add(f.husband === id ? f.wife : f.husband, "spouse"); for (const c of f.children || []) add(c, "child"); }
  for (const fid of me.famc || []) for (const c of F[fid]?.children || []) add(c, "sibling");
  for (const x of parents) for (const fid of P[x]?.fams || []) {
    if ((me.famc || []).includes(fid)) continue;
    for (const c of F[fid]?.children || []) add(c, "half-sibling");
  }

  const out: FamilyEvent[] = [];
  const inWindow = (s: number | null): s is number => s != null && s >= win[0] && s <= win[1];
  const push = (label: string, who: string | null, ev: any, sort: number, partner?: string | null) =>
    out.push({ label, who, ...(partner !== undefined ? { partner } : {}), dateDisplay: ev.dateDisplay || ev.date || "", ...(ev.place ? { place: ev.place } : {}), sort });

  for (const [x, r] of role) {
    const rp = P[x], word = relationWord(r, rp.sex);
    const b = sortOf(rp.birth), d = sortOf(rp.death);
    if (inWindow(b)) push(`${word} born`, x, rp.birth, b);
    if (inWindow(d)) push(`${word} died`, x, rp.death, d);
  }

  // marriages: each family once; the person's own marriages are already their own events
  const seen = new Set<string>();
  for (const [x, r] of role) for (const fid of P[x].fams || []) {
    const f = F[fid];
    if (!f || seen.has(fid) || f.husband === id || f.wife === id) continue;
    seen.add(fid);
    const partner = f.husband === x ? f.wife : f.husband;
    // a living relative's partner whose details are withheld: say nothing about the marriage
    if (partner && P[partner] && P[partner].private) continue;
    for (const e of f.events || []) {
      if (e.type !== "Marriage" || !inWindow(sortOf(e))) continue;
      const bothParents = r === "parent" && partner && role.get(partner) === "parent";
      if (bothParents) push("Parents married", null, e, e.sort as number);
      else push(`${relationWord(r, P[x].sex)} married`, x, e, e.sort as number, visible(partner) ? partner : null);
    }
  }
  return out.sort((a, b) => a.sort - b.sort);
}
