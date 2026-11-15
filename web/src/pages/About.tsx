import { Link } from "react-router";
import { useData } from "../data";
import { useTitle } from "../lib";

export function About() {
  const { D } = useData();
  useTitle("How this site works");
  return (
    <div className="wrap page">
      <article className="prose" style={{ maxWidth: 760 }}>
        <h1>How this site works</h1>
        <p>The app (<code>web/</code>) contains no family data. A Cloudflare Worker serves the tree from a private D1 database, only to people let in by Cloudflare Access. The data is built from two private inputs:</p>
        <p><b>1. The GEDCOM file</b> (<code>*.ged</code>) — the structure of the tree: people, families, events and the Ancestry citations. Keep editing the tree in Ancestry (or Gramps), then export a new GEDCOM and replace the file.</p>
        <p><b>2. The research file</b> (<code>research.json</code>) — everything Ancestry can’t hold well: verification status for each person, research findings with links to sources, corrections, written stories, historical context and the to-do list. It is keyed by the GEDCOM person IDs, so it survives re-exports.</p>
        <p>Run <code>python3 tools/build.py</code> to produce <code>build/seed.sql</code>, then load it into the Cloudflare D1 database (see the README). The build also runs automatic checks (duplicates, impossible ages, people with two sets of parents, misfiled events, bad dates) which appear under <Link to="/research/review">Research → Data problems</Link>.</p>
        <h2>Verification levels</h2>
        <p><span className="badge st-verified">Verified</span> independent records confirm identity and key dates. <span className="badge st-partly-verified">Partly verified</span> some facts confirmed. <span className="badge st-unverified">Unverified</span> only Ancestry tree data. <span className="badge st-disputed">Disputed</span> the evidence contradicts what the tree says.</p>
        <h2>Photos</h2>
        <p>The Ancestry export references {Object.keys(D.media || {}).length} photos and documents but doesn’t include the files. Download them, upload them to the R2 bucket (or <code>family-data/media/</code> for local preview) and list them under <code>media</code> in <code>research.json</code>, e.g. <code>{'{"I123": [{"file": "photos/name.jpg", "portrait": true}]}'}</code>.</p>
      </article>
    </div>
  );
}
