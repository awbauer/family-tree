// Life events (own, own marriages, close family's births/deaths/marriages, historical context) with footnoted
// citations, and, when the API is live, each fact's verification badge, review form and provenance.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { store, useData } from "../../data";
import { familyEvents } from "../../familyEvents";
import { PersonLink, norm } from "../../lib";
import { CitationFields, Cite, fillCitation, readCitation, SourceLink } from "../../ops";
import { ago, apidLink, eventLabel, spousesOf } from "../../tree";
import { Linkify, useBranchStyle, useWho } from "../../ui";
import type { Tree } from "../../types";
import { usePerson } from "./context";
import { S } from "../../../../strings/index.ts";

const T = S.person.lifeEvents;

interface Item { e: any; sort?: number | null; kind: "own" | "fam" | "kin" | "ctx" }

/** The timeline items and the footnotes they cite (numbered in the order they first appear, then the person's own). */
export function buildTimeline(D: Tree, id: string) {
  const p = D.people[id] as any, R = D.research as any;
  const spouses = spousesOf(D, id);
  const items: Item[] = [];
  p.events.forEach((e: any) => items.push({ e, sort: e.sort, kind: "own" }));
  spouses.forEach(({ fam, spouse }) => (fam.events || []).forEach((e) => items.push({ e: { ...e, withWho: spouse }, sort: e.sort, kind: "fam" })));
  // close family's births, deaths and marriages in the person's lifetime (after their own events on the same date: the sort is stable)
  familyEvents(D, id).forEach((fe) => items.push({ e: { type: fe.label, dateDisplay: fe.dateDisplay, place: fe.place, who: fe.who, partner: fe.partner }, sort: fe.sort, kind: "kin" }));
  const by = p.birth && p.birth.year, dy = (p.death && p.death.year) || (p.living ? new Date().getFullYear() : by && by + 80);
  (R.context || []).forEach((c: any) => {
    if (by && dy && c.year >= by && c.year <= dy && (!c.branches || c.branches.includes(p.branch)) && (!c.places || p.events.some((e: any) => c.places.includes(e.placeKey))))
      items.push({ e: { type: "ctx", text: c.title }, sort: c.year * 10000 + 615, kind: "ctx" });
  });
  items.sort((a, b) => (a.sort || 99999999) - (b.sort || 99999999));
  // drop repeats: an undated event that duplicates a dated one (same type & place), or a vaguer copy of the same event in the same year
  const kept: Item[] = [];
  items.forEach((it) => {
    const e = it.e;
    if (it.kind === "ctx" || it.kind === "kin" || e.misfiled) return kept.push(it);
    const pl = (x?: string) => norm((x || "").split(",")[0]);
    const dupe = kept.find((k) => k.kind === it.kind && k.e.type === e.type && (!e.place || !k.e.place || pl(k.e.place) === pl(e.place)) && (k.e.withWho || null) === (e.withWho || null) &&
      (!it.sort || (k.sort && Math.floor(k.sort / 10000) === Math.floor(it.sort / 10000) && (e.type === "Marriage" || e.type === "Birth" || e.type === "Death"))));
    if (dupe) { dupe.e = { ...dupe.e, citations: (dupe.e.citations || []).concat(e.citations || []) }; return; }
    kept.push(it);
  });
  const notes: any[] = [], noteIdx = new Map<string, number>();
  const cite = (c: any) => {
    const key = [c.source, c.title, c.url, c.page].map((x) => x || "").join("|");
    if (!noteIdx.has(key)) { notes.push(c); noteIdx.set(key, notes.length); }
    return noteIdx.get(key)!;
  };
  const rows = kept.map((it) => ({ ...it, cites: it.kind === "ctx" ? [] : (it.e.citations || []).map(cite) }));
  (p.citations || []).forEach(cite);
  return { rows, notes };
}

function FnLink({ n }: { n: number }) {
  return <a href={`#fn-${n}`} onClick={(ev) => { ev.preventDefault(); document.getElementById(`fn-${n}`)?.scrollIntoView({ behavior: "smooth", block: "center" }); }}>{n}</a>;
}

export function FactBadge({ r }: { r?: any }) {
  if (!r || !r.status || r.status === "unverified") return null;
  const tip = T.badgeTip(r.status, r.by || "?", (r.at || "").slice(0, 10), r.note, (r.evidence || []).length);
  return <>{" "}<span className={`badge st-${r.status === "verified" ? "verified" : "disputed"}`} title={tip}>{r.status}</span></>;
}

/** Set to "0" (per browser) when the viewer turns family events off; they're on by default. */
const KIN_KEY = "lifeEvents:family";

export function LifeEvents() {
  const { D, live } = useData();
  const { id, p } = usePerson();
  const bstyle = useBranchStyle();
  const [showKin, setShowKin] = useState(() => store.get(KIN_KEY) !== "0");
  const all = buildTimeline(D, id).rows;
  const hasKin = all.some((r) => r.kind === "kin");
  const rows = showKin ? all : all.filter((r) => r.kind !== "kin");
  // #/person/I5?fact=e3 (e.g. from a source's page) points at one fact
  const target = useSearchParams()[0].get("fact");
  useEffect(() => {
    if (target) document.querySelector(`.t-body[data-fid="${CSS.escape(target)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [target]);
  return (
    <section className="card">
      <div className="life-head">
        <h2>{T.title}</h2>
        {hasKin && <label className="small muted kin-toggle"><input type="checkbox" checked={showKin}
          onChange={(ev) => { setShowKin(ev.target.checked); store.set(KIN_KEY, ev.target.checked ? null : "0"); }} /> {T.familyToggle}</label>}
      </div>
      {rows.length ? (
        <ul className="timeline-list" style={bstyle(p.branch)}>
          {rows.map((it, i) => {
            const { e, kind } = it;
            if (kind === "ctx") return <li className="ctx" key={i}><div className="t-date">{String(it.sort).slice(0, 4)}</div><span className="t-dot"></span><div className="t-body">{e.text}</div></li>;
            let what: ReactNode = <><b>{eventLabel(e)}</b>{e.value && e.type !== "Residence" ? ` — ${e.value}` : ""}</>;
            if (kind === "fam") what = <><b>{e.type === "Marriage" ? T.married : e.type}</b>{e.withWho ? <> <PersonLink id={e.withWho} /></> : null}</>;
            if (kind === "kin") what = <><b>{e.type}{e.who ? ":" : ""}</b>{e.who && <> <PersonLink id={e.who} /></>}{e.partner && <> {T.to} <PersonLink id={e.partner} /></>}</>;
            const own = kind === "own" && e.fid;
            return (
              <li key={i} className={kind === "kin" ? "kin" : e.misfiled ? "misfiled" : ""}>
                <div className="t-date">{e.dateDisplay || T.undated}</div><span className="t-dot"></span>
                <div className={`t-body${own && e.fid === target ? " fact-target" : ""}`} data-fid={own ? e.fid : undefined}>
                  {what}{e.place && <> <span className="t-place">· {e.place}</span></>}
                  {it.cites.length > 0 && <sup className="cite">{it.cites.map((n: number, j: number) => <span key={j}>{j > 0 && ","}<FnLink n={n} /></span>)}</sup>}
                  {e.note ? <div className="t-note">{e.note}</div> : e.address ? <div className="t-note">{e.address}</div> : null}
                  {e.misfiled && <div className="t-note sev-warn">{T.misfiled}</div>}
                  {own && live && <FactTools fid={e.fid} />}
                </div>
              </li>
            );
          })}
        </ul>
      ) : <p className="muted">{T.none}</p>}
      {p.notes.length > 0 && <><h3 style={{ marginTop: 20 }}>{T.notes}</h3>{p.notes.map((n: string, i: number) => <p className="small" key={i}><Linkify text={n} /></p>)}</>}
    </section>
  );
}

/** "n of m facts verified" for the header (live only). */
export function FactsChip() {
  const { p } = usePerson();
  const own = (p.events || []).filter((e: any) => e.fid);
  if (!own.length) return null;
  const nV = own.filter((e: any) => e.review && e.review.status === "verified").length, nD = own.filter((e: any) => e.review && e.review.status === "disputed").length;
  return <>{" "}<span className="chip" title={T.factsTitle}>{T.factsVerified(nV, own.length)}{nD ? T.factsDisputed(nD) : ""}</span></>;
}

function FactTools({ fid }: { fid: string }) {
  const { p, verify, setVerify } = usePerson();
  const [prov, setProv] = useState(false);
  const e = (p.events || []).find((x: any) => x.fid === fid);
  if (!e) return null;
  const open = verify && verify.at === "fact" && verify.fid === fid;
  return (
    <>
      <FactBadge r={e.review} />{" "}
      <button className="linklike fact-verify" data-fid={fid} onClick={() => setVerify({ fid, at: "fact", preset: {} })}>{e.review && e.review.status !== "unverified" ? T.review : T.verify}</button>{" "}
      <button className="linklike fact-prov" data-fid={fid} onClick={() => setProv((x) => !x)}>{T.history}</button>
      {open && <VerifyForm e={e} preset={verify!.preset} />}
      {prov && <Provenance fid={fid} />}
    </>
  );
}

const KIND: Record<string, string> = T.provenance.kinds;

/** One fact's chain (PROV-O, from /api/prov): each change to it, who made it (and on whose behalf), why, from which sources. */
function Provenance({ fid }: { fid: string }) {
  const { tree } = useData();
  const { id, provCache } = usePerson();
  const who = useWho();
  const [state, setState] = useState<{ steps?: any[]; error?: string }>({});
  const href = `api/prov?id=${encodeURIComponent(id)}${tree ? `&tree=${encodeURIComponent(tree)}` : ""}`;
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        if (!provCache.current || provCache.current.id !== id) {
          const r = await fetch(href, { credentials: "same-origin" });
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || T.provenance.serverAnswered(r.status));
          provCache.current = { id, doc: await r.json() };
        }
        const g = provCache.current.doc["@graph"], byId = new Map<string, any>(g.map((n: any) => [n["@id"], n]));
        const label = (ref: any) => (byId.get(ref && ref["@id"]) || {})["rdfs:label"] || "";
        const steps: any[] = [];
        for (const n of g) for (const f of n["ft:changedFacts"] || []) {
          if (f.fact !== fid) continue;
          const act = byId.get(n["prov:wasGeneratedBy"]["@id"]) || {};
          const used = (act["prov:used"] || []).map((u: any) => byId.get(u["@id"]) || u);
          const sugg = used.find((u: any) => (u["@type"] || []).includes("ft:Suggestion"));
          const run = sugg && sugg["prov:wasGeneratedBy"] && byId.get(sugg["prov:wasGeneratedBy"]["@id"]);
          steps.push({ at: (n["prov:generatedAtTime"] || {})["@value"] || "", who: label(act["prov:wasAssociatedWith"]), behalf: label(act["ft:onBehalfOf"]), kind: (act["@type"] || [])[1] || "", change: f.change, reason: act["rdfs:comment"],
            sources: used.filter((u: any) => (u["@type"] || []).includes("gx:SourceDescription")), sugg, author: sugg && label(sugg["prov:wasAttributedTo"]), run,
            onBehalf: run && label((byId.get((run["prov:wasAssociatedWith"] || {})["@id"]) || {})["prov:actedOnBehalfOf"]) });
        }
        if (live) setState({ steps });
      } catch (e: any) { if (live) setState({ error: e.message }); }
    })();
    return () => { live = false; };
  }, [id, fid, href, provCache]);
  return (
    <div className="card sub prov-panel small">
      {state.error ? state.error : !state.steps ? T.provenance.loading : state.steps.length ? <>
        <b>{T.provenance.title}</b>
        <ol className="prov-steps">{state.steps.map((s, i) => {
          const pages = s.run ? (s.run["prov:used"] || []).length : 0;
          return (
            <li key={i}><span className="muted">{s.at.slice(0, 16).replace("T", " ")} · {who(s.who)}{s.behalf ? T.provenance.onBehalfOf(who(s.behalf)) : ""}</span> {KIND[s.kind] || T.provenance.changed}: <b>{s.change}</b>{s.reason ? ` — ${s.reason}` : ""}
              {s.sugg && <div>{T.provenance.from} <Link to="/research/queue">{s.sugg["rdfs:label"]}</Link> {T.provenance.by} {who(s.author)}{s.run ? T.provenance.byAgent(who(s.onBehalf), pages) : ""}</div>}
              {s.sources.length > 0 && <div>{T.provenance.evidence} {s.sources.map((x: any, j: number) => <span key={j}>{j > 0 && "; "}{x["ft:url"] ? <a href={x["ft:url"]} target="_blank" rel="noopener">{x["rdfs:label"] || x["ft:url"]}</a> : x["rdfs:label"] || ""}</span>)}</div>}
            </li>
          );
        })}</ol>
        <a className="muted" href={href} target="_blank" rel="noopener">{T.provenance.asProv}</a>
      </> : <p className="muted">{T.provenance.none}</p>}
    </div>
  );
}

/** Review one fact: a conclusion, the evidence (sources already cited, or a new one), and a note. Queues fact.review. */
export function VerifyForm({ e, preset }: { e: any; preset: any }) {
  const { D } = useData();
  const { editor } = useData();
  const { id, queue, setVerify } = usePerson();
  const who = useWho();
  const ref = useRef<HTMLFormElement>(null);
  const cites = e.citations || [];
  const r = e.review || {};
  useEffect(() => {
    const form = ref.current!;
    if (preset.citation) fillCitation(D, form, "n", preset.citation);
    form.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [preset, D]);
  return (
    <form ref={ref} className="card sub verify-form" onSubmit={(ev) => {
      ev.preventDefault();
      const form = ev.currentTarget;
      try {
        const status = (form.querySelector("input[name=status]:checked") as HTMLInputElement).value;
        const evidence: any[] = [...form.querySelectorAll<HTMLInputElement>("input[name=ev]:checked")].map((x) => ({ index: +x.value }));
        const nc = readCitation(form, "n");
        if (nc) evidence.push(nc);
        const note = (form.elements.namedItem("note") as HTMLTextAreaElement).value.trim();
        if (status === "verified" && !evidence.length) throw new Error(T.verifyForm.noEvidence);
        if (status !== "unverified" && !note) throw new Error(T.verifyForm.noNote);
        queue([{ op: "fact.review", entity: "person", id, fid: e.fid, status, note, evidence, ...(preset.finding != null ? { finding: preset.finding } : {}) }],
          { resolves: preset.resolves, reason: preset.reason || note });
        setVerify(null);
      } catch (err: any) { alert(err.message); }
    }}>
      <div className="small"><b>{T.verifyForm.title([e.type, e.dateDisplay || e.date, e.place].filter(Boolean).join(", "))}</b>
        {r.status && <span className="muted">{T.verifyForm.currently(r.status)}{r.by ? T.verifyForm.by(who(r.by), ago(r.at)) : ""}</span>}</div>
      <div className="filters" role="radiogroup" aria-label={T.verifyForm.conclusion}>
        {[["verified", T.verifyForm.conclusions.verified], ["disputed", T.verifyForm.conclusions.disputed], ["unverified", T.verifyForm.conclusions.unverified]].map(([v, l]) => (
          <label className="small" key={v}><input type="radio" name="status" value={v} defaultChecked={(preset.status || r.status || "verified") === v} /> {l}</label>
        ))}
      </div>
      {cites.length ? (
        <div className="small"><div className="muted">{T.verifyForm.evidenceCited}</div>
          {cites.map((ci: any, i: number) => <label style={{ display: "block" }} key={i}><input type="checkbox" name="ev" value={i} defaultChecked={(r.evidence || []).some((x: any) => JSON.stringify(x) === JSON.stringify(ci))} /> <Cite cit={ci} /></label>)}</div>
      ) : <p className="small muted">{T.verifyForm.noSources}</p>}
      <CitationFields prefix="n" />
      <textarea name="note" rows={2} placeholder={T.verifyForm.note} style={{ width: "100%" }} defaultValue={preset.note || ""} />
      <div className="btn-row"><button className="btn primary">{editor ? T.verifyForm.addToChanges : T.verifyForm.addToSuggestion}</button><button type="button" className="btn" onClick={() => setVerify(null)}>{T.verifyForm.cancel}</button></div>
    </form>
  );
}

/** The numbered sources the page's footnotes point at. */
export function Sources() {
  const { D } = useData();
  const { id } = usePerson();
  const { notes } = buildTimeline(D, id);
  const SRC = D.sources as any;
  return (
    <section className="card" style={{ marginTop: 20 }}>
      <h2>{T.sources.title}</h2>
      {notes.length ? <>
        <ol className="sources-list">{notes.map((c, i) => {
          const s = SRC[c.source] || {};
          const url = apidLink(c.apid);
          const title = s.title || c.title || c.source || c.url || T.sources.source;
          const ev = [c.source_type && T.sources.types[c.source_type], c.information && T.sources.information(c.information), c.evidence && T.sources.evidence(c.evidence), c.quality != null && T.sources.quality(c.quality), c.accessed && T.sources.viewed(c.accessed)].filter(Boolean);
          return (
            <li id={`fn-${i + 1}`} key={i}>
              {s.title ? <SourceLink id={c.source}>{title}</SourceLink> : c.url ? <a href={c.url} target="_blank" rel="noopener">{title}</a> : title}{s.author ? `, ${s.author}` : ""}
              {url && <> · <a href={url} target="_blank" rel="noopener">{T.sources.viewOnAncestry}</a></>}
              {c.url && s.title && <> · <a href={c.url} target="_blank" rel="noopener">{T.sources.viewRecord}</a></>}
              {c.page && <span className="pg">{c.page}</span>}{c.text && <span className="pg">“{c.text}”</span>}{c.note && <span className="pg">{c.note}</span>}
              {ev.length > 0 && <span className="ev">{ev.join(" · ")}</span>}
            </li>
          );
        })}</ol>
        <p className="small muted">{T.sources.footer}</p>
      </> : <p className="muted small">{T.sources.none}</p>}
    </section>
  );
}
