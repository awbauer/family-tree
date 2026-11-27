// A "within this place" filter: the places, nested by the hierarchy (country, then region, then town…). Choosing a
// place means it and every place inside it.
import { useMemo } from "react";
import { placeOptions } from "../../places";
import { useBrowse } from "./shared";
import { S } from "../../../../strings/index.ts";

export function PlaceSelect({ value, onChange, id, leaves = true, label = S.places.filter.label }: { value: string; onChange: (key: string) => void; id?: string; leaves?: boolean; label?: string }) {
  const { D, people } = useBrowse();
  const opts = useMemo(() => placeOptions(D, people, { leaves }), [D, people, leaves]);
  if (!opts.length) return null;
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className="place-select">
      <option value="">{S.places.filter.anywhere}</option>
      {opts.map((o) => <option key={o.key} value={o.key}>{"  ".repeat(o.depth)}{o.label}</option>)}
    </select>
  );
}
