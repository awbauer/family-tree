import { Fragment } from "react";
import { Link } from "react-router";
import { useData } from "../data";
import { useTitle } from "../lib";
import { S } from "../../../strings/index.ts";

const T = S.browse.about;
const LEVELS = ["verified", "partly-verified", "unverified", "disputed"] as const;

/** Catalog text with code spans: even items are text, odd items are code. */
const Code = ({ parts }: { parts: readonly string[] }) => <>{parts.map((t, i) => (i % 2 ? <code key={i}>{t}</code> : <Fragment key={i}>{t}</Fragment>))}</>;

export function About() {
  const { D } = useData();
  useTitle(T.title);
  return (
    <div className="wrap page">
      <article className="prose" style={{ maxWidth: 760 }}>
        <h1>{T.title}</h1>
        <p><Code parts={T.intro} /></p>
        <p><b>{T.gedcom.title}</b><Code parts={T.gedcom.text} /></p>
        <p><b>{T.research.title}</b><Code parts={T.research.text} /></p>
        <p><Code parts={T.build.text} /><Link to="/research/review">{T.build.link}</Link>{T.build.end}</p>
        <h2>{T.levels.title}</h2>
        <p>{LEVELS.map((k) => <Fragment key={k}><span className={`badge st-${k}`}>{S.common.status[k]}</span>{T.levels[k]}</Fragment>)}</p>
        <h2>{T.photos.title}</h2>
        <p><Code parts={T.photos.text(Object.keys(D.media || {}).length)} /></p>
      </article>
    </div>
  );
}
