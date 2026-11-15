// The owner's admin pages: Access (people, grants, views, storage, trees) and the audit history (#/admin/audit).
// Anyone but the owner gets "Not found".
import { Link, useParams } from "react-router";
import { useData } from "../../data";
import { useTitle } from "../../lib";
import { NotFound } from "../NotFound";
import { Access } from "./Access";
import { Audit } from "./Audit";

function AdminPage({ tab }: { tab: "access" | "audit" }) {
  useTitle(tab === "audit" ? "Audit history" : "Admin");
  const tabs: [string, string, string][] = [["access", "Access", "/admin"], ["audit", "Audit history", "/admin/audit"]];
  return (
    <div className="wrap page">
      <h1>Admin</h1>
      <nav className="tabs">{tabs.map(([k, l, h]) => <Link key={k} to={h} className={k === tab ? "on" : ""} aria-current={k === tab ? "page" : undefined}>{l}</Link>)}</nav>
      {tab === "audit" ? <>
        <p className="muted">Every change to every tree and to the sharing settings, newest first: who made it (and on whose behalf), what changed and why. Select a row for the full detail.</p>
        <Audit />
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
  return <AdminPage key={tab === "audit" ? "audit" : "access"} tab={tab === "audit" ? "audit" : "access"} />;
}
