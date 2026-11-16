// Turn scoped tool results into site links and concise previews without looking up unshared records.
import { documentType } from "./documents.ts";
import { S } from "../strings/index.ts";

const L = S.api.mcp.cards;
const enc = encodeURIComponent;
const idOf = (person) => typeof person === "object" ? person?.id : person;
const line = (...parts) => parts.filter(Boolean).join(" · ");
const dateText = (value) => typeof value === "object" ? value?.date : value;
const years = (p) => line(dateText(p.birth ?? p.born), dateText(p.death ?? p.died));
const rows = (value) => Array.isArray(value) ? value : [];

function siteUrl(origin, tree, path, params) {
  const url = new URL("/", origin);
  if (tree) url.searchParams.set("tree", tree);
  const query = new URLSearchParams(params).toString();
  url.hash = path + (query ? `?${query}` : "");
  return url.href;
}

const personPath = (person) => `/person/${enc(idOf(person))}`;
const personSection = (person, section) => [personPath(person), { section }];

const sections = {
  search_people: "/people", list_surnames: "/people", list_places: "/map",
  search_events: "/timeline", list_data_issues: "/research/review", list_duplicates: "/research/review",
  list_sources: "/sources", list_stories: "/stories", list_findings: "/research/findings",
  list_research_log: "/research/overview", list_todos: "/research/todo", get_my_queue: "/research/todo",
  get_todo_history: "/research/todo", list_suggestions: "/research/queue", list_research_sites: "/admin/sites",
  list_agent_runs: "/research/agents", get_agent_run: "/research/agents", admin_overview: "/admin",
  admin_save_tree: "/admin", admin_save_view: "/admin", admin_save_member: "/admin",
  admin_grant: "/admin", admin_revoke_grant: "/admin", audit_log: "/admin/audit",
  audit_detail: "/admin/audit", list_hidden_stories: "/admin/stories", save_research_site: "/admin/sites",
  delete_research_site: "/admin/sites", withdraw_suggestion: "/research/queue", review_suggestion: "/research/queue",
};

const personTools = new Set(["get_person", "get_family", "get_ancestors", "get_descendants", "relationship_between", "get_timeline",
  "get_source", "get_story", "get_history", "get_provenance", "list_comments", "list_attachments", "get_media", "get_attachment",
  "get_report", "add_attachment", "add_report", "add_comment", "link_my_person", "tree_overview", "edit_tree", "preview_edit",
  "revert_change", "update_finding", "apply_quality_review", "suggest_edit", "suggest_research", "create_todo", "update_todo", "claim_todo"]);

export const presentsRecords = (name) => Object.hasOwn(sections, name) || personTools.has(name) || name === "whoami";

export async function recordResult(x, tool, args, output) {
  const name = tool.name;
  const cards = [];
  const url = (path, params, tree = x.treeId) => siteUrl(x.c.url.origin, tree, path, params);
  const card = (page_url, title, summary, detail) => ({ page_url, title, summary, detail });
  const shorten = (display) => Object.fromEntries(Object.entries(display).filter(([, v]) => v)
    .map(([k, v]) => [k, k === "page_url" ? v : String(v).slice(0, k === "detail" ? 6000 : 360)]));
  const add = (display) => { if (cards.length < 20 && display?.page_url) cards.push(shorten(display)); };
  const map = (value, describe) => rows(value).map((item) => {
    const preview = describe(item);
    if (!preview?.page_url) return item;
    add(preview);
    return { ...item, page_url: preview.page_url };
  });
  const person = (p) => p?.id && card(url(personPath(p)), p.name, line(years(p), p.relation || p.relation_to_home_person),
    p.profile || rows(p.notes).join("\n"));
  const profile = (p) => person(p) && card(url(personPath(p)), p.name, line(years(p), p.relation_to_home_person),
    p.profile || rows(p.notes).join("\n") || line(p.birth?.place, p.death?.place));
  const source = (s) => card(url(`/source/${enc(s.id)}`), s.title || s.id, line(s.author, s.publication, s.type), s.note || s.text);
  const story = (s) => card(url(`/story/${enc(s.slug)}`), s.title, s.era, s.body);
  const todo = (t) => card(url("/research/todo", { section: `td-${t.id}` }), t.task, line(t.status, t.priority), t.where || t.outcome);
  const proposal = (p) => card(url("/research/queue", { section: `proposal-${p.id}`, status: p.status === "open" ? "open" : "all" }), L.suggestion(p.id), p.status, p.rationale);
  const run = (r) => card(url("/research/agents", { section: r.id }, r.tree || x.treeId), L.run(r.id), line(r.kind, r.status), r.summary);
  const finding = (f, owner = f.person) => card(owner
    ? url(...personSection(owner, f.id == null ? "w-research" : `finding-${f.id}`))
    : url("/research/findings", f.id == null ? undefined : { section: `finding-${f.id}` }),
    f.claim || f.kind, f.status, f.finding);
  const event = (e, owner, ownFact) => owner && card(url(personPath(owner), ownFact && e.fid ? { fact: e.fid } : undefined),
    line(e.type, (typeof owner === "object" ? owner.name : "")), line(e.date, e.place, e.value), e.note);
  const doc = (d, owner) => card(url(personPath(owner), { section: d.file, attachment: d.file }), d.caption || d.file.split("/").pop(),
    documentType(d.file) === "report" ? L.report : L.attachment, d.markdown);
  const edited = (entity) => entity.type === "source" && entity.after ? source({ id: entity.id, ...entity.after }) :
    ["person", "media_map"].includes(entity.type) && entity.after ? card(url(personPath(entity.id)), entity.id) : null;
  const section = sections[name];
  let data = output;
  let main = section && (name !== "list_research_sites" || x.c.access.isOwner) ? card(url(section), tool.title) : null;
  // Slugs and family participants below come from the returned, scoped records.
  const familyPerson = (f) => f.person || f.husband || f.wife || f.children?.[0];
  const set = (key, describe) => { if (Array.isArray(data[key])) data = { ...data, [key]: map(data[key], describe) }; };

  switch (name) {
    case "whoami":
      set("trees", (t) => card(url("/", undefined, t.id), t.name, t.role));
      break;
    case "tree_overview":
      main = card(url("/"), data.name, data.home_person?.name);
      if (data.home_person) data = { ...data, home_person: map([data.home_person], person)[0] };
      set("core_people", person);
      set("branches", (b) => card(url(`/branch/${enc(b.key)}`), b.name || b.key, b.label));
      break;
    case "get_person":
      main = profile(data);
      if (!data.private) {
        set("events", (e) => event(e, data, true));
        set("findings", (f) => finding(f, data));
        set("todos", todo);
        set("stories", story);
        set("attachments", (d) => doc(d, data));
      }
      break;
    case "get_family": {
      const owner = familyPerson(data);
      if (owner) main = card(url(personPath(owner)), tool.title, line(data.person?.name, data.husband?.name, data.wife?.name));
      for (const key of ["parents", "siblings", "spouses", "children"]) set(key, person);
      break;
    }
    case "get_ancestors":
    case "get_descendants":
      main = card(url(`/tree/${enc(data.person.id)}`, { mode: name === "get_descendants" ? "desc" : "anc", g: data.generations }), data.person.name);
      data = { ...data, person: { ...data.person, page_url: url(personPath(data.person)) } };
      set("ancestors", person);
      set("descendants", person);
      break;
    case "relationship_between":
      if (data.found) {
        main = card(url(...personSection(data.from, "w-graph")), data.label, data.summary);
        set("chain", person);
        set("common_ancestors", person);
      }
      break;
    case "search_people":
      main = card(url("/people", args.query ? { q: args.query } : undefined), tool.title);
      set("people", person);
      break;
    case "get_timeline":
      main = person(data.person);
      set("events", (e) => event(e, e.person || data.person, e.whose === "self"));
      break;
    case "search_events":
      set("events", (e) => event(e, familyPerson(e), Boolean(e.person)));
      break;
    case "list_surnames":
      set("surnames", (s) => card(url("/people", { q: s.surname }), s.surname, s.people));
      break;
    case "list_places":
      set("places", (p) => { const label = p.name || p.place || p.key; return card(url("/people", { q: label }), label); });
      break;
    case "list_research_sites":
      if (x.c.access.isOwner) set("sites", (s) => card(url("/admin/sites"), s.name, s.coverage));
      break;
    case "list_data_issues":
      set("issues", (i) => card(i.person ? url(...personSection(i.person, "w-research")) : url("/research/review"), i.message || i.kind, i.severity));
      break;
    case "list_duplicates":
      set("candidates", (d) => d.people?.[0] && card(url(personPath(d.people[0])), line(...d.people.map((p) => p?.name)), d.note));
      break;
    case "list_sources":
      set("sources", source);
      break;
    case "get_source":
      main = source(data);
      set("cited_by", (c) => c.person && card(url(personPath(c.person), c.fid?.startsWith("e") ? { fact: c.fid } : undefined), c.person.name, line(c.where, c.page)));
      break;
    case "list_stories":
      set("stories", story);
      break;
    case "list_hidden_stories":
      set("stories", (s) => card(url("/admin/stories"), s.title, s.era, s.body));
      break;
    case "get_story":
      main = story(data);
      set("people", person);
      break;
    case "list_findings":
      set("findings", (f) => finding(f));
      break;
    case "list_research_log":
      set("searches", (s) => card(s.person ? url(...personSection(s.person, "w-research")) : url("/research/overview"), s.searched, s.result, s.note));
      break;
    case "list_todos":
    case "get_my_queue":
      for (const key of ["todos", "assigned", "available"]) set(key, todo);
      break;
    case "get_todo_history":
      main = card(url("/research/todo", { section: `td-${args.id}` }), L.todo(args.id));
      break;
    case "create_todo":
    case "update_todo":
    case "claim_todo":
      if (data.todo) main = todo(data.todo);
      break;
    case "list_suggestions":
      set("proposals", proposal);
      break;
    case "suggest_edit":
    case "suggest_research":
      if (data.proposal) main = proposal(data.proposal);
      break;
    case "review_suggestion":
    case "withdraw_suggestion":
      main = proposal({ id: args.id, status: data.status });
      break;
    case "list_agent_runs":
      set("runs", run);
      break;
    case "get_agent_run":
    case "apply_quality_review":
      if (data.run) main = run(data.run);
      break;
    case "list_attachments":
      main = card(url(...personSection(args.person, "w-attachments")), tool.title);
      set("attachments", (d) => doc(d, args.person));
      break;
    case "add_attachment":
    case "add_report":
      main = data.proposal ? proposal({ id: data.proposal, status: "open" }) : doc({ ...data, caption: args.title || args.name }, args.person);
      break;
    case "get_media":
    case "get_attachment":
    case "get_report": {
      const b = await x.bundle();
      const attached = Object.entries(b.research.media || {}).find(([, files]) => files.some((m) => m.file === args.file));
      const item = attached?.[1].find((m) => m.file === args.file);
      if (item) main = documentType(item.file) ? doc({ ...item, markdown: data.markdown }, attached[0])
        : card(url(...personSection(attached[0], "w-photos")), item.caption || args.file.split("/").pop(), L.photo);
      else {
        const ids = new Set(Object.entries(b.media || {}).filter(([, m]) => m.file === args.file).map(([id]) => id));
        const owner = Object.values(b.people).find((p) => (p.media || []).some((id) => ids.has(id)));
        if (owner) main = card(url(...personSection(owner, "w-photos")), args.file.split("/").pop(), L.photo);
      }
      break;
    }
    case "list_comments":
    case "add_comment":
      if ((args.type || "person") === "person") {
        main = card(url(...personSection(args.id, "w-comments")), tool.title);
        set("comments", (c) => card(main.page_url, tool.title, c.created_at?.slice(0, 10), c.body));
      }
      break;
    case "get_history":
    case "get_provenance":
      if (args.id?.startsWith("I")) main = card(url(...personSection(args.id, "w-history")), tool.title);
      else if (name === "get_history" && !args.id && x.c.access.isOwner) main = card(url("/admin/audit"), tool.title);
      if (args.run) main = card(url("/research/agents", { section: args.run }), tool.title);
      break;
    case "audit_log":
      set("batches", (b) => card(url("/admin/audit", { q: b.key }), b.key, b.op, b.reason));
      break;
    case "audit_detail":
      main = card(url("/admin/audit", { q: args.key }), tool.title);
      break;
    case "edit_tree":
    case "preview_edit":
      set("touched", (entity) => name === "edit_tree" || entity.before ? edited(entity) : null);
      break;
    case "update_finding":
      if (data.finding) main = finding(data.finding);
      break;
    case "revert_change":
      if (x.c.access.isOwner) main = card(url("/admin/audit", { q: data.batchId }), tool.title);
      break;
    case "link_my_person":
      if (args.person_id) main = card(url(personPath(args.person_id)), tool.title);
      break;
  }

  // A primary record leads the card view. A list's page remains available without crowding out its results.
  if (main) data = { ...data, page_url: main.page_url };
  if (main && (!section || !cards.length || main.page_url !== url(section))) {
    cards.unshift(shorten(main));
    cards.length = Math.min(cards.length, 20);
  }
  return { data, cards };
}
