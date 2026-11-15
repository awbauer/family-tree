// Admin → Hidden stories (#/admin/stories): stories some tree doesn't show, and why (GET /api/admin/stories/hidden).
// A tree shows a story only when everyone it's about is in that tree, so these can't be read anywhere else: their text
// is shown here.
import { Fragment, useEffect, useState } from "react";
import { useData } from "../../data";
import { PersonLink } from "../../lib";
import { StoryBody } from "../../StoryText";
import { S } from "../../../../strings/index.ts";

interface Who { id: string; state: "ok" | "merged" | "removed"; name: string | null; into?: string }
interface Hidden {
  slug: string; title: string; era: string | null; branch: string | null; body: string;
  sources: { title?: string; url?: string; note?: string }[];
  people: Who[]; trees: { id: string; name: string; hidden: boolean; outside: string[] }[];
}

const T = S.admin.hiddenStories;
const list = (items: React.ReactNode[]) => items.map((x, i) => <Fragment key={i}>{i > 0 && ", "}{x}</Fragment>);

function Story({ s }: { s: Hidden }) {
  const { D, branches } = useData();
  const removed = s.people.filter((p) => p.state === "removed");
  const merged = s.people.filter((p) => p.state === "merged");
  const hidden = s.trees.filter((t) => t.hidden), shown = s.trees.filter((t) => !t.hidden);
  return (
    <section className="card hidden-story">
      <h3>{s.title}</h3>
      {(s.era || s.branch) && <p className="small muted">{[s.era, s.branch && (branches[s.branch] ? branches[s.branch].label : s.branch)].filter(Boolean).join(" · ")}</p>}
      <p><b>{shown.length ? T.hiddenFrom : T.hiddenEverywhere}</b>{shown.length ? hidden.map((t) => t.name).join(", ") : null}
        {shown.length > 0 && <><br /><span className="muted">{T.shownIn}{shown.map((t) => t.name).join(", ")}</span></>}</p>
      <ul className="small">
        {removed.length > 0 && <li>{T.removed(removed.length)} {list(removed.map((p) => <span key={p.id}>{p.name || T.removedNoName} <code>{p.id}</code></span>))}</li>}
        {!removed.length && hidden.map((t) => t.outside.length > 0 && (
          <li key={t.id}>{T.outside(t.name)}{list(t.outside.map((id) => <PersonLink key={id} id={id}>{D.people[id] ? undefined : id}</PersonLink>))}</li>
        ))}
        {merged.length > 0 && <li className="muted">{T.merged}{list(merged.map((p) => <span key={p.id}><code>{p.id}</code>{T.mergedInto}<PersonLink id={p.into!} /></span>))}</li>}
      </ul>
      <p className="small muted">{removed.length ? T.fix : T.spans}</p>
      <details><summary className="small">{T.read}</summary>
        <div className="prose"><StoryBody body={s.body} /></div>
        {s.sources.length > 0 && <><h4>{T.sources}</h4><ul className="small">{s.sources.map((x, i) => <li key={i}>{x.url ? <a href={x.url} target="_blank" rel="noopener">{x.title || x.url}</a> : x.title}{x.note && <span className="muted"> — {x.note}</span>}</li>)}</ul></>}
      </details>
    </section>
  );
}

export function HiddenStories() {
  const { api } = useData();
  const [state, setState] = useState<{ stories?: Hidden[]; error?: string }>({});
  useEffect(() => { api<{ stories: Hidden[] }>("GET", "admin/stories/hidden").then((r) => setState({ stories: r.stories }), (e) => setState({ error: (e as Error).message })); }, [api]);
  if (state.error) return <p className="sev-error">{state.error}</p>;
  if (!state.stories) return <p className="muted">{T.loading}</p>;
  if (!state.stories.length) return <p className="muted">{T.none}</p>;
  return <>
    <p>{T.count(state.stories.length)}</p>
    {state.stories.map((s) => <Story key={s.slug} s={s} />)}
  </>;
}
