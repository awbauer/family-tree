// The frame around every page: header (brand, navigation, search, theme), the owner's preview bar, and the footer.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import { store, useData } from "./data";
import { Chat } from "./Chat";
import { isUnknown, useSite, years } from "./lib";
import { indexFor, search } from "./search";
import { S } from "../../strings/index.ts";

const T = S.common.shell;

const N = S.common.nav;
const NAV: [string, string][] = [["/tree", N.tree], ["/people", N.people], ["/stories", N.stories], ["/places", N.places], ["/timeline", N.timeline], ["/research", N.research]];

/** Per-branch colours from the tree's config, as CSS variables (light and dark). */
function BranchColors() {
  const { D } = useData();
  const css = useMemo(() => {
    const bs = D.research.branches || [];
    const light = bs.map((b) => `--b-${b.key}:${b.color || "#888"};`).join("");
    const dark = bs.map((b) => `--b-${b.key}:${b.colorDark || `color-mix(in srgb, ${b.color || "#888"} 62%, white)`};`).join(""); // strings-ok (CSS)
    return `:root{${light}}@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${dark}}}:root[data-theme="dark"]{${dark}}`;
  }, [D]);
  return <style>{css}</style>;
}

function Search() {
  const { D, branches } = useData();
  const [q, setQ] = useState(""), [open, setOpen] = useState(false), [sel, setSel] = useState(-1);
  const navigate = useNavigate();
  const box = useRef<HTMLDivElement>(null);
  // Names first, including alternate names, spelling variants and sound-alikes; the last row searches every record.
  const hits = useMemo(() => (q.trim() ? search(indexFor(D), q, { kinds: ["person"], namesOnly: true }) : [])
    .filter((h) => !isUnknown(D.people[h.id])).slice(0, 10), [q, D]);
  const allPath = `/search?q=${encodeURIComponent(q.trim())}`;
  useEffect(() => {
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);
  const go = (path: string) => { setQ(""); setOpen(false); setSel(-1); navigate(path); };
  return (
    <div className="search" ref={box}>
      <input id="search" type="search" placeholder={T.search.placeholder} autoComplete="off" aria-label={T.search.label} value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setSel(-1); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, Math.min(hits.length, s + (e.key === "ArrowDown" ? 1 : -1)))); }
          else if (e.key === "Enter" && q.trim()) { go(sel === hits.length || !hits.length ? allPath : `/person/${hits[Math.max(0, sel)].id}`); (e.target as HTMLInputElement).blur(); }
          else if (e.key === "Escape") setOpen(false);
        }} />
      <ul id="search-results" className="search-results" role="listbox" hidden={!open || !q.trim()}>
        {hits.length ? hits.map((h, i) => {
          const p = D.people[h.id], m = h.matches.find((x) => x.how !== "exact");
          return (
            <li key={h.id}><Link to={`/person/${h.id}`} className={i === sel ? "sel" : ""} onClick={() => { setQ(""); setOpen(false); }}>
              {p.name}{m && m.word && <span className="sr-how"> · {T.search[m.how as "sounds" | "close"]} {m.word}</span>}
              <span className="sr-meta">{years(p)} · {p.relation || (branches[p.branch || ""] || {}).label || ""}</span></Link></li>
          );
        }) : <li className="muted small" style={{ padding: 8 }}>{T.search.noMatches}</li>}
        <li className="sr-all"><Link to={allPath} className={sel === hits.length ? "sel" : ""} onClick={() => { setQ(""); setOpen(false); }}>{T.search.all(q.trim())}</Link></li>
      </ul>
    </div>
  );
}

function ThemeToggle() {
  return <button id="theme" className="icon-btn" aria-label={T.theme} title={T.theme} onClick={() => {
    const root = document.documentElement;
    const cur = root.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); // strings-ok (a media query)
    const next = cur === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    store.set("theme", next);
    window.dispatchEvent(new Event("themechange")); // the map redraws its tiles
  }}>◐</button>;
}

function TreeSwitch() {
  const { account, tree } = useData();
  if (!account || account.trees.length < 2) return null;
  return <select className="tree-switch" aria-label={T.treeSwitch} value={tree || ""} onChange={(e) => {
    store.set("tree", e.target.value);
    const url = new URL(location.href);
    url.searchParams.delete("tree");
    history.replaceState(history.state, "", url);
    location.reload();
  }}>
    {account.trees.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
  </select>;
}

function PreviewBar() {
  const { D } = useData();
  if (!D.previewView) return null;
  return <div className="preview-bar">{T.preview.before}<b>{D.previewView}</b>{T.preview.after}{" "}
    <button className="btn" onClick={() => { store.set("previewView", null, sessionStorage); location.reload(); }}>{T.preview.exit}</button></div>;
}

export function Shell({ children }: { children: ReactNode }) {
  const { D, account, people } = useData();
  const site = useSite();
  const loc = useLocation();
  const [menu, setMenu] = useState(false);
  const main = useRef<HTMLElement>(null);
  useEffect(() => { setMenu(false); }, [loc.pathname]);
  // A new page starts at the top, back and forward included (main.tsx turns off the browser's own restoring), unless
  // the link names a section to scroll to (next effect). Changes that stay on the page (a filter, the tree view) only
  // change the query, so they keep the scroll position.
  useLayoutEffect(() => {
    if (!new URLSearchParams(loc.search).get("section")) window.scrollTo(0, 0);
  }, [loc.pathname]);
  useEffect(() => {
    const section = new URLSearchParams(loc.search).get("section");
    const content = main.current;
    if (!section || !content) return;
    const scroll = () => {
      const target = document.getElementById(section);
      if (!target || !content.contains(target)) return false;
      const header = document.querySelector(".site-header")?.getBoundingClientRect().height || 0;
      window.scrollTo({ top: window.scrollY + target.getBoundingClientRect().top - header - 12 });
      return true;
    };
    if (scroll()) return;
    const observer = new MutationObserver(() => { if (scroll()) observer.disconnect(); });
    observer.observe(content, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [loc.pathname, loc.search]);
  const family = site.familyName.replace(/^The /, "").replace(/ Family$/, "");
  return (
    <>
      <BranchColors />
      <PreviewBar />
      <a className="skip" href="#app" onClick={(e) => { e.preventDefault(); main.current?.focus(); }}>{T.skip}</a>
      <header className="site-header">
        <div className="wrap header-inner">
          <Link className="brand" to="/">
            <span className="brand-mark" aria-hidden="true">{site.mark || site.familyName.replace(/^The /, "")[0] || "F"}</span>
            <span className="brand-text">{family} <em>{T.brand}</em></span>
          </Link>
          <button className="nav-toggle" aria-label={T.menu} aria-expanded={menu} onClick={() => setMenu((m) => !m)}>☰</button>
          <nav className={`site-nav${menu ? " open" : ""}`} aria-label={T.mainNav}>
            {NAV.map(([to, label]) => <NavLink key={to} to={to} className={({ isActive }) => (isActive ? "active" : "")}>{label}</NavLink>)}
            {account && account.isOwner && <NavLink to="/admin" className={({ isActive }) => (isActive ? "active" : "")}>{N.admin}</NavLink>}
            <TreeSwitch />
          </nav>
          <Search />
          <ThemeToggle />
        </div>
      </header>
      <main id="app" tabIndex={-1} ref={main}>{children}</main>
      <Chat />
      <footer className="site-footer">
        <div className="wrap">
          <span id="footer-meta">{T.footer.meta(people.length, D.generated)}</span>
          <Link to="/about">{T.footer.about}</Link>
        </div>
      </footer>
    </>
  );
}
