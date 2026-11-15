// The home page: the site's hero with a fan chart of the home person's ancestors, the family lines, stories and
// the state of the research.
import { Link } from "react-router";
import { branchColor, isUnknown, PersonLink, useSite, useTitle, years as yearsOf } from "../lib";
import { homeFirst, STATUS_LABEL } from "../tree";
import { useBranchStyle } from "../ui";
import { StoryCard } from "./Stories";
import { useBrowse, type BBranch } from "./browse/shared";
import { FanChart } from "./browse/FanChart";

const ST_KEYS = ["verified", "partly-verified", "disputed", "unverified"] as const;
const ST_COLOR: Record<string, string> = { verified: "var(--ok)", "partly-verified": "var(--info)", disputed: "var(--err)", unverified: "var(--line)" };

export function Home() {
  const { D, people, branches: BR } = useBrowse();
  const site = useSite();
  const bstyle = useBranchStyle();
  useTitle("");
  const R = D.research as any;
  const color = (k: string) => branchColor(k, BR);
  const HOME = D.home, HOME_FIRST = homeFirst(D);
  const total = people.filter((p) => !isUnknown(p)).length;
  const anc = people.filter((p) => p.direct && !isUnknown(p) && p.id !== HOME);
  const earliest = Math.min(...people.map((p) => (p.birth && p.birth.year) || 9999));
  const gens = Math.max(...people.map((p) => p.generation || 0));
  const nCites = people.reduce((n, p) => n + p.events.reduce((m, e) => m + (e.citations || []).length, 0), 0);
  const st: Record<string, number> = { verified: 0, "partly-verified": 0, unverified: 0, disputed: 0 };
  people.forEach((p) => { if (!isUnknown(p)) st[p.status || ""] = (st[p.status || ""] || 0) + 1; });
  const branches = ((D.research.branches || []) as BBranch[]).filter((b) => !b.inLaw);
  const errs = (D.issues || []).filter((i) => i.severity === "error").length;
  const stories = (D.research.stories || []).slice(0, 6);
  const todos: any[] = (R.todo || []).filter((t: any) => t.priority === "high").slice(0, 6);
  return (
    <div className="wrap">
      <section className="hero">
        <div>
          <div className="eyebrow">{site.eyebrow}</div>
          <h1>{site.familyName}</h1>
          {site.lede ? <p className="lede">{site.lede}</p> : null}
          <div className="stats">
            <div className="stat"><b>{total}</b><span>People</span></div>
            <div className="stat"><b>{anc.length}</b><span>Direct ancestors</span></div>
            <div className="stat"><b>{gens + 1}</b><span>Generations</span></div>
            <div className="stat"><b>{earliest}</b><span>Earliest birth</span></div>
            <div className="stat"><b>{nCites}</b><span>Citations</span></div>
          </div>
          <div className="btn-row" style={{ marginTop: 22 }}>
            <Link className="btn primary" to="/tree">Explore the tree</Link>
            <Link className="btn" to={`/person/${HOME}`}>Start with {HOME_FIRST}</Link>
            <Link className="btn" to="/research">Research status</Link>
          </div>
        </div>
        <div className="fan-wrap"><FanChart rootId={HOME} gens={5} />
          <p className="small muted" style={{ textAlign: "center", margin: "6px 0 0" }}>Five generations of {HOME_FIRST}’s ancestors. Grey = not yet identified.</p></div>
      </section>

      <section className="section">
        <div className="section-head"><h2>{branches.length === 4 ? "Four grandparents, four lines" : "Family lines"}</h2><Link to="/people">All people →</Link></div>
        <div className="grid g4">
          {branches.map((b) => {
            const p = D.people[b.root || ""];
            const n = people.filter((x) => x.branch === b.key).length;
            const origin = (p && p.birth && p.birth.place) || "";
            return (
              <Link key={b.key} className="card branch-card" to={`/branch/${b.key}`} style={bstyle(b.key)}>
                <span className="eyebrow" style={{ color: color(b.key) }}>{b.label} line</span>
                <span className="who">{p ? p.name : ""}</span>
                <span className="meta">{yearsOf(p)}{origin ? ` · born ${origin.split(",")[0]}` : ""}</span>
                <span className="meta">{b.tagline}</span>
                <span className="meta" style={{ marginTop: "auto" }}>{n} people in this branch →</span>
              </Link>
            );
          })}
        </div>
      </section>

      {stories.length ? (
        <section className="section">
          <div className="section-head"><h2>Stories</h2><Link to="/stories">All stories →</Link></div>
          <div className="grid g3">{stories.map((s) => <StoryCard key={s.slug} story={s} />)}</div>
        </section>
      ) : null}

      <section className="section grid g2">
        <div className="card">
          <h3>How solid is this tree?</h3>
          <p className="small muted">Each person is graded on whether independent records (not just other Ancestry trees) back up who they were.</p>
          <div className="progress" aria-hidden="true">
            {ST_KEYS.map((k) => <span key={k} style={{ width: `${(100 * st[k]) / total}%`, background: ST_COLOR[k] }} />)}
          </div>
          <p className="small" style={{ marginTop: 10 }}>{ST_KEYS.map((k, i) => <span key={k}>{i > 0 && " "}<span className={`badge st-${k}`}>{STATUS_LABEL[k]} {st[k]}</span></span>)}</p>
          <p className="small"><Link to="/research/review">{errs} data problems flagged automatically →</Link></p>
        </div>
        <div className="card">
          <h3>Top open questions</h3>
          {todos.length ? <>
            <ul className="rel-list">{todos.map((t, i) => <li key={t.id ?? i}><span>{t.person && D.people[t.person] ? <><PersonLink id={t.person} />: </> : null}{t.task}</span></li>)}</ul>
            <Link className="small" to="/research/todo">Full research to-do list →</Link>
          </> : <p className="muted small">No research tasks recorded yet.</p>}
        </div>
      </section>
    </div>
  );
}
