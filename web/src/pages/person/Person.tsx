// A person's page: who they were, their family, life events with sources, stories, research, photos and, when the
// API is live, the tools to verify, fix, discuss and edit.
import { Fragment, useState } from "react";
import { Link, useParams } from "react-router";
import { useData } from "../../data";
import { PersonLink, isUnknown, useTitle, years } from "../../lib";
import { byBirth, homeFirst, initials, mediaUrl, mentionsFor, parentsOf, siblingsOf, spousesOf, storiesFor, STATUS_LABEL } from "../../tree";
import { BranchChip, Finding, Issue, StatusBadge, useBranchStyle } from "../../ui";
import { StoryCard } from "../Stories";
import { NotFound } from "../NotFound";
import { PersonProvider, usePerson } from "./context";
import { FindingWithActions } from "./Findings";
import { Graph } from "./Graph";
import { FactsChip, LifeEvents, Sources } from "./LifeEvents";
import { Photos } from "./Photos";
import { Todos } from "./Todos";
import { Work } from "./Work";

export function Person() {
  const { id = "" } = useParams();
  const { D } = useData();
  if (!D.people[id]) return <NotFound />;
  // keyed by id: going from one person to another starts the page (queue, open forms, graph path) afresh
  return <PersonProvider key={id} id={id}><PersonPage /></PersonProvider>;
}

function RelationText() {
  const { D } = useData();
  const { p } = usePerson();
  const first = homeFirst(D);
  if (p.id === D.home) return <>This is {first}</>;
  if (p.relation) return <>{first}’s {p.relation}</>;
  if (p.relationVia && D.people[p.relationVia]) return <>Related by marriage — via <PersonLink id={p.relationVia} /> ({D.people[p.relationVia].relation || ""})</>;
  return <>Connection not yet established</>;
}

function RelLine({ pid, extra }: { pid?: string | null; extra?: string }) {
  const { D } = useData();
  if (!pid || !D.people[pid]) return <li><span className="muted">Unknown</span></li>;
  return <li><span><PersonLink id={pid} />{extra && <> <span className="muted small">{extra}</span></>}</span><span className="yrs">{years(D.people[pid])}</span></li>;
}

function MiniPedigree() {
  const { D } = useData();
  const { id } = usePerson();
  const bstyle = useBranchStyle();
  const P = D.people, F = D.families;
  const par = (x?: string | null): [string | null, string | null] => { const f = x && P[x] && P[x].famc[0] && F[P[x].famc[0]]; return f ? [f.husband || null, f.wife || null] : [null, null]; };
  const [fa, mo] = par(id);
  if (!fa && !mo) return null;
  const gp = [...par(fa), ...par(mo)];
  const cell = (x: string | null, lbl: string) => x && P[x] && !isUnknown(P[x])
    ? <Link to={`/person/${x}`} style={bstyle(P[x].branch)}>{P[x].name}<br /><span className="muted small">{years(P[x])}</span></Link>
    : <span className="unk">{lbl} unknown</span>;
  return (
    <div className="card" style={{ marginTop: 16 }}><h4 style={{ marginTop: 0 }}>Grandparents</h4>
      <div className="mini-ped">{cell(gp[0], "Paternal grandfather")}{cell(gp[2], "Maternal grandfather")}{cell(gp[1], "Paternal grandmother")}{cell(gp[3], "Maternal grandmother")}</div></div>
  );
}

function Facts() {
  const { D } = useData();
  const { id, p } = usePerson();
  const parents = parentsOf(D, id), spouses = spousesOf(D, id), sibs = siblingsOf(D, id);
  return (
    <div className="card facts">
      <h4>Vital facts</h4>
      <dl>
        <dt>Born</dt><dd>{p.birth ? <>{p.birth.date || "date unknown"}{p.birth.place && <><br /><span className="muted">{p.birth.place}</span></>}</> : <span className="muted">Unknown</span>}</dd>
        {p.death && <><dt>Died</dt><dd>{p.death.date || "date unknown"}{p.death.place && <><br /><span className="muted">{p.death.place}</span></>}</dd></>}
        {p.burial && <><dt>Buried</dt><dd>{p.burial.place}{p.burial.note && <><br /><span className="muted">{p.burial.note}</span></>}</dd></>}
        <dt>Sex</dt><dd>{p.sex === "M" ? "Male" : p.sex === "F" ? "Female" : <span className="sev-warn">not recorded</span>}{p.sexOriginal && <> <span className="small muted">(corrected; Ancestry says {p.sexOriginal || "—"})</span></>}</dd>
      </dl>
      <h4>Parents</h4>
      {parents.length ? parents.map(({ father, mother }, i) => (
        <ul className="rel-list" key={i}>{parents.length > 1 && <li className="small sev-err">Parent set {i + 1} of {parents.length} — only one can be right</li>}<RelLine pid={father} /><RelLine pid={mother} /></ul>
      )) : <p className="muted small">Not yet identified.</p>}
      {spouses.map(({ fam, spouse, children }, i) => {
        const m = (fam.events || []).find((e) => e.type === "Marriage");
        return <Fragment key={i}>
          <h4>{spouse ? "Spouse" : "Family"}</h4><ul className="rel-list"><RelLine pid={spouse} extra={m && m.dateDisplay ? "m. " + m.dateDisplay : ""} /></ul>
          {children.length > 0 && <><h4>Children</h4><ul className="rel-list">{children.slice().sort(byBirth(D)).map((c) => <RelLine key={c} pid={c} />)}</ul></>}
        </Fragment>;
      })}
      {sibs.length > 0 && <><h4>Siblings</h4><ul className="rel-list">{sibs.map((s) => <RelLine key={s} pid={s} />)}</ul></>}
      <div className="btn-row" style={{ marginTop: 14 }}><Link className="btn" to={`/tree/${id}`}>Ancestors</Link><Link className="btn" to={`/tree/${id}?mode=desc`}>Descendants</Link></div>
    </div>
  );
}

function Profile() {
  const { ai, api } = useData();
  const { id, p } = usePerson();
  const [btn, setBtn] = useState<{ busy: boolean; text?: string }>({ busy: false });
  if (!p.profile && !(ai && !p.living)) return null;
  return (
    <section className="card profile" style={{ marginBottom: 20 }}><h2>Profile</h2>
      {p.profile ? <><p className="prose">{p.profile.text}</p><p className="small muted">Written by AI from the recorded facts on {p.profile.generated_at.slice(0, 10)}, and rewritten when they change. It can be wrong: the events and sources below are the record.</p></>
        : <p className="small muted">No profile yet. Profiles are written by AI from the recorded facts.</p>}
      {ai && !p.living && <button className="btn" id="profile-refresh" disabled={btn.busy} onClick={async () => {
        setBtn({ busy: true });
        try { await api("POST", `profiles/${encodeURIComponent(id)}/refresh`); setBtn({ busy: true, text: "Queued: reload in a minute" }); }
        catch (e: any) { alert(e.message); setBtn({ busy: false }); }
      }}>{btn.text || (p.profile ? "Rewrite now" : "Write one now")}</button>}
    </section>
  );
}

const ACTIONABLE = ["conflict", "correction", "data-error", "new-fact"];
function Research() {
  const { D, live } = useData();
  const { id, p } = usePerson();
  const findings = ((D.research as any).findings || []).filter((f: any) => f.person === id).slice().sort((a: any, b: any) => (a.resolution ? 1 : 0) - (b.resolution ? 1 : 0));
  const toAct = findings.filter((f: any) => !f.resolution && ACTIONABLE.includes(f.kind)).length;
  const issues = p.issues || [];
  return (
    <section className="card" style={{ marginTop: 20 }}>
      <h2>Research</h2>
      {findings.length ? <><h3>Findings{toAct > 0 && <> <span className="count">{toAct} to act on</span></>}</h3>
        {findings.map((f: any, i: number) => live ? <FindingWithActions key={f.id ?? i} f={f} /> : <Finding key={f.id ?? i} f={f} here={id} />)}</>
        : <p className="muted small">No independent research recorded yet beyond the Ancestry citations below.</p>}
      {issues.length > 0 && <><h3 style={{ marginTop: 18 }}>Automatic data checks</h3>{issues.map((x: any, i: number) => <Issue key={i} i={x} here={id} />)}</>}
      <h3 style={{ marginTop: 18 }}>Next steps</h3>
      <Todos />
    </section>
  );
}

function PersonPage() {
  const { D, live } = useData();
  const { id, p } = usePerson();
  const bstyle = useBranchStyle();
  useTitle(p.name);
  const stories = storiesFor(D, id), mentions = mentionsFor(D, id);
  const media: any[] = ((D.research as any).media || {})[id] || [];
  const portrait = media.find((m) => m.portrait) || media[0];
  const alt = p.names.slice(1).map((n: any) => `${n.given} ${n.surname}`.trim()).filter((n: string) => n && n !== p.name);
  const dup: string[] = p.duplicateOf || [];
  return (
    <div className="wrap">
      <div className="person-head" style={bstyle(p.branch)}>
        <div className="portrait">{portrait ? <img src={mediaUrl(portrait.file)} alt={p.name} /> : initials(p)}</div>
        <div>
          <div className="eyebrow"><RelationText /></div>
          <h1>{p.name}</h1>
          <div className="life">{p.birth ? p.birth.date || "?" : "?"} – {p.death ? p.death.date || "?" : p.living ? "living" : "?"}</div>
          <div className="tags"><BranchChip k={p.branch} /> <StatusBadge status={p.status} note={p.statusNote} /> {p.living && <span className="chip">Living</span>}
            {alt.length > 0 && <span className="small muted">Also recorded as: {alt.join(", ")}</span>}{live && <FactsChip />}</div>
        </div>
      </div>
      {dup.length > 0 && <div className="callout err"><b>Probable duplicate.</b> This looks like the same person as {dup.map((d, i) => <span key={d}>{i > 0 && ", "}<PersonLink id={d} /></span>)}. Merge them in Ancestry and re-export.</div>}
      {p.statusNote && <div className={`callout ${p.status === "verified" ? "ok" : p.status === "disputed" ? "err" : ""}`}><b>{STATUS_LABEL[p.status!]}:</b> {p.statusNote}</div>}
      <div className="person-layout">
        <aside className="side">
          <Facts />
          <MiniPedigree />
        </aside>
        <div>
          {stories.length > 0 && <div className="grid g2" style={{ marginBottom: mentions.length ? 10 : 20 }}>{stories.map((s) => <StoryCard key={s.slug} story={s} />)}</div>}
          {mentions.length > 0 && <p className="small story-mentions" style={{ margin: "0 0 20px" }}><span className="muted">{stories.length ? "Also mentioned in" : "Mentioned in"}</span>{" "}
            {mentions.map((s, i) => <span key={s.slug}>{i > 0 && " · "}<Link to={`/story/${s.slug}`}>{s.title}</Link>{s.era && <> <span className="muted">({s.era})</span></>}</span>)}</p>}
          <Profile />
          {live && <Graph />}
          <LifeEvents />
          <Research />
          <Photos />
          <Sources />
        </div>
      </div>
      {live && <Work />}
    </div>
  );
}
