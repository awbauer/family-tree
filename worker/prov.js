// W3C PROV-O provenance (JSON-LD) over the change log. docs/design/standards.md, phase 1.
//
//   change batch            → prov:Activity (ft:Edit, ft:Revert, ft:Import, ft:Resolution, …)
//   record after a change   → prov:Entity, a version: specializationOf the record, wasGeneratedBy the activity,
//                             wasRevisionOf the previous version, wasDerivedFrom the sources cited
//   who made it             → prov:Person / prov:SoftwareAgent, wasAssociatedWith
//   approved suggestion     → an Entity attributed to its author, used by the approving activity
//   cloud research run      → prov:Activity associated with agent:cloud, which actedOnBehalfOf the editor who started
//                             it; every page it read is prov:used; its suggestions wasGeneratedBy it
//   undo                    → the undone version wasInvalidatedBy the revert activity
// Built from rows the caller is already allowed to see (index.js scopes them first).

const parse = (s, d = null) => { if (s == null) return d; try { return JSON.parse(s); } catch { return d; } };

const CONTEXT = {
  prov: "http://www.w3.org/ns/prov#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  gx: "http://gedcomx.org/",
  ft: "https://family-tree.example/terms/",
};
const OP_TYPE = { edit: "ft:Edit", revert: "ft:Revert", import: "ft:Import", resolve: "ft:Resolution", dismissed: "ft:Decision", reopen: "ft:Decision", resolved: "ft:Decision", set: "ft:StatusChange", revise: "ft:StoryRevision" };
const dt = (v) => (v ? { "@value": v, "@type": "xsd:dateTime" } : undefined);
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && !v.length)));

/** Which facts (events e…, names n…) a person or family version added, removed, changed or reviewed. */
export function changedFacts(before, after) {
  const out = [];
  const facts = (x) => new Map([...(x && x.events) || [], ...(x && x.names) || []].filter((f) => f && f.fid).map((f) => [f.fid, f]));
  const A = facts(before), B = facts(after);
  const label = (f) => (f.type ? [f.type, f.date].filter(Boolean).join(" ") : `name ${`${f.given || ""} ${f.surname || ""}`.trim()}`);
  const strip = (f) => { const { review, citations, ...rest } = f; return JSON.stringify(rest); };
  for (const [fid, f] of B) {
    const o = A.get(fid);
    if (!o) { out.push({ fact: fid, change: "added", label: label(f) }); continue; }
    if (strip(o) !== strip(f)) out.push({ fact: fid, change: "updated", label: label(f) });
    if (JSON.stringify(o.citations || []) !== JSON.stringify(f.citations || [])) out.push({ fact: fid, change: "cited", label: label(f) });
    if (JSON.stringify(o.review || null) !== JSON.stringify(f.review || null)) out.push({ fact: fid, change: f.review ? `reviewed: ${f.review.status}` : "review removed", label: label(f) });
  }
  for (const [fid, f] of A) if (!B.has(fid)) out.push({ fact: fid, change: "removed", label: label(f) });
  return out;
}

export function toProv({ rows = [], runs = [], proposals = [], base = "", detail = true }) {
  const graph = new Map();
  const node = (id, props) => { const cur = graph.get(id) || { "@id": id }; graph.set(id, { ...cur, ...clean(props) }); return { "@id": id }; };
  const who = (principal) => (detail ? principal : String(principal || "").split("@")[0]); // members don't see emails
  const agent = (principal, kind) => {
    const software = kind === "agent" || /^(agent|service):/.test(principal || "");
    return node(`agent/${encodeURIComponent(who(principal))}`, { "@type": software ? ["prov:SoftwareAgent", "prov:Agent"] : ["prov:Person", "prov:Agent"], "rdfs:label": who(principal) });
  };
  let srcN = 0;
  const srcKey = new Map();
  const source = (s) => {
    const key = JSON.stringify([s.title || "", s.url || "", s.note || ""]);
    if (!srcKey.has(key)) srcKey.set(key, `source/${++srcN}`);
    return node(srcKey.get(key), { "@type": ["prov:Entity", "gx:SourceDescription"], "rdfs:label": s.title, "ft:url": s.url, "rdfs:comment": s.note });
  };
  const propById = new Map(proposals.map((p) => [p.id, p]));
  const proposal = (id) => {
    const p = propById.get(id);
    return node(`proposal/${id}`, { "@type": ["prov:Entity", "ft:Suggestion"], "rdfs:label": `Suggestion #${id}`, "prov:wasAttributedTo": p ? agent(p.author, p.author_kind) : undefined, "prov:generatedAtTime": p ? dt(p.created_at) : undefined, "ft:kind": p && p.kind });
  };

  // research runs (and the suggestions they produced)
  for (const r of runs) {
    const cloud = agent("agent:cloud", "agent");
    node(cloud["@id"], { "prov:actedOnBehalfOf": agent(r.started_by, "person") });
    const used = (parse(r.used, []) || []).map((u) => (u.kind === "page" && u.url
      ? node(u.url, { "@type": ["prov:Entity", "ft:WebPage"], "rdfs:label": u.title || u.url, "prov:atTime": dt(u.at) })
      : node(`run/${r.id}/search/${encodeURIComponent(u.query || "")}`, { "@type": ["prov:Entity", "ft:WebSearch"], "rdfs:label": u.query, "prov:atTime": dt(u.at) })));
    node(`run/${r.id}`, {
      "@type": ["prov:Activity", "ft:ResearchRun"], "rdfs:label": `Research run ${r.id}`,
      "prov:startedAtTime": dt(r.started_at || r.created_at), "prov:endedAtTime": dt(r.finished_at),
      "prov:wasAssociatedWith": cloud,
      "prov:qualifiedAssociation": { "@type": "prov:Association", "prov:agent": cloud, "prov:hadPlan": clean({ "@type": "prov:Plan", "rdfs:comment": r.instructions || (r.todo_id ? `To-do #${r.todo_id}` : undefined) }) },
      "prov:wasStartedBy": agent(r.started_by, "person"), "prov:used": used, "ft:model": r.model, "ft:status": r.status,
    });
    for (const pid of parse(r.proposal_ids, []) || []) node(proposal(pid)["@id"], { "prov:wasGeneratedBy": { "@id": `run/${r.id}` } });
  }

  // the change log: activities and entity versions
  const last = new Map(); // record → its latest version id
  for (const r of rows) {
    const actKey = r.batch_id || `c${r.id}`;
    const actId = `activity/${actKey}`;
    const sources = (parse(r.sources, []) || []).map(source);
    const used = [...sources];
    if (r.proposal_id) used.push(proposal(r.proposal_id));
    const cur = graph.get(actId);
    node(actId, {
      "@type": ["prov:Activity", OP_TYPE[r.op] || "ft:Change"],
      "prov:startedAtTime": dt(r.at), "prov:wasAssociatedWith": agent(r.actor, r.actor_kind),
      "rdfs:comment": r.reason, "prov:used": [...((cur && cur["prov:used"]) || []), ...used].filter((x, i, a) => a.findIndex((y) => y["@id"] === x["@id"]) === i),
    });
    const rec = `${r.entity_type}/${r.entity_id}`;
    node(rec, { "@type": ["prov:Entity", r.entity_type === "person" ? "gx:Person" : r.entity_type === "family" ? "gx:Relationship" : `ft:${r.entity_type}`] });
    const before = parse(r.before), after = parse(r.after);
    const prev = last.get(rec);
    if (after == null) {
      if (prev) node(prev, { "prov:wasInvalidatedBy": { "@id": actId } });
      last.delete(rec);
      continue;
    }
    const vid = `${rec}/v${r.version_after || `c${r.id}`}`;
    const facts = ["person", "family"].includes(r.entity_type) ? changedFacts(before, after) : [];
    node(vid, {
      "@type": "prov:Entity", "prov:specializationOf": { "@id": rec }, "prov:wasGeneratedBy": { "@id": actId },
      "prov:generatedAtTime": dt(r.at), "prov:wasRevisionOf": prev ? { "@id": prev } : undefined,
      "prov:wasDerivedFrom": sources, "ft:changedFacts": facts.length ? facts : undefined,
    });
    if (r.op === "revert" && prev) node(prev, { "prov:wasInvalidatedBy": { "@id": actId } });
    last.set(rec, vid);
  }
  return { "@context": { ...CONTEXT, "@base": base ? `${base}/prov/` : undefined }, "@graph": [...graph.values()] };
}

/** The history of one fact, from a prov document: [{at, who, kind, change, reason, sources, suggestion}]. */
export function factHistory(doc, fid) {
  const byId = new Map(doc["@graph"].map((n) => [n["@id"], n]));
  const out = [];
  for (const n of doc["@graph"]) {
    for (const f of n["ft:changedFacts"] || []) {
      if (f.fact !== fid) continue;
      const act = byId.get(n["prov:wasGeneratedBy"]["@id"]) || {};
      const ag = byId.get((act["prov:wasAssociatedWith"] || {})["@id"]) || {};
      const used = (act["prov:used"] || []).map((u) => byId.get(u["@id"]) || u);
      out.push({ at: (n["prov:generatedAtTime"] || {})["@value"], who: ag["rdfs:label"], kind: (act["@type"] || [])[1], change: f.change, reason: act["rdfs:comment"],
        sources: used.filter((u) => (u["@type"] || []).includes("gx:SourceDescription")).map((u) => ({ title: u["rdfs:label"], url: u["ft:url"] })),
        suggestion: used.filter((u) => (u["@type"] || []).includes("ft:Suggestion")).map((u) => u["@id"].split("/").pop())[0] });
    }
  }
  return out;
}
