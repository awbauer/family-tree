// The places, as suggestions for a place box (<input list="w-places">). Choosing one types its full name; the form then
// links the fact to that place record (place_ref) and keeps the name as the fact's place text.
import { useData } from "../../data";
import type { Place } from "./shared";

export function PlaceOptions({ id = "w-places" }: { id?: string }) {
  const { D } = useData();
  const places = ((D as any).places || {}) as Record<string, Place>;
  return <datalist id={id}>{Object.values(places).map((p) => p.name).sort((a, b) => a.localeCompare(b)).map((n) => <option key={n} value={n} />)}</datalist>;
}

/** The place record whose full name a place text is, if any. */
export function placeRefFor(D: any, text: string | undefined) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return null;
  for (const [k, p] of Object.entries((D.places || {}) as Record<string, Place>)) if (p.name.toLowerCase() === t) return k;
  return null;
}
