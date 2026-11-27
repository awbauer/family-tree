// Places, gathered once per loaded tree: every event (people's and families') and every photo or document that is
// on the map, by place key, plus the place texts that aren't on the map yet. Shared by the Places page, the place
// pages and the person page's map.
import { documentType } from "./documents";
import type { BEvent, BPerson, BTree, Place } from "./pages/browse/shared";

/** One event at a place. A family event (a marriage) is a visit for each spouse; the second is marked `again`. */
export interface Visit { p: BPerson; e: BEvent; spouse?: string | null; again?: boolean }
export interface Artifact { pid: string; m: any; here: "made" | "named" }
export interface PlaceInfo extends Place {
  key: string;
  visits: Visit[];
  people: string[];            // ids, in order of first visit
  artifacts: Artifact[];       // one per file (the first person it's linked to)
  from: number | null; to: number | null;
  texts: string[];             // the place texts in the tree that resolve here
}
export interface Unplaced { text: string; visits: Visit[]; people: string[] }

export const yearOf = (e: { sort?: number | null }) => (e.sort ? Math.floor(e.sort / 10000) : null);
export const PLACE_TYPES = ["country", "region", "county", "city", "district", "street", "building", "cemetery", "church", "landmark", "other"] as const;

export const isPhoto = (m: { file: string; image?: boolean }) => !documentType(m.file) || !!m.image;

interface Built {
  index: Record<string, PlaceInfo>;          // places something points at, with what
  unplaced: Unplaced[];                      // place texts on no place
  byText: Map<string, string>;               // place text → key
  kids: Record<string, string[]>;            // key → the places directly inside it, by name
  roots: string[];                           // places inside no other, by name
}
const cache = new WeakMap<object, Built>();

function build(D: BTree, people: BPerson[]) {
  const places = D.places || {};
  const index: Record<string, PlaceInfo> = {};
  const loose = new Map<string, Unplaced>();
  const info = (k: string) => (index[k] = index[k] || { key: k, ...places[k], visits: [], people: [], artifacts: [], from: null, to: null, texts: [] });
  const visit = (v: Visit) => {
    const e = v.e;
    if (!e.place || e.misfiled) return;
    if (e.placeKey && places[e.placeKey]) {
      const pl = info(e.placeKey);
      pl.visits.push(v);
      if (!pl.people.includes(v.p.id)) pl.people.push(v.p.id);
      if (!pl.texts.includes(e.place)) pl.texts.push(e.place);
      const y = yearOf(e);
      if (y) { pl.from = pl.from == null ? y : Math.min(pl.from, y); pl.to = pl.to == null ? y : Math.max(pl.to, y); }
    } else if (!v.p.private) {
      const u = loose.get(e.place) || { text: e.place, visits: [], people: [] };
      u.visits.push(v);
      if (!u.people.includes(v.p.id)) u.people.push(v.p.id);
      loose.set(e.place, u);
    }
  };
  const byId = D.people;
  for (const p of people) for (const e of p.events || []) visit({ p, e });
  for (const f of Object.values(D.families || {})) for (const e of (f.events || []) as BEvent[]) {
    let n = 0;
    for (const [a, b] of [[f.husband, f.wife], [f.wife, f.husband]]) if (a && byId[a]) visit({ p: byId[a], e, spouse: b && byId[b] ? b : null, again: n++ > 0 });
  }
  const seen = new Set<string>();
  for (const [pid, list] of Object.entries(((D.research as any).media || {}) as Record<string, any[]>)) {
    if (!byId[pid]) continue;
    for (const m of list || []) (m.placeKeys || []).forEach((k: string, i: number) => {
      if (!places[k] || seen.has(`${k}|${m.file}`)) return;
      seen.add(`${k}|${m.file}`);
      info(k).artifacts.push({ pid, m, here: i === 0 && m.place ? "made" : "named" });
    });
  }
  for (const pl of Object.values(index)) pl.visits.sort((a, b) => (a.e.sort || 9e9) - (b.e.sort || 9e9));
  const byText = new Map<string, string>();
  for (const pl of Object.values(index)) for (const t of pl.texts) byText.set(t, pl.key);
  for (const [k, pl] of Object.entries(places)) if (!byText.has(pl.name)) byText.set(pl.name, k);
  const unplaced = [...loose.values()].sort((a, b) => b.visits.length - a.visits.length || a.text.localeCompare(b.text));
  const kids: Record<string, string[]> = {}, roots: string[] = [];
  const short = (k: string) => places[k].short || places[k].name;
  for (const [k, pl] of Object.entries(places)) if (pl.parent && places[pl.parent]) (kids[pl.parent] = kids[pl.parent] || []).push(k); else roots.push(k);
  for (const list of [roots, ...Object.values(kids)]) list.sort((a, b) => short(a).localeCompare(short(b)));
  return { index, unplaced, byText, kids, roots };
}

/** The place and every place inside it, nearest first. */
export function within(b: Built, key: string) {
  const out = [key];
  for (let i = 0; i < out.length; i++) out.push(...(b.kids[out[i]] || []));
  return out;
}

/** The places that enclose a place, outermost first. */
export function enclosing(D: BTree, key: string) {
  const places = D.places || {}, out: string[] = [];
  for (let at = places[key]?.parent; at && places[at] && !out.includes(at) && out.length < 20; at = places[at].parent) out.unshift(at);
  return out;
}

/** What happened at a place and inside it: visits and artifacts, each with the key of where exactly. */
export function rollup(b: Built, key: string) {
  const visits: (Visit & { at: string })[] = [], artifacts: (Artifact & { at: string })[] = [], people: string[] = [];
  let from: number | null = null, to: number | null = null;
  const files = new Set<string>();
  for (const k of within(b, key)) {
    const pl = b.index[k];
    if (!pl) continue;
    for (const v of pl.visits) visits.push({ ...v, at: k });
    for (const a of pl.artifacts) if (!files.has(a.m.file)) { files.add(a.m.file); artifacts.push({ ...a, at: k }); }
    for (const id of pl.people) if (!people.includes(id)) people.push(id);
    if (pl.from != null) from = from == null ? pl.from : Math.min(from, pl.from);
    if (pl.to != null) to = to == null ? pl.to : Math.max(to, pl.to);
  }
  visits.sort((a, c) => (a.e.sort || 9e9) - (c.e.sort || 9e9));
  return { visits, artifacts, people, from, to };
}

/** Every place on the map that something in this tree points at, by key (computed once per loaded tree). */
export function placeIndex(D: BTree, people: BPerson[]): Built {
  let c = cache.get(D);
  if (!c) cache.set(D, (c = build(D, people)));
  return c;
}

/** Distance in km between two points (haversine). */
export function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

/** The first part of a place name ("Leeds" of "Leeds, England"), for finding it in story text. */
export const shortName = (name: string) => String(name || "").split(",")[0].trim();

/** Stories that name the place (its short name, or one of the place texts that resolve to it). */
export function storiesAt(D: BTree, pl: { name: string; short?: string; texts: string[]; names?: { name: string }[] }) {
  const words = [...new Set([pl.short || shortName(pl.name), ...pl.texts.map(shortName), ...(pl.names || []).map((n) => n.name)])].filter((w) => w.length >= 4);
  if (!words.length) return [];
  const rx = new RegExp(`(?<![\\p{L}\\p{N}])(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}\\p{N}])`, "iu");
  return (D.research.stories || []).filter((s) => rx.test(`${s.title} ${s.body || ""}`));
}

/** A key for a new place: its name in lower-case ASCII with hyphens ("14 Fenwick Row, Leeds" → 14-fenwick-row-leeds). */
export function placeKeyFor(name: string, taken: Record<string, unknown>) {
  const base = String(name).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56) || "place";
  let k = base, n = 2;
  while (Object.hasOwn(taken, k)) k = `${base}-${n++}`;
  return k;
}

/** How deep a place sits: 0 for one inside no other (a country, usually). */
export function depthOf(D: BTree, key: string) { return enclosing(D, key).length; }

/** The place itself or the one enclosing it at `depth` (0 = outermost); a place shallower than that is itself. */
export function atDepth(D: BTree, key: string, depth: number) {
  const chain = [...enclosing(D, key), key];
  return chain[Math.min(depth, chain.length - 1)];
}

/** The keys of a place and every place inside it, for "in this place" filters (empty key: no filter). */
export function inPlace(D: BTree, people: BPerson[], key: string): Set<string> | null {
  if (!key || !(D.places || {})[key]) return null;
  return new Set(within(placeIndex(D, people), key));
}

/** Where a fact is on the map: its place key, or the key of a place whose texts or full name its text is. */
export function placeOfEvent(b: Built, e: { placeKey?: string; place?: string }) {
  return (e.placeKey && b.index[e.placeKey] ? e.placeKey : e.place ? b.byText.get(e.place) : undefined) || null;
}

/**
 * The places as options for a "within" filter, nested (indented by depth) in hierarchy order: only places where
 * something happened, in them or inside them, and only those with places inside them unless `leaves` is set.
 */
export function placeOptions(D: BTree, people: BPerson[], { leaves = false } = {}) {
  const b = placeIndex(D, people), places = D.places || {};
  const out: { key: string; label: string; depth: number }[] = [];
  const busy = (k: string): boolean => !!b.index[k] || (b.kids[k] || []).some(busy);
  const walk = (k: string, d: number) => {
    if (!busy(k)) return;
    if (leaves || (b.kids[k] || []).some(busy)) out.push({ key: k, label: places[k].short || places[k].name, depth: d });
    for (const c of b.kids[k] || []) walk(c, d + 1);
  };
  for (const r of b.roots) walk(r, 0);
  return out;
}
