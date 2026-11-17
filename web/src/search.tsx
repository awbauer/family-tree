// The site's side of search (worker/textsearch.ts): one index per loaded tree, links to each kind of result, and
// highlighting of the words that matched. The tree is already scoped to the viewer, so results never go beyond it.
import { Fragment, type ReactNode } from "react";
import { buildIndex, fold, terms, type Hit, type Index } from "../../worker/textsearch.ts";
import type { Tree } from "./types";

export { search, type Hit, type Kind } from "../../worker/textsearch.ts";

const cache = new WeakMap<Tree, Index>();
/** The index for this tree, built once. */
export function indexFor(D: Tree): Index {
  let ix = cache.get(D);
  if (!ix) cache.set(D, (ix = buildIndex(D)));
  return ix;
}

/** Where a result opens. */
export function hitPath(h: Hit): string {
  const enc = encodeURIComponent;
  switch (h.kind) {
    case "person": return `/person/${enc(h.id)}`;
    case "story": return `/story/${enc(h.id)}`;
    case "finding": return h.person ? `/person/${enc(h.person)}?section=finding-${enc(h.id)}` : `/research/findings?section=finding-${enc(h.id)}`;
    case "todo": return `/research/todo?section=td-${enc(h.id)}`;
    default: return `/source/${enc(h.id)}`;
  }
}

/** Text with the query's words marked. Folding keeps positions for almost every character; where it doesn't
 *  (ß, æ, œ), the text is shown unmarked rather than marked in the wrong place. */
export function Marked({ text, q }: { text: string; q: string }): ReactNode {
  const f = fold(text);
  const ts = terms(q).filter((t) => t.length > 1);
  if (!ts.length || f.length !== text.length) return text;
  const marks: [number, number][] = [];
  for (const t of ts) for (let i = f.indexOf(t); i >= 0; i = f.indexOf(t, i + 1)) if (i === 0 || !/[a-z0-9]/.test(f[i - 1])) marks.push([i, i + t.length]);
  if (!marks.length) return text;
  marks.sort((a, b) => a[0] - b[0]);
  const out: ReactNode[] = [];
  let at = 0;
  for (const [s, e] of marks) {
    if (s < at) continue;
    out.push(text.slice(at, s), <mark key={s}>{text.slice(s, e)}</mark>);
    at = e;
  }
  out.push(text.slice(at));
  return <Fragment>{out}</Fragment>;
}
