// Paragraph-level diff of two story texts: removed paragraphs struck through,
// added ones highlighted, unchanged ones muted.
import { Inline } from "../../StoryText";

const Para = ({ t }: { t: string }) => (t.startsWith("## ") ? <b>{t.slice(3)}</b> : <Inline text={t} />);

export function StoryDiff({ a, b }: { a?: string; b?: string }) {
  const A = String(a || "").split(/\n\n+/), B = String(b || "").split(/\n\n+/);
  const L = Array.from({ length: A.length + 1 }, () => new Array<number>(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: { cls: string; t: string }[] = [];
  let i = 0, j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) { out.push({ cls: "muted", t: A[i] }); i++; j++; }
    else if (i < A.length && (j >= B.length || L[i + 1][j] >= L[i][j + 1])) out.push({ cls: "d-del", t: A[i++] });
    else out.push({ cls: "d-ins", t: B[j++] });
  }
  return <div className="prose small story-diff">{out.map((p, k) => <p key={k} className={p.cls}><Para t={p.t} /></p>)}</div>;
}
