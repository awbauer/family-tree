// Keeps narrative content in step with the facts (the shared, model-free half; the writing is done by the Flue
// agents in agents/src/agents/content.js, which call prepare*/save* below through their tools):
//   - profiles: a short AI-written biography for each person who has died, rebuilt whenever their recorded facts,
//     findings or close family change (content hash). Shown on the person page, labelled as AI-written.
//   - stories: when the facts behind a story change, Claude checks the story against them and, if it is now wrong
//     or incomplete, proposes a revision as a suggestion (stories are authored content, so an editor decides).
// Living people never reach the model here: a living relative appears only as "a living son", with no name.
import { J, now, write, audit } from "../db.js";
import { fullBundle } from "../bundle.js";
import { settings, recordUsage } from "./config.js";

export const CONTENT_AGENT = "agent:content";
const PROMPT_VERSION = "1"; // bump to rebuild every profile after changing the prompts below

export const PROFILE_SYSTEM = `You write short biographies for a private family-history site, from the recorded facts you are given and nothing else.
- 80 to 220 words of plain prose. No headings, lists, links or markdown.
- Use only the facts given. Do not add context, motives, feelings or "likely" details that the facts don't state. If facts conflict, or a status says something is unverified or disputed, say so plainly.
- Refer to relatives by the names given. Relatives described as "a living …" stay unnamed.
- Dates and places as recorded. If little is known, write a short paragraph and say what is not yet known.`;

export const STORY_SYSTEM = `You maintain stories on a private family-history site. You are given a story and the current recorded facts about the people in it. Decide whether the story still agrees with the facts.
- If it does, set up_to_date to true and return the story unchanged.
- If a fact in the story is now contradicted, or an important new fact belongs in it, set up_to_date to false and return a revised story: change as little as possible, keep the author's voice, structure, [[id|name]] links and headings, and use only the facts given. Never add a person who isn't already linked.
- reason: one or two sentences for the editor saying what changed and why.`;

async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const isUnknown = (p) => !p || !p.name || p.name === "Unknown";
const REL = { parent: ["father", "mother", "parent"], spouse: ["husband", "wife", "spouse"], child: ["son", "daughter", "child"], sibling: ["brother", "sister", "sibling"] };
const relWord = (kind, p) => REL[kind][p.sex === "M" ? 0 : p.sex === "F" ? 1 : 2];

function relative(full, id, kind) {
  const p = full.people[id];
  if (!p) return null;
  if (p.living) return `a living ${relWord(kind, p)}`;
  const y = [p.birth && p.birth.year, p.death && p.death.year];
  return `${relWord(kind, p)} ${p.name}${y[0] || y[1] ? ` (${y[0] || "?"}–${y[1] || "?"})` : ""}`;
}

/** The facts a profile is written from (also what its hash covers). */
export function profileFacts(full, id) {
  const p = full.people[id];
  const F = full.families;
  const fam = [];
  for (const fid of p.famc || []) {
    const f = F[fid]; if (!f) continue;
    for (const x of [f.husband, f.wife]) if (x) fam.push(relative(full, x, "parent"));
    for (const x of f.children || []) if (x !== id) fam.push(relative(full, x, "sibling"));
  }
  for (const fid of p.fams || []) {
    const f = F[fid]; if (!f) continue;
    const sp = f.husband === id ? f.wife : f.husband;
    const m = (f.events || []).find((e) => e.type === "Marriage");
    if (sp) fam.push(relative(full, sp, "spouse") + (m ? `, married ${[m.date, m.place].filter(Boolean).join(", ")}` : ""));
    for (const x of f.children || []) fam.push(relative(full, x, "child"));
  }
  const R = full.research || {};
  return {
    name: p.name, sex: p.sex || "unknown",
    other_names: (p.names || []).slice(1).map((n) => `${n.given || ""} ${n.surname || ""}`.trim()).filter(Boolean),
    events: (p.events || []).map((e) => [e.type, e.date, e.place, e.value, e.note].filter(Boolean).join(" · ")),
    notes: p.notes || [],
    verification: p.status ? `${p.status}${p.statusNote ? `: ${p.statusNote}` : ""}` : undefined,
    findings: (R.findings || []).filter((f) => f.person === id).map((f) => `${f.kind} (${f.confidence}): ${f.finding}`),
    family: fam.filter(Boolean),
  };
}

const profileCandidate = (p) => p && !p.living && !isUnknown(p) && ((p.events || []).length >= 2 || (p.notes || []).length);

function storyFacts(full, story) {
  return {
    story: { title: story.title, body: story.body },
    people: (story.people || []).map((id) => {
      const p = full.people[id];
      if (!p) return { id, missing: true };
      if (p.living) return { id, name: p.name, living: true };
      return { id, ...profileFacts(full, id) };
    }),
  };
}

/** What needs refreshing, most important first: stories, then profiles of direct ancestors by generation. */
export async function planContent(env, { limit } = {}) {
  const s = settings(env);
  const max = limit || s.contentPerRun;
  const { full } = await fullBundle(env);
  const have = Object.fromEntries((await env.DB.prepare("SELECT person_id, source_hash FROM profiles").all()).results.map((r) => [r.person_id, r.source_hash]));
  const checked = Object.fromEntries((await env.DB.prepare("SELECT key, source_hash FROM content_checks").all()).results.map((r) => [r.key, r.source_hash]));
  const plan = [];
  for (const st of (full.research && full.research.stories) || []) {
    if (plan.length >= max) break;
    const h = await sha256(PROMPT_VERSION + s.agents.story_checks.model + J(storyFacts(full, st)));
    if (checked[`story:${st.slug}`] !== h) plan.push({ kind: "story", id: st.slug });
  }
  const people = Object.values(full.people).filter(profileCandidate)
    .sort((a, b) => (b.direct ? 1 : 0) - (a.direct ? 1 : 0) || (a.generation ?? 99) - (b.generation ?? 99) || a.id.localeCompare(b.id));
  for (const p of people) {
    if (plan.length >= max) break;
    const h = await sha256(PROMPT_VERSION + s.agents.profiles.model + J(profileFacts(full, p.id)));
    if (have[p.id] !== h) plan.push({ kind: "profile", id: p.id });
  }
  return plan;
}

/** What a profile would be written from now, or {skipped}. `hash` says whether the stored profile is current. */
export async function prepareProfile(env, id) {
  const s = settings(env);
  const { full } = await fullBundle(env);
  const p = full.people[id];
  if (!profileCandidate(p)) return { skipped: p && p.living ? "living" : "not enough recorded to write a profile" };
  const facts = profileFacts(full, id);
  const hash = await sha256(PROMPT_VERSION + s.agents.profiles.model + J(facts));
  const cur = await env.DB.prepare("SELECT source_hash FROM profiles WHERE person_id = ?").bind(id).first();
  return { facts, hash, current: !!(cur && cur.source_hash === hash) };
}

/** Store a written profile (and its token use). Bumps data_version so the site shows it. */
export async function saveProfile(env, id, { text, hash, model, usage }) {
  const body = String(text || "").trim();
  if (body.length < 40) throw new Error("profile text is too short");
  const t = now();
  await write(env, [
    env.DB.prepare("INSERT INTO profiles (person_id, text, source_hash, model, generated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(person_id) DO UPDATE SET text = excluded.text, source_hash = excluded.source_hash, model = excluded.model, generated_at = excluded.generated_at")
      .bind(id, body.slice(0, 4000), hash, model || null, t),
    ...(usage ? [recordUsage(env, usage)] : []),
  ]);
  return { person: id, generated_at: t };
}

/** The first tree whose definition covers every person in the story (proposals belong to a tree). */
async function treeFor(env, full, people) {
  const trees = (await env.DB.prepare("SELECT id, definition FROM trees ORDER BY rowid").all()).results;
  for (const t of trees) {
    const d = JSON.parse(t.definition || "{}");
    const br = d.branches || ["*"];
    const ok = people.every((id) => !(d.exclude || []).includes(id) && ((d.include || []).includes(id) || br.includes("*") || (full.people[id] && br.includes(full.people[id].branch))));
    if (ok) return t.id;
  }
  return trees.length ? trees[0].id : null;
}

/** What a story check works from, or {skipped}. */
export async function prepareStory(env, slug) {
  const s = settings(env);
  const { full } = await fullBundle(env);
  const story = ((full.research && full.research.stories) || []).find((x) => x.slug === slug);
  if (!story) return { skipped: "no such story" };
  const open = await env.DB.prepare("SELECT id FROM proposals WHERE status = 'open' AND author = ? AND payload LIKE ?").bind(CONTENT_AGENT, `%"slug":${J(slug)}%`).first();
  if (open) return { skipped: `revision #${open.id} is waiting for review` };
  const facts = storyFacts(full, story);
  return { facts, hash: await sha256(PROMPT_VERSION + s.agents.story_checks.model + J(facts)), title: story.title };
}

/** Record a story check. An out-of-date story becomes a suggested revision for an editor. */
export async function saveStoryVerdict(env, slug, { hash, up_to_date, reason, title, body, usage }) {
  const { full } = await fullBundle(env);
  const story = ((full.research && full.research.stories) || []).find((x) => x.slug === slug);
  if (!story) return { skipped: "no such story" };
  const t = now();
  const mark = (outcome) => env.DB.prepare("INSERT INTO content_checks (key, source_hash, checked_at, outcome) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET source_hash = excluded.source_hash, checked_at = excluded.checked_at, outcome = excluded.outcome").bind(`story:${slug}`, hash, t, outcome);
  const spend = usage ? [recordUsage(env, usage)] : [];
  if (up_to_date || !String(body || "").trim() || String(body).trim() === String(story.body || "").trim()) {
    await env.DB.batch([...spend, mark("up to date")]);
    return { story: slug, up_to_date: true };
  }
  const tree = await treeFor(env, full, story.people || []);
  const payload = {
    agent: "content",
    story_updates: [{ slug, title: title || story.title, body, people: story.people || [], sources: story.sources || [], reason }],
  };
  const row = await env.DB.prepare("INSERT INTO proposals (created_at, author, author_kind, tree_id, kind, payload, rationale) VALUES (?, ?, 'agent', ?, 'research', ?, ?) RETURNING id")
    .bind(t, CONTENT_AGENT, tree, J(payload), `Story “${story.title}” may be out of date: ${reason}`).first();
  await write(env, [
    ...spend, mark(`proposed #${row.id}`),
    audit(env, { actor: CONTENT_AGENT, actorKind: "agent", entityType: "proposal", entityId: row.id, op: "create", after: { kind: "research", story: slug } }),
  ]);
  return { story: slug, up_to_date: false, proposal: row.id };
}
