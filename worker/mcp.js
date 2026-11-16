// The MCP server (issue #3): the family tree as tools for members' own AI clients (Claude, ChatGPT, Cursor, …).
//
//   POST /mcp   JSON-RPC 2.0 over MCP's Streamable HTTP transport, stateless, answered as application/json
//
// Who is calling: the same Cloudflare Access identity as the site. Put /mcp behind Access with Managed OAuth (Access is
// the OAuth server; the client signs the member in through the family's identity provider) and, optionally, list it in
// an MCP server portal. docs/agents/operations.md → MCP server.
//
// What they can do: everything the site's API lets them do, through their grants and views, except running the AI
// agents (research runs, AI profiles, the page assistant). Write tools call the site's own route handlers in-process
// (worker/index.js route()), so there is one set of rules: members suggest, editors edit and review, the owner
// administers, and every change lands in the change log as the member. Read tools work over the member's scoped
// bundle (worker/mcp-views.js), so living relatives come through exactly as that member's view shows them.
//
// Every tool call is logged in the change log (entity_type "mcp", the tool's name, the tree, ok or not), never its
// arguments, which may carry names.
import { HttpError, fail } from "./http.js";
import { grantFor, can } from "./auth.js";
import { now, J } from "./db.js";
import { PERSON_STATUSES } from "./ops.js";
import { safeMediaType } from "./media-types.js";
import { documentType, documentsFor, FILE_LIMIT } from "./documents.ts";
import { presentsRecords, recordResult } from "./mcp-records.js";
import { cardResource, cardHtml } from "./mcp-card-view.js";
import * as V from "./mcp-views.js";
import { S } from "../strings/index.ts";

const M = S.api.mcp;
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER = { name: "family-tree", title: "Family tree", version: "1.0.0" };
const MAX_RPC_BYTES = 30 * 1024 * 1024;
const MEDIA_MAX = 8 * 1024 * 1024;

export const isMcpPath = (p) => p === "/mcp" || p === "/mcp/";
/** Extra Access audience tags accepted on /mcp: a separate Access application for the MCP endpoint (Managed OAuth). */
export const audiences = (env) => String(env.MCP_ACCESS_AUD || "").split(",").map((s) => s.trim()).filter(Boolean);

const rpc = (body, status = 200, headers = {}) => new Response(body == null ? null : JSON.stringify(body),
  { status, headers: { ...(body == null ? {} : { "Content-Type": "application/json; charset=utf-8" }), "Cache-Control": "no-store", "X-Robots-Tag": "noindex", ...headers } });
const rpcError = (id, code, message, data) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });

export const unauthorized = (msg) => rpc(rpcError(null, -32001, msg), 401, { "WWW-Authenticate": 'Bearer realm="family-tree"' });

// ---------------------------------------------------------------- server instructions (sent once, at initialize)
const INSTRUCTIONS = `This server is a private family-history database. Everything you read here is private family data shared with the signed-in member; don't repeat it anywhere public.

How to work:
- Include the returned page_url when referring to a record so the member can open it in the site.
- Start with whoami (which trees you can use and your role in each) and tree_overview. Every tool takes an optional "tree" (a tree id from whoami); without it, the member's first tree is used.
- People are I… ids, families F…, sources S…. Events and names carry a fact id ("fid": e1, n1) that edits, reviews and citations point at. Find people with search_people, then get_person.
- A person shown as {private: true} is a name only in this member's view: use them to walk the family, never research or change them.
- Never invent records. Cite only what you actually retrieved and read; a guess is a to-do, not a finding. Negative searches count: log them.
- Members suggest (suggest_research, suggest_edit); editors review suggestions and edit directly (edit_tree), always with a reason and sources. Use preview_edit to show a change before making it. Never delete people: merge duplicates with person.merge.
- Ask the member before any write: edits, suggestions, to-dos, comments, uploads, sharing changes.`;

const OPS_HELP = `Edit ops (applied in order, all or nothing). People I…, families F…, sources S…; new records get ids when "id" is left out. Facts are addressed by fid.
person.create {id?, names:[{given,surname,suffix?,type?}], sex?:"M"|"F"|"U", events?:[event]} · person.update {id, set:{sex?, notes?, research_status?:"unverified"|"partly-verified"|"verified"|"disputed", status_note?:string|null}} · person.merge {keep, drop} · person.delete {id} (only if in no family; prefer merge)
name.add {person, name} · name.update {person, fid, set} · name.remove {person, fid}
event.add {entity:"person"|"family", id, event:{type, date?, place?, note?, value?, age?, citations?}} · event.update {entity, id, fid, set} · event.remove {entity, id, fid}
citation.add {entity, id, fid?, citation} · citation.remove {entity, id, fid?, index}
fact.review {entity, id, fid, status:"verified"|"disputed"|"unverified", note, evidence?:[{index}|citation], finding?}
family.create {id?, husband?, wife?, children?, events?} · family.set_spouse {family, role:"husband"|"wife", person|null} · family.swap_spouses {family} · family.add_child / family.remove_child {family, person} · family.delete {family} · family.merge {keep, drop}
source.upsert {id?, data:{title, type?, author?, publication?, url?, repository?, apid?, note?, text?}} · source.merge {keep, drop} · source.delete {id}
media.attach {person, file, caption?, type?, date?, place?, note?, source?, portrait?} · media.update {person, file, set:{caption?, type?, date?, place?, note?, source?}} (set source to a catalogued source id, or null to unlink it) · media.set_primary {person, file} · media.detach {person, file}
A citation: {source?:"S…", title?, url?, page?, text?, note?, accessed?, source_type?:"original"|"derivative"|"authored", information?:"primary"|"secondary"|"undetermined", evidence?:"direct"|"indirect"|"negative", quality?:0-3, personal?:true}.`;

const BATCH_HELP = `A research batch: {findings?:[{person, kind:"confirmed"|"correction"|"conflict"|"data-error"|"new-fact"|"new-person", field?, fact?:"e3", claim?, finding, confidence:"high"|"medium"|"low", sources:[{title, url?|note?}], proposed_ops?:[op]}], log?:[{person?, searched, result:"found"|"nil"|"inconclusive", note?, url?}], todo?:[{person?, task, where?, priority:"high"|"medium"|"low"}], todo_done?:[{id, outcome?}], people_status?:{"I…":{status:"unverified"|"partly-verified"|"verified"|"disputed", note?}}, stories?:[{title, body, people:[ids], sources:[…], era?}]}. Every finding and story needs sources; story bodies link people as [[I12|Name]].`;

// ---------------------------------------------------------------- schema helpers
const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const int = (description, extra = {}) => ({ type: "integer", description, ...extra });
const bool = (description) => ({ type: "boolean", description });
const en = (values, description) => ({ type: "string", enum: values, description });
const arr = (items, description) => ({ type: "array", items, description });
const objAny = (description) => ({ type: "object", description, additionalProperties: true });
const TREE = str("Tree id (from whoami). Defaults to your first tree.");
const OPS = arr({
  ...objAny("one op"),
  required: ["op"],
  if: { properties: { op: { const: "person.update" } } },
  then: {
    required: ["id", "set"],
    properties: {
      id: str("person id"),
      set: {
        type: "object", minProperties: 1, additionalProperties: false,
        properties: {
          sex: en(["M", "F", "U", ""], "sex"),
          notes: { anyOf: [str("one note"), arr(str("note"), "notes"), { type: "null" }] },
          research_status: en(PERSON_STATUSES, "person-level research status"),
          status_note: { type: ["string", "null"], description: "person-level status note; null clears it" },
        },
      },
    },
  },
}, "The ops. " + OPS_HELP);
const SOURCES = arr({ type: "object", properties: { title: str("what the record is"), url: str("where it is (http/https)"), note: str("where/how, if no url") }, required: ["title"] }, "The records that support this change.");

// ---------------------------------------------------------------- the tools
// role: "any" (anyone with a grant), "editor" (editor or owner on some tree), "owner". The handlers check again, per
// tree, exactly as the site does; the role here only decides which tools are listed.
const T = [];
const tool = (name, def) => T.push({ name, role: "any", readOnly: true, ...def });

// orientation
tool("whoami", { title: "Who am I", description: "Who you're signed in as, the trees you can use with your role and view in each, and the person you're linked to in the tree.",
  props: {}, run: async (x) => x.api("GET", "/api/me") });
tool("tree_overview", { title: "Tree overview", description: "Counts, years covered, branches, the home person, research status and data-issue totals for one tree, as your view shows it.",
  run: async (x) => V.overview(await x.bundle()) });

// people
tool("search_people", { title: "Search people", description: "Find people by name and filters (birth/death year ranges, a place anywhere in their events, branch, sex, living, direct line, research status). Sorted by birth.",
  props: { query: str("name words, any order, accents ignored"), surname: str("exact surname (any of their names)"), given: str("given name contains"), born_from: int("birth year ≥"), born_to: int("birth year ≤"),
    died_from: int("death year ≥"), died_to: int("death year ≤"), place: str("any event place contains"), branch: str("branch key"), sex: en(["M", "F", "U"], "sex"), living: bool("living or not"),
    direct_line: bool("only the home person's direct line"), status: en(["unverified", "partly-verified", "verified", "disputed"], "research status"), limit: int("max results (default 25, max 200)"), offset: int("skip this many") },
  run: async (x, a) => V.search(await x.bundle(), a) });
tool("get_person", { title: "Get person", description: "One person in full: names and events with fact ids, citations and review status, notes, photos, AI profile, parents' and own families, findings, searches already logged, to-dos, stories, data issues, possible duplicates.",
  props: { id: str("person id, e.g. I12"), include_comments: bool("also the discussion comments on this person") }, required: ["id"],
  run: async (x, a) => {
    const b = await x.bundle();
    const comments = a.include_comments && b.people[a.id] && !b.people[a.id].private && b.scope.view.notes ? (await x.api("GET", `/api/comments?type=person&id=${enc(a.id)}`)).comments : undefined;
    return V.person(b, a.id, { comments }) || fail(404, M.notInTree(a.id));
  } });
tool("get_family", { title: "Get family", description: "A family by its F id (couple, children, family events), or a person's immediate family by their I id: parents, full and half siblings, spouses with marriage, children.",
  props: { id: str("F… family id or I… person id") }, required: ["id"], run: async (x, a) => V.family(await x.bundle(), a.id) || fail(404, M.notInTree(a.id)) });
tool("get_ancestors", { title: "Get ancestors (pedigree)", description: "A pedigree with Ahnentafel numbers (1 = the person, 2n = father, 2n+1 = mother), birth/death years and places, repeats from pedigree collapse marked, and the numbers of ancestors still unknown (brick walls).",
  props: { id: str("person id"), generations: int("how many generations up (1–12, default 4)") }, required: ["id"],
  run: async (x, a) => V.ancestors(await x.bundle(), a.id, a.generations) || fail(404, M.notInTree(a.id)) });
tool("get_descendants", { title: "Get descendants", description: "Descendants generation by generation with d'Aboville numbers (1.2.1), each with their parents and spouses.",
  props: { id: str("person id"), generations: int("how many generations down (1–12, default 3)") }, required: ["id"],
  run: async (x, a) => V.descendants(await x.bundle(), a.id, a.generations) || fail(404, M.notInTree(a.id)) });
tool("relationship_between", { title: "Relationship between two people", description: "How two people are related: the label (\"second cousin once removed\"), a plain-English chain, the path of people, and their nearest common ancestors. `from` defaults to you (your linked person) or the tree's home person.",
  props: { from: str("person id (default: you)"), to: str("person id") }, required: ["to"],
  run: async (x, a) => { const b = await x.bundle(); return V.relate(b, a.from || (b.people[x.c.access.personId] ? x.c.access.personId : b.home), a.to); } });
tool("get_timeline", { title: "Life timeline", description: "A person's life in date order with their age: their own events, marriages, children's births, and the deaths of parents, siblings, spouses and children.",
  props: { id: str("person id") }, required: ["id"], run: async (x, a) => V.timeline(await x.bundle(), a.id) || fail(404, M.notInTree(a.id)) });

// across the tree
tool("search_events", { title: "Search events", description: "Events across the whole tree (people and families) by type (Birth, Death, Marriage, Residence, Census, Immigration, Military, Occupation…), place, year range and text in value or note. Good for \"who lived in X in 1900\" or \"every census entry\".",
  props: { type: str("event type, exact (case ignored)"), place: str("place contains"), year_from: int("year ≥"), year_to: int("year ≤"), text: str("value/note contains"), limit: int("max (default 50, max 500)") },
  run: async (x, a) => V.searchEvents(await x.bundle(), a) });
tool("list_surnames", { title: "Surnames", description: "Every surname with how many people carry it, the years it spans, its branches and its most common places.",
  props: { min_count: int("only surnames with at least this many people") }, run: async (x, a) => V.surnames(await x.bundle(), a) });
tool("list_places", { title: "Places", description: "Places in the tree with event and people counts, years, event types, and the standardized name and coordinates where known.",
  props: { query: str("place contains") }, run: async (x, a) => V.places(await x.bundle(), a) });
tool("list_data_issues", { title: "Data-quality issues", description: "Problems the tree's checks found (impossible dates, parents too young, multiple parent families, missing sexes…), filterable.",
  props: { person: str("person id"), kind: str("issue kind"), severity: en(["error", "warning", "info"], "severity"), limit: int("max (default 100)") }, run: async (x, a) => V.issues(await x.bundle(), a) });
tool("list_duplicates", { title: "Possible duplicates", description: "Pairs of people who may be the same person (flagged by research or detected by the checks).",
  run: async (x) => V.duplicates(await x.bundle()) });

// sources and stories
tool("list_sources", { title: "Sources", description: "The catalogued sources (S… ids) your view can see, with how often each is cited.",
  props: { query: str("title/author/publication contains") }, run: async (x, a) => V.sourceList(await x.bundle(), a) });
tool("get_source", { title: "Get source", description: "One source record and every fact, name, person and photo that cites it (with page and citation index).",
  props: { id: str("source id, e.g. S3") }, required: ["id"], run: async (x, a) => V.source(await x.bundle(), a.id) || fail(404, M.notInTree(a.id)) });
tool("list_stories", { title: "Stories", description: "The family stories in this tree's view, optionally about one person or containing some text.",
  props: { person: str("person id"), query: str("title/body contains") }, run: async (x, a) => V.stories(await x.bundle(), a) });
tool("get_story", { title: "Get story", description: "One story: title, Markdown body (people linked as [[I12|Name]]), the people it's about and its sources.",
  props: { slug: str("story slug from list_stories") }, required: ["slug"], run: async (x, a) => V.story(await x.bundle(), a.slug) || fail(404, M.noStory(a.slug)) });

// research
tool("list_findings", { title: "Research findings", description: "Research findings (confirmations, corrections, conflicts, new facts…) with their sources, proposed fixes and resolution.",
  props: { person: str("person id"), status: en(["open", "resolved", "dismissed", "all"], "default open"), kind: str("finding kind"), limit: int("max (default 100)") },
  run: async (x, a) => V.findings(await x.bundle(), a) });
tool("list_research_log", { title: "Research log", description: "Searches already run (including nil results), so you don't repeat them.",
  props: { person: str("person id"), result: en(["found", "nil", "inconclusive"], "result"), limit: int("most recent N (default 200)") }, run: async (x, a) => V.researchLog(await x.bundle(), a) });
tool("list_todos", { title: "Research to-dos", description: "Research to-dos, by status, assignee or person.",
  props: { status: str("open, in_progress, needs_review, done, wont_do (comma-separated), or active"), assignee: str("me, unassigned, or a principal"), person: str("person id") },
  run: async (x, a) => x.api("GET", `/api/todos${qs({ status: a.status, assignee: a.assignee, person: a.person })}`) });
tool("get_my_queue", { title: "My work queue", description: "To-dos assigned to you and not finished, then unassigned open ones you could claim.",
  run: async (x) => x.api("GET", "/api/queue") });
tool("get_todo_history", { title: "To-do history", description: "A to-do's events: status changes, assignments, comments, linked suggestions and review notes.",
  props: { id: int("to-do id") }, required: ["id"], run: async (x, a) => x.api("GET", `/api/todos/${+a.id}/events`) });
tool("list_suggestions", { title: "Suggestions", description: "The suggestions queue (research batches and tree edits awaiting review). Members see their own; editors see all.",
  props: { status: en(["open", "approved", "rejected", "withdrawn", "all"], "default open") }, run: async (x, a) => x.api("GET", `/api/proposals${qs({ status: a.status })}`) });
tool("list_comments", { title: "Comments", description: "The discussion on a person or a family.",
  props: { type: en(["person", "family"], "default person"), id: str("person or family id") }, required: ["id"],
  run: async (x, a) => x.api("GET", `/api/comments${qs({ type: a.type || "person", id: a.id })}`) });
tool("get_history", { title: "Change history", description: "Who changed what and why: for one person or family (their record, families, findings, photos and status), or, for editors, the latest changes to the whole tree. Each change has a batch id that revert_change can undo.",
  props: { id: str("person or family id (leave out for the whole tree; editors only)") }, run: async (x, a) => x.api("GET", `/api/history${qs({ id: a.id })}`) });
tool("get_provenance", { title: "Provenance (PROV-O)", description: "W3C PROV-O (JSON-LD) for one person's records: every change, who made it, from which suggestion and evidence. Editors may ask for an agent run's provenance instead.",
  props: { id: str("person id"), run: str("agent run id (editors)") }, run: async (x, a) => x.api("GET", `/api/prov${qs({ id: a.id, run: a.run })}`) });
tool("get_media", { title: "Get photo or document", description: "A photo or scanned document attached to someone you can see (its `file` from get_person), returned as an image or a PDF.",
  props: { file: str("the media file key") }, required: ["file"], run: (x, a) => media(x, a.file) });
tool("list_attachments", { title: "List attachments and reports", description: "List general attachments and Markdown reports attached to one person in your view.",
  props: { person: str("person id"), type: en(["attachment", "report"], "omit to list both") }, required: ["person"],
  run: async (x, a) => {
    const b = await x.bundle();
    if (!Object.hasOwn(b.people, a.person) || b.people[a.person].private) fail(404, M.notInTree(a.person));
    return { attachments: documentsFor(b, a.person).filter((m) => !a.type || documentType(m.file) === a.type)
      .map((m) => ({ ...m, download_url: documentUrl(x, m.file) })) };
  } });
tool("get_attachment", { title: "Open an attachment", description: "Get a private attachment by its file key. Files up to 8 MB are embedded. Larger files return an authenticated download link.",
  props: { file: str("attachment file key from list_attachments") }, required: ["file"],
  run: (x, a) => getDocument(x, a.file, "attachment") });
tool("get_report", { title: "Read a Markdown report", description: "Read the original Markdown of a visible report by its file key.",
  props: { file: str("report file key from list_attachments") }, required: ["file"],
  run: (x, a) => getDocument(x, a.file, "report") });
tool("preview_edit", { title: "Preview an edit", description: "What a list of edit ops would change, record by record (before and after), without saving anything. Show this to the member before suggest_edit or edit_tree.",
  props: { ops: OPS }, required: ["ops"], run: async (x, a) => x.api("POST", "/api/edit/preview", { ops: a.ops }) });
tool("list_research_sites", { title: "Research sites", description: "The genealogy sites this family prefers for research, with coverage, record types, access and notes on how to search each (editors).",
  role: "editor", run: async (x) => x.api("GET", "/api/research-sites") });
tool("list_agent_runs", { title: "AI agent runs", description: "Past and current runs of the site's AI agents on this tree, with their results and costs (editors; read-only, they can't be started from here).",
  role: "editor", props: { person: str("person id") }, run: async (x, a) => x.api("GET", `/api/agent/runs${qs({ person: a.person })}`) });
tool("get_agent_run", { title: "AI agent run", description: "One AI agent run in full (editors).", role: "editor", props: { id: str("run id") }, required: ["id"],
  run: async (x, a) => x.api("GET", `/api/agent/runs/${enc(a.id)}`) });
tool("export_tree", { title: "Export tree", description: "The tree as your view shows it, as GEDCOM 5.5.1 text or GEDCOM X JSON (editors).", role: "editor",
  props: { format: en(["gedcom", "gedcomx"], "default gedcom") }, run: async (x, a) => x.api("GET", a.format === "gedcomx" ? "/api/export.gedcomx" : "/api/export.ged") });

// writes: anyone with a grant (the route decides what each role may do)
const W = (name, def) => tool(name, { readOnly: false, ...def });
W("create_todo", { title: "Add a research to-do", description: "Add a research to-do, about a person or the tree in general. Only editors may assign it to someone else.",
  props: { person: str("person id"), task: str("what to look for, and why"), where: str("collection, archive or site to search"), priority: en(["high", "medium", "low"], "default medium"), assignee: str("me, or a principal (editors)") }, required: ["task"],
  run: async (x, a) => x.api("POST", "/api/todos", pick(a, ["person", "task", "where", "priority", "assignee"])) });
W("update_todo", { title: "Update a to-do", description: "Change a to-do's status, assignee, details or outcome, or add a comment. Members and agents may move their own to-dos to open, in_progress or needs_review; editors may also close them (done, wont_do) and change details.",
  props: { id: int("to-do id"), version: int("the version you read (guards against overwriting someone else's change)"), status: en(["open", "in_progress", "needs_review", "done", "wont_do"], "new status"),
    assignee: { type: ["string", "null"], description: "me, a principal, or null to unassign" }, priority: en(["high", "medium", "low"], "priority"), task: str("task text"), where: str("where to search"), outcome: str("what was found"), comment: str("a progress note") }, required: ["id"],
  run: async (x, a) => x.api("PATCH", `/api/todos/${+a.id}`, pick(a, ["version", "status", "assignee", "priority", "task", "where", "outcome", "comment"])) });
W("claim_todo", { title: "Claim a to-do", description: "Assign an open to-do to yourself and mark it in progress.", props: { id: int("to-do id") }, required: ["id"],
  run: async (x, a) => x.api("POST", `/api/todos/${+a.id}/claim`) });
W("suggest_research", { title: "Suggest research", description: "Submit research for an editor to review: findings with sources, the searches you ran (including nil results), new to-dos, finished to-dos, status changes and stories. Linking a to-do you're working on moves it to needs_review. " + BATCH_HELP,
  props: { batch: objAny("the research batch"), rationale: str("a short summary for the reviewer"), todo_id: int("the to-do this answers") }, required: ["batch"],
  run: async (x, a) => x.api("POST", "/api/proposals", { tree: x.treeId, kind: "research", payload: a.batch, rationale: a.rationale, todo_id: a.todo_id }) });
W("suggest_edit", { title: "Suggest a tree edit", description: "Propose changes to the tree itself for an editor to review (the way members and agents change the tree). Cite the records. " + OPS_HELP,
  props: { ops: OPS, reason: str("the evidence, in a sentence or two"), sources: SOURCES, resolves: arr({ type: "integer" }, "finding ids this settles"), rationale: str("note to the reviewer"), todo_id: int("the to-do this answers") }, required: ["ops", "reason"],
  run: async (x, a) => x.api("POST", "/api/proposals", { tree: x.treeId, kind: "edit", payload: pick(a, ["ops", "reason", "sources", "resolves"]), rationale: a.rationale || a.reason, todo_id: a.todo_id }) });
W("withdraw_suggestion", { title: "Withdraw a suggestion", description: "Withdraw one of your own open suggestions.", props: { id: int("suggestion id") }, required: ["id"],
  run: async (x, a) => x.api("POST", `/api/proposals/${+a.id}/withdraw`, {}) });
W("add_comment", { title: "Comment", description: "Add a comment to the discussion on a person or family, optionally about one fact.",
  props: { type: en(["person", "family"], "default person"), id: str("person or family id"), fid: str("fact id (e3, n1) the comment is about"), body: str("the comment") }, required: ["id", "body"],
  run: async (x, a) => x.api("POST", "/api/comments", { tree: x.treeId, type: a.type || "person", id: a.id, fid: a.fid, body: a.body }) });
W("resolve_comment", { title: "Resolve a comment", description: "Mark a comment resolved (its author or an editor).", props: { id: int("comment id") }, required: ["id"],
  run: async (x, a) => x.api("POST", `/api/comments/${+a.id}/resolve`, {}) });
W("upload_media", { title: "Upload a photo or document", description: "Upload a photo (JPEG, PNG, WebP, GIF) or PDF, up to 20 MB, base64-encoded. Returns its file key; attach it to someone with a media.attach op (edit_tree, or suggest_edit for members).",
  props: { name: str("file name"), content_type: en(["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"], "file type"), data_base64: str("the file, base64") }, required: ["content_type", "data_base64"],
  run: async (x, a) => {
    const bytes = uploadBytes(a.data_base64);
    return x.api("POST", `/api/media/upload${qs({ name: a.name || "upload" })}`, bytes, { "Content-Type": a.content_type, "Content-Length": String(bytes.byteLength) });
  } });
W("add_attachment", { title: "Add an attachment", description: "Upload any file (up to 20 MB) and attach it to a person, optionally linking an existing source. Members submit it for review.",
  props: { person: str("person id"), name: str("original filename"), title: str("optional display title"), source: str("existing catalogued source id from get_source"), data_base64: str("file bytes as base64") },
  required: ["person", "name", "data_base64"],
  run: (x, a) => {
    return addDocument(x, a, "attachment", uploadBytes(a.data_base64));
  } });
W("add_report", { title: "Add a report", description: "Attach UTF-8 Markdown as a report with a built-in viewer and optionally link an existing source. For an already uploaded report, use media.update with set.source. Members submit it for review.",
  props: { person: str("person id"), name: str("filename ending in .md or .markdown"), title: str("optional display title"), source: str("existing catalogued source id from get_source"), markdown: str("the report in Markdown") },
  required: ["person", "name", "markdown"],
  run: (x, a) => addDocument(x, a, "report", new TextEncoder().encode(a.markdown)) });
W("link_my_person", { title: "Link me to my person", description: "Say which person in the tree you are, so relationships are labelled relative to you. null unlinks.",
  props: { person_id: { type: ["string", "null"], description: "person id, or null" } }, required: ["person_id"],
  run: async (x, a) => x.api("PUT", "/api/me/person", { tree: x.treeId, person_id: a.person_id }) });

// editors
const E = (name, def) => W(name, { role: "editor", ...def });
E("edit_tree", { title: "Edit the tree", description: "Change the tree directly (editors; recorded as you, undoable with revert_change). Give the evidence in reason and sources. `resolves` closes findings in the same change. Preview first and confirm with the member. " + OPS_HELP,
  destructive: true, props: { ops: OPS, reason: str("why: the evidence"), sources: SOURCES, resolves: arr({ type: "integer" }, "finding ids this settles") }, required: ["ops", "reason"],
  run: async (x, a) => x.api("POST", "/api/edit", { tree: x.treeId, ...pick(a, ["ops", "reason", "sources", "resolves"]) }) });
E("revert_change", { title: "Undo a change", description: "Undo one change (a batch id from get_history), if nothing has changed those records since (editors).", destructive: true,
  props: { batch: str("batch id"), reason: str("why") }, required: ["batch"], run: async (x, a) => x.api("POST", `/api/changes/${enc(a.batch)}/revert`, { reason: a.reason }) });
E("review_suggestion", { title: "Approve or reject a suggestion", description: "Approve (applies it: research is recorded, edits are made) or reject (back to its author with your note) an open suggestion (editors). skip_missing approves a research batch without parts about people no longer in the tree; close_todo:false keeps the linked to-do open.",
  destructive: true, props: { id: int("suggestion id"), decision: en(["approve", "reject"], "decision"), note: str("note to the author (needed when rejecting, usually)"), skip_missing: bool("leave out parts about people removed since"), close_todo: bool("close the linked to-do (default true)") }, required: ["id", "decision"],
  run: async (x, a) => x.api("POST", `/api/proposals/${+a.id}/${a.decision === "approve" ? "approve" : "reject"}`, pick(a, ["note", "skip_missing", "close_todo"])) });
E("update_finding", { title: "Resolve, dismiss or reopen a finding", description: "Close a finding as resolved (the tree was fixed) or dismissed (keep the tree as it is; needs a note), or reopen it (editors). To fix the tree and close it in one step, use edit_tree with resolves.",
  props: { id: int("finding id"), status: en(["resolved", "dismissed", "open"], "new status"), note: str("why"), version: int("the version you read") }, required: ["id", "status"],
  run: async (x, a) => x.api("PATCH", `/api/findings/${+a.id}`, { tree: x.treeId, ...pick(a, ["status", "note", "version"]) }) });
E("apply_quality_review", { title: "Apply a quality review", description: "Record a finished quality-review run's report as findings and to-dos (editors). The run itself is started on the site.",
  props: { run: str("run id") }, required: ["run"], run: async (x, a) => x.api("POST", `/api/agent/runs/${enc(a.run)}/apply`, {}) });

// owner
const O = (name, def) => W(name, { role: "owner", ...def });
O("admin_overview", { title: "Sharing settings", description: "Every tree, view, member and grant (owner).", readOnly: true, run: async (x) => x.api("GET", "/api/admin") });
O("admin_save_tree", { title: "Create or change a tree", description: "Define a tree: which branches it takes in, plus people to include or exclude, and its root (owner).",
  props: { id: str("tree id"), name: str("display name"), definition: { type: "object", properties: { branches: arr({ type: "string" }, "branch keys, or [\"*\"] for all"), include: arr({ type: "string" }, "person ids"), exclude: arr({ type: "string" }, "person ids"), root: str("person id") } } }, required: ["id", "name", "definition"],
  run: async (x, a) => x.api("PUT", `/api/admin/trees/${enc(a.id)}`, pick(a, ["name", "definition"])) });
O("admin_save_view", { title: "Create or change a view", description: "Define a view that narrows what a grant shows (owner).",
  props: { id: str("view id"), name: str("display name"), filter: { type: "object", properties: { living: en(["full", "names-only", "anonymous", "hidden"], "how living people show"), branches: arr({ type: "string" }, "branch keys"),
    max_generations: int("depth from the root"), research: bool("findings, to-dos, log"), notes: bool("notes and profiles"), media: bool("photos"), sources: bool("citations"), exclude_people: arr({ type: "string" }, "person ids never shown") } } }, required: ["id", "name", "filter"],
  run: async (x, a) => x.api("PUT", `/api/admin/views/${enc(a.id)}`, pick(a, ["name", "filter"])) });
O("admin_save_member", { title: "Add or change a member", description: "A member's display name, kind (person or agent) and linked person (owner).",
  props: { principal: str("email, or service:<name> for an Access service token"), display_name: str("name"), kind: en(["person", "agent"], "default person"), person_id: str("their person in the tree") }, required: ["principal"],
  run: async (x, a) => x.api("PUT", `/api/admin/members/${enc(a.principal)}`, pick(a, ["display_name", "kind", "person_id"])) });
O("admin_grant", { title: "Share a tree", description: "Give someone a role on a tree, optionally through a view; invite also adds them to the Access group when that's automated (owner).", destructive: true,
  props: { principal: str("email or service:<name>"), tree_id: str("tree id"), role: en(["editor", "member", "agent"], "role"), view_id: str("view id"), invite: bool("add to the Access group") }, required: ["principal", "tree_id", "role"],
  run: async (x, a) => x.api("PUT", "/api/admin/grants", pick(a, ["principal", "tree_id", "role", "view_id", "invite"])) });
O("admin_revoke_grant", { title: "Stop sharing a tree", description: "Remove someone's grant on a tree; revoke_access also removes them from the Access group when it was their last grant (owner).", destructive: true,
  props: { principal: str("email or service:<name>"), tree_id: str("tree id"), revoke_access: bool("remove from the Access group") }, required: ["principal", "tree_id"],
  run: async (x, a) => x.api("DELETE", `/api/admin/grants${qs({ principal: a.principal, tree_id: a.tree_id, revoke_access: a.revoke_access ? "1" : undefined })}`) });
O("audit_log", { title: "Audit history", description: "Every change to the database, newest first, grouped by batch, with filters and paging (owner).", readOnly: true,
  props: { actor: str("principal"), type: str("entity type: person, family, source, finding, todo, proposal, story, grant, mcp…"), q: str("reason, id or batch contains"), limit: int("batches per page (max 100)"), before: int("the `next` cursor from the previous page") },
  run: async (x, a) => x.api("GET", `/api/admin/audit${qs(pick(a, ["actor", "type", "q", "limit", "before"]))}`) });
O("audit_detail", { title: "Audit detail", description: "One batch from the audit history in full: every record's before and after, its suggestion and agent run (owner).", readOnly: true,
  props: { key: str("batch id or c<row id>") }, required: ["key"], run: async (x, a) => x.api("GET", `/api/admin/audit/${enc(a.key)}`) });
O("list_hidden_stories", { title: "Hidden stories", description: "The stories some tree doesn't show, and why (owner).", readOnly: true, run: async (x) => x.api("GET", "/api/admin/stories/hidden") });
O("save_research_site", { title: "Add or change a research site", description: "Add a genealogy site to the research list, or change one (give id). Credentials are set on the site, never through MCP (owner).",
  props: { id: str("site id, to change an existing one"), name: str("name"), url: str("home page"), search_url: str("search URL with {given} {surname} {birth_year} {place}"), domains: arr({ type: "string" }, "domains"), coverage: str("what it covers"),
    record_types: arr({ type: "string" }, "record types"), access: en(["open", "free-account", "subscription", "institution"], "access"), source_quality: en(["original-images", "indexes", "compiled"], "what it holds"), api: str("API notes"), agent_notes: str("how to search it"), enabled: bool("in use"), sort: int("order") },
  run: async (x, a) => { const { id, ...d } = a; return id ? x.api("PUT", `/api/research-sites/${enc(id)}`, d) : x.api("POST", "/api/research-sites", d); } });
O("delete_research_site", { title: "Remove a research site", description: "Remove a site and its credential from the research list (owner).", destructive: true, props: { id: str("site id") }, required: ["id"],
  run: async (x, a) => x.api("DELETE", `/api/research-sites/${enc(a.id)}`) });
O("storage_upgrade", { title: "GEDCOM X storage", description: "Check (dry_run, the default) or carry out the move of the tree to GEDCOM X storage (owner).", destructive: true,
  props: { dry_run: bool("only report (default true)") }, run: async (x, a) => x.api("POST", "/api/admin/storage", { dry_run: a.dry_run !== false }) });
O("import_gedcomx", { title: "Import GEDCOM X", description: "Start an empty database from a GEDCOM X JSON document (owner).", destructive: true,
  props: { document: objAny("the GEDCOM X document ({persons, relationships, sourceDescriptions…})") }, required: ["document"], run: async (x, a) => x.api("POST", "/api/admin/import.gedcomx", a.document) });
O("export_database", { title: "Export the whole database", description: "Everything, raw: every tree, research, config (owner; a backup).", readOnly: true, run: async (x) => x.api("GET", "/api/export.json") });

const TOOLS = new Map(T.map((t) => [t.name, t]));
export const toolNames = () => [...TOOLS.keys()];

// ---------------------------------------------------------------- helpers
const enc = encodeURIComponent;
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const qs = (o) => { const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""); return p.length ? `?${p.map(([k, v]) => `${k}=${enc(v)}`).join("&")}` : ""; };

const isEditor = (access) => access.isOwner || access.grants.some((g) => can.review(g));
const allowed = (t, access) => t.role === "any" || (t.role === "editor" ? isEditor(access) : access.isOwner);

function schemaOf(t) {
  const properties = { ...(t.props || {}) };
  if (!["whoami"].includes(t.name) && t.role !== "owner") properties.tree = TREE;
  return { type: "object", properties, ...(t.required ? { required: t.required } : {}), additionalProperties: false };
}
const listed = (t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: schemaOf(t),
  ...(presentsRecords(t.name) ? { _meta: { ui: { resourceUri: cardResource.uri } } } : {}),
  annotations: { title: t.title, readOnlyHint: !!t.readOnly, destructiveHint: !!t.destructive, idempotentHint: !!t.readOnly, openWorldHint: false } });

/** Light argument check against the tool's schema: required fields and types, unknown fields refused. */
function checkArgs(t, args) {
  if (args == null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) fail(400, M.badArguments("arguments must be an object"));
  const s = schemaOf(t);
  for (const r of s.required || []) if (args[r] === undefined || args[r] === "") fail(400, M.missing(r));
  for (const [k, v] of Object.entries(args)) {
    const d = s.properties[k];
    if (!d) fail(400, M.badArguments(`unknown field "${k}"`));
    if (v === null) { if (!(Array.isArray(d.type) && d.type.includes("null"))) fail(400, M.badArguments(`${k} can't be null`)); continue; }
    const want = Array.isArray(d.type) ? d.type : [d.type];
    const got = Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
    if (!want.some((w) => w === got || (w === "number" && got === "integer") || (w === "object" && got === "object"))) fail(400, M.badArguments(`${k} must be ${want.join(" or ")}`));
    if (d.enum && !d.enum.includes(v)) fail(400, M.badArguments(`${k} must be one of ${d.enum.join(", ")}`));
  }
  return args;
}

/** Call one of the site's own routes as the signed-in member, in-process. Returns the JSON body, or the text for an
 *  export; a refusal becomes an HttpError the tool call reports. */
async function callRoute(c, route, method, path, body, headers = {}) {
  const url = new URL(path, c.url.origin);
  const isBytes = body instanceof Uint8Array;
  const request = new Request(url, { method, headers: { ...(body !== undefined && !isBytes ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : isBytes ? body : JSON.stringify(body) });
  const res = await route({ ...c, request, url });
  const type = res.headers.get("Content-Type") || "";
  const text = await res.text();
  const data = /json/.test(type) ? (() => { try { return JSON.parse(text); } catch { return text; } })() : text;
  if (res.status >= 400) throw new HttpError(res.status, (data && data.error) || M.failed(res.status, ""), data && typeof data === "object" ? (({ error, ...rest }) => rest)(data) : undefined);
  return data;
}

function uploadBytes(encoded) {
  const data = encoded.replace(/\s+/g, "");
  if (data.length > Math.ceil(FILE_LIMIT / 3) * 4) fail(413, S.api.uploads.tooLarge);
  try { return Uint8Array.fromBase64(data); } catch { fail(400, M.badBase64); }
}

const b64 = (buffer) => new Uint8Array(buffer).toBase64();

function documentUrl(x, file) {
  return `${x.c.url.origin}/media/${file}${qs({ tree: x.treeId })}`;
}

function addDocument(x, args, type, bytes) {
  return x.api("POST", `/api/attachments${qs({ person: args.person, type, source: args.source })}`, bytes, {
    "Content-Length": String(bytes.byteLength),
    "X-Document-Name": enc(args.name),
    "X-Document-Title": enc(args.title || ""),
  });
}

async function getDocument(x, file, type) {
  if (documentType(file) !== type || !x.c.env.MEDIA) fail(404, M.notInTree(file));
  const uri = documentUrl(x, file);
  const response = await x.downloadDocument(uri, file);
  if (type === "report") return { file, markdown: await response.text(), download_url: uri };
  const size = await x.c.env.DB.prepare("SELECT bytes FROM uploads WHERE key = ?").bind(file).first("bytes");
  const mimeType = "application/octet-stream";
  if (size > MEDIA_MAX) {
    await response.body?.cancel();
    return { content: [{ type: "resource_link", name: file, uri, mimeType, size }] };
  }
  return { content: [{ type: "resource", resource: { uri, mimeType, blob: b64(await response.arrayBuffer()) } }] };
}

async function media(x, file) {
  const typeOfDocument = documentType(file);
  if (typeOfDocument) return getDocument(x, file, typeOfDocument);
  const b = await x.bundle();
  const files = new Set([...Object.values((b.research && b.research.media) || {}).flat().map((m) => m && m.file), ...Object.values(b.media || {}).map((m) => m.file),
  ]);
  if (!x.c.env.MEDIA || !files.has(file)) fail(404, M.notInTree(file));
  const obj = await x.c.env.MEDIA.get(file);
  if (!obj) fail(404, M.notInTree(file));
  if (obj.size > MEDIA_MAX) {
    await obj.body?.cancel?.();
    fail(413, M.mediaTooLarge(MEDIA_MAX / 1024 / 1024));
  }
  const buf = await new Response(obj.body).arrayBuffer();
  if (buf.byteLength > MEDIA_MAX) fail(413, M.mediaTooLarge(MEDIA_MAX / 1024 / 1024));
  const h = new Headers();
  if (obj.writeHttpMetadata) obj.writeHttpMetadata(h);
  const type = safeMediaType(h.get("Content-Type"));
  const data = b64(buf);
  return { content: [type.startsWith("image/") ? { type: "image", data, mimeType: type }
    : { type: "resource", resource: { uri: `${x.c.url.origin}/media/${file.split("/").map(enc).join("/")}${qs({ tree: x.treeId })}`, mimeType: type, blob: data } }] };
}

const textResult = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v) }] });

async function logCall(c, name, treeId, ok) {
  try {
    await c.env.DB.prepare("INSERT INTO changes (at, actor, actor_kind, entity_type, entity_id, op, after) VALUES (?, ?, ?, 'mcp', ?, 'call', ?)")
      .bind(now(), c.access.principal, c.access.kind === "agent" ? "agent" : "person", name, J({ tree: treeId || null, ok })).run();
  } catch (e) { console.error("mcp audit", e); }
}

/** Run one tool for the caller. Returns an MCP CallToolResult. */
export async function callTool(c, deps, name, rawArgs) {
  const t = TOOLS.get(name);
  if (!t) return { ...textResult(M.unknownTool(name)), isError: true };
  let treeId = null;
  try {
    if (!allowed(t, c.access)) fail(403, M.toolNotAllowed(name));
    const args = { ...checkArgs(t, rawArgs) };
    const g = t.role === "owner" || name === "whoami" ? grantFor(c.access, args.tree) : deps.grantOrFail(c, args.tree || null);
    treeId = g && g.tree_id;
    delete args.tree;
    const x = {
      c, treeId,
      bundle: () => deps.scoped(c, g),
      downloadDocument: (uri, file) => deps.downloadDocument({ ...c, url: new URL(uri) }, file),
      api: (method, path, body, headers) => {
        const sep = path.includes("?") ? "&" : "?";
        return callRoute(c, deps.route, method, treeId && !/[?&]tree=/.test(path) ? `${path}${sep}tree=${enc(treeId)}` : path, body, headers);
      },
    };
    const out = await t.run(x, args);
    const result = presentsRecords(name) ? await recordResult(x, t, args, out) : { data: out, cards: [] };
    await logCall(c, name, treeId, true);
    const response = Array.isArray(out?.content) ? out : textResult(result.data);
    if (!result.cards.length) return response;
    const revision = c.request.headers.get("MCP-Protocol-Version");
    if (revision === "2024-11-05" || revision === "2025-03-26") {
      return Array.isArray(out?.content)
        ? { ...response, content: [...response.content, { type: "text", text: JSON.stringify({ page_url: result.data.page_url }) }] }
        : response;
    }
    const links = [...new Map(result.cards.map((card) => [card.page_url, card])).values()].slice(0, 8)
      .map((card) => ({ type: "resource_link", uri: card.page_url, name: card.title || t.title, mimeType: "text/html" }));
    return { ...response, content: [...response.content, ...links], structuredContent: { cards: result.cards } };
  } catch (e) {
    await logCall(c, name, treeId, false);
    if (e instanceof HttpError) {
      const extra = e.extra && Object.keys(e.extra).length ? `\n${JSON.stringify(e.extra)}` : "";
      return { ...textResult(`${e.message}${extra}`), isError: true };
    }
    console.error(e);
    return { ...textResult(S.api.http.internalError), isError: true };
  }
}

// ---------------------------------------------------------------- JSON-RPC
async function dispatch(c, deps, msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return rpcError(null, -32600, M.invalidRequest);
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return "result" in msg || "error" in msg ? null : rpcError(msg.id, -32600, M.invalidRequest);
  }
  const isNote = !("id" in msg);
  const ok = (result) => (isNote ? null : { jsonrpc: "2.0", id: msg.id, result });
  const p = msg.params || {};
  switch (msg.method) {
    case "initialize":
      return ok({ protocolVersion: PROTOCOLS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false }, resources: {} }, serverInfo: SERVER, instructions: INSTRUCTIONS });
    case "ping": return ok({});
    case "tools/list": return ok({ tools: T.filter((t) => allowed(t, c.access)).map(listed) });
    case "tools/call": return isNote ? null : ok(await callTool(c, deps, p.name, p.arguments));
    case "resources/list": return ok({ resources: c.access.grants.length || c.access.isOwner ? [cardResource] : [] });
    case "resources/read":
      if (p.uri === cardResource.uri && (c.access.grants.length || c.access.isOwner)) {
        return ok({ contents: [{ uri: cardResource.uri, mimeType: cardResource.mimeType, text: cardHtml }] });
      }
      return isNote ? null : rpcError(msg.id, -32002, M.resourceNotFound);
    case "resources/templates/list": return ok({ resourceTemplates: [] });
    case "prompts/list": return ok({ prompts: [] });
    default:
      if (msg.method.startsWith("notifications/")) return null;
      return isNote ? null : rpcError(msg.id, -32601, M.unknownMethod(msg.method));
  }
}

export async function handle(c, deps) {
  const { request, env, url } = c;
  const origin = request.headers.get("Origin");
  const origins = String(env.MCP_ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (origin && origin !== url.origin && !origins.includes(origin)) return rpc(rpcError(null, -32002, M.badOrigin), 403);
  if (request.method !== "POST") return rpc(rpcError(null, -32000, M.postOnly), 405, { Allow: "POST" });
  if (Number(request.headers.get("Content-Length")) > MAX_RPC_BYTES) return rpc(rpcError(null, -32600, M.requestTooLarge), 413);
  let body;
  try {
    const reader = request.body?.getReader();
    if (!reader) return rpc(rpcError(null, -32700, M.parseError), 400);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0, data = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RPC_BYTES) {
        await reader.cancel();
        return rpc(rpcError(null, -32600, M.requestTooLarge), 413);
      }
      data += decoder.decode(value, { stream: true });
    }
    body = JSON.parse(data + decoder.decode());
  } catch { return rpc(rpcError(null, -32700, M.parseError), 400); }
  const batch = Array.isArray(body);
  const msgs = batch ? body : [body];
  if (!msgs.length || msgs.length > 25) return rpc(rpcError(null, -32600, M.invalidRequest), 400);
  const out = [];
  for (const m of msgs) { const r = await dispatch(c, deps, m); if (r) out.push(r); }
  if (!out.length) return rpc(null, 202);
  return rpc(batch ? out : out[0]);
}
