// The bridge to the views not yet ported to React (web/public/legacy/app.js). React owns routing; for a legacy route
// it hands the old code a container and the path, and the old code draws the page into it. When a view is ported,
// its route moves to App.tsx and its code leaves app.js.
import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { useData } from "./data";
import type { Tree } from "./types";

interface Legacy { render(path: string, el: HTMLElement): void; unmount(): void; routes: string[] }
declare global { interface Window { startFamilyApp?: (D: Tree) => Legacy } }

let instance: { D: Tree; legacy: Legacy } | null = null;
/** One legacy app per loaded tree (it also mounts the page assistant once). */
export function legacyFor(D: Tree): Legacy {
  if (!instance || instance.D !== D) {
    if (!window.startFamilyApp) throw new Error("The page code (legacy/app.js) didn't load.");
    instance = { D, legacy: window.startFamilyApp(D) };
  }
  return instance.legacy;
}

export function LegacyRoute() {
  const { D } = useData();
  const loc = useLocation();
  const el = useRef<HTMLDivElement>(null);
  const path = `${loc.pathname.replace(/^\//, "")}${loc.search}`;
  useEffect(() => {
    const legacy = legacyFor(D);
    legacy.render(path, el.current!);
    if (!path.startsWith("tree")) window.scrollTo(0, 0);
  }, [D, path]);
  useEffect(() => () => legacyFor(D).unmount(), [D]);
  return <div className="legacy-view" ref={el} />;
}
