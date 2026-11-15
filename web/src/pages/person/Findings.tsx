// Research findings on the person page, with what to do about each: verify or dispute the fact, apply the suggested
// change, fix it in the tree (citing the finding's sources), keep the tree as is, reopen, or discuss.
import { useEffect, useRef } from "react";
import { useData } from "../../data";
import { CitationFields, fillCitation, findingCitations, readCitation } from "../../ops";
import { ago } from "../../tree";
import { Finding, useWho } from "../../ui";
import { EVENT_TYPE_FOR_FIELD, reloadPage, usePerson } from "./context";
import { VerifyForm } from "./LifeEvents";

const KIND_HELP: Record<string, string> = {
  conflict: "Records disagree. Weigh them (an original over an index, first-hand over second-hand information), then fix the tree, mark the fact disputed, or keep the tree as it is and say why.",
  correction: "A record says the tree is wrong. If the evidence holds, apply the fix; it is cited and can be undone.",
  "data-error": "Something in how the tree records this is wrong (a typo, a misattached record). Fix it in the tree.",
  "new-fact": "A record adds something the tree doesn't have. Add it, citing the record.",
  confirmed: "A record backs up what the tree says. Mark the fact verified with it as the evidence.",
  "new-person": "A relative not yet in the tree. Add them from Edit (parent, spouse or child), citing the record.",
};

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
  const reason = `Finding #${f.id}: ${f.finding}`.slice(0, 1000);

  async function act(a: string) {
    try {
      if (a === "discuss") {
        const box = commentBox.current;
        if (box) { box.value = `About finding #${f.id} (${f.kind}): `; box.focus(); box.scrollIntoView({ behavior: "smooth", block: "center" }); }
      } else if (a === "keep") {
        const note = prompt(f.kind === "confirmed" ? "Note (optional):" : "Why does the tree stay as it is? (kept with the finding)", "");
        if (note === null) return;
        if (f.kind !== "confirmed" && !note.trim()) return alert("Say why: the reason is the record of your decision.");
        await api("PATCH", `findings/${f.id}`, { status: "dismissed", note: note.trim() || "Noted.", version: f.version });
        reloadPage();
      } else if (a === "reopen") {
        await api("PATCH", `findings/${f.id}`, { status: "open", version: f.version });
        reloadPage();
      } else if (a === "verify" || a === "dispute") {
        setFix(null);
        setVerify({ fid: target.fid, at: "finding", finding: f.id, preset: {
          status: a === "verify" ? "verified" : "disputed",
          note: a === "verify" ? `Confirmed by ${cites.map((x: any) => x.title).join("; ") || "the record"}: ${f.finding}` : f.finding,
          citation: cites[0], finding: f.id, resolves: [f.id], reason,
        } });
      } else if (a === "apply") {
        queue(f.proposed_ops, { resolves: [f.id], reason, sources: f.sources });
      } else if (a === "fix") {
        setVerify(null);
        setFix(f.id);
      }
    } catch (e: any) { alert(e.status === 409 ? "Someone changed this meanwhile. Reload and try again." : e.message); }
  }

  const btns: [string, string, boolean][] = [];
  if (!res) {
    if (editor || live) {
      if (f.kind === "confirmed" && target) btns.push(["verify", "Mark the fact verified", true]);
      if ((f.proposed_ops || []).length) btns.push(["apply", "Apply the suggested change", true]);
      if (["correction", "data-error", "conflict", "new-fact"].includes(f.kind)) btns.push(["fix", f.kind === "new-fact" ? "Add it to the tree" : "Fix in the tree", !(f.proposed_ops || []).length]);
      if (f.kind === "conflict" && target) btns.push(["dispute", "Mark the fact disputed", false]);
      if (editor) btns.push(["keep", f.kind === "confirmed" ? "Done" : "Keep the tree as is", false]);
    }
    btns.push(["discuss", "Discuss", false]);
  }
  const verifyHere = verify && verify.at === "finding" && verify.finding === f.id && target;
  return (
    <Finding f={f} here={id}>
      <div className="f-actions">
        {res ? <>
          <span className={`badge st-${res.status === "resolved" ? "verified" : "unverified"}`}>{res.status === "resolved" ? "Resolved" : "Kept as is"}</span>{" "}
          <span className="small muted">by {who(res.by)} {ago(res.at)}{res.note ? `: ${res.note}` : ""}{res.proposal ? ` (suggestion #${res.proposal})` : ""}</span>
          {editor && <> <button className="linklike" data-a="reopen" onClick={() => act("reopen")}>reopen</button></>}
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
        if (!citations.length) throw new Error("Cite the record that supports the change.");
        let ops: any[];
        if (isName) {
          if (!v("given") && !v("surname")) throw new Error("Give the name as the record has it.");
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
        <div><div className="eyebrow">Tree says</div><div className="small">{target ? [target.date, target.place, target.value].filter(Boolean).join(", ") : f.claim || "(nothing recorded)"}</div></div>
        <div><div className="eyebrow">Record says</div><div className="small">{f.finding}</div></div>
      </div>
      {isName ? (
        <div className="filters"><input name="given" placeholder="Given names" /><input name="surname" placeholder="Surname" />
          <select name="ntype" defaultValue=""><option value="">Kind</option><option>birth</option><option>married</option><option>also known as</option></select></div>
      ) : (
        <div className="filters"><b style={{ minWidth: 110 }}>{type}</b>
          <input name="date" defaultValue={target ? target.date || "" : ""} placeholder="Date (e.g. 3 Mar 1931, abt 1890)" />
          <input name="place" defaultValue={target ? target.place || "" : ""} placeholder="Place, most specific first" style={{ flex: 1, minWidth: 200 }} />
          <input name="value" defaultValue={target ? target.value || "" : ""} placeholder="Detail (occupation, age…)" /></div>
      )}
      <p className="small muted">{cites.length ? `Cites ${cites.map((x) => x.title).join("; ")}. Assess it: ` : "Add the record: "}</p>
      <CitationFields prefix="fx" />
      <div className="btn-row"><button className="btn primary">{editor ? "Add to changes" : "Add to suggestion"}</button><button type="button" className="btn" onClick={() => setFix(null)}>Cancel</button></div>
    </form>
  );
}
