// Everyone in the tree, grouped by surname, with filters kept in the URL (?q=&branch=&status=&direct=1).
import { Fragment, useEffect, useMemo, useState } from "react";
import { useLocation, useSearchParams } from "react-router";
import { isUnknown, norm, useTitle } from "../lib";
import { STATUS_LABEL } from "../tree";
import { PCard, useBrowse, type BPerson } from "./browse/shared";

interface Filters { q: string; b: string; s: string; d: boolean }
const fromParams = (ps: URLSearchParams): Filters => ({ q: ps.get("q") || "", b: ps.get("branch") || "", s: ps.get("status") || "", d: !!ps.get("direct") });
function toSearch(f: Filters) {
  const ps = new URLSearchParams();
  if (norm(f.q)) ps.set("q", f.q);
  if (f.b) ps.set("branch", f.b);
  if (f.s) ps.set("status", f.s);
  if (f.d) ps.set("direct", "1");
  const s = ps.toString();
  return s ? `?${s}` : "";
}

export function People() {
  useTitle("People");
  const { people, branches } = useBrowse();
  const [params, setParams] = useSearchParams();
  const loc = useLocation();
  const [f, setF] = useState<Filters>(() => fromParams(params));

  // A navigation to /people?… from elsewhere (e.g. the header's People link while here) sets the filters from the URL;
  // the URL updates this page makes itself are marked in their history state.
  useEffect(() => {
    if (!(loc.state as { pf?: boolean } | null)?.pf) setF(fromParams(new URLSearchParams(loc.search)));
  }, [loc.key]); // eslint-disable-line react-hooks/exhaustive-deps
  // Keep the URL in step with the filters, without adding history entries.
  useEffect(() => {
    const s = toSearch(f);
    if (s !== loc.search) setParams(new URLSearchParams(s), { replace: true, state: { pf: true } });
  }, [f]); // eslint-disable-line react-hooks/exhaustive-deps

  const branchOpts = useMemo(() => Object.values(branches).filter((b) => people.some((p) => p.branch === b.key)), [branches, people]);
  const list = useMemo(() => {
    const q = norm(f.q);
    return people.filter((p) => !isUnknown(p) && (!f.b || p.branch === f.b) && (!f.s || p.status === f.s) && (!f.d || p.direct) &&
      (!q || norm(p.name + " " + p.names.map((n) => n.given + " " + n.surname).join(" ") + " " + p.events.map((e) => e.place || "").join(" ")).includes(q)))
      .sort((x, y) => (x.surname || "~").localeCompare(y.surname || "~") || x.given.localeCompare(y.given));
  }, [people, f]);
  const groups = useMemo(() => {
    const out: { surname: string; people: BPerson[] }[] = [];
    for (const p of list) {
      if (!out.length || out[out.length - 1].surname !== p.surname) out.push({ surname: p.surname, people: [] });
      out[out.length - 1].people.push(p);
    }
    return out;
  }, [list]);

  return (
    <div className="wrap page">
      <h1>People</h1>
      <div className="filters">
        <input id="pf-q" type="search" placeholder="Filter by name or place…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <select id="pf-b" value={f.b} onChange={(e) => setF({ ...f, b: e.target.value })}>
          <option value="">All branches</option>{branchOpts.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
        </select>
        <select id="pf-s" value={f.s} onChange={(e) => setF({ ...f, s: e.target.value })}>
          <option value="">Any status</option>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <label className="small"><input id="pf-d" type="checkbox" checked={f.d} onChange={(e) => setF({ ...f, d: e.target.checked })} /> Direct ancestors only</label>
        <span id="pf-n" className="muted small">{list.length} people</span>
      </div>
      <div id="pf-out">
        {groups.length ? groups.map((g, i) => (
          <Fragment key={`${i}-${g.surname}`}>
            <div className="letter-head">{g.surname || "No surname"}</div>
            <div className="people-grid">{g.people.map((p) => <PCard key={p.id} p={p} />)}</div>
          </Fragment>
        )) : <div className="empty">No one matches.</div>}
      </div>
    </div>
  );
}
