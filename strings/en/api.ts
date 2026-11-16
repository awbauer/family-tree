// User-facing text: api. See strings/index.ts for the conventions.
// The messages the Worker's API returns ({ error } and validation lists); the site shows them as they are.
import { plural } from "../format.ts";

const oneOf = (field: string, allowed: readonly string[]): string => `${field} must be one of ${allowed.join(", ")}`;

/** The SITE_CREDENTIALS_KEY setup steps (secrets.KEY_HELP). */
const keyHelp = "Set SITE_CREDENTIALS_KEY (32 random bytes, base64) on the Worker, then try again:\n"
  + "  openssl rand -base64 32\n"
  + "  npx wrangler secret put SITE_CREDENTIALS_KEY --name family-tree";

export const api = {
  /** Setup and request-level errors (worker/index.js, worker/bundle.js). */
  http: {
    noDatabase: "No D1 binding named DB. See README → Deploy.",
    internalError: "Internal error",
    notFound: "Not found",
    notFoundDot: "Not found.",
    bodyNotJson: "Body must be JSON.",
    noMediaBinding: "No R2 binding named MEDIA.",
    badMediaKey: "Bad key",
    emptyDatabase: "The database is empty. Run the one-time import (README → Deploy).",
  },

  /** Signing in and who may see what (worker/auth.js, worker/index.js, worker/audit.js). */
  auth: {
    accessNotConfigured: "Cloudflare Access is not configured (set ACCESS_TEAM_DOMAIN and ACCESS_AUD). Refusing to serve family data.",
    notSignedIn: "Not signed in through Cloudflare Access.",
    invalidToken: (detail: string) => `Invalid Access token: ${detail}`,
    noTreeAccess: "You don't have access to that tree.",
    noTreesShared: "No family trees have been shared with you yet. Ask the owner to invite you.",
    ownerOnly: "Owner only.",
    ownerOnlyPreview: "Only the owner can preview views.",
  },

  /** Direct edits, edit previews and their scope checks (worker/index.js). */
  edit: {
    opsRequired: "payload.ops must be a non-empty list",
    personNotVisible: (id: string) => `Person ${id} isn't in a tree you can see.`,
    nameOnly: (id: string) => `${id} is shown to you as a name only; you can't change their details.`,
    familyNotVisible: (id: string) => `Family ${id} isn't in a tree you can see.`,
    sourceNotVisible: (id: string) => `Source ${id} isn't in a tree you can see.`,
    sourceCitedOutsidePeople: "This source is also cited by people outside the tree you can see; ask the owner.",
    sourceCitedOutsideFamilies: "This source is also cited on families outside the tree you can see; ask the owner.",
    agentsSuggest: "Agents suggest changes (POST /api/proposals with kind \"edit\"); they don't edit directly.",
    editorsOnly: "Only editors can change the tree directly. Use \"Suggest a change\" instead.",
    reasonRequired: "Say why (reason) — it's kept in the history.",
    conflict: "Someone changed this while you were editing. Reload and try again.",
    cantEditOrSuggest: "You can't change or suggest changes in this tree.",
  },

  /** OpError messages from the edit engine (worker/ops.js). */
  ops: {
    /** Prefix for an error in one op of a list (1-based). */
    atOp: (n: number, message: string) => `op ${n}: ${message}`,
    opsRequired: "ops must be a non-empty list",
    tooMany: "too many ops in one edit (max 500)",
    noPerson: (id: unknown) => `no person ${JSON.stringify(id)}`,
    noFamily: (id: unknown) => `no family ${JSON.stringify(id)}`,
    entityInvalid: 'entity must be "person" or "family"',
    noFact: (what: string, fid: unknown) => `no ${what} ${JSON.stringify(fid)}`,
    eventNeedsType: "event needs a type",
    citationEmpty: "citation needs a source id, title, url or note",
    personalTitle: "Personal knowledge",
    personalNotForAgents: "only a person can cite their own knowledge, not an agent",
    settledBy: {
      sex: "the sex fix it asks for",
      merge: "the merge it asks for",
      familyDelete: "the family deletion it asks for",
    },
    settledNote: (why: string) => `Resolved automatically: this edit made ${why}.`,
    noSource: (id: unknown) => `no source ${JSON.stringify(id)}`,
    citationUrl: "citation url must start with http(s)://",
    citationEnum: (field: string, allowed: readonly string[]) => oneOf(`citation ${field}`, allowed),
    mediaType: (allowed: readonly string[]) => oneOf("media type", allowed),
    nameEmpty: "a name needs a given name or surname",
    personExists: (id: string) => `person ${id} already exists`,
    personNeedsName: "person.create needs at least one name",
    sexInvalid: "sex must be M, F or U",
    unlinkFirst: "unlink this person from their families first",
    samePerson: "keep and drop are the same person",
    keepOneName: "a person keeps at least one name",
    reviewStatus: "status must be unverified, verified or disputed",
    noCitation: (index: number, fid: string) => `no citation ${index} on ${fid}`,
    verifyNeedsSource: "verifying a fact needs at least one cited source",
    noCitationAtIndex: "no citation at that index",
    familyExists: (id: string) => `family ${id} already exists`,
    familyNeedsMember: "a family needs at least one member",
    roleInvalid: 'role must be "husband" or "wife"',
    sameFamily: "keep and drop are the same family",
    spousesDiffer: (role: string) => `the ${role}s differ; merge those people first`,
    sourceNeedsData: "source.upsert needs data",
    sourceNeedsTitle: "a source needs a title",
    sourceType: (allowed: readonly string[]) => oneOf("source type", allowed),
    sourceUrl: "source url must start with http(s)://",
    sameSource: "keep and drop are the same source",
    sourceStillCited: (id: string, n: number) => `source ${id} is still cited ${plural(n, "time", "times")}; merge it into another source instead`,
    fileKey: "file must be an R2 key like uploads/…",
    noMedia: (file: unknown) => `no photo or document ${JSON.stringify(file)} on this person`,
    unknownOp: (op: unknown) => `unknown op ${JSON.stringify(op)}`,
    missingMember: (fid: string, pid: string) => `family ${fid} points at missing person ${pid}`,
  },

  /** The suggestions queue (worker/index.js). */
  proposals: {
    cantSuggest: "You can't make suggestions in this tree.",
    kindInvalid: "kind must be research or edit",
    batchInvalid: "The batch didn't validate.",
    noSuch: "No such suggestion.",
    alreadyDecided: (status: string) => `This suggestion is already ${status}.`,
    authorWithdraws: "Only the author can withdraw a suggestion.",
    editorsReview: "Only editors can review suggestions.",
    noLongerApplies: (reason: string) => `This suggestion no longer applies: ${reason}`,
    treeChanged: "The tree changed while approving. Try again.",
    peopleMissing: (dropped: number, missing: string[]) =>
      `${plural(dropped, "item", "items")} ${dropped === 1 ? "is" : "are"} about ${missing.length === 1 ? "a person" : plural(missing.length, "person", "people")} no longer in the tree (${missing.join(", ")}). Approve without them, or reject the suggestion.`,
    noLongerValidates: (errors: string[]) =>
      `The batch no longer validates: ${errors.slice(0, 3).join("; ")}${errors.length > 3 ? ` (and ${errors.length - 3} more)` : ""}`,
  },

  /** To-dos and the work queue (worker/index.js). */
  todos: {
    cantAdd: "You can't add to-dos in this tree.",
    taskRequired: "task is required",
    priorityInvalid: "priority must be high, medium or low",
    personNotVisible: "That person isn't in a tree you can see.",
    editorsAssign: "Only editors can assign to-dos to someone else.",
    noSuch: "No such to-do.",
    changed: "Someone changed this to-do. Reload and try again.",
    statusInvalid: (allowed: readonly string[]) => oneOf("status", allowed),
    agentsNeedReview: "Agents finish work by moving it to needs_review; an editor closes it.",
    statusNotAllowed: "Only the assignee or an editor can change the status.",
    editorsDetails: "Only editors can edit a to-do's details.",
    outcomeNotAllowed: "Only the assignee or an editor can record an outcome.",
    alreadyAssigned: (who: string) => `Already assigned to ${who}.`,
    closed: "This to-do is closed.",
    claimedFirst: "Someone else claimed it first.",
  },

  /** Resolving, dismissing and reopening findings (worker/index.js). */
  findings: {
    noSuch: "No such finding.",
    editorsResolve: "Only editors can resolve findings.",
    changed: "Someone changed this finding. Reload and try again.",
    statusInvalid: (allowed: readonly string[]) => oneOf("status", allowed),
    dismissReason: "Say why the tree stays as it is; the reason is kept with the finding.",
  },

  /** History, provenance and reverting (worker/index.js, worker/audit.js). */
  history: {
    editorsFull: "Only editors can see the full history.",
    editorsRuns: "Only editors can see research runs.",
    noSuchRun: "No such run.",
    editorsRevert: "Only editors can revert changes.",
    noSuchChange: "No such change.",
    revertConflict: "Those records have changed since; revert the later changes first.",
  },

  /** Comments on people and families (worker/index.js). */
  comments: {
    empty: "Empty comment.",
    authorOrEditorResolves: "Only the author or an editor can resolve a comment.",
  },

  /** Photo and document uploads (worker/index.js). */
  uploads: {
    fileType: "Upload a JPEG, PNG, WebP, GIF or PDF.",
    tooLarge: "Files are limited to 20 MB.",
    reportTooLarge: "Markdown reports are limited to 1 MB.",
    documentType: "Choose attachment or report.",
    reportFormat: "Choose a UTF-8 Markdown file ending in .md or .markdown.",
    invalidMetadata: "The filename or title is invalid.",
    nameRequired: "A filename is required.",
    emptyFile: "Choose a file containing data.",
    crossOrigin: "Upload files from the family tree site.",
    documentsHidden: "Attachments are unavailable for this person in this view.",
    uploadNotOwned: "You can only attach a file you uploaded.",
    addAttachment: "Add an attachment",
    addReport: "Add a report",
  },

  /** Exports and imports (worker/index.js). */
  export: {
    editorsOnly: "Only editors and the owner can export.",
    ownerWholeDatabase: "Only the owner can export the whole database.",
    gedcomxRequired: "Send a GEDCOM X JSON document (with persons).",
  },

  /** Relationship paths and linking yourself to a person (worker/index.js). */
  graph: {
    pickTwo: "Pick two people you can see.",
    pickSomeone: "Pick someone in a tree you can see.",
  },

  /** Trees, views, members and grants (worker/index.js, owner only). */
  admin: {
    treeFields: "name and definition are required",
    viewFields: "name and filter are required",
    livingInvalid: "filter.living must be full, names-only, anonymous or hidden",
    grantFields: "principal and tree_id are required",
    roleInvalid: "role must be editor, member or agent",
    accessGroupUnreadable: "Couldn't read the Access group.",
    accessGroupEmpty: "Refusing to leave the Access group empty.",
    accessManual: (email: string, action: "add" | "remove") =>
      `Add ${email} to the Access group or policy for this app (Zero Trust → Access → ${action} the email). Automate this by setting CF_API_TOKEN, CF_ACCOUNT_ID and ACCESS_GROUP_ID.`,
  },

  /** The research sites list and its credentials (worker/sites.js). */
  sites: {
    ownerOnly: "Only the owner can change the research sites.",
    readersOnly: "Only editors and research agents can see the research sites.",
    invalidMetadata: "The filename or title is invalid.",
    nameRequired: "name is required",
    urlInvalid: "url must be the site's address, starting with https:// (or http://)",
    searchUrlInvalid: "search_url must start with https:// (or http://)",
    searchUrlPlaceholder: "search_url needs at least one placeholder: {given}, {surname}, {birth_year} or {place}",
    domainInvalid: (domain: string) => `domains: ${JSON.stringify(domain)} isn't a hostname (e.g. example.org)`,
    accessInvalid: (allowed: readonly string[]) => oneOf("access", allowed),
    qualityInvalid: (allowed: readonly string[]) => oneOf("source_quality", allowed),
    sortNumber: "sort must be a number",
    idInvalid: "id must be lowercase letters, digits and dashes",
    idTaken: (id: string) => `There's already a site with the id ${id}.`,
    noSuch: "No such research site.",
    credentialKind: (allowed: readonly string[]) =>
      `${oneOf("kind", allowed)}. Agents use API keys or HTTP sign-in only; for sites you sign in to in a browser, agents leave you a to-do instead.`,
    headerName: "name must be an HTTP header name, e.g. X-Api-Key or Authorization",
    headerForbidden: (name: string) => `${name} can't be used: cookies and connection headers aren't credentials agents may send.`,
    headerValue: "value is required (one line, up to 4,000 characters)",
    queryName: "name must be a URL parameter name, e.g. api_key",
    queryValue: "value is required (one line, up to 2,000 characters)",
    usernameRequired: "username is required (no colons)",
    passwordRequired: "password is required",
    noCredential: "This site has no credential.",
  },

  /** Cloud research runs, profiles, quality reviews, stories, library and relatives (worker/agent/routes.js). */
  agentRuns: {
    editorsOnly: "Only editors can run research agents.",
    notSetUp: "Research agents aren't set up yet: build them into the Worker (npm run build:agents) and deploy. See docs/agents/operations.md → Cloud research agents.",
    kindInvalid: "kind must be research, quality, story, library or relatives",
    todoClosed: "That to-do is closed.",
    todoBusy: "A research agent is already working on that to-do.",
    todoAssigned: (who: string) => `That to-do is assigned to ${who}. Unassign it first.`,
    personNotInTree: "That person isn't in this tree.",
    livingNotResearched: "This person is private in your view of the tree, so they can't be researched from it.",
    needTarget: "Give a to-do, a person, or instructions saying what to research.",
    todoChanged: "Someone changed that to-do meanwhile. Reload and try again.",
    runNotStarted: (reason: string) => `Couldn't start the run: ${reason}`,
    reviewNotStarted: (reason: string) => `Couldn't start the review: ${reason}`,
    noSuchRun: "No such run.",
    finished: "That run has already finished.",
    profileLiving: "This person is private in your view of the tree, so no profile can be written from it.",
    nothingToReview: "There are no open items to review with those options.",
    qualityOnly: "Only a data quality review can be applied.",
    reviewNotFinished: "Wait for the review to finish.",
    storyMode: "mode must be review or draft",
    noSuchStory: "No such story.",
    storyPeople: "Choose who the story is about.",
    notInTree: (id: string) => `${id} isn't in this tree.`,
    storyLiving: (name: string) => `${name} is private in your view of the tree, so a story can't be about them; they can be mentioned by name.`,
    libraryN: (max: number) => `n must be 0 to ${max}`,
    libraryEmpty: "There are no stories to review and no candidates for new ones.",
    relativesPerson: "Say whose relatives to look for (person).",
    relativesLiving: "This person is private in your view of the tree, so their relatives can't be looked for from it.",
  },

  /** The page assistant's HTTP routes (worker/agent/chat-routes.js). */
  chat: {
    editorsOnly: "The assistant is for editors.",
    notSetUp: "The assistant isn't set up yet: the agents aren't built into this Worker. See docs/agents/operations.md → Page assistant.",
    noSuchChat: "No such chat.",
    noSuchChange: "No such change.",
    saySomething: "Say something.",
    tooLong: (max: number) => `Keep messages under ${max} characters.`,
    undoAppliedOnly: "Only an applied change can be undone.",
    editGone: "That edit is no longer in the history.",
    undoConflict: "Those records have changed since; undo the later changes first.",
    alreadyDecided: (status: string) => `That change is already ${status}.`,
    cantApply: (reason: string) => `This change can't be applied any more: ${reason}`,
    alreadyInTree: "the tree already says this",
    changedMeanwhile: "Someone changed these records meanwhile. Ask the assistant to look again.",
    /** Notices in the conversation when a reply was stopped or failed. */
    stopped: "Stopped.",
    replyFailed: "The assistant couldn't reply to that. Try again; if it keeps happening, check the Worker's logs.",
  },

  /** Research batch validation (worker/research.js validateBatch); `at` is where in the batch, e.g. findings[0]. */
  batch: {
    notObject: "batch must be a JSON object",
    missingPerson: (at: string) => `${at}: missing person`,
    personNotInTree: (at: string, id: unknown) => `${at}: person ${JSON.stringify(id)} is not in this tree`,
    noSources: (at: string) => `${at}: no sources. Every claim needs a citation`,
    sourceTitle: (at: string, j: number) => `${at}.sources[${j}]: missing title`,
    sourceWhere: (at: string, j: number) => `${at}.sources[${j}]: needs a url or a note saying where the record is`,
    findingKind: (at: string, allowed: readonly string[]) => `${at}: ${oneOf("kind", allowed)}`,
    confidence: (at: string) => `${at}: confidence must be high, medium or low`,
    emptyFinding: (at: string) => `${at}: empty finding`,
    factId: (at: string) => `${at}: fact must be a fact id like e3 (an event) or n1 (a name)`,
    proposedOps: (at: string) => `${at}: proposed_ops must be a list of edit ops`,
    proposedDelete: (at: string) => `${at}: proposed_ops may not delete people`,
    resolutionSet: (at: string) => `${at}: resolution is set by editors, not in research`,
    peopleStatus: (at: string, allowed: readonly string[]) => `${at}: ${oneOf("status", allowed)}`,
    missingTitle: (at: string) => `${at}: missing title`,
    missingSlug: (at: string) => `${at}: missing slug`,
    emptyBody: (at: string) => `${at}: empty body`,
    keepCitations: (at: string) => `${at}: no sources. Keep the story's citations`,
    todoPriority: (at: string) => `${at}: priority must be high, medium or low`,
    missingTask: (at: string) => `${at}: missing task`,
    todoDoneId: (at: string) => `${at}: give the to-do id (or its task text)`,
    logResult: (at: string) => `${at}: result must be found, nil or inconclusive`,
    logSearched: (at: string) => `${at}: say what was searched (collection, site, archive)`,
    noMedia: "media: photos are attached by the owner, not through research batches (yet)",
  },

  /** The MCP server (worker/mcp.js): JSON-RPC errors and tool errors an AI client shows its user. */
  mcp: {
    cards: {
      title: "Family tree records",
      open: "Open on family tree",
      loading: "Loading records…",
      empty: "No linked records in this result.",
      failed: "Could not load the records.",
      cancelled: "Request cancelled.",
      suggestion: (id: number) => `Suggestion #${id}`,
      run: (id: string) => `Agent run ${id}`,
      todo: (id: number) => `To-do #${id}`,
      report: "Report",
      attachment: "Attachment",
      photo: "Photo or scan",
    },
    resourceNotFound: "MCP resource not found.",
    parseError: "Parse error: the body must be a JSON-RPC 2.0 message.",
    invalidRequest: "Invalid request: expected a JSON-RPC 2.0 request.",
    unknownMethod: (m: string) => `Method not found: ${m}`,
    unknownTool: (t: string) => `Unknown tool: ${t}`,
    toolNotAllowed: (t: string) => `${t} needs a role you don't have on any tree.`,
    badArguments: (detail: string) => `Invalid arguments: ${detail}`,
    missing: (field: string) => `${field} is required.`,
    notInTree: (id: string) => `There's no ${id} in this tree, or this tree's view doesn't show it.`,
    noStory: (slug: string) => `There's no story "${slug}" in this tree's view.`,
    badOrigin: "This origin may not call the MCP server.",
    postOnly: "The MCP endpoint takes JSON-RPC over POST (Streamable HTTP, no SSE stream).",
    mediaTooLarge: (mb: number) => `That file is over ${mb} MB, too large to return through MCP. Open it on the site.`,
    badBase64: "data_base64 isn't valid base64.",
    failed: (status: number, msg: string) => `${msg} (HTTP ${status})`,
  },

  /** Encryption key setup for research site credentials (worker/secrets.js). */
  secrets: {
    keyHelp,
    keyMissing: `Credentials can't be saved: SITE_CREDENTIALS_KEY isn't set. ${keyHelp}`,
    keyInvalid: `SITE_CREDENTIALS_KEY must be 32 bytes, base64-encoded. ${keyHelp}`,
  },
} as const;
