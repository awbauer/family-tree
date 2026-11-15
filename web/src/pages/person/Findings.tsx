// Research findings on the person page, with what to do about each: verify or dispute the fact, apply the suggested
// change, fix it in the tree (citing the finding's sources), keep the tree as is, reopen, or discuss.
import { useEffect, useRef } from "react";
import { useData } from "../../data";
import { CitationFields, fillCitation, findingCitations, readCitation } from "../../ops";
import { ago } from "../../tree";
import { Finding, useWho } from "../../ui";
import { EVENT_TYPE_FOR_FIELD, reloadPage, usePerson } from "./context";
import { VerifyForm } from "./LifeEvents";
import { S } from "../../../../strings/index.ts";

const T = S.person.findings;

const KIND_HELP: Record<string, string> = T.kindHelp;

export function targetFact(p: any, f: any) {
  if (f.fact) return (p.events || []).find((e: any) => e.fid === f.fact) || null;
  const type = EVENT_TYPE_FOR_FIELD[String(f.field || "").toLowerCase()];
  return type ? (p.events || []).find((e: any) => e.type === type) || null : null;
}

/** A finding with its action bar (live API only), and the verify / fix form when one is open on it. */
export function FindingWithActions({ f }: { f: any }) {
  const { editor, live, api } = useData();
  const { id, p, queue, verify, setVerify, fix, setFix, commentBox } = usePerson();
  const who = useWho();
  const res = f.resolution;
  const target = targetFact(p, f);
  const cites = findingCitations(f);
  const reason = T.reason(f.id, f.finding).slice(0, 1000);

  async function act(a: string) {
    try {
      if (a === "discuss") {
        const box = commentBox.current;
        if (box) { box.value = T.discussPrefix(f.id, f.kind); box.focus(); box.scrollIntoView({ behavior: "smooth", block: "center" }); }
      } else if (a === "keep") {
        const note = prompt(f.kind === "confirmed" ? T.keepNotePrompt : T.keepWhyPrompt, "");
        if (note === null) return;
        if (f.kind !== "confirmed" && !note.trim()) return alert(T.keepWhyRequired);
        await api("PATCH", `findings/${f.id}`, { status: "dismissed", note: note.trim() || "Noted.", version: f.version });
        reloadPage();
      } else if (a === "reopen") {
        await api("PATCH", `findings/${f.id}`, { status: "open", version: f.version });
        reloadPage();
      } else if (a === "verify" || a === "dispute") {
        setFix(null);
        setVerify({ fid: target.fid, at: "finding", finding: f.id, preset: {
          status: a === "verify" ? "verified" : "disputed",
          note: a === "verify" ? T.confirmedBy(cites.map((x: any) => x.title).join("; ") || T.theRecord, f.finding) : f.finding,
          citation: cites[0], finding: f.id, resolves: [f.id], reason,
        } });
      } else if (a === "apply") {
        queue(f.proposed_ops, { resolves: [f.id], reason, sources: f.sources });
      } else if (a === "fix") {
        setVerify(null);
        setFix(f.id);
      }
    } catch (e: any) { alert(e.status === 409 ? T.conflict : e.message); }
  }

  const btns: [string, string, boolean][] = [];
  if (!res) {
    if (editor || live) {
      if (f.kind === "confirmed" && target) btns.push(["verify", T.actions.verify, true]);
      if ((f.proposed_ops || []).length) btns.push(["apply", T.actions.apply, true]);
      if (["correction", "data-error", "conflict", "new-fact"].includes(f.kind)) btns.push(["fix", f.kind === "new-fact" ? T.actions.addToTree : T.actions.fixInTree, !(f.proposed_ops || []).length]);
      if (f.kind === "conflict" && target) btns.push(["dispute", T.actions.dispute, false]);
      if (editor) btns.push(["keep", f.kind === "confirmed" ? T.actions.done : T.actions.keep, false]);
    }
    btns.push(["discuss", T.actions.discuss, false]);
  }
  const verifyHere = verify && verify.at === "finding" && verify.finding === f.id && target;
  return (
    <Finding f={f} here={id}>
      <div className="f-actions">
        {res ? <>
          <span className={`badge st-${res.status === "resolved" ? "verified" : "unverified"}`}>{res.status === "resolved" ? T.resolved : T.keptAsIs}</span>{" "}
          <span className="small muted">{T.by} {who(res.by)} {ago(res.at)}{res.note ? `: ${res.note}` : ""}{res.proposal ? T.suggestionRef(res.proposal) : ""}</span>
          {editor && <> <button className="linklike" data-a="reopen" onClick={() => act("reopen")}>{T.reopen}</button></>}
        </> : <>
          <p className="small muted f-help">{KIND_HELP[f.kind] || ""}</p>
          <div className="btn-row">{btns.map(([a, l, primary]) => <button key={a} className={`btn${primary ? " primary" : ""}`} data-a={a} onClick={() => act(a)}>{l}</button>)}</div>
        </>}
      </div>
      {verifyHere && <VerifyForm e={target} preset={verify!.preset} />}
      {fix === f.id && !res && <FixForm f={f} target={target} cites={cites} reason={reason} />}
    </Finding>
  );
}

/** A side-by-side "tree says / record says" editor for the fact a finding concerns, citing the finding's sources. */
function FixForm({ f, target, cites, reason }: { f: any; target: any; cites: any[]; reason: string }) {
  const { D, editor } = useData();
  const { id, queue, setFix } = usePerson();
  const ref = useRef<HTMLFormElement>(null);
  const type = (target && target.type) || EVENT_TYPE_FOR_FIELD[String(f.field || "").toLowerCase()] || "Event";
  const isName = String(f.field || "").toLowerCase() === "name";
  useEffect(() => {
    const form = ref.current!;
    if (cites[0]) fillCitation(D, form, "fx", cites[0]);
    form.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []); // prefill once, when the form opens
  return (
    <form ref={ref} className="card sub fix-form" onSubmit={(ev) => {
      ev.preventDefault();
      const form = ev.currentTarget, v = (k: string) => String(((form.elements.namedItem(k) as HTMLInputElement | null)?.value) || "").trim();
      try {
        const cit = readCitation(form, "fx");
        const citations = cit ? [cit, ...cites.slice(1)] : cites;
        if (!citations.length) throw new Error(T.fix.noCitation);
        let ops: any[];
        if (isName) {
          if (!v("given") && !v("surname")) throw new Error(T.fix.noName);
          ops = [{ op: "name.add", person: id, name: { given: v("given"), surname: v("surname"), type: v("ntype") } }];
        } else {
          const set = { date: v("date"), place: v("place"), value: v("value") };
          if (target) {
            ops = [{ op: "event.update", entity: "person", id, fid: target.fid, set }];
            for (const ci of citations) ops.push({ op: "citation.add", entity: "person", id, fid: target.fid, citation: ci });
          } else {
            ops = [{ op: "event.add", entity: "person", id, event: { type, ...Object.fromEntries(Object.entries(set).filter(([, x]) => x)), citations } }];
          }
        }
        queue(ops, { resolves: [f.id], reason, sources: f.sources });
        setFix(null);
      } catch (err: any) { alert(err.message); }
    }}>
      <div className="fix-cols">
        <div><div className="eyebrow">{T.fix.treeSays}</div><div className="small">{target ? [target.date, target.place, target.value].filter(Boolean).join(", ") : f.claim || T.fix.nothingRecorded}</div></div>
        <div><div className="eyebrow">{T.fix.recordSays}</div><div className="small">{f.finding}</div></div>
      </div>
      {isName ? (
        <div className="filters"><input name="given" placeholder={T.fix.given} /><input name="surname" placeholder={T.fix.surname} />
          <select name="ntype" defaultValue=""><option value="">{T.fix.nameKind}</option><option value="birth">{T.fix.nameKinds.birth}</option><option value="married">{T.fix.nameKinds.married}</option><option value="also known as">{T.fix.nameKinds.aka}</option></select></div>
      ) : (
        <div className="filters"><b style={{ minWidth: 110 }}>{type}</b>
          <input name="date" defaultValue={target ? target.date || "" : ""} placeholder={T.fix.date} />
          <input name="place" defaultValue={target ? target.place || "" : ""} placeholder={T.fix.place} style={{ flex: 1, minWidth: 200 }} />
          <input name="value" defaultValue={target ? target.value || "" : ""} placeholder={T.fix.detail} /></div>
      )}
      <p className="small muted">{cites.length ? T.fix.cites(cites.map((x) => x.title).join("; ")) : T.fix.addRecord}</p>
      <CitationFields prefix="fx" />
      <div className="btn-row"><button className="btn primary">{editor ? T.fix.addToChanges : T.fix.addToSuggestion}</button><button type="button" className="btn" onClick={() => setFix(null)}>{T.fix.cancel}</button></div>
    </form>
  );
}
