// Admin → Access (owner only): people and grants, views (with preview), data storage and tree definitions.
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { store, useData } from "../../data";
import { PersonLink } from "../../lib";

const say = (msg: string) => alert(msg);
const VIEW_KEYS = ["research", "notes", "media", "sources"] as const;
const BLANK_VIEW = { id: "", name: "", living: "full", branches: "", max_generations: "", exclude: "", research: true, notes: true, media: true, sources: true };
type ViewForm = typeof BLANK_VIEW;

function ViewOptions({ views }: { views: any[] }) {
  return <><option value="">Full view</option>{views.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</>;
}

function StorageReport({ r }: { r: any }) {
  const rep = r.report;
  if (rep.already) return <>Stored as GEDCOM X.</>;
  return <>{!rep.ok ? <b>Not safe to move</b> : rep.dryRun ? "Ready to move" : "Moved"}: {rep.persons} people, {rep.families} families → {rep.relationships} relationships ({Object.entries(rep.relationshipTypes || {}).map(([k, v]) => `${v} ${k}`).join(", ")}), {rep.sourceDescriptions} sources and media.{(rep.mismatched || []).length ? ` These wouldn't convert back exactly: ${rep.mismatched.join(", ")}` : ""}</>;
}

function Storage() {
  const { api } = useData();
  const [out, setOut] = useState<ReactNode>(null), [canGo, setCanGo] = useState(false);
  async function check() {
    try { const r = await api("POST", "admin/storage", { dry_run: true }); setOut(<StorageReport r={r} />); setCanGo(!!(r.report.ok && !r.report.already)); }
    catch (e) { setOut((e as Error).message); }
  }
  async function go() {
    if (!confirm("Move the tree to GEDCOM X storage now? It runs as one transaction; D1 Time Travel can restore the previous state.")) return;
    try { const r = await api("POST", "admin/storage", { dry_run: false }); setOut(<StorageReport r={r} />); setCanGo(false); }
    catch (e) { setOut((e as Error).message); }
  }
  return (
    <section className="card" id="adm-storage"><h2>Data storage</h2>
      <p className="small muted">The tree is stored as GEDCOM X: people as Persons, families as Couple and Parent–Child relationships, sources as Source Descriptions. A database created before that change can be moved over here, in one step, after a check that every record converts back exactly.</p>
      <div className="btn-row"><button className="btn" id="st-check" onClick={check}>Check</button><button className="btn primary" id="st-go" hidden={!canGo} onClick={go}>Move to GEDCOM X storage</button></div>
      <div id="st-out" className="small">{out}</div>
    </section>
  );
}

export function Access() {
  const { D, api } = useData();
  const [a, setA] = useState<any>(null), [error, setError] = useState("");
  const [msg, setMsg] = useState<ReactNode>(null);
  const [vf, setVf] = useState<ViewForm>(BLANK_VIEW);
  const [gen, setGen] = useState(0); // bumped on every redraw: saving resets the forms
  const alive = useRef(true);
  const draw = useCallback(async () => {
    const r = await api("GET", "admin");
    if (!alive.current) return;
    setA(r); setGen((g) => g + 1); setVf(BLANK_VIEW);
  }, [api]);
  useEffect(() => {
    alive.current = true;
    draw().catch((e) => alive.current && setError(e.message));
    return () => { alive.current = false; };
  }, [draw]);

  async function grant(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const f = ev.currentTarget.elements as any;
    try {
      if (f.principal.value.startsWith("agent:")) await api("PUT", `admin/members/${encodeURIComponent(f.principal.value)}`, { kind: "agent", display_name: f.principal.value });
      const r = await api("PUT", "admin/grants", { principal: f.principal.value, tree_id: f.tree.value, role: f.role.value, view_id: f.view.value || null, invite: f.invite.checked });
      await draw();
      if (r.access && r.access.todo) setMsg(<>Granted. <b>One more step:</b> {r.access.todo}</>);
      else if (r.access && r.access.automated) setMsg(r.access.ok ? "Granted and added to Access." : `Granted, but Access wasn't updated: ${r.access.error || ""}`);
    } catch (e) { say((e as Error).message); }
  }
  async function revoke(principal: string, tree_id: string) {
    if (!confirm(`Remove ${principal}'s access to this tree?`)) return;
    try {
      const r = await api("DELETE", `admin/grants?principal=${encodeURIComponent(principal)}&tree_id=${encodeURIComponent(tree_id)}&revoke_access=1`);
      await draw();
      if (r.access && r.access.todo) setMsg(r.access.todo);
    } catch (e) { say((e as Error).message); }
  }
  async function setView(principal: string, tree_id: string, role: string, view: string) {
    try { await api("PUT", "admin/grants", { principal, tree_id, role, view_id: view || null }); }
    catch (e) { say((e as Error).message); }
  }
  function preview(id: string) { store.set("previewView", id, sessionStorage); location.hash = "#/"; location.reload(); }
  function editView(v: any) {
    setVf({ id: v.id, name: v.name, living: v.filter.living || "full", branches: (v.filter.branches || []).join(", "), max_generations: String(v.filter.max_generations || ""),
      exclude: (v.filter.exclude_people || []).join(", "), research: v.filter.research !== false, notes: v.filter.notes !== false, media: v.filter.media !== false, sources: v.filter.sources !== false });
  }
  async function saveView(ev: FormEvent) {
    ev.preventDefault();
    const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
    const filter: any = { living: vf.living, research: vf.research, notes: vf.notes, media: vf.media, sources: vf.sources };
    if (list(vf.branches).length) filter.branches = list(vf.branches);
    if (vf.max_generations) filter.max_generations = +vf.max_generations;
    if (list(vf.exclude).length) filter.exclude_people = list(vf.exclude);
    try { await api("PUT", `admin/views/${encodeURIComponent(vf.id)}`, { name: vf.name, filter }); await draw(); } catch (e) { say((e as Error).message); }
  }
  async function saveTree(ev: FormEvent<HTMLFormElement>, id: string) {
    ev.preventDefault();
    const f = ev.currentTarget.elements as any;
    let def; try { def = JSON.parse(f.def.value); } catch { return say("The definition isn't valid JSON."); }
    try { await api("PUT", `admin/trees/${encodeURIComponent(id)}`, { name: f.name.value, definition: def }); await draw(); } catch (e) { say((e as Error).message); }
  }

  if (error) return <div id="adm"><p>{error}</p></div>;
  if (!a) return <div id="adm"><p className="muted">Loading…</p></div>;
  const members: Record<string, any> = Object.fromEntries(a.members.map((m: any) => [m.principal, m]));
  const principals = [...new Set<string>([...a.grants.map((g: any) => g.principal), ...a.members.map((m: any) => m.principal)])].sort();
  const set = (k: keyof ViewForm) => (e: any) => setVf((v) => ({ ...v, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  return (
    <div id="adm">
      <section className="card"><h2>People and access</h2>
        <div className="table-wrap"><table className="data stack"><thead><tr><th>Who</th><th>Tree</th><th>Role</th><th>View</th><th></th></tr></thead><tbody>
          {principals.flatMap((pr) => {
            const gs = a.grants.filter((g: any) => g.principal === pr), m = members[pr] || {};
            const label = <>{m.display_name || pr}{m.is_owner && <> <span className="badge st-verified">owner</span></>}{m.kind === "agent" ? " 🤖" : ""}{m.person_id && D.people[m.person_id] && <><br /><span className="small muted">is <PersonLink id={m.person_id} /></span></>}</>;
            return gs.length ? gs.map((g: any) => (
              <tr key={`${pr}|${g.tree_id}`}><td>{label}</td><td>{(a.trees.find((t: any) => t.id === g.tree_id) || {}).name || g.tree_id}</td><td>{g.role}</td>
                <td><select key={gen} data-view={`${pr}|${g.tree_id}|${g.role}`} defaultValue={g.view_id || ""} onChange={(e) => setView(pr, g.tree_id, g.role, e.target.value)}><ViewOptions views={a.views} /></select></td>
                <td><button className="btn" data-revoke={`${pr}|${g.tree_id}`} onClick={() => revoke(pr, g.tree_id)}>Remove</button></td></tr>
            )) : [<tr key={pr}><td>{label}</td><td colSpan={4} className="muted small">{m.is_owner ? "sees everything" : "no trees"}</td></tr>];
          })}
        </tbody></table></div>
        <form key={gen} id="adm-g" className="filters" style={{ marginTop: 12 }} onSubmit={grant}>
          <input name="principal" placeholder="Email, or agent:name" required style={{ minWidth: 220 }} />
          <select name="tree">{a.trees.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          <select name="role"><option value="member">Member: view, suggest, comment</option><option value="editor">Editor: edit and review</option><option value="agent">Agent: research suggestions only</option></select>
          <select name="view" defaultValue=""><ViewOptions views={a.views} /></select>
          <label className="small"><input type="checkbox" name="invite" defaultChecked /> add to Access</label><button className="btn primary">Grant</button>
        </form>
        <div id="adm-msg" className="small">{msg}</div>
      </section>
      <section className="card"><h2>Views</h2><p className="small muted">A view filters what someone sees. Preview it to check before you share.</p>
        {a.views.length ? a.views.map((v: any) => (
          <div key={v.id} className="view-row"><b>{v.name}</b> <code className="small">{JSON.stringify(v.filter)}</code> <button className="linklike" data-preview={v.id} onClick={() => preview(v.id)}>preview</button> <button className="linklike" data-editview={v.id} onClick={() => editView(v)}>edit</button></div>
        )) : <p className="muted">No views yet; everyone sees their tree in full.</p>}
        <form id="adm-v" className="filters" style={{ marginTop: 10 }} onSubmit={saveView}>
          <input name="id" placeholder="id (e.g. cousins)" required pattern={"[a-z0-9\\-]+"} value={vf.id} onChange={set("id")} />
          <input name="name" placeholder="Name" required value={vf.name} onChange={set("name")} />
          <select name="living" value={vf.living} onChange={set("living")}><option value="full">Living: full</option><option value="names-only">Living: names only</option><option value="anonymous">Living: “Living Surname”</option><option value="hidden">Living: hidden</option></select>
          <input name="branches" placeholder="Branches (comma-separated; empty = all)" value={vf.branches} onChange={set("branches")} />
          <input name="max_generations" type="number" min="1" placeholder="Max generations" style={{ maxWidth: 150 }} value={vf.max_generations} onChange={set("max_generations")} />
          {VIEW_KEYS.map((k) => <label key={k} className="small"><input type="checkbox" name={k} checked={vf[k]} onChange={set(k)} /> {k}</label>)}
          <input name="exclude" placeholder="Exclude people (IDs)" value={vf.exclude} onChange={set("exclude")} /><button className="btn primary">Save view</button>
        </form>
      </section>
      <Storage />
      <section className="card"><h2>Trees</h2>
        {a.trees.map((t: any) => (
          <form key={`${t.id}|${gen}`} className="filters tree-def" data-tree={t.id} onSubmit={(e) => saveTree(e, t.id)}>
            <b style={{ minWidth: 160 }}>{t.name}</b><input name="name" defaultValue={t.name} />
            <textarea name="def" rows={2} style={{ flex: 1, minWidth: 260, fontFamily: "monospace", fontSize: ".8rem" }} defaultValue={JSON.stringify(t.definition)} />
            <button className="btn">Save</button>
          </form>
        ))}
        <p className="small muted">A tree is <code>{`{"branches": ["*"] or [keys], "include": [ids], "exclude": [ids], "root": id}`}</code>. Branch keys: {(D.research.branches || []).map((b, i) => <span key={b.key}>{i > 0 && " "}<code>{b.key}</code></span>)}</p>
      </section>
    </div>
  );
}
