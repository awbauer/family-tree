// Worker-level code that isn't HTTP (Flue keeps HTTP in app.js): the weekly content job (cron in wrangler.jsonc) and
// the ChatStore Durable Object. Named exports become top-level Worker exports.
import { DurableObject } from "cloudflare:workers";
import { settings } from "../../worker/agent/config.js";
import { ChatBook, REMOTE_METHODS } from "../../worker/agent/chat-store.js";
import { runContentJob } from "./content-jobs.js";

/** One editor's chats and the changes the assistant drafted for them (worker/agent/chat-store.js). One object per
 *  editor, named by their principal; reached by the Assistant agent directly and by the site Worker through
 *  /internal/chats/:principal (app.js). */
export class ChatStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.book = new ChatBook((q, ...b) => ctx.storage.sql.exec(q, ...b).toArray());
  }
  call(method, args = []) {
    if (![...REMOTE_METHODS, "propose", "addUsage"].includes(method)) throw new Error(`unknown method ${method}`);
    return this.book[method](...args);
  }
}

export default {
  async scheduled(controller, env, ctx) {
    if (!settings(env).contentEnabled) return;
    ctx.waitUntil(runContentJob().then((r) => console.log("content job", JSON.stringify({ planned: r.planned, skipped: r.skipped }))));
  },
};
