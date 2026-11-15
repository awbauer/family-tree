// Admin → Research sites (owner only): the genealogy sites every research agent prefers, grouped by access, with
// notes on how to search each, an on/off switch, and optional credentials. A credential's value is write-only: the
// page shows only its kind, when it was set and by whom.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { S } from "../../../../strings/index.ts";
import { useData } from "../../data";
import { useWho } from "../../ui";

const T = S.admin.sites;
type Site = {
  id: string; name: string; url: string; search_url: string; domains: string[]; coverage: string; record_types: string[];
  access: string; source_quality: string; api: string; agent_notes: string; enabled: boolean; sort: number;
  has_credential: boolean; credential: { kind: string; updated_at: string; updated_by: string } | null;
};
const ACCESS: [string, string][] = [["open", T.access.open], ["free-account", T.access["free-account"]], ["subscription", T.access.subscription], ["institution", T.access.institution]];
const ACCESS_TXT = Object.fromEntries(ACCESS);
const QUALITY: [string, string][] = [["original-images", T.quality["original-images"]], ["indexes", T.quality.indexes], ["compiled", T.quality.compiled]];
const QUALITY_TXT = Object.fromEntries(QUALITY);
const BADGE: Record<string, string> = { open: "st-verified", "free-account": "st-partly-verified", subscription: "st-disputed", institution: "st-unverified" };
const KIND_TXT: Record<string, string> = { header: T.credential.kinds.header, query: T.credential.kinds.query, basic: T.credential.kinds.basic };
const BLANK = { id: "", name: "", url: "", search_url: "", domains: "", coverage: "", record_types: "", access: "open", source_quality: "indexes", api: "", agent_notes: "", enabled: true };
type Form = typeof BLANK;
const wrap = { overflowWrap: "anywhere" as const };

function SiteForm({ initial, onSave, onCancel }: { initial: Form; onSave: (f: Form) => Promise<void>; onCancel: () => void }) {
  const F = T.form;
  const [f, setF] = useState<Form>(initial);
  const set = (k: keyof Form) => (e: any) => setF((v) => ({ ...v, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  return (
    <form id="rs-form" className="card sub" style={{ margin: "12px 0" }} onSubmit={async (e) => { e.preventDefault(); await onSave(f); }}>
      <h3 style={{ marginTop: 0 }}>{initial.id ? F.editTitle(initial.name) : F.addTitle}</h3>
      <div className="filters">
        <input name="name" placeholder={F.name} required value={f.name} onChange={set("name")} style={{ flex: "1 1 200px" }} />
        <input name="url" placeholder={F.url} required value={f.url} onChange={set("url")} style={{ flex: "2 1 240px" }} />
      </div>
      <div className="filters">
        <input name="domains" placeholder={F.domains} value={f.domains} onChange={set("domains")} style={{ flex: "1 1 260px" }} />
        <input name="search_url" placeholder={F.searchUrl} value={f.search_url} onChange={set("search_url")} style={{ flex: "2 1 260px" }} />
      </div>
      <div className="filters">
        <select name="access" value={f.access} onChange={set("access")} aria-label={F.access}>{ACCESS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <select name="source_quality" value={f.source_quality} onChange={set("source_quality")} aria-label={F.quality}>{QUALITY.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <input name="record_types" placeholder={F.recordTypes} value={f.record_types} onChange={set("record_types")} style={{ flex: "1 1 220px" }} />
        <label className="small"><input type="checkbox" name="enabled" checked={f.enabled} onChange={set("enabled")} /> {F.enabled}</label>
      </div>
      <div className="filters">
        <textarea name="coverage" placeholder={F.coverage} rows={2} value={f.coverage} onChange={set("coverage")} style={{ flex: "1 1 260px" }} />
        <textarea name="agent_notes" placeholder={F.agentNotes} rows={2} value={f.agent_notes} onChange={set("agent_notes")} style={{ flex: "1 1 260px" }} />
      </div>
      <div className="filters">
        <input name="api" placeholder={F.api} value={f.api} onChange={set("api")} style={{ flex: "1 1 260px" }} />
        <button className="btn primary">{initial.id ? F.save : F.add}</button><button type="button" className="btn" onClick={onCancel}>{F.cancel}</button>
      </div>
    </form>
  );
}

function CredentialForm({ site, onDone, keyHelp }: { site: Site; onDone: (msg?: string) => void; keyHelp?: string }) {
  const C = T.credential;
  const { api } = useData();
  const [kind, setKind] = useState("header");
  const [err, setErr] = useState("");
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = e.currentTarget.elements as any;
    const body = kind === "basic" ? { kind, username: f.username.value, password: f.password.value } : { kind, name: f.cname.value, value: f.value.value };
    try { await api("PUT", `research-sites/${encodeURIComponent(site.id)}/credential`, body); onDone(C.saved(site.name)); }
    catch (x) { setErr((x as Error).message); }
  }
  return (
    <form id="rs-cred" className="card sub" style={{ margin: "10px 0" }} onSubmit={save} autoComplete="off">
      <h3 style={{ marginTop: 0 }}>{C.title(site.has_credential, site.name)}</h3>
      <p className="small"><b>{C.policy.bold}</b> {C.policy.after}</p>
      <p className="small muted">{C.encrypted(site.domains.join(", "))}</p>
      {keyHelp && <pre className="small" style={{ whiteSpace: "pre-wrap", ...wrap }}>{keyHelp}</pre>}
      <div className="filters">
        <select name="kind" value={kind} onChange={(e) => setKind(e.target.value)} aria-label={C.kind}>{Object.entries(KIND_TXT).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        {kind === "basic" ? <>
          <input name="username" placeholder={C.username} required autoComplete="off" />
          <input name="password" type="password" placeholder={C.password} required autoComplete="new-password" />
        </> : <>
          <input name="cname" placeholder={kind === "header" ? C.headerName : C.paramName} required autoComplete="off" />
          <input name="value" type="password" placeholder={kind === "header" ? C.headerValue : C.keyValue} required autoComplete="new-password" />
        </>}
        <button className="btn primary">{C.save}</button><button type="button" className="btn" onClick={() => onDone()}>{C.cancel}</button>
      </div>
      {err && <pre className="small sev-error" style={{ whiteSpace: "pre-wrap", ...wrap }}>{err}</pre>}
    </form>
  );
}

export function Sites() {
  const L = T.site;
  const { api } = useData();
  const who = useWho();
  const [data, setData] = useState<{ sites: Site[]; key_configured?: boolean; key_help?: string } | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Form | null>(null);
  const [cred, setCred] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState("");
  const alive = useRef(true);
  const load = useCallback(async () => {
    try { const r = await api("GET", "research-sites"); if (alive.current) setData(r); }
    catch (e) { if (alive.current) setError((e as Error).message); }
  }, [api]);
  useEffect(() => { alive.current = true; load(); return () => { alive.current = false; }; }, [load]);

  const groups = useMemo(() => {
    const t = q.trim().toLowerCase();
    const list = (data ? data.sites : []).filter((s) => !t || [s.name, s.coverage, s.agent_notes, ...s.domains, ...s.record_types].join(" ").toLowerCase().includes(t));
    return ACCESS.map(([k, l]) => [k, l, list.filter((s) => s.access === k)] as [string, string, Site[]]).filter(([, , xs]) => xs.length);
  }, [data, q]);

  async function save(f: Form) {
    const body = { ...f, domains: f.domains, record_types: f.record_types };
    try {
      if (f.id) await api("PUT", `research-sites/${encodeURIComponent(f.id)}`, body);
      else await api("POST", "research-sites", body);
      setEditing(null); setMsg(f.id ? L.saved(f.name) : L.added(f.name)); await load();
    } catch (e) { alert((e as Error).message); }
  }
  async function toggle(s: Site, enabled: boolean) {
    try { await api("PUT", `research-sites/${encodeURIComponent(s.id)}`, { enabled }); await load(); } catch (e) { alert((e as Error).message); }
  }
  async function remove(s: Site) {
    if (!confirm(L.confirmRemove(s.name, s.has_credential))) return;
    try { await api("DELETE", `research-sites/${encodeURIComponent(s.id)}`); setMsg(L.removed(s.name)); await load(); } catch (e) { alert((e as Error).message); }
  }
  async function removeCred(s: Site) {
    if (!confirm(L.confirmRemoveCredential(s.name))) return;
    try { await api("DELETE", `research-sites/${encodeURIComponent(s.id)}/credential`); setMsg(L.credentialRemoved(s.name)); await load(); } catch (e) { alert((e as Error).message); }
  }
  const edit = (s: Site) => { setCred(null); setEditing({ id: s.id, name: s.name, url: s.url, search_url: s.search_url, domains: s.domains.join(", "), coverage: s.coverage, record_types: s.record_types.join(", "), access: s.access, source_quality: s.source_quality, api: s.api, agent_notes: s.agent_notes, enabled: s.enabled }); };

  if (error) return <div className="empty">{error}</div>;
  if (!data) return <p className="muted">{T.loading}</p>;
  return (
    <div id="rs">
      {data.key_configured === false && (
        <div className="card sub" id="rs-key" style={{ marginBottom: 12 }}>
          <p className="small"><b>{T.keyMissing.bold}</b> {T.keyMissing.after}</p>
          <pre className="small" style={{ whiteSpace: "pre-wrap", ...wrap }}>{data.key_help}</pre>
        </div>
      )}
      <div className="filters">
        <input placeholder={T.filter} value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: "1 1 200px" }} aria-label={T.filterLabel} />
        <button className="btn primary" id="rs-add" onClick={() => { setCred(null); setEditing({ ...BLANK }); }}>{T.add}</button>
      </div>
      {msg && <p className="small" id="rs-msg">{msg}</p>}
      {editing && !editing.id && <SiteForm key="new" initial={editing} onSave={save} onCancel={() => setEditing(null)} />}
      {groups.map(([k, label, xs]) => (
        <section key={k} className="card" style={{ marginBottom: 14 }} data-group={k}>
          <h2>{label} <span className="small muted">· {xs.length}</span></h2>
          {xs.map((s) => (
            <div key={s.id} data-site={s.id} style={{ padding: "10px 0", borderBottom: "1px solid var(--line)", opacity: s.enabled ? 1 : 0.6 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
                <b><a href={s.url} target="_blank" rel="noopener noreferrer">{s.name}</a></b>
                <span className={`badge ${BADGE[s.access] || ""}`}>{ACCESS_TXT[s.access] || s.access}</span>
                <span className="small muted">{QUALITY_TXT[s.source_quality] || s.source_quality}</span>
                {!s.enabled && <span className="small muted">{L.off}</span>}
              </div>
              <div className="small muted" style={wrap}>{s.domains.join(", ")}{s.record_types.length > 0 && <> · {s.record_types.join(", ")}</>}</div>
              {s.coverage && <div className="small">{s.coverage}</div>}
              {s.agent_notes && <div className="small"><span className="muted">{L.forAgents}</span> {s.agent_notes}</div>}
              {s.search_url && <div className="small muted" style={wrap}>{L.search}<code>{s.search_url}</code></div>}
              {s.api && <div className="small muted">{L.api(s.api)}</div>}
              <div className="small" data-cred-status={s.id}>{s.credential
                ? <>{L.credentialSet(s.credential.kind, s.credential.updated_at.slice(0, 10), who(s.credential.updated_by))}</>
                : <span className="muted">{L.noCredential}</span>}</div>
              <div className="btn-row" style={{ marginTop: 6, alignItems: "center" }}>
                <label className="small"><input type="checkbox" data-toggle={s.id} checked={s.enabled} onChange={(e) => toggle(s, e.target.checked)} /> {L.enabled}</label>
                <button className="btn" data-edit={s.id} onClick={() => edit(s)}>{L.edit}</button>
                <button className="btn" data-cred={s.id} onClick={() => { setEditing(null); setCred(cred === s.id ? null : s.id); }}>{s.has_credential ? L.replaceCredential : L.setCredential}</button>
                {s.has_credential && <button className="btn" data-cred-remove={s.id} onClick={() => removeCred(s)}>{L.removeCredential}</button>}
                <button className="btn" data-delete={s.id} onClick={() => remove(s)}>{L.remove}</button>
              </div>
              {editing && editing.id === s.id && <SiteForm key={s.id} initial={editing} onSave={save} onCancel={() => setEditing(null)} />}
              {cred === s.id && <CredentialForm site={s} keyHelp={data.key_configured === false ? data.key_help : undefined} onDone={(m) => { setCred(null); if (m) setMsg(m); load(); }} />}
            </div>
          ))}
        </section>
      ))}
      {!groups.length && <div className="empty">{T.noMatch}</div>}
    </div>
  );
}
