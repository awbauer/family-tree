// Loading the tree, and what every page needs to know about the viewer: who they are, which tree, what they may do.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Account, Branch, Person, Tree } from "./types";
import { S } from "../../strings/index.ts";

const L = S.common.load;

export class ApiError extends Error { status = 0; data: unknown = null; }

interface Data {
  D: Tree;
  account: Account | null;
  tree: string | null;          // the tree id being viewed (null when previewing locally with tools/serve.py)
  editor: boolean;              // may change the tree directly
  live: boolean;                // the API supports writes (false on the static preview)
  ai: boolean;                  // the agents are set up and this viewer may use them
  branches: Record<string, Branch>;
  people: Person[];
  api: <T = any>(method: string, path: string, body?: object) => Promise<T>;
}
const Ctx = createContext<Data | null>(null);
export const useData = (): Data => {
  const d = useContext(Ctx);
  if (!d) throw new Error("useData outside <DataProvider>");
  return d;
};

const store = {
  get(k: string, s: Storage = localStorage) { try { return s.getItem(k); } catch { return null; } },
  set(k: string, v: string | null, s: Storage = localStorage) { try { v == null ? s.removeItem(k) : s.setItem(k, v); } catch { /* private mode */ } },
};
export { store };

/** A server error or a dropped connection: worth trying again in a moment (the database sometimes refuses for a few
 *  seconds; the Worker already retries, this covers the rest). */
const RETRY_DELAYS = [700, 2000, 5000];
let onRetry: ((attempt: number) => void) | null = null;

async function getJson(path: string) {
  for (let attempt = 0; ; attempt++) {
    let r: Response | null = null;
    try { r = await fetch(path, { credentials: "same-origin", headers: { Accept: "application/json" } }); }
    catch { r = null; } // offline, or the connection dropped
    if ((r && r.status < 500) || attempt >= RETRY_DELAYS.length) {
      if (!r) throw new Error(L.unavailable);
      return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
    }
    if (onRetry) onRetry(attempt + 1);
    await new Promise((res) => setTimeout(res, RETRY_DELAYS[attempt]));
  }
}

/** Load /api/me (the Worker) and the tree; on the static preview (tools/serve.py) there is no /api/me. */
async function loadTree(): Promise<Tree> {
  const me = await getJson("api/me");
  let tree: string | null = null, account: Account | null = null;
  if (me.ok) {
    account = me.body;
    if (!account!.trees.length) throw new Error(L.noTrees);
    const saved = store.get("tree");
    const linkedTree = new URLSearchParams(location.search).get("tree");
    tree = linkedTree || (account!.trees.find((t) => t.id === saved) || account!.trees[0]).id;
  } else if (me.status === 403) throw new Error(me.body.error || L.notSignedIn);
  else if (me.status >= 500) throw new Error(me.body.error ? `${L.unavailable} (${me.body.error})` : L.unavailable); // not the static preview
  const preview = account && account.isOwner ? store.get("previewView", sessionStorage) : null;
  const r = await getJson(`api/tree${tree ? `?tree=${encodeURIComponent(tree)}` : ""}${preview ? `&preview_view=${encodeURIComponent(preview)}` : ""}`);
  if (!r.ok) throw new Error(r.body.error || L.serverAnswered(r.status));
  r.body.account = account;
  if (preview) r.body.previewView = preview;
  return r.body as Tree;
}

export function DataProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ D?: Tree; error?: string; retrying?: number }>({});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    onRetry = (n) => setState((s) => ({ ...s, retrying: n }));
    loadTree().then((D) => setState({ D }), (e) => setState({ error: String(e.message || e) }));
    return () => { onRetry = null; };
  }, [attempt]);
  const value = useMemo<Data | null>(() => {
    const D = state.D;
    if (!D) return null;
    const me = D.me || null, account = D.account || null, tree = me ? me.tree : null;
    const role = me ? me.role : "owner";
    const editor = role === "owner" || role === "editor";
    const branches: Record<string, Branch> = {};
    for (const b of D.research.branches || []) branches[b.key] = b;
    branches.home = { key: "home", label: S.common.branches.home, color: "var(--b-home)" };
    branches.other = { key: "other", label: S.common.branches.other, color: "var(--b-other)" };
    async function api(method: string, path: string, body?: object) {
      const sep = path.includes("?") ? "&" : "?";
      const r = await fetch(`api/${path}${tree ? `${sep}tree=${encodeURIComponent(tree)}` : ""}`, {
        method, credentials: "same-origin",
        headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify({ tree, ...body }) : undefined,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { const e = new ApiError(data.error || L.serverAnswered(r.status)); e.status = r.status; e.data = data; throw e; }
      return data;
    }
    return { D, account, tree, editor, live: !!me, ai: !!(account && account.ai) && editor, branches, people: Object.values(D.people), api };
  }, [state.D]);

  if (state.error) return (
    <div className="wrap page"><h1>{L.failed.title}</h1><p>{state.error}</p>
      <p><button type="button" className="btn primary" onClick={() => { setState({}); setAttempt((n) => n + 1); }}>{L.tryAgain}</button></p>
      <p className="muted small">{L.failed.locally}<code>{L.failed.cmds.devExample}</code>{L.failed.and}<code>{L.failed.cmds.devWeb}</code>{L.failed.or}<code>{L.failed.cmds.build}</code>{L.failed.then}<code>{L.failed.cmds.serve}</code>{L.failed.cloudflare}</p></div>
  );
  if (!value) return <div className="wrap page"><p className="muted" aria-live="polite">{state.retrying ? L.retrying : L.loading}</p></div>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
