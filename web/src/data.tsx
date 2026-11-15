// Loading the tree, and what every page needs to know about the viewer: who they are, which tree, what they may do.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Account, Branch, Person, Tree } from "./types";

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

async function getJson(path: string) {
  const r = await fetch(path, { credentials: "same-origin", headers: { Accept: "application/json" } });
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
}

/** Load /api/me (the Worker) and the tree; on the static preview (tools/serve.py) there is no /api/me. */
async function loadTree(): Promise<Tree> {
  const me = await getJson("api/me");
  let tree: string | null = null, account: Account | null = null;
  if (me.ok) {
    account = me.body;
    if (!account!.trees.length) throw new Error("No family trees have been shared with you yet. Ask the owner to invite you.");
    const saved = store.get("tree");
    tree = (account!.trees.find((t) => t.id === saved) || account!.trees[0]).id;
  } else if (me.status === 403) throw new Error(me.body.error || "Not signed in.");
  const preview = account && account.isOwner ? store.get("previewView", sessionStorage) : null;
  const r = await getJson(`api/tree${tree ? `?tree=${encodeURIComponent(tree)}` : ""}${preview ? `&preview_view=${encodeURIComponent(preview)}` : ""}`);
  if (!r.ok) throw new Error(r.body.error || `The server answered ${r.status}.`);
  r.body.account = account;
  if (preview) r.body.previewView = preview;
  return r.body as Tree;
}

export function DataProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ D?: Tree; error?: string }>({});
  useEffect(() => { loadTree().then((D) => setState({ D }), (e) => setState({ error: String(e.message || e) })); }, []);
  const value = useMemo<Data | null>(() => {
    const D = state.D;
    if (!D) return null;
    const me = D.me || null, account = D.account || null, tree = me ? me.tree : null;
    const role = me ? me.role : "owner";
    const editor = role === "owner" || role === "editor";
    const branches: Record<string, Branch> = {};
    for (const b of D.research.branches || []) branches[b.key] = b;
    branches.home = { key: "home", label: "Home", color: "var(--b-home)" };
    branches.other = { key: "other", label: "Other", color: "var(--b-other)" };
    async function api(method: string, path: string, body?: object) {
      const sep = path.includes("?") ? "&" : "?";
      const r = await fetch(`api/${path}${tree ? `${sep}tree=${encodeURIComponent(tree)}` : ""}`, {
        method, credentials: "same-origin",
        headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify({ tree, ...body }) : undefined,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { const e = new ApiError(data.error || `The server answered ${r.status}.`); e.status = r.status; e.data = data; throw e; }
      return data;
    }
    return { D, account, tree, editor, live: !!me, ai: !!(account && account.ai) && editor, branches, people: Object.values(D.people), api };
  }, [state.D]);

  if (state.error) return (
    <div className="wrap page"><h1>Can’t load the tree</h1><p>{state.error}</p>
      <p className="muted small">Locally: run <code>npm run dev:example</code> and <code>npm run dev:web</code>, or <code>python3 tools/build.py</code> then <code>python3 tools/serve.py</code>. On Cloudflare: check the D1 binding, that the seed was loaded, and that you came in through Cloudflare Access.</p></div>
  );
  if (!value) return <div className="wrap page"><p className="muted">Loading the family tree…</p></div>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
