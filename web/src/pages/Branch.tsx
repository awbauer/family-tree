// One family line: its people (direct ancestors first), surnames and stories.
import { Link, useParams } from "react-router";
import { branchColor, isUnknown, useTitle } from "../lib";
import { byBirth } from "../tree";
import { NotFound } from "./NotFound";
import { StoryCard } from "./Stories";
import { PCard, useBrowse, type BBranch } from "./browse/shared";
import { S } from "../../../strings/index.ts";

const T = S.browse.branch;

export function Branch() {
  const { key = "" } = useParams();
  const { D, people, branches } = useBrowse();
  const b = branches[key] as BBranch | undefined;
  const ok = !!b && !!D.people[b.root || ""];
  useTitle(ok ? T.line(b!.label) : S.browse.notFound.title);
  if (!ok) return <NotFound />;
  const root = D.people[b!.root!];
  const bb = byBirth(D);
  const list = people.filter((p) => p.branch === key && !isUnknown(p));
  const direct = list.filter((p) => p.direct).sort((x, y) => ((x.generation || 0) - (y.generation || 0)) || bb(x.id, y.id));
  const others = list.filter((p) => !p.direct).sort((x, y) => x.surname.localeCompare(y.surname) || bb(x.id, y.id));
  const surnames: Record<string, number> = {};
  list.forEach((p) => { if (p.surname) surnames[p.surname] = (surnames[p.surname] || 0) + 1; });
  const stories = (D.research.stories || []).filter((s) => s.branch === key);
  return (
    <div className="wrap page">
      <div className="eyebrow" style={{ color: branchColor(key, branches) }}>{b!.tagline}</div>
      <h1>{T.heading(b!.label)}</h1>
      <p className="lede prose">{b!.intro || ""}</p>
      <div className="btn-row"><Link className="btn primary" to={`/tree/${b!.root}`}>{T.ancestorsOf(root.name)}</Link><Link className="btn" to={`/people?branch=${key}`}>{T.allPeople(list.length)}</Link></div>
      <p className="small muted" style={{ marginTop: 14 }}>{T.surnames}{Object.entries(surnames).sort((x, y) => y[1] - x[1]).map(([s, n], i) => (
        <span key={s}>{i > 0 && " · "}<Link to={`/people?q=${encodeURIComponent(s)}`}>{s}</Link> ({n})</span>
      ))}</p>
      {stories.length ? <section className="section"><h2>{T.stories}</h2><div className="grid g3">{stories.map((s) => <StoryCard key={s.slug} story={s} />)}</div></section> : null}
      <section className="section"><h2>{T.direct}</h2><div className="people-grid">{direct.map((p) => <PCard key={p.id} p={p} />)}</div></section>
      <section className="section"><h2>{T.others}</h2><div className="people-grid">{others.map((p) => <PCard key={p.id} p={p} />)}</div></section>
    </div>
  );
}
