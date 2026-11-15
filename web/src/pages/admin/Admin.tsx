// The owner's admin pages: Access (people, grants, views, storage, trees), the research sites the agents use
// (#/admin/sites) and the audit history (#/admin/audit). Anyone but the owner gets "Not found".
import { Link, useParams } from "react-router";
import { useData } from "../../data";
import { useTitle } from "../../lib";
import { NotFound } from "../NotFound";
import { Access } from "./Access";
import { Audit } from "./Audit";
import { Sites } from "./Sites";

type Tab = "access" | "sites" | "audit";

function AdminPage({ tab }: { tab: Tab }) {
  useTitle(tab === "audit" ? "Audit history" : tab === "sites" ? "Research sites" : "Admin");
  const tabs: [Tab, string, string][] = [["access", "Access", "/admin"], ["sites", "Research sites", "/admin/sites"], ["audit", "Audit history", "/admin/audit"]];
  return (
    <div className="wrap page">
      <h1>Admin</h1>
      <nav className="tabs">{tabs.map(([k, l, h]) => <Link key={k} to={h} className={k === tab ? "on" : ""} aria-current={k === tab ? "page" : undefined}>{l}</Link>)}</nav>
      {tab === "audit" ? <>
        <p className="muted">Every change to every tree and to the sharing settings, newest first: who made it (and on whose behalf), what changed and why. Select a row for the full detail.</p>
        <Audit />
      </> : tab === "sites" ? <>
        <p className="muted">The genealogy sites every research agent works from. Agents prefer these, follow your notes on each, and for subscription or institution sites they can't sign in to, log the search as inconclusive and leave you a to-do. Switch a site off to stop pointing agents to it.</p>
        <Sites />
      </> : <>
        <p className="muted">Who can see which tree, and how much of it. Signing in happens through Cloudflare Access; a person also needs a grant here, or they see nothing.</p>
        <Access />
      </>}
    </div>
  );
}

export function Admin() {
  const { tab } = useParams();
  const { account } = useData();
  if (!account || !account.isOwner) return <NotFound />;
  const t: Tab = tab === "audit" || tab === "sites" ? tab : "access";
  return <AdminPage key={t} tab={t} />;
}
