// Story text: plain paragraphs separated by blank lines, "## " headings, [[I12|label]] person links, **bold**, *italic*.
// Parsed into elements (never injected as HTML).
import { Fragment, type ReactNode } from "react";
import { PersonLink } from "./lib";

const TOKEN = /\[\[(I[\w-]+)(?:\|([^\]]+))?\]\]|\*\*([^*]+)\*\*|\*([^*]+)\*/g;

/** One paragraph's inline markup. */
export function Inline({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0, m: RegExpExecArray | null, k = 0;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<PersonLink key={k++} id={m[1]}>{m[2]}</PersonLink>);
    else if (m[3]) out.push(<b key={k++}>{m[3]}</b>);
    else out.push(<i key={k++}>{m[4]}</i>);
    last = TOKEN.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

export function StoryBody({ body }: { body: string }) {
  return <>{String(body || "").split(/\n\n+/).map((t, i) => (
    <Fragment key={i}>{t.startsWith("## ") ? <h2>{t.slice(3)}</h2> : <p><Inline text={t} /></p>}</Fragment>
  ))}</>;
}

/** The first paragraph as plain text, for cards. */
export function storyExcerpt(body: string | undefined, names: (id: string) => string | undefined, max = 220) {
  const first = String(body || "").split(/\n\n/)[0]
    .replace(/\[\[(I[\w-]+)(?:\|([^\]]+))?\]\]/g, (_, id, l) => l || names(id) || id)
    .replace(/\*\*?([^*]+)\*\*?/g, "$1");
  return first.length > max ? first.slice(0, max - 3) + "…" : first;
}
