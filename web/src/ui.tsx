// Small shared components: badges, chips, linkified text, findings and data issues.
import type { ReactNode } from "react";
import { useData } from "./data";
import { PersonLink, branchColor } from "./lib";
import { FINDING_KINDS, STATUS_LABEL, whoText } from "./tree";

export function StatusBadge({ status, note }: { status?: string; note?: string }) {
  if (!status) return null;
  return <span className={`badge st-${status}`} title={note || ""}>{STATUS_LABEL[status] || status}</span>;
}

export function BranchChip({ k }: { k?: string }) {
  const { branches } = useData();
  if (!k) return null;
  return <span className="chip branch" style={{ ["--bc" as any]: branchColor(k, branches) }}>{branches[k] ? branches[k].label : k}</span>;
}

/** `style` for an element coloured by a branch (`--bc`). */
export function useBranchStyle() {
  const { branches } = useData();
  return (k?: string) => ({ ["--bc" as any]: branchColor(k, branches) });
}

/** Text with bare http(s) URLs turned into links. */
export function Linkify({ text }: { text?: string | null }) {
  const s = String(text ?? "");
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of s.matchAll(/https?:\/\/[^\s<]+/g)) {
    if (m.index! > last) out.push(s.slice(last, m.index));
    const u = m[0];
    out.push(<a key={m.index} href={u} target="_blank" rel="noopener">{u.length > 60 ? u.slice(0, 57) + "…" : u}</a>);
    last = m.index! + u.length;
  }
  out.push(s.slice(last));
  return <>{out}</>;
}

/** "me", "🤖 researcher" or a name. */
export function Who({ x }: { x?: string | null }) {
  const { D } = useData();
  return <>{whoText(D.me ? D.me.principal : null, x)}</>;
}
export function useWho() {
  const { D } = useData();
  return (x?: string | null) => whoText(D.me ? D.me.principal : null, x);
}

/** A research finding. `here` is the person whose page this is (their name isn't repeated). */
export function Finding({ f, here, children }: { f: any; here?: string; children?: ReactNode }) {
  const { D } = useData();
  const res = f.resolution;
  const elsewhere = f.person !== here;
  return (
    <div className={`finding${res ? " f-closed" : ""}`} data-finding={f.id != null ? f.id : undefined}>
      <div className="f-head">
        <span className={`f-kind k-${f.kind}`}>{FINDING_KINDS[f.kind] || f.kind}</span>
        {res && elsewhere && <span className={`badge st-${res.status === "resolved" ? "verified" : "unverified"}`}>{res.status === "resolved" ? "resolved" : "kept as is"}</span>}
        {f.field && <span className="chip">{f.field}</span>}
        <span className={`conf-${f.confidence}`}>● {f.confidence} confidence</span>
        {f.person && D.people[f.person] && elsewhere ? <> · <PersonLink id={f.person} /></> : f.personName && !f.person ? <> · {f.personName}</> : null}
      </div>
      {f.claim && <div className="f-claim">Tree says: {f.claim}</div>}
      <div>{f.finding}</div>
      {(f.sources || []).length > 0 && (
        <div className="f-src">{f.sources.map((s: any, i: number) => (
          <span key={i}>{i > 0 && <br />}{s.url ? <a href={s.url} target="_blank" rel="noopener">{s.title || s.url}</a> : s.title}{s.note && <span className="muted"> — {s.note}</span>}</span>
        ))}</div>
      )}
      {children}
    </div>
  );
}

/** One automatic data check result. */
export function Issue({ i, here }: { i: any; here?: string }) {
  const { D } = useData();
  return (
    <div className="issue"><span className={`sev sev-${i.severity}`}>{i.severity}</span>
      <span>{i.person && D.people[i.person] && i.person !== here ? <><PersonLink id={i.person} />: </> : null}{i.message}</span></div>
  );
}
