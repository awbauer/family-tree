import { Link } from "react-router";
import { useTitle } from "../lib";
import { S } from "../../../strings/index.ts";

export function NotFound() {
  useTitle(S.browse.notFound.title);
  return <div className="wrap page"><h1>{S.browse.notFound.title}</h1><p><Link to="/">{S.browse.notFound.home}</Link></p></div>;
}
