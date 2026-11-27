// Births, deaths, marriages, arrivals and service by decade, with historical context. ?scope=direct|all&place=<key>
// (only events in that place or a place inside it; the historical context is left out then).
import { Fragment, useMemo, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { branchColor, PersonLink, useTitle } from "../lib";
import { eventLabel, spousesOf } from "../tree";
import { useBranchStyle } from "../ui";
import { useBrowse, type ContextRow } from "./browse/shared";
import { PlaceSelect } from "./browse/PlaceSelect";
import { inPlace, placeIndex, placeOfEvent } from "../places";
import { S } from "../../../strings/index.ts";

const T = S.browse.timeline;

const TYPES = new Set(["Birth", "Death", "Arrival", "Marriage", "Military", "NaturalizationPetition"]);
interface Row { sort: number; date?: string; body: ReactNode; br?: string; ctx?: boolean }

export function Timeline() {
  useTitle(T.title);
  const { D, people, branches } = useBrowse();
  const bstyle = useBranchStyle();
  const [params, setParams] = useSearchParams();
  const scope = params.get("scope") || "direct", place = params.get("place") || "";
  const go = (patch: Record<string, string>) => { const ps = new URLSearchParams(params); for (const [k, v] of Object.entries(patch)) if (v) ps.set(k, v); else ps.delete(k); setParams(ps, { replace: true }); };
  const rows = useMemo(() => {
    const rows: Row[] = [];
    const keys = inPlace(D, people, place), built = placeIndex(D, people);
    const here = (e: any) => !keys || keys.has(placeOfEvent(built, e) || "");
    for (const p of people) {
      if (scope === "direct" && !p.direct) continue;
      for (const e of p.events) if (TYPES.has(e.type) && e.sort && !e.misfiled && here(e))
        rows.push({ sort: e.sort, date: e.dateDisplay, body: <><PersonLink id={p.id} /> — {eventLabel(e).toLowerCase()}{e.place ? `, ${e.place}` : ""}</>, br: p.branch });
    }
    const seenFam = new Set<string>();
    for (const p of people) {
      if (scope === "direct" && !p.direct) continue;
      for (const { fam, spouse } of spousesOf(D, p.id)) {
        if (seenFam.has(fam.id)) continue;
        seenFam.add(fam.id);
        for (const e of fam.events || []) if (e.sort && e.type === "Marriage" && here(e))
          rows.push({ sort: e.sort, date: e.dateDisplay, body: <><PersonLink id={p.id} />{T.married}{spouse ? <PersonLink id={spouse} /> : "?"}{e.place ? `, ${e.place}` : ""}</>, br: p.branch });
      }
    }
    if (!keys) for (const c of ((D.research as any).context || []) as ContextRow[])
      rows.push({ sort: c.year * 10000 + (c.month || 6) * 100 + 15, date: String(c.year), body: <><b>{c.title}</b>{c.text ? ` — ${c.text}` : ""}</>, ctx: true });
    return rows.sort((a, b) => a.sort - b.sort);
  }, [D, people, scope, place]);

  let dec: number | null = null;
  return (
    <div className="wrap page"><h1>{T.title}</h1>
      <div className="filters"><div className="seg">
        <button data-s="direct" className={scope === "direct" ? "on" : ""} onClick={() => go({ scope: "direct" })}>{T.direct}</button>
        <button data-s="all" className={scope === "all" ? "on" : ""} onClick={() => go({ scope: "all" })}>{T.everyone}</button>
      </div>
        <PlaceSelect value={place} onChange={(k) => go({ place: k })} />
        {!place && <span className="small muted">{T.hint}</span>}</div>
      {rows.map((r, i) => {
        const d = Math.floor(r.sort / 100000) * 10;
        const head = d !== dec ? <div className="decade">{T.decade(d)}</div> : null;
        dec = d;
        return (
          <Fragment key={i}>
            {head}
            <div className={`tl-row${r.ctx ? " ctx" : ""}`} style={r.br ? bstyle(r.br) : undefined}>
              <div className="d">{r.date}</div>
              <div className="w" style={r.br ? { borderLeft: `3px solid ${branchColor(r.br, branches)}`, paddingLeft: 10 } : undefined}>{r.body}</div>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
