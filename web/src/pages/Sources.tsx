// The sources list (#/sources): every catalogued source with its kind, repository and how many facts cite it,
// searchable and sortable, plus adding a new one.
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useData } from "../data";
import { norm, useTitle } from "../lib";
import { SOURCE_KINDS } from "../ops";
import { citeCount, sourceUses } from "../tree";
import { SourceForm, useSourceChange } from "./sourceEdit";

type Sort = "title" | "cites" | "type" | "repository";

export function Sources() {
  const { D, live, editor } = useData();
  useTitle("Sources");
  const change = useSourceChange();
  const [q, setQ] = useState(""), [sort, setSort] = useState<Sort>("title"), [adding, setAdding] = useState(false);
  const uses = useMemo(() => sourceUses(D), [D]);
  const all = Object.values(D.sources as Record<string, any>);
  const list = useMemo(() => {
    const n = norm(q.trim());
    const by: Record<Sort, (a: any, b: any) => number> = {
      title: (a, b) => String(a.title || "").localeCompare(String(b.title || "")),
      cites: (a, b) => citeCount(uses[b.id]) - citeCount(uses[a.id]),
      type: (a, b) => String(SOURCE_KINDS[a.type] || "~").localeCompare(String(SOURCE_KINDS[b.type] || "~")),
      repository: (a, b) => String(a.repository || "~").localeCompare(String(b.repository || "~")),
    };
    return all.filter((s) => !n || norm([s.title, s.author, s.publication, s.repository, s.note, s.id].filter(Boolean).join(" ")).includes(n))
      .sort((a, b) => by[sort](a, b) || by.title(a, b));
  }, [all, q, sort, uses]);
  const th = (k: Sort, label: ReactNode) => (
    <th aria-sort={sort === k ? (k === "cites" ? "descending" : "ascending") : undefined}>
      <button className="linklike" data-sort={k} onClick={() => setSort(k)}>{label}{sort === k ? (k === "cites" ? " ↓" : " ↑") : ""}</button>
    </th>
  );
  return (
    <div className="wrap page">
      <h1>Sources</h1>
      <p className="muted">Every record, index, tree, book and website the facts in this tree cite. Indexes and compiled trees are pointers, not proof: follow them to the original record. <Link to="/research">Research</Link></p>
      <div className="filters">
        <input id="src-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search titles, authors, repositories…" style={{ flex: 1, minWidth: 220 }} />
        <select id="src-sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort by">
          <option value="title">Title</option><option value="cites">Most cited</option><option value="type">Kind</option><option value="repository">Repository</option>
        </select>
        {live && <button className="btn" id="src-add" onClick={() => setAdding((x) => !x)}>{editor ? "Add a source" : "Suggest a source"}</button>}
      </div>
      {adding && <SourceForm submit={editor ? "Add source" : "Send suggestion"} onCancel={() => setAdding(false)} onSave={async (data, reason) => {
        if (await change([{ op: "source.upsert", data }], reason)) location.reload();
      }} />}
      <p className="small muted" id="src-count">{list.length === all.length ? `${all.length} sources` : `${list.length} of ${all.length} sources`}</p>
      {list.length ? (
        <div className="table-wrap"><table className="data" id="src-table"><thead><tr>{th("title", "Title")}{th("type", "Kind")}{th("repository", "Repository")}{th("cites", "Citations")}</tr></thead><tbody>
          {list.map((s) => {
            const n = citeCount(uses[s.id]);
            return (
              <tr key={s.id} data-source={s.id}>
                <td><Link to={`/source/${encodeURIComponent(s.id)}`}>{s.title || s.id}</Link>{s.author && <><br /><span className="small muted">{s.author}</span></>}</td>
                <td className="small">{SOURCE_KINDS[s.type] || <span className="muted">—</span>}</td>
                <td className="small">{s.repository || <span className="muted">—</span>}</td>
                <td className="small nowrap">{n || <span className="muted">not cited</span>}</td>
              </tr>
            );
          })}
        </tbody></table></div>
      ) : <div className="empty">{all.length ? "No sources match." : "No sources yet."}</div>}
    </div>
  );
}
