// The owner's admin pages: Access (people, grants, views, storage, trees), the research sites the agents use
// (#/admin/sites), the stories some tree doesn't show (#/admin/stories) and the audit history (#/admin/audit). Anyone but the owner gets "Not found".
import { Link, useParams } from "react-router";
import { useData } from "../../data";
import { useTitle } from "../../lib";
import { S } from "../../../../strings/index.ts";
import { NotFound } from "../NotFound";
import { Access } from "./Access";
import { Audit } from "./Audit";
import { Sites } from "./Sites";
import { HiddenStories } from "./HiddenStories";

type Tab = "access" | "sites" | "stories" | "audit";

function AdminPage({ tab }: { tab: Tab }) {
  const T = S.admin.page;
  useTitle(tab === "audit" ? T.tabs.audit : tab === "sites" ? T.tabs.sites : tab === "stories" ? T.tabs.stories : T.title);
  const tabs: [Tab, string, string][] = [["access", T.tabs.access, "/admin"], ["sites", T.tabs.sites, "/admin/sites"], ["stories", T.tabs.stories, "/admin/stories"], ["audit", T.tabs.audit, "/admin/audit"]];
  return (
    <div className="wrap page">
      <h1>{T.heading}</h1>
      <nav className="tabs">{tabs.map(([k, l, h]) => <Link key={k} to={h} className={k === tab ? "on" : ""} aria-current={k === tab ? "page" : undefined}>{l}</Link>)}</nav>
      {tab === "audit" ? <>
        <p className="muted">{T.intro.audit}</p>
        <Audit />
      </> : tab === "stories" ? <>
        <p className="muted">{T.intro.stories}</p>
        <HiddenStories />
      </> : tab === "sites" ? <>
        <p className="muted">{T.intro.sites}</p>
        <Sites />
      </> : <>
        <p className="muted">{T.intro.access}</p>
        <Access />
      </>}
    </div>
  );
}

export function Admin() {
  const { tab } = useParams();
  const { account } = useData();
  if (!account || !account.isOwner) return <NotFound />;
  const t: Tab = tab === "audit" || tab === "sites" || tab === "stories" ? tab : "access";
  return <AdminPage key={t} tab={t} />;
}
