// Plans the content job and hands each item to its own agent conversation. Called nightly from src/cloudflare.js
// and on demand through the site (owner: "refresh content"; editors: "rewrite this profile").
import { env } from "cloudflare:workers";
import { dispatch } from "@flue/runtime";
import { settings, checkDaily, BudgetError } from "../../worker/agent/config.js";
import { planContent, prepareProfile, prepareStory } from "../../worker/agent/content.js";
import { ProfileWriter, StoryReviewer } from "./agents/content.js";

const J = (x) => JSON.stringify(x);

/** Queue one profile. The conversation id includes the facts' hash, so the same facts are written once. */
export async function queueProfile(person, { force = false } = {}) {
  const p = await prepareProfile(env, person);
  if (p.skipped) return { person, skipped: p.skipped };
  if (p.current && !force) return { person, skipped: "up to date" };
  const id = `${person}-${p.hash.slice(0, 16)}${force ? `-${Date.now().toString(36)}` : ""}`;
  await dispatch(ProfileWriter, { id, initialData: { person, hash: p.hash }, message: `Recorded facts:\n${J(p.facts)}` });
  return { person, queued: id };
}

export async function queueStory(slug) {
  const s = await prepareStory(env, slug);
  if (s.skipped) return { story: slug, skipped: s.skipped };
  const id = `${slug}-${s.hash.slice(0, 16)}`.slice(0, 120);
  await dispatch(StoryReviewer, { id, initialData: { slug, hash: s.hash }, message: J(s.facts) });
  return { story: slug, queued: id };
}

/** The whole job: whatever changed since last time, most important first, up to CONTENT_MAX_PER_RUN items. */
export async function runContentJob({ limit } = {}) {
  try { await checkDaily(env, settings(env)); } catch (e) { if (e instanceof BudgetError) return { skipped: e.message }; throw e; }
  const plan = await planContent(env, { limit });
  const out = [];
  for (const item of plan) out.push(item.kind === "story" ? await queueStory(item.id) : await queueProfile(item.id));
  return { planned: plan.length, items: out };
}
