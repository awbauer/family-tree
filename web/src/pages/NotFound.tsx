import { Link } from "react-router";
import { useTitle } from "../lib";

export function NotFound() {
  useTitle("Not found");
  return <div className="wrap page"><h1>Not found</h1><p><Link to="/">Go home</Link></p></div>;
}
