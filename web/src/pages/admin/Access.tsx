// Admin → Access (owner only): people and grants, views (with preview), data storage and tree definitions.
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { S } from "../../../../strings/index.ts";
import { store, useData } from "../../data";
import { PersonLink } from "../../lib";

const T = S.admin.access;
const say = (msg: string) => alert(msg);
const VIEW_KEYS = ["research", "notes", "media", "sources"] as const;
const BLANK_VIEW = { id: "", name: "", living: "full", branches: "", max_generations: "", exclude: "", research: true, notes: true, media: true, sources: true };
type ViewForm = typeof BLANK_VIEW;

function ViewOptions({ views }: { views: any[] }) {
  return <><option value="">{T.fullView}</option>{views.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</>;
}

function StorageReport({ r }: { r: any }) {
  const M = T.storage;
  const rep = r.report;
  if (rep.already) return <>{M.already}</>;
  return <>{!rep.ok ? <b>{M.notSafe}</b> : rep.dryRun ? M.ready : M.moved}: {M.report(rep.persons, rep.families, rep.relationships, Object.entries(rep.relationshipTypes || {}).map(([k, v]) => `${v} ${k}`).join(", "), rep.sourceDescriptions)}{(rep.mismatched || []).length ? M.mismatched(rep.mismatched.join(", ")) : ""}</>;
}

function Storage() {
  const M = T.storage;
  const { api } = useData();
  const [out, setOut] = useState<ReactNode>(null), [canGo, setCanGo] = useState(false);
  async function check() {
    try { const r = await api("POST", "admin/storage", { dry_run: true }); setOut(<StorageReport r={r} />); setCanGo(!!(r.report.ok && !r.report.already)); }
    catch (e) { setOut((e as Error).message); }
  }
  async function go() {
    if (!confirm(M.confirmMove)) return;
    try { const r = await api("POST", "admin/storage", { dry_run: false }); setOut(<StorageReport r={r} />); setCanGo(false); }
    catch (e) { setOut((e as Error).message); }
  }
  return (
    <section className="card" id="adm-storage"><h2>{M.heading}</h2>
      <p className="small muted">{M.help}</p>
      <div className="btn-row"><button className="btn" id="st-check" onClick={check}>{M.check}</button><button className="btn primary" id="st-go" hidden={!canGo} onClick={go}>{M.move}</button></div>
      <div id="st-out" className="small">{out}</div>
    </section>
  );
}

export function Access() {
  const P = T.people, G = T.grant, V = T.views;
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
      if (r.access && r.access.todo) setMsg(<>{G.granted} <b>{G.oneMoreStep}</b> {r.access.todo}</>);
      else if (r.access && r.access.automated) setMsg(r.access.ok ? G.grantedAndAdded : G.accessNotUpdated(r.access.error || ""));
    } catch (e) { say((e as Error).message); }
  }
  async function revoke(principal: string, tree_id: string) {
    if (!confirm(P.confirmRevoke(principal))) return;
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
    let def; try { def = JSON.parse(f.def.value); } catch { return say(T.trees.invalidJson); }
    try { await api("PUT", `admin/trees/${encodeURIComponent(id)}`, { name: f.name.value, definition: def }); await draw(); } catch (e) { say((e as Error).message); }
  }

  if (error) return <div id="adm"><p>{error}</p></div>;
  if (!a) return <div id="adm"><p className="muted">{T.loading}</p></div>;
  const members: Record<string, any> = Object.fromEntries(a.members.map((m: any) => [m.principal, m]));
  const principals = [...new Set<string>([...a.grants.map((g: any) => g.principal), ...a.members.map((m: any) => m.principal)])].sort();
  const set = (k: keyof ViewForm) => (e: any) => setVf((v) => ({ ...v, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  return (
    <div id="adm">
      <section className="card"><h2>{P.heading}</h2>
        <div className="table-wrap"><table className="data stack"><thead><tr><th>{P.columns.who}</th><th>{P.columns.tree}</th><th>{P.columns.role}</th><th>{P.columns.view}</th><th></th></tr></thead><tbody>
          {principals.flatMap((pr) => {
            const gs = a.grants.filter((g: any) => g.principal === pr), m = members[pr] || {};
            const label = <>{m.display_name || pr}{m.is_owner && <> <span className="badge st-verified">{P.owner}</span></>}{m.kind === "agent" ? " 🤖" : ""}{m.person_id && D.people[m.person_id] && <><br /><span className="small muted">{P.is}<PersonLink id={m.person_id} /></span></>}</>;
            return gs.length ? gs.map((g: any) => (
              <tr key={`${pr}|${g.tree_id}`}><td>{label}</td><td>{(a.trees.find((t: any) => t.id === g.tree_id) || {}).name || g.tree_id}</td><td>{g.role}</td>
                <td><select key={gen} data-view={`${pr}|${g.tree_id}|${g.role}`} defaultValue={g.view_id || ""} onChange={(e) => setView(pr, g.tree_id, g.role, e.target.value)}><ViewOptions views={a.views} /></select></td>
                <td><button className="btn" data-revoke={`${pr}|${g.tree_id}`} onClick={() => revoke(pr, g.tree_id)}>{P.remove}</button></td></tr>
            )) : [<tr key={pr}><td>{label}</td><td colSpan={4} className="muted small">{m.is_owner ? P.seesEverything : P.noTrees}</td></tr>];
          })}
        </tbody></table></div>
        <form key={gen} id="adm-g" className="filters" style={{ marginTop: 12 }} onSubmit={grant}>
          <input name="principal" placeholder={G.principal} required style={{ minWidth: 220 }} />
          <select name="tree">{a.trees.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          <select name="role"><option value="member">{G.roles.member}</option><option value="editor">{G.roles.editor}</option><option value="agent">{G.roles.agent}</option></select>
          <select name="view" defaultValue=""><ViewOptions views={a.views} /></select>
          <label className="small"><input type="checkbox" name="invite" defaultChecked /> {G.invite}</label><button className="btn primary">{G.submit}</button>
        </form>
        <div id="adm-msg" className="small">{msg}</div>
      </section>
      <section className="card"><h2>{V.heading}</h2><p className="small muted">{V.help}</p>
        {a.views.length ? a.views.map((v: any) => (
          <div key={v.id} className="view-row"><b>{v.name}</b> <code className="small">{JSON.stringify(v.filter)}</code> <button className="linklike" data-preview={v.id} onClick={() => preview(v.id)}>{V.preview}</button> <button className="linklike" data-editview={v.id} onClick={() => editView(v)}>{V.edit}</button></div>
        )) : <p className="muted">{V.none}</p>}
        <form id="adm-v" className="filters" style={{ marginTop: 10 }} onSubmit={saveView}>
          <input name="id" placeholder={V.id} required pattern={"[a-z0-9\\-]+"} value={vf.id} onChange={set("id")} />
          <input name="name" placeholder={V.name} required value={vf.name} onChange={set("name")} />
          <select name="living" value={vf.living} onChange={set("living")}><option value="full">{V.living.full}</option><option value="names-only">{V.living["names-only"]}</option><option value="anonymous">{V.living.anonymous}</option><option value="hidden">{V.living.hidden}</option></select>
          <input name="branches" placeholder={V.branches} value={vf.branches} onChange={set("branches")} />
          <input name="max_generations" type="number" min="1" placeholder={V.maxGenerations} style={{ maxWidth: 150 }} value={vf.max_generations} onChange={set("max_generations")} />
          {VIEW_KEYS.map((k) => <label key={k} className="small"><input type="checkbox" name={k} checked={vf[k]} onChange={set(k)} /> {V.show[k]}</label>)}
          <input name="exclude" placeholder={V.exclude} value={vf.exclude} onChange={set("exclude")} /><button className="btn primary">{V.save}</button>
        </form>
      </section>
      <Storage />
      <section className="card"><h2>{T.trees.heading}</h2>
        {a.trees.map((t: any) => (
          <form key={`${t.id}|${gen}`} className="filters tree-def" data-tree={t.id} onSubmit={(e) => saveTree(e, t.id)}>
            <b style={{ minWidth: 160 }}>{t.name}</b><input name="name" defaultValue={t.name} />
            <textarea name="def" rows={2} style={{ flex: 1, minWidth: 260, fontFamily: "monospace", fontSize: ".8rem" }} defaultValue={JSON.stringify(t.definition)} />
            <button className="btn">{T.trees.save}</button>
          </form>
        ))}
        <p className="small muted">{T.trees.help.before}<code>{T.trees.help.format}</code>{T.trees.help.after}{(D.research.branches || []).map((b, i) => <span key={b.key}>{i > 0 && " "}<code>{b.key}</code></span>)}</p>
      </section>
    </div>
  );
}
