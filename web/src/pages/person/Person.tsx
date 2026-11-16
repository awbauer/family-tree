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
import { S } from "../../../../strings/index.ts";

const T = S.person.page;

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
  if (p.id === D.home) return <>{T.relation.thisIs(first)}</>;
  if (p.relation) return <>{T.relation.relativeOf(first, p.relation)}</>;
  if (p.relationVia && D.people[p.relationVia]) return <>{T.relation.byMarriageVia} <PersonLink id={p.relationVia} /> ({D.people[p.relationVia].relation || ""})</>;
  return <>{T.relation.notEstablished}</>;
}

function RelLine({ pid, extra }: { pid?: string | null; extra?: string }) {
  const { D } = useData();
  if (!pid || !D.people[pid]) return <li><span className="muted">{T.unknown}</span></li>;
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
    : <span className="unk">{T.grandparents.unknown(lbl)}</span>;
  return (
    <div className="card" style={{ marginTop: 16 }}><h4 style={{ marginTop: 0 }}>{T.grandparents.title}</h4>
      <div className="mini-ped">{cell(gp[0], T.grandparents.paternalGrandfather)}{cell(gp[2], T.grandparents.maternalGrandfather)}{cell(gp[1], T.grandparents.paternalGrandmother)}{cell(gp[3], T.grandparents.maternalGrandmother)}</div></div>
  );
}

function Facts() {
  const { D } = useData();
  const { id, p } = usePerson();
  const parents = parentsOf(D, id), spouses = spousesOf(D, id), sibs = siblingsOf(D, id);
  return (
    <div className="card facts">
      <h4>{T.facts.title}</h4>
      <dl>
        <dt>{T.facts.born}</dt><dd>{p.birth ? <>{p.birth.date || T.facts.dateUnknown}{p.birth.place && <><br /><span className="muted">{p.birth.place}</span></>}</> : <span className="muted">{T.unknown}</span>}</dd>
        {p.death && <><dt>{T.facts.died}</dt><dd>{p.death.date || T.facts.dateUnknown}{p.death.place && <><br /><span className="muted">{p.death.place}</span></>}</dd></>}
        {p.burial && <><dt>{T.facts.buried}</dt><dd>{p.burial.place}{p.burial.note && <><br /><span className="muted">{p.burial.note}</span></>}</dd></>}
        <dt>{T.facts.sex}</dt><dd>{p.sex === "M" ? T.facts.male : p.sex === "F" ? T.facts.female : <span className="sev-warn">{T.facts.sexNotRecorded}</span>}{p.sexOriginal && <> <span className="small muted">{T.facts.sexCorrected(p.sexOriginal || "—")}</span></>}</dd>
      </dl>
      <h4>{T.facts.parents}</h4>
      {parents.length ? parents.map(({ father, mother }, i) => (
        <ul className="rel-list" key={i}>{parents.length > 1 && <li className="small sev-err">{T.facts.parentSet(i + 1, parents.length)}</li>}<RelLine pid={father} /><RelLine pid={mother} /></ul>
      )) : <p className="muted small">{T.facts.parentsNone}</p>}
      {spouses.map(({ fam, spouse, children }, i) => {
        const m = (fam.events || []).find((e) => e.type === "Marriage");
        return <Fragment key={i}>
          <h4>{spouse ? T.facts.spouse : T.facts.family}</h4><ul className="rel-list"><RelLine pid={spouse} extra={m && m.dateDisplay ? T.facts.married(m.dateDisplay) : ""} /></ul>
          {children.length > 0 && <><h4>{T.facts.children}</h4><ul className="rel-list">{children.slice().sort(byBirth(D)).map((c) => <RelLine key={c} pid={c} />)}</ul></>}
        </Fragment>;
      })}
      {sibs.length > 0 && <><h4>{T.facts.siblings}</h4><ul className="rel-list">{sibs.map((s) => <RelLine key={s} pid={s} />)}</ul></>}
      <div className="btn-row" style={{ marginTop: 14 }}><Link className="btn" to={`/tree/${id}`}>{T.facts.ancestors}</Link><Link className="btn" to={`/tree/${id}?mode=desc`}>{T.facts.descendants}</Link></div>
    </div>
  );
}

function Profile() {
  const { ai, api } = useData();
  const { id, p } = usePerson();
  const [btn, setBtn] = useState<{ busy: boolean; text?: string }>({ busy: false });
  if (!p.profile && !(ai && !p.private)) return null;
  return (
    <section className="card profile" style={{ marginBottom: 20 }}><h2>{T.profile.title}</h2>
      {p.profile ? <><p className="prose">{p.profile.text}</p><p className="small muted">{T.profile.written(p.profile.generated_at.slice(0, 10))}</p></>
        : <p className="small muted">{T.profile.none}</p>}
      {ai && !p.private && <button className="btn" id="profile-refresh" disabled={btn.busy} onClick={async () => {
        setBtn({ busy: true });
        try { await api("POST", `profiles/${encodeURIComponent(id)}/refresh`); setBtn({ busy: true, text: T.profile.queued }); }
        catch (e: any) { alert(e.message); setBtn({ busy: false }); }
      }}>{btn.text || (p.profile ? T.profile.rewrite : T.profile.write)}</button>}
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
      <h2>{T.research.title}</h2>
      {findings.length ? <><h3>{T.research.findings}{toAct > 0 && <> <span className="count">{T.research.toActOn(toAct)}</span></>}</h3>
        {findings.map((f: any, i: number) => live ? <FindingWithActions key={f.id ?? i} f={f} /> : <Finding key={f.id ?? i} f={f} here={id} />)}</>
        : <p className="muted small">{T.research.none}</p>}
      {issues.length > 0 && <><h3 style={{ marginTop: 18 }}>{T.research.checks}</h3>{issues.map((x: any, i: number) => <Issue key={i} i={x} here={id} />)}</>}
      <h3 style={{ marginTop: 18 }}>{T.research.nextSteps}</h3>
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
          <div className="life">{p.birth ? p.birth.date || "?" : "?"} – {p.death ? p.death.date || "?" : p.living ? T.living : "?"}</div>
          <div className="tags"><BranchChip k={p.branch} /> <StatusBadge status={p.status} note={p.statusNote} /> {p.living && <span className="chip">{T.livingChip}</span>}
            {alt.length > 0 && <span className="small muted">{T.alsoRecordedAs(alt.join(", "))}</span>}{live && <FactsChip />}</div>
        </div>
      </div>
      {dup.length > 0 && <div className="callout err"><b>{T.duplicate.title}</b> {T.duplicate.before} {dup.map((d, i) => <span key={d}>{i > 0 && ", "}<PersonLink id={d} /></span>)}{T.duplicate.after}</div>}
      {p.statusNote && <div className={`callout ${p.status === "verified" ? "ok" : p.status === "disputed" ? "err" : ""}`}><b>{STATUS_LABEL[p.status!]}:</b> {p.statusNote}</div>}
      <div className="person-layout">
        <aside className="side">
          <Facts />
          <MiniPedigree />
        </aside>
        <div>
          {stories.length > 0 && <div className="grid g2" style={{ marginBottom: mentions.length ? 10 : 20 }}>{stories.map((s) => <StoryCard key={s.slug} story={s} />)}</div>}
          {mentions.length > 0 && <p className="small story-mentions" style={{ margin: "0 0 20px" }}><span className="muted">{stories.length ? T.alsoMentionedIn : T.mentionedIn}</span>{" "}
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
