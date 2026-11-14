/* Family history — single-page app.
   Data comes from /api/tree (Cloudflare Worker + D1, or tools/serve.py locally); this file holds no family data. */
function startFamilyApp(D) {
  "use strict";
  const P = D.people, F = D.families, S = D.sources, R = D.research || {};
  const HOME = D.home;
  const HOME_FIRST = (P[HOME] && P[HOME].given.split(" ")[0]) || "the home person";
  const app = document.getElementById("app");
  // who is looking, and in which tree (null when previewing locally with tools/serve.py)
  const ME = D.me || null, ACCOUNT = D.account || null, TREE = ME ? ME.tree : null;
  const ROLE = ME ? ME.role : "owner";
  const EDITOR = ROLE === "owner" || ROLE === "editor";
  const LIVE = !!ME; // the API supports writes
  async function api(method, path, body) {
    const sep = path.includes("?") ? "&" : "?";
    const r = await fetch(`api/${path}${TREE ? `${sep}tree=${encodeURIComponent(TREE)}` : ""}`, {
      method, credentials: "same-origin",
      headers: Object.assign({ Accept: "application/json" }, body ? { "Content-Type": "application/json" } : {}),
      body: body ? JSON.stringify(Object.assign({ tree: TREE }, body)) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(data.error || `The server answered ${r.status}.`); e.status = r.status; e.data = data; throw e; }
    return data;
  }
  const whoTxt = (x) => !x ? "—" : ME && x === ME.principal ? "me" : x.startsWith("service:") || x.startsWith("agent:") ? "🤖 " + x.replace(/^(service|agent):/, "") : x.split("@")[0];
  const CTX = () => ({ P, F, S, R, D, ME, ACCOUNT, TREE, EDITOR, app, api, esc, plink, findingHtml, people, isUnknown, who: whoTxt });
  if (ACCOUNT && ACCOUNT.isOwner) {
    const a = document.createElement("a"); a.href = "#/admin"; a.textContent = "Sharing";
    document.querySelector(".site-nav").appendChild(a);
  }
  if (D.previewView) {
    const bar = document.createElement("div");
    bar.className = "preview-bar";
    bar.innerHTML = `Previewing what someone with the view <b>${esc0(D.previewView)}</b> sees. <button class="btn">Exit preview</button>`;
    bar.querySelector("button").onclick = () => { try { sessionStorage.removeItem("previewView"); } catch {} location.reload(); };
    document.body.prepend(bar);
  }
  if (ACCOUNT && ACCOUNT.trees.length > 1) {
    const sel = document.createElement("select");
    sel.className = "tree-switch"; sel.setAttribute("aria-label", "Family tree");
    sel.innerHTML = ACCOUNT.trees.map((t) => `<option value="${esc0(t.id)}"${t.id === TREE ? " selected" : ""}>${esc0(t.name)}</option>`).join("");
    sel.onchange = () => { try { localStorage.setItem("tree", sel.value); } catch {} location.reload(); };
    document.querySelector(".site-nav").appendChild(sel); // folds into the menu on small screens
  }
  const SITE = Object.assign({ title: "Family History", familyName: "Our Family", eyebrow: "A family history, in progress", lede: "" }, R.site || {});
  // brand + per-branch colours from config
  document.querySelector(".brand-text").innerHTML = `${esc0(SITE.familyName.replace(/^The /, "").replace(/ Family$/, ""))} <em>Family History</em>`;
  document.querySelector(".brand-mark").textContent = SITE.mark || SITE.familyName.replace(/^The /, "")[0] || "F";
  (function () {
    const css = (R.branches || []).map((b) => `--b-${b.key}:${b.color || "#888"};`).join("");
    const dark = (R.branches || []).map((b) => `--b-${b.key}:${b.colorDark || `color-mix(in srgb, ${b.color || "#888"} 62%, white)`};`).join("");
    const st = document.createElement("style");
    st.textContent = `:root{${css}}@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${dark}}}:root[data-theme="dark"]{${dark}}`;
    document.head.appendChild(st);
  })();
  function esc0(x) { return String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  // ---------------------------------------------------------------- helpers
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const BR = {};
  (R.branches || []).forEach((b) => (BR[b.key] = b));
  BR.home = { key: "home", label: "Home", tagline: "", color: "var(--b-home)" };
  BR.other = { key: "other", label: "Other", tagline: "", color: "var(--b-other)" };
  const bcolor = (k) => `var(--b-${k in BR ? k : "other"})`;
  const bstyle = (k) => `style="--bc:${bcolor(k)}"`;
  const STATUS_LABEL = { verified: "Verified", "partly-verified": "Partly verified", unverified: "Unverified", disputed: "Disputed" };

  const isUnknown = (p) => !p || p.name === "Unknown";
  function years(p) {
    if (!p) return "";
    const b = p.birth && p.birth.year, d = p.death && p.death.year;
    if (b && d) return `${b}–${d}`;
    if (b && p.living) return `b. ${b}`;
    if (b) return `${b}–?`;
    if (d) return `?–${d}`;
    return p.living ? "Living" : "";
  }
  const initials = (p) => (p.given[0] || "?") + (p.surname[0] || "");
  const plink = (id, label) => (P[id] ? `<a href="#/person/${id}">${esc(label || P[id].name)}</a>` : esc(label || "Unknown"));
  const statusBadge = (p) => `<span class="badge st-${p.status}" title="${esc(p.statusNote || "")}">${STATUS_LABEL[p.status] || p.status}</span>`;
  const branchChip = (k) => `<span class="chip branch" style="--bc:${bcolor(k)}">${esc(BR[k] ? BR[k].label : k)}</span>`;

  function parentsOf(id) {
    const out = [];
    (P[id].famc || []).forEach((fid) => {
      const f = F[fid];
      out.push({ fam: f, father: f.husband, mother: f.wife });
    });
    return out;
  }
  function spousesOf(id) {
    return (P[id].fams || []).map((fid) => {
      const f = F[fid];
      return { fam: f, spouse: f.husband === id ? f.wife : f.husband, children: f.children };
    });
  }
  function siblingsOf(id) {
    const set = new Set();
    (P[id].famc || []).forEach((fid) => F[fid].children.forEach((c) => c !== id && set.add(c)));
    return [...set].sort(byBirth);
  }
  function byBirth(a, b) {
    const x = (P[a].birth && P[a].birth.sort) || 99999999, y = (P[b].birth && P[b].birth.sort) || 99999999;
    return x - y;
  }
  function relationText(p) {
    if (p.id === HOME) return `This is ${esc(HOME_FIRST)}`;
    if (p.relation) return `${esc(HOME_FIRST)}’s ${esc(p.relation)}`;
    if (p.relationVia && P[p.relationVia]) return `Related by marriage — via ${plink(p.relationVia)} (${esc(P[p.relationVia].relation || "")})`;
    return "Connection not yet established";
  }
  const findingsFor = (id) => (R.findings || []).filter((f) => f.person === id);
  const todosFor = (id) => (R.todo || []).filter((t) => t.person === id);
  const storiesFor = (id) => (R.stories || []).filter((s) => (s.people || []).includes(id));
  function apidLink(apid) {
    const m = /^\d+,(\d+)::(\d+)$/.exec(apid || "");
    if (!m || m[2] === "0") return "";
    return `https://www.ancestry.com/discoveryui-content/view/${m[2]}:${m[1]}`;
  }
  function eventLabel(e) {
    const map = { Residence: "Lived in", Arrival: "Arrived", Departure: "Departed", Burial: "Buried", Military: "Military service", NaturalizationPetition: "Naturalization petition" };
    return map[e.type] || e.type;
  }
  const people = Object.values(P);
  const mediaUrl = (f) => (/^(https?:)?\/\//.test(f) || f.startsWith("/") ? f : "media/" + f.replace(/^media\//, ""));
  const branchPeople = (k) => people.filter((p) => p.branch === k);

  // ---------------------------------------------------------------- theme & nav
  const themeBtn = document.getElementById("theme");
  try { const t = localStorage.getItem("theme"); if (t) document.documentElement.dataset.theme = t; } catch (e) {}
  themeBtn.addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch (e) {}
    if (currentRoute[0] === "map") route();
  });
  const navToggle = document.querySelector(".nav-toggle"), nav = document.querySelector(".site-nav");
  navToggle.addEventListener("click", () => { nav.classList.toggle("open"); navToggle.setAttribute("aria-expanded", nav.classList.contains("open")); });

  // search
  const sIn = document.getElementById("search"), sOut = document.getElementById("search-results");
  let sSel = -1;
  const index = people.filter((p) => !isUnknown(p)).map((p) => ({ p, key: norm(p.names.map((n) => n.given + " " + n.surname).join(" | ")) }));
  function doSearch() {
    const q = norm(sIn.value.trim());
    if (!q) { sOut.hidden = true; return; }
    const terms = q.split(/\s+/);
    const hits = index.filter((x) => terms.every((t) => x.key.includes(t))).slice(0, 12);
    sSel = -1;
    sOut.innerHTML = hits.length ? hits.map((x) => `<li><a href="#/person/${x.p.id}">${esc(x.p.name)}<span class="sr-meta">${years(x.p)} · ${esc(x.p.relation || (BR[x.p.branch] || {}).label || "")}</span></a></li>`).join("")
      : `<li class="muted small" style="padding:8px">No matches</li>`;
    sOut.hidden = false;
  }
  sIn.addEventListener("input", doSearch);
  sIn.addEventListener("keydown", (e) => {
    const links = [...sOut.querySelectorAll("a")];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      sSel = Math.max(0, Math.min(links.length - 1, sSel + (e.key === "ArrowDown" ? 1 : -1)));
      links.forEach((a, i) => a.classList.toggle("sel", i === sSel));
    } else if (e.key === "Enter" && links.length) {
      location.hash = links[Math.max(0, sSel)].getAttribute("href");
      sIn.value = ""; sOut.hidden = true; sIn.blur();
    } else if (e.key === "Escape") { sOut.hidden = true; }
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".search")) sOut.hidden = true; });
  sOut.addEventListener("click", () => { sIn.value = ""; sOut.hidden = true; });

  // ---------------------------------------------------------------- router
  let currentRoute = [];
  let cleanup = null;
  function route() {
    if (cleanup) { cleanup(); cleanup = null; }
    const h = location.hash.replace(/^#\/?/, "");
    const [path, qs] = h.split("?");
    const parts = path.split("/").filter(Boolean);
    const params = new URLSearchParams(qs || "");
    currentRoute = parts;
    nav.classList.remove("open");
    document.querySelectorAll(".site-nav a").forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#/" + (parts[0] || "")));
    const views = { "": viewHome, tree: viewTree, person: viewPerson, people: viewPeople, stories: viewStories, story: viewStory, map: viewMap, timeline: viewTimeline, research: viewResearch, about: viewAbout, branch: viewBranch,
      admin: () => (ACCOUNT && ACCOUNT.isOwner && window.FamilyWork ? (setTitle("Sharing"), window.FamilyWork.admin(CTX())) : viewNotFound()) };
    const v = views[parts[0] || ""] || viewNotFound;
    v(parts.slice(1), params);
    if (!["tree"].includes(parts[0])) window.scrollTo(0, 0);
    app.focus({ preventScroll: true });
  }
  window.addEventListener("hashchange", route);
  document.getElementById("footer-meta").textContent = `${people.length} people · data built ${D.generated}`;

  function setTitle(t) { document.title = t ? `${t} · ${SITE.title}` : SITE.title; }

  // ---------------------------------------------------------------- fan chart
  function fanChart(rootId, gens) {
    const R0 = 58, W = [0, 62, 62, 62, 70, 74];
    const radii = [R0];
    for (let g = 1; g <= gens; g++) radii[g] = radii[g - 1] + W[g];
    const size = radii[gens] + 6;
    const slots = [[rootId]];
    for (let g = 1; g <= gens; g++) {
      slots[g] = [];
      slots[g - 1].forEach((id) => {
        let fa = null, mo = null;
        if (id && P[id] && P[id].famc[0]) { const f = F[P[id].famc[0]]; fa = f.husband; mo = f.wife; }
        slots[g].push(fa, mo);
      });
    }
    const A0 = Math.PI, A1 = 2 * Math.PI; // top half, left -> right
    const pt = (r, a) => [size + r * Math.cos(a), size + r * Math.sin(a)];
    let out = "";
    for (let g = 1; g <= gens; g++) {
      const n = slots[g].length, span = (A1 - A0) / n;
      slots[g].forEach((id, i) => {
        const a0 = A0 + i * span, a1 = a0 + span, r0 = radii[g - 1] + 2, r1 = radii[g];
        const [x0, y0] = pt(r0, a0), [x1, y1] = pt(r1, a0), [x2, y2] = pt(r1, a1), [x3, y3] = pt(r0, a1);
        const d = `M${x0},${y0} L${x1},${y1} A${r1},${r1} 0 0 1 ${x2},${y2} L${x3},${y3} A${r0},${r0} 0 0 0 ${x0},${y0} Z`;
        const p = id && P[id];
        const known = p && !isUnknown(p);
        const fill = known ? `color-mix(in srgb, ${bcolor(p.branch)} ${92 - g * 12}%, var(--card))` : "var(--paper-2)";
        const am = (a0 + a1) / 2, rm = (r0 + r1) / 2;
        let label = "";
        if (known) {
          const fs = g <= 2 ? 12 : g === 3 ? 10.5 : 9.5;
          const txtFill = g <= 3 ? "#fff" : "var(--ink)";
          if (g <= 2) {
            const [tx, ty] = pt(rm, am);
            const nm = g === 1 ? p.given.split(" ")[0] : p.given.split(" ")[0];
            label = `<text x="${tx}" y="${ty - 4}" text-anchor="middle" font-size="${fs}" font-weight="600" fill="${txtFill}">${esc(nm)}</text>
                     <text x="${tx}" y="${ty + 10}" text-anchor="middle" font-size="${fs - 1.5}" fill="${txtFill}" opacity=".9">${esc(p.surname)}</text>`;
          } else {
            let deg = (am * 180) / Math.PI;
            const [tx, ty] = pt(rm, am);
            let rot = deg;
            if (deg > 270) rot = deg; else rot = deg + 180;
            const txt = g === 3 ? `${p.given.split(" ")[0]} ${p.surname}` : p.given.split(" ")[0];
            const max = g === 3 ? 15 : 11;
            label = `<text x="${tx}" y="${ty}" transform="rotate(${rot} ${tx} ${ty})" text-anchor="middle" dominant-baseline="middle" font-size="${fs}" font-weight="500" fill="${txtFill}">${esc(txt.length > max ? txt.slice(0, max - 1) + "…" : txt)}</text>`;
          }
        }
        const title = known ? `${p.name} (${years(p)})` : "Unknown — research opportunity";
        const shape = `<path d="${d}" fill="${fill}" stroke="var(--card)" stroke-width="1.5"><title>${esc(title)}</title></path>${label}`;
        out += known ? `<a href="#/person/${id}">${shape}</a>` : shape;
      });
    }
    const root = P[rootId];
    out += `<a href="#/person/${rootId}"><circle cx="${size}" cy="${size}" r="${R0}" fill="var(--accent)"/>
      <text x="${size}" y="${size - 18}" text-anchor="middle" font-size="15" font-weight="600" fill="var(--accent-ink)" font-family="var(--serif)">${esc(root.given.split(" ")[0])}</text>
      <text x="${size}" y="${size - 2}" text-anchor="middle" font-size="12" fill="var(--accent-ink)" opacity=".9">${esc(root.surname)}</text></a>`;
    return `<svg viewBox="0 0 ${size * 2} ${size + 4}" role="img" aria-label="Fan chart of ${esc(root.name)}'s ancestors" font-family="Inter, system-ui, sans-serif">${out}</svg>`;
  }

  // ---------------------------------------------------------------- home
  function viewHome() {
    setTitle("");
    const total = people.filter((p) => !isUnknown(p)).length;
    const anc = people.filter((p) => p.direct && !isUnknown(p) && p.id !== HOME);
    const earliest = Math.min(...people.map((p) => (p.birth && p.birth.year) || 9999));
    const gens = Math.max(...people.map((p) => p.generation || 0));
    const nCites = people.reduce((n, p) => n + p.events.reduce((m, e) => m + (e.citations || []).length, 0), 0);
    const st = { verified: 0, "partly-verified": 0, unverified: 0, disputed: 0 };
    people.forEach((p) => { if (!isUnknown(p)) st[p.status] = (st[p.status] || 0) + 1; });
    const branches = (R.branches || []).filter((b) => !b.inLaw);
    const errs = D.issues.filter((i) => i.severity === "error").length;
    const stories = (R.stories || []).slice(0, 6);
    const todos = (R.todo || []).filter((t) => t.priority === "high").slice(0, 6);
    app.innerHTML = `
    <div class="wrap">
      <section class="hero">
        <div>
          <div class="eyebrow">${esc(SITE.eyebrow)}</div>
          <h1>${esc(SITE.familyName)}</h1>
          ${SITE.lede ? `<p class="lede">${esc(SITE.lede)}</p>` : ""}
          <div class="stats">
            <div class="stat"><b>${total}</b><span>People</span></div>
            <div class="stat"><b>${anc.length}</b><span>Direct ancestors</span></div>
            <div class="stat"><b>${gens + 1}</b><span>Generations</span></div>
            <div class="stat"><b>${earliest}</b><span>Earliest birth</span></div>
            <div class="stat"><b>${nCites}</b><span>Citations</span></div>
          </div>
          <div class="btn-row" style="margin-top:22px">
            <a class="btn primary" href="#/tree">Explore the tree</a>
            <a class="btn" href="#/person/${HOME}">Start with ${esc(HOME_FIRST)}</a>
            <a class="btn" href="#/research">Research status</a>
          </div>
        </div>
        <div class="fan-wrap">${fanChart(HOME, 5)}<p class="small muted" style="text-align:center;margin:6px 0 0">Five generations of ${esc(HOME_FIRST)}’s ancestors. Grey = not yet identified.</p></div>
      </section>

      <section class="section">
        <div class="section-head"><h2>${branches.length === 4 ? "Four grandparents, four lines" : "Family lines"}</h2><a href="#/people">All people →</a></div>
        <div class="grid g4">
          ${branches.map((b) => {
            const p = P[b.root];
            const n = branchPeople(b.key).length;
            const origin = (p.birth && p.birth.place) || "";
            return `<a class="card branch-card" href="#/branch/${b.key}" ${bstyle(b.key)}>
              <span class="eyebrow" style="color:${bcolor(b.key)}">${esc(b.label)} line</span>
              <span class="who">${esc(p.name)}</span>
              <span class="meta">${years(p)}${origin ? " · born " + esc(origin.split(",")[0]) : ""}</span>
              <span class="meta">${esc(b.tagline)}</span>
              <span class="meta" style="margin-top:auto">${n} people in this branch →</span>
            </a>`;
          }).join("")}
        </div>
      </section>

      ${stories.length ? `<section class="section">
        <div class="section-head"><h2>Stories</h2><a href="#/stories">All stories →</a></div>
        <div class="grid g3">${stories.map(storyCard).join("")}</div>
      </section>` : ""}

      <section class="section grid g2">
        <div class="card">
          <h3>How solid is this tree?</h3>
          <p class="small muted">Each person is graded on whether independent records (not just other Ancestry trees) back up who they were.</p>
          <div class="progress" aria-hidden="true">
            ${["verified", "partly-verified", "disputed", "unverified"].map((k) => `<span style="width:${(100 * st[k]) / total}%;background:${k === "verified" ? "var(--ok)" : k === "partly-verified" ? "var(--info)" : k === "disputed" ? "var(--err)" : "var(--line)"}"></span>`).join("")}
          </div>
          <p class="small" style="margin-top:10px">${["verified", "partly-verified", "disputed", "unverified"].map((k) => `<span class="badge st-${k}">${STATUS_LABEL[k]} ${st[k]}</span>`).join(" ")}</p>
          <p class="small"><a href="#/research/review">${errs} data problems flagged automatically →</a></p>
        </div>
        <div class="card">
          <h3>Top open questions</h3>
          ${todos.length ? `<ul class="rel-list">${todos.map((t) => `<li><span>${t.person && P[t.person] ? plink(t.person) + ": " : ""}${esc(t.task)}</span></li>`).join("")}</ul><a class="small" href="#/research/todo">Full research to-do list →</a>`
            : `<p class="muted small">No research tasks recorded yet.</p>`}
        </div>
      </section>
    </div>`;
  }
  function storyCard(s) {
    const first = (s.body || "").split(/\n\n/)[0].replace(/\[\[(I[\w-]+)(?:\|([^\]]+))?\]\]/g, (_, id, l) => l || (P[id] ? P[id].name : id)).replace(/\*\*?([^*]+)\*\*?/g, "$1");
    return `<a class="card story-card" href="#/story/${esc(s.slug)}" ${bstyle(s.branch || "other")} style="border-top:3px solid ${bcolor(s.branch || "other")}">
      <span class="eyebrow">${esc((BR[s.branch] || {}).label || "Family")}${s.era ? " · " + esc(s.era) : ""}</span>
      <h3>${esc(s.title)}</h3><p>${esc(first.length > 220 ? first.slice(0, 217) + "…" : first)}</p></a>`;
  }

  // ---------------------------------------------------------------- branch
  function viewBranch([key]) {
    const b = BR[key];
    if (!b || !P[b.root]) return viewNotFound();
    setTitle(b.label + " line");
    const list = branchPeople(key).filter((p) => !isUnknown(p));
    const direct = list.filter((p) => p.direct).sort((a, b2) => (a.generation - b2.generation) || byBirth(a.id, b2.id));
    const others = list.filter((p) => !p.direct).sort((a, b2) => a.surname.localeCompare(b2.surname) || byBirth(a.id, b2.id));
    const surnames = {};
    list.forEach((p) => p.surname && (surnames[p.surname] = (surnames[p.surname] || 0) + 1));
    const stories = (R.stories || []).filter((s) => s.branch === key);
    app.innerHTML = `<div class="wrap page">
      <div class="eyebrow" style="color:${bcolor(key)}">${esc(b.tagline)}</div>
      <h1>The ${esc(b.label)} line</h1>
      <p class="lede prose">${esc(b.intro || "")}</p>
      <div class="btn-row"><a class="btn primary" href="#/tree/${b.root}">Ancestors of ${esc(P[b.root].name)}</a><a class="btn" href="#/people?branch=${key}">All ${list.length} people</a></div>
      <p class="small muted" style="margin-top:14px">Surnames: ${Object.entries(surnames).sort((a, c) => c[1] - a[1]).map(([s, n]) => `<a href="#/people?q=${encodeURIComponent(s)}">${esc(s)}</a> (${n})`).join(" · ")}</p>
      ${stories.length ? `<section class="section"><h2>Stories</h2><div class="grid g3">${stories.map(storyCard).join("")}</div></section>` : ""}
      <section class="section"><h2>Direct ancestors</h2><div class="people-grid">${direct.map(pcard).join("")}</div></section>
      <section class="section"><h2>Other relatives</h2><div class="people-grid">${others.map(pcard).join("")}</div></section>
    </div>`;
  }
  function pcard(p) {
    return `<a class="p-card" href="#/person/${p.id}" ${bstyle(p.branch)}>
      <div><div class="nm">${esc(p.name)}</div><div class="sub">${years(p) || "dates unknown"}${p.relation ? " · " + esc(p.relation) : ""}</div></div>
      <span class="badge st-${p.status}" title="${STATUS_LABEL[p.status]}"></span></a>`;
  }

  // ---------------------------------------------------------------- person
  function viewPerson([id]) {
    const p = P[id];
    if (!p) return viewNotFound();
    setTitle(p.name);
    const parents = parentsOf(id);
    const spouses = spousesOf(id);
    const sibs = siblingsOf(id);
    const findings = findingsFor(id);
    const todos = todosFor(id);
    const stories = storiesFor(id);
    const media = (R.media || {})[id] || [];
    const portrait = media.find((m) => m.portrait) || media[0];
    const alt = p.names.slice(1).map((n) => `${n.given} ${n.surname}`.trim()).filter((n) => n && n !== p.name);

    // footnotes
    const notes = [];
    const noteIdx = new Map();
    function cite(c) {
      const key = c.source + "|" + (c.page || "");
      if (!noteIdx.has(key)) { notes.push(c); noteIdx.set(key, notes.length); }
      const n = noteIdx.get(key);
      return `<a href="#fn-${n}" onclick="event.preventDefault();document.getElementById('fn-${n}').scrollIntoView({behavior:'smooth',block:'center'})">${n}</a>`;
    }
    // timeline: own events + family events + children's births + context
    const items = [];
    p.events.forEach((e) => items.push({ e, sort: e.sort, kind: "own" }));
    spouses.forEach(({ fam, spouse }) => fam.events.forEach((e) => items.push({ e: Object.assign({}, e, { withWho: spouse }), sort: e.sort, kind: "fam" })));
    spouses.forEach(({ children }) => children.forEach((c) => {
      const cp = P[c];
      if (cp && cp.birth && cp.birth.sort) items.push({ e: { type: "Child born", dateDisplay: cp.birth.date, place: cp.birth.place, child: c }, sort: cp.birth.sort, kind: "child" });
    }));
    parents.forEach(({ father, mother }) => [father, mother].forEach((x) => {
      const xp = x && P[x];
      if (xp && xp.death && xp.death.sort && p.birth && p.birth.sort && xp.death.sort > p.birth.sort && (!p.death || !p.death.sort || xp.death.sort < p.death.sort))
        items.push({ e: { type: (xp.sex === "F" ? "Mother" : "Father") + " died", dateDisplay: xp.death.date, place: xp.death.place, child: x }, sort: xp.death.sort, kind: "rel" });
    }));
    const by = p.birth && p.birth.year, dy = (p.death && p.death.year) || (p.living ? new Date().getFullYear() : by && by + 80);
    (R.context || []).forEach((c) => {
      if (by && dy && c.year >= by && c.year <= dy && (!c.branches || c.branches.includes(p.branch)) && (!c.places || p.events.some((e) => c.places.includes(e.placeKey))))
        items.push({ e: { type: "ctx", text: c.title }, sort: c.year * 10000 + 615, kind: "ctx" });
    });
    items.sort((a, b) => (a.sort || 99999999) - (b.sort || 99999999));
    // drop repeats: an undated event that duplicates a dated one (same type & place), or a vaguer copy of the same event in the same year
    const kept = [];
    items.forEach((it) => {
      const e = it.e;
      if (it.kind === "ctx" || e.misfiled) return kept.push(it);
      const pl = (x) => norm((x || "").split(",")[0]);
      const dupe = kept.find((k) => k.kind === it.kind && k.e.type === e.type && (!e.place || !k.e.place || pl(k.e.place) === pl(e.place)) && (k.e.withWho || null) === (e.withWho || null) &&
        (!it.sort || (k.sort && Math.floor(k.sort / 10000) === Math.floor(it.sort / 10000) && (e.type === "Marriage" || e.type === "Birth" || e.type === "Death"))));
      if (dupe) { dupe.e = Object.assign({}, dupe.e, { citations: (dupe.e.citations || []).concat(e.citations || []) }); return; }
      kept.push(it);
    });
    items.length = 0; items.push(...kept);
    const tl = items.map(({ e, kind }) => {
      if (kind === "ctx") return `<li class="ctx"><div class="t-date">${Math.floor(0)}</div><span class="t-dot"></span><div class="t-body">${esc(e.text)}</div></li>`.replace(">0<", `>${esc(String(e.text && items.find((i) => i.e === e).sort).slice(0, 4))}<`);
      const cites = (e.citations || []).map(cite);
      let what = `<b>${esc(eventLabel(e))}</b>`;
      if (e.value && e.type !== "Residence") what += ` — ${esc(e.value)}`;
      if (kind === "fam") what = `<b>${esc(e.type === "Marriage" ? "Married" : e.type)}</b>${e.withWho ? " " + plink(e.withWho) : ""}`;
      if (kind === "child") what = `<b>Child born:</b> ${plink(e.child)}`;
      if (kind === "rel") what = `<b>${esc(e.type)}:</b> ${plink(e.child)}`;
      const place = e.place ? ` <span class="t-place">· ${esc(e.place)}</span>` : "";
      const note = e.note ? `<div class="t-note">${esc(e.note)}</div>` : e.address ? `<div class="t-note">${esc(e.address)}</div>` : "";
      const mis = e.misfiled ? `<div class="t-note sev-warn">⚠ This is a relative’s event that Ancestry exported as this person’s own — ignore.</div>` : "";
      return `<li class="${e.misfiled ? "misfiled" : ""}"><div class="t-date">${esc(e.dateDisplay || "undated")}</div><span class="t-dot"></span>
        <div class="t-body"${kind === "own" && e.fid ? ` data-fid="${esc(e.fid)}"` : ""}>${what}${place}${cites.length ? `<sup class="cite">${cites.join(",")}</sup>` : ""}${note}${mis}</div></li>`;
    }).join("");
    (p.citations || []).forEach(cite);

    const relLine = (pid, extra) => pid && P[pid] ? `<li><span>${plink(pid)}${extra ? ` <span class="muted small">${extra}</span>` : ""}</span><span class="yrs">${years(P[pid])}</span></li>` : `<li><span class="muted">Unknown</span></li>`;

    const issues = p.issues || [];
    const dup = p.duplicateOf || [];
    app.innerHTML = `<div class="wrap">
      <div class="person-head" ${bstyle(p.branch)}>
        <div class="portrait">${portrait ? `<img src="${esc(mediaUrl(portrait.file))}" alt="${esc(p.name)}">` : esc(initials(p))}</div>
        <div>
          <div class="eyebrow">${relationText(p)}</div>
          <h1>${esc(p.name)}</h1>
          <div class="life">${p.birth ? esc(p.birth.date || "?") : "?"} – ${p.death ? esc(p.death.date || "?") : p.living ? "living" : "?"}</div>
          <div class="tags">${branchChip(p.branch)} ${statusBadge(p)} ${p.living ? '<span class="chip">Living</span>' : ""}
            ${alt.length ? `<span class="small muted">Also recorded as: ${alt.map(esc).join(", ")}</span>` : ""}</div>
        </div>
      </div>
      ${dup.length ? `<div class="callout err"><b>Probable duplicate.</b> This looks like the same person as ${dup.map((d) => plink(d)).join(", ")}. Merge them in Ancestry and re-export.</div>` : ""}
      ${p.statusNote ? `<div class="callout ${p.status === "verified" ? "ok" : p.status === "disputed" ? "err" : ""}"><b>${STATUS_LABEL[p.status]}:</b> ${esc(p.statusNote)}</div>` : ""}
      <div class="person-layout">
        <aside class="side">
          <div class="card facts">
            <h4>Vital facts</h4>
            <dl>
              <dt>Born</dt><dd>${p.birth ? `${esc(p.birth.date || "date unknown")}${p.birth.place ? `<br><span class="muted">${esc(p.birth.place)}</span>` : ""}` : '<span class="muted">Unknown</span>'}</dd>
              ${p.death ? `<dt>Died</dt><dd>${esc(p.death.date || "date unknown")}${p.death.place ? `<br><span class="muted">${esc(p.death.place)}</span>` : ""}</dd>` : ""}
              ${p.burial ? `<dt>Buried</dt><dd>${esc(p.burial.place)}${p.burial.note ? `<br><span class="muted">${esc(p.burial.note)}</span>` : ""}</dd>` : ""}
              <dt>Sex</dt><dd>${p.sex === "M" ? "Male" : p.sex === "F" ? "Female" : '<span class="sev-warn">not recorded</span>'}${p.sexOriginal ? ` <span class="small muted">(corrected; Ancestry says ${esc(p.sexOriginal || "—")})</span>` : ""}</dd>
            </dl>
            <h4>Parents</h4>
            ${parents.length ? parents.map(({ father, mother }, i) => `<ul class="rel-list">${parents.length > 1 ? `<li class="small sev-err">Parent set ${i + 1} of ${parents.length} — only one can be right</li>` : ""}${relLine(father)}${relLine(mother)}</ul>`).join("") : '<p class="muted small">Not yet identified.</p>'}
            ${spouses.map(({ fam, spouse, children }) => {
              const m = fam.events.find((e) => e.type === "Marriage");
              return `<h4>${spouse ? "Spouse" : "Family"}</h4><ul class="rel-list">${relLine(spouse, m && m.dateDisplay ? "m. " + esc(m.dateDisplay) : "")}</ul>
                ${children.length ? `<h4>Children</h4><ul class="rel-list">${children.slice().sort(byBirth).map((c) => relLine(c)).join("")}</ul>` : ""}`;
            }).join("")}
            ${sibs.length ? `<h4>Siblings</h4><ul class="rel-list">${sibs.map((s) => relLine(s)).join("")}</ul>` : ""}
            <div class="btn-row" style="margin-top:14px"><a class="btn" href="#/tree/${id}">Ancestors</a><a class="btn" href="#/tree/${id}?mode=desc">Descendants</a></div>
          </div>
          ${miniPedigree(id)}
        </aside>
        <div>
          ${stories.length ? `<div class="grid g2" style="margin-bottom:20px">${stories.map(storyCard).join("")}</div>` : ""}
          <section class="card">
            <h2>Life events</h2>
            ${items.length ? `<ul class="timeline-list" ${bstyle(p.branch)}>${tl}</ul>` : '<p class="muted">No events recorded yet.</p>'}
            ${p.notes.length ? `<h3 style="margin-top:20px">Notes</h3>${p.notes.map((n) => `<p class="small">${linkify(n)}</p>`).join("")}` : ""}
          </section>

          <section class="card" style="margin-top:20px">
            <h2>Research</h2>
            ${findings.length ? `<h3>Findings</h3>${findings.map(findingHtml).join("")}` : `<p class="muted small">No independent research recorded yet beyond the Ancestry citations below.</p>`}
            ${issues.length ? `<h3 style="margin-top:18px">Automatic data checks</h3>${issues.map(issueHtml).join("")}` : ""}
            ${todos.length ? `<h3 style="margin-top:18px">Next steps</h3><ul>${todos.map((t) => `<li><span class="prio-${t.priority}">[${esc(t.priority)}]</span> ${esc(t.task)}${t.status && t.status !== "open" ? ` <span class="small muted">· ${esc((t.status || "").replace("_", " "))}${t.assignee ? ` · ${who(t.assignee)}` : ""}</span>` : t.assignee ? ` <span class="small muted">· ${who(t.assignee)}</span>` : ""}${t.where ? ` <span class="muted small">— ${linkify(t.where)}</span>` : ""}</li>`).join("")}</ul>` : ""}
          </section>

          <section class="card" style="margin-top:20px">
            <h2>Sources</h2>
            ${notes.length ? `<ol class="sources-list">${notes.map((c, i) => {
              const s = S[c.source] || {};
              const url = apidLink(c.apid);
              return `<li id="fn-${i + 1}">${esc(s.title || c.source)}${s.author ? `, ${esc(s.author)}` : ""}${url ? ` · <a href="${url}" target="_blank" rel="noopener">view record on Ancestry</a>` : ""}${c.page ? `<span class="pg">${esc(c.page)}</span>` : ""}${c.text ? `<span class="pg">“${esc(c.text)}”</span>` : ""}</li>`;
            }).join("")}</ol><p class="small muted">Source titles are Ancestry collections; most are indexes or derivative records. “View record” links need an Ancestry login.</p>` : '<p class="muted small">No sources cited. Everything on this page is unsourced.</p>'}
          </section>
        </div>
      </div>
    </div>`;
    if (LIVE && window.FamilyWork) window.FamilyWork.person(CTX(), id);
  }
  function linkify(s) {
    return esc(s).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u.length > 60 ? u.slice(0, 57) + "…" : u}</a>`);
  }
  function findingHtml(f) {
    const kinds = { confirmed: "Confirmed", correction: "Correction", conflict: "Conflict", "new-fact": "New fact", "new-person": "New person", "data-error": "Data error" };
    return `<div class="finding">
      <div class="f-head"><span class="f-kind k-${esc(f.kind)}">${kinds[f.kind] || esc(f.kind)}</span>${f.field ? `<span class="chip">${esc(f.field)}</span>` : ""}<span class="conf-${esc(f.confidence)}">● ${esc(f.confidence)} confidence</span>
      ${f.person && P[f.person] && !currentRoute.includes(f.person) ? `· ${plink(f.person)}` : f.personName && !f.person ? `· ${esc(f.personName)}` : ""}</div>
      ${f.claim ? `<div class="f-claim">Tree says: ${esc(f.claim)}</div>` : ""}
      <div>${esc(f.finding)}</div>
      ${(f.sources || []).length ? `<div class="f-src">${f.sources.map((s) => `${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a>` : esc(s.title)}${s.note ? ` <span class="muted">— ${esc(s.note)}</span>` : ""}`).join("<br>")}</div>` : ""}
    </div>`;
  }
  function issueHtml(i) {
    return `<div class="issue"><span class="sev sev-${i.severity}">${esc(i.severity)}</span><span>${i.person && P[i.person] && !currentRoute.includes(i.person) ? plink(i.person) + ": " : ""}${esc(i.message)}</span></div>`;
  }
  function miniPedigree(id) {
    const par = (x) => { const f = x && P[x] && P[x].famc[0] && F[P[x].famc[0]]; return f ? [f.husband, f.wife] : [null, null]; };
    const [fa, mo] = par(id);
    const gp = [...par(fa), ...par(mo)];
    if (!fa && !mo) return "";
    const cell = (x, lbl) => x && P[x] && !isUnknown(P[x]) ? `<a href="#/person/${x}" ${bstyle(P[x].branch)}>${esc(P[x].name)}<br><span class="muted small">${years(P[x])}</span></a>` : `<span class="unk">${lbl} unknown</span>`;
    return `<div class="card" style="margin-top:16px"><h4 style="margin-top:0">Grandparents</h4>
      <div class="mini-ped">${cell(gp[0], "Paternal grandfather")}${cell(gp[2], "Maternal grandfather")}${cell(gp[1], "Paternal grandmother")}${cell(gp[3], "Maternal grandmother")}</div></div>`;
  }

  // ---------------------------------------------------------------- interactive tree
  function viewTree([id], params) {
    const root = id && P[id] ? id : HOME;
    const mode = params.get("mode") === "desc" ? "desc" : "anc";
    const gens = Math.max(2, Math.min(8, +params.get("g") || (mode === "anc" ? 5 : 4)));
    const p = P[root];
    setTitle("Tree · " + p.name);
    app.innerHTML = `<div class="tree-page">
      <div class="tree-bar">
        <span class="who">${esc(p.name)} <span class="muted small">${years(p)}</span></span>
        <div class="seg" role="group" aria-label="Tree type">
          <button data-mode="anc" class="${mode === "anc" ? "on" : ""}">Ancestors</button>
          <button data-mode="desc" class="${mode === "desc" ? "on" : ""}">Descendants</button>
        </div>
        <div class="seg" role="group" aria-label="Generations">
          ${[3, 4, 5, 6, 7].map((g) => `<button data-g="${g}" class="${g === gens ? "on" : ""}">${g}</button>`).join("")}
        </div>
        <a class="btn" href="#/person/${root}">Profile →</a>
        ${root !== HOME ? `<a class="btn" href="#/tree/${HOME}${mode === "desc" ? "?mode=desc" : ""}">↺ ${esc(HOME_FIRST)}</a>` : ""}
      </div>
      <div class="tree-canvas" id="tc"><svg id="tsvg"><g id="tg"></g></svg>
        <div class="tree-zoom"><button data-z="in" aria-label="Zoom in">+</button><button data-z="out" aria-label="Zoom out">−</button><button data-z="fit" aria-label="Fit">⤢</button></div>
        <div class="tree-legend">${(R.branches || []).map((b) => `<span><i style="background:${bcolor(b.key)}"></i>${esc(b.label)}</span>`).join("")}<span class="muted">Click a person to re-centre · drag to pan · scroll to zoom</span></div>
      </div></div>`;
    const qs = (m, g) => `#/tree/${root}?${m === "desc" ? "mode=desc&" : ""}g=${g}`;
    app.querySelectorAll("[data-mode]").forEach((b) => b.onclick = () => (location.hash = qs(b.dataset.mode, b.dataset.mode === "anc" ? 5 : 4)));
    app.querySelectorAll("[data-g]").forEach((b) => b.onclick = () => (location.hash = qs(mode, b.dataset.g)));

    const BW = 210, BH = 54, HG = 70, VG = 14;
    const nodes = [], links = [];
    if (mode === "anc") {
      let next = 0;
      const place = (pid, g, slotName) => {
        const n = { id: pid, g, x: g * (BW + HG), unknown: !pid, label: slotName };
        nodes.push(n);
        let fa = null, mo = null, hasFam = false;
        if (pid && P[pid].famc[0] && g < gens - 1) { const f = F[P[pid].famc[0]]; fa = f.husband; mo = f.wife; hasFam = true; }
        const kids = [];
        if (hasFam) {
          kids.push(fa ? place(fa, g + 1) : place(null, g + 1, "Unknown father"));
          kids.push(mo ? place(mo, g + 1) : place(null, g + 1, "Unknown mother"));
        }
        if (kids.length) n.y = (kids[0].y + kids[1].y) / 2;
        else { n.y = next * (BH + VG); next++; }
        kids.forEach((k) => links.push([n, k]));
        return n;
      };
      place(root, 0);
    } else {
      let next = 0;
      const place = (pid, g) => {
        const sp = spousesOf(pid);
        const n = { id: pid, g, x: g * (BW + HG), spouses: sp.map((s) => s.spouse).filter(Boolean) };
        n.h = BH + Math.min(2, n.spouses.length) * 16;
        nodes.push(n);
        const kids = [];
        if (g < gens - 1) sp.forEach((s) => s.children.slice().sort(byBirth).forEach((c) => kids.push(place(c, g + 1))));
        if (kids.length) n.y = (kids[0].y + kids[kids.length - 1].y) / 2;
        else { n.y = next; next += n.h + VG; }
        kids.forEach((k) => links.push([n, k]));
        return n;
      };
      place(root, 0);
    }
    const g = document.getElementById("tg");
    let svg = "";
    links.forEach(([a, b]) => {
      const x1 = a.x + BW, y1 = a.y + (a.h || BH) / 2, x2 = b.x, y2 = b.y + (b.h || BH) / 2, mx = x1 + HG / 2;
      svg += `<path class="link" d="M${x1},${y1} H${mx} V${y2} H${x2}"/>`;
    });
    nodes.forEach((n) => {
      const h = n.h || BH;
      if (n.unknown) {
        svg += `<g class="node unknown" transform="translate(${n.x},${n.y})"><rect class="box" width="${BW}" height="${h}" rx="9"/><text class="nm" x="14" y="${h / 2 + 4}">${esc(n.label)}</text></g>`;
        return;
      }
      const q = P[n.id];
      const nm = q.name.length > 26 ? q.name.slice(0, 25) + "…" : q.name;
      const stc = { verified: "var(--ok)", "partly-verified": "var(--info)", disputed: "var(--err)", unverified: "var(--line)" }[q.status];
      let sp = "";
      (n.spouses || []).slice(0, 2).forEach((s, i) => { const t = "⚭ " + P[s].name; sp += `<text class="yr" x="14" y="${54 + i * 16}">${esc(t.length > 30 ? t.slice(0, 29) + "…" : t)}</text>`; });
      if ((n.spouses || []).length > 2) sp += `<text class="yr" x="${BW - 30}" y="70">+${n.spouses.length - 2}</text>`;
      svg += `<g class="node${n.id === root ? " root" : ""}" data-id="${n.id}" transform="translate(${n.x},${n.y})">
        <title>${esc(q.name)} (${years(q)})${q.relation ? " — " + esc(q.relation) : ""}</title>
        <rect class="box" width="${BW}" height="${h}" rx="9"/>
        <rect width="5" height="${h - 12}" x="0" y="6" rx="2" fill="${bcolor(q.branch)}"/>
        <circle cx="${BW - 12}" cy="12" r="4" fill="${stc}"/>
        <text class="nm" x="14" y="22">${esc(nm)}</text>
        <text class="yr" x="14" y="39">${esc(years(q) || "dates unknown")}${q.birth && q.birth.place ? " · " + esc(q.birth.place.split(",")[0].slice(0, 18)) : ""}</text>${sp}</g>`;
    });
    g.innerHTML = svg;

    // pan/zoom
    const canvas = document.getElementById("tc"), svgEl = document.getElementById("tsvg");
    const bbox = { w: (gens) * (BW + HG), h: Math.max(...nodes.map((n) => n.y + (n.h || BH))) };
    let t = { x: 0, y: 0, k: 1 };
    const apply = () => g.setAttribute("transform", `translate(${t.x},${t.y}) scale(${t.k})`);
    const fit = () => {
      const r = canvas.getBoundingClientRect();
      const k = Math.min(1.15, (r.width - 40) / bbox.w, (r.height - 90) / bbox.h);
      t = { k: Math.max(0.2, k), x: 0, y: 0 };
      t.x = (r.width - bbox.w * t.k) / 2 + (mode === "anc" ? 0 : 0);
      t.y = Math.max(20, (r.height - 60 - bbox.h * t.k) / 2);
      apply();
    };
    const zoomAt = (f, cx, cy) => { const k = Math.max(0.15, Math.min(3, t.k * f)); t.x = cx - ((cx - t.x) * k) / t.k; t.y = cy - ((cy - t.y) * k) / t.k; t.k = k; apply(); };
    fit();
    const ptrs = new Map();
    let moved = 0, last = null, pinch = null;
    canvas.addEventListener("pointerdown", (e) => { ptrs.set(e.pointerId, e); moved = 0; last = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); canvas.classList.add("dragging"); });
    canvas.addEventListener("pointermove", (e) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, e);
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        const r = canvas.getBoundingClientRect();
        if (pinch) zoomAt(d / pinch, (a.clientX + b.clientX) / 2 - r.left, (a.clientY + b.clientY) / 2 - r.top);
        pinch = d; moved += 10; return;
      }
      const dx = e.clientX - last.x, dy = e.clientY - last.y;
      moved += Math.abs(dx) + Math.abs(dy);
      t.x += dx; t.y += dy; last = { x: e.clientX, y: e.clientY }; apply();
    });
    const up = (e) => {
      ptrs.delete(e.pointerId); pinch = null; canvas.classList.remove("dragging");
      if (moved < 6 && e.type === "pointerup") {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const node = el && el.closest(".node[data-id]");
        if (node) location.hash = `#/tree/${node.dataset.id}${mode === "desc" ? "?mode=desc" : ""}`;
      }
      if (ptrs.size) last = { x: [...ptrs.values()][0].clientX, y: [...ptrs.values()][0].clientY };
    };
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("wheel", (e) => { e.preventDefault(); const r = canvas.getBoundingClientRect(); zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
    app.querySelectorAll("[data-z]").forEach((b) => b.onclick = (e) => {
      e.stopPropagation();
      const r = canvas.getBoundingClientRect();
      if (b.dataset.z === "fit") fit(); else zoomAt(b.dataset.z === "in" ? 1.25 : 0.8, r.width / 2, r.height / 2);
    });
    app.querySelector(".tree-zoom").addEventListener("pointerdown", (e) => e.stopPropagation());
    const onResize = () => fit();
    window.addEventListener("resize", onResize);
    cleanup = () => window.removeEventListener("resize", onResize);
  }

  // ---------------------------------------------------------------- people index
  function viewPeople(_, params) {
    setTitle("People");
    const q0 = params.get("q") || "", b0 = params.get("branch") || "", s0 = params.get("status") || "", d0 = params.get("direct") || "";
    app.innerHTML = `<div class="wrap page">
      <h1>People</h1>
      <div class="filters">
        <input id="pf-q" type="search" placeholder="Filter by name or place…" value="${esc(q0)}">
        <select id="pf-b"><option value="">All branches</option>${Object.values(BR).filter((b) => branchPeople(b.key).length).map((b) => `<option value="${b.key}" ${b0 === b.key ? "selected" : ""}>${esc(b.label)}</option>`).join("")}</select>
        <select id="pf-s"><option value="">Any status</option>${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${s0 === k ? "selected" : ""}>${v}</option>`).join("")}</select>
        <label class="small"><input id="pf-d" type="checkbox" ${d0 ? "checked" : ""}> Direct ancestors only</label>
        <span id="pf-n" class="muted small"></span>
      </div>
      <div id="pf-out"></div></div>`;
    const render = () => {
      const q = norm(document.getElementById("pf-q").value), b = document.getElementById("pf-b").value, s = document.getElementById("pf-s").value, d = document.getElementById("pf-d").checked;
      const list = people.filter((p) => !isUnknown(p) && (!b || p.branch === b) && (!s || p.status === s) && (!d || p.direct) &&
        (!q || norm(p.name + " " + p.names.map((n) => n.given + " " + n.surname).join(" ") + " " + p.events.map((e) => e.place || "").join(" ")).includes(q)))
        .sort((x, y) => (x.surname || "~").localeCompare(y.surname || "~") || x.given.localeCompare(y.given));
      document.getElementById("pf-n").textContent = `${list.length} people`;
      let html = "", cur = null, buf = [];
      const flush = () => { if (buf.length) html += `<div class="letter-head">${esc(cur || "No surname")}</div><div class="people-grid">${buf.join("")}</div>`; buf = []; };
      list.forEach((p) => { if (p.surname !== cur) { flush(); cur = p.surname; } buf.push(pcard(p)); });
      flush();
      document.getElementById("pf-out").innerHTML = html || `<div class="empty">No one matches.</div>`;
      const ps = new URLSearchParams();
      if (q) ps.set("q", document.getElementById("pf-q").value); if (b) ps.set("branch", b); if (s) ps.set("status", s); if (d) ps.set("direct", "1");
      history.replaceState(null, "", "#/people" + (ps.toString() ? "?" + ps : ""));
    };
    ["pf-q", "pf-b", "pf-s", "pf-d"].forEach((x) => document.getElementById(x).addEventListener("input", render));
    render();
  }

  // ---------------------------------------------------------------- stories
  function viewStories() {
    setTitle("Stories");
    const st = R.stories || [];
    app.innerHTML = `<div class="wrap page"><h1>Stories</h1>
      <p class="prose">Narratives drawn from the records. Each story lists its sources; anything uncertain is said to be uncertain.</p>
      ${st.length ? `<div class="grid g3">${st.map(storyCard).join("")}</div>` : `<div class="empty">No stories written yet. Add them to <code>research.json</code> → <code>stories</code>.</div>`}</div>`;
  }
  function viewStory([slug]) {
    const s = (R.stories || []).find((x) => x.slug === slug);
    if (!s) return viewNotFound();
    setTitle(s.title);
    const paras = (s.body || "").split(/\n\n+/).map((t) => t.startsWith("## ") ? `<h2>${esc(t.slice(3))}</h2>` : `<p>${inline(t)}</p>`).join("");
    app.innerHTML = `<div class="wrap page"><article style="max-width:760px;margin:0 auto">
      <div class="eyebrow" style="color:${bcolor(s.branch || "other")}">${esc((BR[s.branch] || {}).label || "Family")}${s.era ? " · " + esc(s.era) : ""}</div>
      <h1>${esc(s.title)}</h1>
      ${(s.people || []).length ? `<p class="small">People: ${s.people.filter((x) => P[x]).map((x) => plink(x)).join(" · ")}</p>` : ""}
      <div class="prose">${paras}</div>
      ${(s.sources || []).length ? `<h3>Sources</h3><ol class="sources-list">${s.sources.map((x) => `<li>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title || x.url)}</a>` : esc(x.title)}${x.note ? `<span class="pg">${esc(x.note)}</span>` : ""}</li>`).join("")}</ol>` : ""}
      <p><a href="#/stories">← All stories</a></p></article></div>`;
  }
  function inline(t) {
    // [[I123|label]] person links, **bold**, *italic*
    return esc(t).replace(/\[\[(I[\w-]+)(?:\|([^\]]+))?\]\]/g, (_, id, lbl) => plink(id, lbl && lbl.replace(/&amp;/g, "&"))).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/\*([^*]+)\*/g, "<i>$1</i>");
  }

  // ---------------------------------------------------------------- map
  let leafletLoading = null;
  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    if (leafletLoading) return leafletLoading;
    leafletLoading = new Promise((res, rej) => {
      const css = document.createElement("link");
      css.rel = "stylesheet"; css.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
      document.head.appendChild(css);
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
      s.onload = res; s.onerror = rej; document.head.appendChild(s);
    });
    return leafletLoading;
  }
  function viewMap(_, params) {
    setTitle("Map");
    const b0 = params.get("branch") || "", d0 = params.get("direct") === "1";
    app.innerHTML = `<div class="map-bar">
        <strong style="font-family:var(--serif);font-size:1.1rem;margin-right:auto">Where the family lived</strong>
        <select id="mb"><option value="">All branches</option>${(R.branches || []).map((b) => `<option value="${b.key}" ${b0 === b.key ? "selected" : ""}>${esc(b.label)}</option>`).join("")}</select>
        <label class="small"><input type="checkbox" id="md" ${d0 ? "checked" : ""}> Direct ancestors only</label>
        <label class="small"><input type="checkbox" id="mj" checked> Show journeys</label>
      </div><div id="map"><div class="empty" style="margin:40px">Loading map…</div></div>`;
    loadLeaflet().then(() => {
      const el = document.getElementById("map");
      if (!el) return;
      el.innerHTML = "";
      const dark = (document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark";
      const map = L.map(el, { worldCopyJump: true }).setView([45, -30], 3);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap contributors", maxZoom: 18, className: dark ? "tiles-dark" : "tiles-light" }).addTo(map);
      let layer = L.layerGroup().addTo(map);
      const draw = () => {
        layer.clearLayers();
        const b = document.getElementById("mb").value, d = document.getElementById("md").checked, j = document.getElementById("mj").checked;
        history.replaceState(null, "", "#/map" + (b || d ? "?" + new URLSearchParams(Object.assign({}, b ? { branch: b } : {}, d ? { direct: "1" } : {})) : ""));
        const byPlace = {};
        const ps = people.filter((p) => (!b || p.branch === b) && (!d || p.direct));
        ps.forEach((p) => p.events.forEach((e) => {
          if (!e.placeKey || e.misfiled || !D.places[e.placeKey]) return;
          (byPlace[e.placeKey] = byPlace[e.placeKey] || []).push({ p, e });
        }));
        const pts = [];
        Object.entries(byPlace).forEach(([k, evs]) => {
          const pl = D.places[k];
          const counts = {};
          evs.forEach(({ p }) => (counts[p.branch] = (counts[p.branch] || 0) + 1));
          const top = Object.entries(counts).sort((a, c) => c[1] - a[1])[0][0];
          const col = getComputedStyle(document.documentElement).getPropertyValue(`--b-${top}`).trim() || "#888";
          const uniq = [...new Set(evs.map((x) => x.p.id))];
          const m = L.circleMarker([pl.lat, pl.lng], { radius: 5 + Math.sqrt(uniq.length) * 2.4, color: col, weight: 2, fillColor: col, fillOpacity: 0.45 });
          const rows = evs.sort((a, c) => (a.e.sort || 0) - (c.e.sort || 0)).slice(0, 60).map(({ p, e }) => `<li><a href="#/person/${p.id}">${esc(p.name)}</a> — ${esc(eventLabel(e).toLowerCase())}${e.dateDisplay ? " " + esc(e.dateDisplay) : ""}</li>`).join("");
          m.bindPopup(`<h4>${esc(pl.name)}</h4><div class="small muted">${uniq.length} people · ${evs.length} events</div><ul>${rows}</ul>`);
          m.addTo(layer);
          pts.push([pl.lat, pl.lng]);
        });
        if (j) ps.forEach((p) => {
          const bE = p.events.find((e) => e.type === "Birth" && e.placeKey), dE = p.events.find((e) => (e.type === "Death" || e.type === "Burial") && e.placeKey && !e.misfiled);
          if (!bE || !dE || bE.placeKey === dE.placeKey) return;
          const a = D.places[bE.placeKey], c = D.places[dE.placeKey];
          if (!a || !c) return;
          const dist = Math.hypot(a.lat - c.lat, a.lng - c.lng);
          if (dist < 1.5) return;
          const col = getComputedStyle(document.documentElement).getPropertyValue(`--b-${p.branch}`).trim() || "#888";
          // gentle arc
          const mid = [(a.lat + c.lat) / 2 + dist * 0.12, (a.lng + c.lng) / 2];
          const arc = []; for (let i = 0; i <= 24; i++) { const t2 = i / 24; arc.push([(1 - t2) * (1 - t2) * a.lat + 2 * (1 - t2) * t2 * mid[0] + t2 * t2 * c.lat, (1 - t2) * (1 - t2) * a.lng + 2 * (1 - t2) * t2 * mid[1] + t2 * t2 * c.lng]); }
          L.polyline(arc, { color: col, weight: 1.6, opacity: 0.55, dashArray: "4 5" }).bindTooltip(`${esc(p.name)}: ${esc(a.name)} → ${esc(c.name)}`).addTo(layer);
        });
        if (pts.length) map.fitBounds(pts, { padding: [30, 30], maxZoom: 7 });
      };
      ["mb", "md", "mj"].forEach((x) => document.getElementById(x).addEventListener("input", draw));
      draw();
      cleanup = () => map.remove();
    }).catch(() => { const el = document.getElementById("map"); if (el) el.innerHTML = `<div class="empty" style="margin:40px">The map library could not be loaded (offline?).</div>`; });
  }

  // ---------------------------------------------------------------- timeline
  function viewTimeline(_, params) {
    setTitle("Timeline");
    const scope = params.get("scope") || "direct";
    const types = new Set(["Birth", "Death", "Arrival", "Marriage", "Military", "NaturalizationPetition"]);
    const rows = [];
    people.forEach((p) => {
      if (scope === "direct" && !p.direct) return;
      p.events.forEach((e) => { if (types.has(e.type) && e.sort && !e.misfiled) rows.push({ sort: e.sort, date: e.dateDisplay, html: `${plink(p.id)} — ${esc(eventLabel(e).toLowerCase())}${e.place ? ", " + esc(e.place) : ""}`, br: p.branch }); });
    });
    const seenFam = new Set();
    people.forEach((p) => {
      if (scope === "direct" && !p.direct) return;
      spousesOf(p.id).forEach(({ fam, spouse }) => {
        if (seenFam.has(fam.id)) return; seenFam.add(fam.id);
        fam.events.forEach((e) => { if (e.sort && e.type === "Marriage") rows.push({ sort: e.sort, date: e.dateDisplay, html: `${plink(p.id)} married ${spouse ? plink(spouse) : "?"}${e.place ? ", " + esc(e.place) : ""}`, br: p.branch }); });
      });
    });
    (R.context || []).forEach((c) => rows.push({ sort: c.year * 10000 + (c.month || 6) * 100 + 15, date: String(c.year), html: `<b>${esc(c.title)}</b>${c.text ? " — " + esc(c.text) : ""}`, ctx: true }));
    rows.sort((a, b) => a.sort - b.sort);
    let html = "", dec = null;
    rows.forEach((r) => {
      const d = Math.floor(r.sort / 100000) * 10;
      if (d !== dec) { html += `<div class="decade">${d}s</div>`; dec = d; }
      html += `<div class="tl-row${r.ctx ? " ctx" : ""}" ${r.br ? bstyle(r.br) : ""}><div class="d">${esc(r.date)}</div><div class="w" ${r.br ? `style="border-left:3px solid ${bcolor(r.br)};padding-left:10px"` : ""}>${r.html}</div></div>`;
    });
    app.innerHTML = `<div class="wrap page"><h1>Timeline</h1>
      <div class="filters"><div class="seg"><button data-s="direct" class="${scope === "direct" ? "on" : ""}">Direct ancestors</button><button data-s="all" class="${scope === "all" ? "on" : ""}">Everyone</button></div>
      <span class="small muted">Shaded rows are historical context.</span></div>${html}</div>`;
    app.querySelectorAll("[data-s]").forEach((b) => b.onclick = () => (location.hash = "#/timeline?scope=" + b.dataset.s));
  }

  // ---------------------------------------------------------------- research
  function viewResearch([tab]) {
    tab = tab || "overview";
    setTitle("Research");
    const findings = R.findings || [], todos = R.todo || [], issues = D.issues;
    const tabs = [["overview", "Overview"], ["review", "Data problems", issues.filter((i) => i.severity !== "info").length], ["findings", "Findings", findings.length], ["todo", "To-do", todos.length], ...(LIVE ? [["queue", "Suggestions", null]] : []), ["status", "Verification", null], ["sources", "Sources", Object.keys(S).length]];
    let body = "";
    if (tab === "overview") {
      const k = {}; findings.forEach((f) => (k[f.kind] = (k[f.kind] || 0) + 1));
      body = `<div class="prose"><p>This tree began as an Ancestry export. Ancestry trees are easy to grow and easy to get wrong: record “hints” get attached to the wrong person, duplicates creep in, and other people’s unsourced trees get copied. This section tracks what has actually been checked against records, what is wrong, and what to do next.</p></div>
        <div class="grid g4">
          <div class="card"><div class="eyebrow">Findings</div><div class="stat"><b>${findings.length}</b></div><p class="small">${Object.entries(k).map(([a, b]) => `${b} ${esc(a)}`).join(" · ") || "none yet"}</p><a class="small" href="#/research/findings">Review →</a></div>
          <div class="card"><div class="eyebrow">Data problems</div><div class="stat"><b>${issues.filter((i) => i.severity === "error").length}</b></div><p class="small">errors, plus ${issues.filter((i) => i.severity === "warn").length} warnings, found automatically on each build.</p><a class="small" href="#/research/review">Review →</a></div>
          <div class="card"><div class="eyebrow">Open tasks</div><div class="stat"><b>${todos.length}</b></div><p class="small">${todos.filter((t) => t.priority === "high").length} high priority</p><a class="small" href="#/research/todo">See list →</a></div>
          <div class="card"><div class="eyebrow">Sources</div><div class="stat"><b>${Object.keys(S).length}</b></div><p class="small">record collections cited from Ancestry</p><a class="small" href="#/research/sources">Browse →</a></div>
        </div>
        ${LIVE && EDITOR ? `<p class="btn-row" style="margin-top:14px"><a class="btn" href="api/export.ged?tree=${encodeURIComponent(TREE)}" download>Download GEDCOM (what you can see)</a>${ACCOUNT && ACCOUNT.isOwner ? `<a class="btn" href="api/export.json" download>Download everything (JSON)</a>` : ""}</p>` : ""}
        ${R.methodology ? `<section class="section prose">${R.methodology.split(/\n\n+/).map((t) => `<p>${inline(t)}</p>`).join("")}</section>` : ""}`;
    } else if (tab === "review") {
      const groups = {};
      issues.forEach((i) => (groups[i.kind] = groups[i.kind] || []).push(i));
      const labels = { "possible-duplicate": "Possible duplicates", "multiple-parents": "Attached to two sets of parents", "sex-role": "Sex conflicts with role", "parent-age": "Impossible parent ages", "born-after-parent-death": "Born after a parent died", "misfiled-event": "Relatives’ events misfiled", "conflicting-dates": "Records disagree on dates", "conflicting-places": "Records disagree on places", "anachronistic-place": "Anachronistic place names", "date-format": "Badly formatted dates", "missing-sex": "Missing sex", "marriage-age": "Implausible marriage ages", "death-before-birth": "Death before birth", age: "Implausible lifespans" };
      const order = ["error", "warn", "info"];
      body = `<p class="muted">Generated by <code>tools/build.py</code> on every build, so this list shrinks as you fix things in Ancestry and re-export.</p>` +
        Object.entries(groups).sort((a, b) => order.indexOf(a[1][0].severity) - order.indexOf(b[1][0].severity)).map(([k, list]) => `<section class="card" style="margin-bottom:14px"><h3>${esc(labels[k] || k)} <span class="count">${list.length}</span></h3>${list.map(issueHtml).join("")}</section>`).join("");
    } else if (tab === "findings") {
      body = `<div class="filters"><select id="ff-k"><option value="">All kinds</option>${[...new Set(findings.map((f) => f.kind))].map((k) => `<option>${esc(k)}</option>`).join("")}</select>
        <select id="ff-b"><option value="">All branches</option>${(R.branches || []).map((b) => `<option value="${b.key}">${esc(b.label)}</option>`).join("")}</select>
        <select id="ff-c"><option value="">Any confidence</option><option>high</option><option>medium</option><option>low</option></select></div><div id="ff-out"></div>`;
    } else if (tab === "todo" && LIVE) {
      body = `<div class="filters" id="td-filters">${[["active", "Active"], ["mine", "Assigned to me"], ["unassigned", "Unassigned"], ["needs_review", "Needs review"], ["done", "Done"], ["all", "All"]].map(([k, l]) => `<button class="btn${k === "active" ? " primary" : ""}" data-f="${k}">${l}</button>`).join("")}
        <button class="btn" id="td-new" style="margin-left:auto">+ New to-do</button></div>
        <form id="td-form" class="card" hidden style="margin-bottom:16px"><div class="filters">
          <input name="task" placeholder="What needs doing?" required style="flex:2;min-width:240px">
          <input name="person" list="td-people" placeholder="Person (optional)" style="flex:1;min-width:180px">
          <datalist id="td-people">${people.filter((p) => !isUnknown(p)).map((p) => `<option value="${esc(p.name)} (${p.id})">`).join("")}</datalist>
          <input name="where" placeholder="Where to look" style="flex:1;min-width:180px">
          <select name="priority"><option>high</option><option selected>medium</option><option>low</option></select>
          <label class="small"><input type="checkbox" name="mine" checked> assign to me</label>
          <button class="btn primary">Add</button></div></form>
        <div id="td-out"><p class="muted">Loading…</p></div>`;
    } else if (tab === "queue" && LIVE) {
      body = `<p class="muted">Research from relatives and AI agents waits here until an editor approves it. Approved findings, log entries and to-dos are added to the tree; nothing is applied without review.</p>
        <div class="filters">${[["open", "Waiting"], ["approved", "Approved"], ["rejected", "Rejected"], ["all", "All"]].map(([k, l]) => `<button class="btn${k === "open" ? " primary" : ""}" data-q="${k}">${l}</button>`).join("")}</div><div id="q-out"><p class="muted">Loading…</p></div>`;
    } else if (tab === "todo") {
      const pr = { high: 0, medium: 1, low: 2 };
      body = todos.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Priority</th><th>Person</th><th>Task</th><th>Where to look</th></tr></thead><tbody>${todos.slice().sort((a, b) => pr[a.priority] - pr[b.priority]).map((t) => `<tr><td class="prio-${t.priority}">${esc(t.priority)}</td><td>${t.person && P[t.person] ? plink(t.person) : "—"}</td><td>${esc(t.task)}</td><td class="small">${linkify(t.where || "")}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">No tasks yet.</div>`;
    } else if (tab === "status") {
      const list = people.filter((p) => !isUnknown(p) && p.direct).sort((a, b) => a.generation - b.generation || byBirth(a.id, b.id));
      body = `<p class="muted">Direct ancestors, by generation. Status is set in <code>research.json → people_status</code>.</p><div class="table-wrap"><table class="data"><thead><tr><th>Gen</th><th>Person</th><th>Status</th><th>Note</th><th>Findings</th></tr></thead><tbody>${list.map((p) => `<tr><td>${p.generation}</td><td>${plink(p.id)}<br><span class="small muted">${years(p)} · ${esc(p.relation || "")}</span></td><td>${statusBadge(p)}</td><td class="small">${esc(p.statusNote)}</td><td>${findingsFor(p.id).length || ""}</td></tr>`).join("")}</tbody></table></div>`;
    } else if (tab === "sources") {
      const use = {};
      people.forEach((p) => { const seen = new Set(); p.events.concat([{ citations: p.citations }]).forEach((e) => (e.citations || []).forEach((c) => { if (!seen.has(c.source)) { seen.add(c.source); (use[c.source] = use[c.source] || []).push(p.id); } })); });
      const list = Object.values(S).sort((a, b) => (use[b.id] || []).length - (use[a.id] || []).length);
      body = `<p class="muted">Every record collection cited in the Ancestry export, with the people who cite it. Indexes (e.g. “Find a Grave Index”, “Public Records Index”) are pointers, not proof — follow them to the underlying record.</p><div class="table-wrap"><table class="data"><thead><tr><th>Collection</th><th>People</th></tr></thead><tbody>${list.map((s) => `<tr><td>${esc(s.title)}<br><span class="small muted">${esc(s.author || "")}</span></td><td class="small">${(use[s.id] || []).map((id) => plink(id)).join(", ") || "—"}</td></tr>`).join("")}</tbody></table></div>`;
    }
    app.innerHTML = `<div class="wrap page"><h1>Research</h1><nav class="tabs">${tabs.map(([k, l, n]) => `<a href="#/research/${k}" class="${k === tab ? "on" : ""}">${l}${n != null ? `<span class="count">${n}</span>` : ""}</a>`).join("")}</nav>${body}</div>`;
    if (tab === "todo" && LIVE) wireTodos();
    if (tab === "queue" && LIVE) wireQueue();
    if (tab === "findings") {
      const draw = () => {
        const k = document.getElementById("ff-k").value, b = document.getElementById("ff-b").value, c = document.getElementById("ff-c").value;
        const order = { correction: 0, "data-error": 0, conflict: 1, "new-person": 2, "new-fact": 3, confirmed: 4 };
        const list = findings.filter((f) => (!k || f.kind === k) && (!c || f.confidence === c) && (!b || (f.person && P[f.person] && P[f.person].branch === b) || (!f.person && f.branch === b)))
          .sort((x, y) => (order[x.kind] ?? 5) - (order[y.kind] ?? 5));
        document.getElementById("ff-out").innerHTML = list.length ? list.map(findingHtml).join("") : `<div class="empty">No findings match.</div>`;
      };
      ["ff-k", "ff-b", "ff-c"].forEach((x) => document.getElementById(x).addEventListener("input", draw));
      draw();
    }
  }

  // ---------------------------------------------------------------- to-dos (live, from /api/todos)
  const STATUS_TXT = { open: "Open", in_progress: "In progress", needs_review: "Needs review", done: "Done", wont_do: "Won’t do" };
  const who = (x) => !x ? "—" : x === (ME && ME.principal) ? "me" : x.startsWith("service:") || x.startsWith("agent:") ? `🤖 ${esc(x.replace(/^(service|agent):/, ""))}` : esc(x.split("@")[0]);
  function wireTodos() {
    const out = document.getElementById("td-out");
    let filter = "active";
    const query = { active: "status=active", mine: "assignee=me&status=active", unassigned: "assignee=unassigned&status=open", needs_review: "status=needs_review", done: "status=done,wont_do", all: "" };
    async function load() {
      out.innerHTML = `<p class="muted">Loading…</p>`;
      try {
        const { todos } = await api("GET", `todos?${query[filter]}`);
        out.innerHTML = todos.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Priority</th><th>Person</th><th>Task</th><th>Status</th><th>Assigned</th><th></th></tr></thead><tbody>${todos.map(row).join("")}</tbody></table></div>` : `<div class="empty">Nothing here.</div>`;
        out.querySelectorAll("[data-act]").forEach((b) => b.onclick = () => act(b.dataset.act, todos.find((t) => t.id === +b.dataset.id), b));
        out.querySelectorAll("select[data-status]").forEach((sel) => sel.onchange = () => act("status", todos.find((t) => t.id === +sel.dataset.status), sel));
      } catch (e) { out.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
    }
    function row(t) {
      const mine = ME && t.assignee === ME.principal;
      const statuses = EDITOR ? Object.keys(STATUS_TXT) : mine ? ["open", "in_progress", "needs_review"] : [];
      const status = statuses.length && !(statuses.indexOf(t.status) < 0 && !EDITOR)
        ? `<select data-status="${t.id}">${statuses.map((x) => `<option value="${x}"${x === t.status ? " selected" : ""}>${STATUS_TXT[x]}</option>`).join("")}</select>`
        : `<span class="badge st-${t.status === "done" ? "verified" : t.status === "needs_review" ? "partly-verified" : "unverified"}">${STATUS_TXT[t.status]}</span>`;
      const acts = [];
      if (!t.assignee && !["done", "wont_do"].includes(t.status)) acts.push(`<button class="btn" data-act="claim" data-id="${t.id}">Take it</button>`);
      if (EDITOR) acts.push(`<button class="btn" data-act="assign" data-id="${t.id}" title="Assign to someone (an email, or agent:name)">Assign…</button>`);
      acts.push(`<button class="btn" data-act="history" data-id="${t.id}">History</button>`);
      return `<tr id="td-${t.id}"><td class="prio-${t.priority}">${esc(t.priority)}</td><td>${t.person && P[t.person] ? plink(t.person) : "—"}</td>
        <td>${esc(t.task)}${t.where ? `<br><span class="small muted">${linkify(t.where)}</span>` : ""}${t.outcome ? `<br><span class="small"><b>Outcome:</b> ${esc(t.outcome)}</span>` : ""}</td>
        <td>${status}</td><td class="small">${who(t.assignee)}</td><td><div class="btn-row">${acts.join("")}</div></td></tr>`;
    }
    async function act(kind, t, el) {
      try {
        if (kind === "claim") await api("POST", `todos/${t.id}/claim`);
        else if (kind === "assign") {
          const a = prompt("Assign to (an email, \"me\", \"agent:name\", or empty to unassign):", t.assignee || "me");
          if (a === null) return;
          await api("PATCH", `todos/${t.id}`, { version: t.version, assignee: a.trim() || null });
        } else if (kind === "status") {
          const body = { version: t.version, status: el.value };
          if (["done", "wont_do", "needs_review"].includes(el.value)) {
            const o = prompt("Outcome (what was found, or why it was dropped):", t.outcome || "");
            if (o === null) { el.value = t.status; return; }
            body.outcome = o;
          }
          await api("PATCH", `todos/${t.id}`, body);
        } else if (kind === "history") {
          const { events } = await api("GET", `todos/${t.id}/events`);
          const tr = document.getElementById(`td-${t.id}`);
          const nx = tr.nextElementSibling;
          if (nx && nx.classList.contains("td-hist")) { nx.remove(); return; }
          tr.insertAdjacentHTML("afterend", `<tr class="td-hist"><td colspan="6" class="small">${events.map((e) => `<div>${esc(e.at.slice(0, 16).replace("T", " "))} · ${who(e.actor)} · ${esc(e.kind)} ${esc(e.data.text || e.data.outcome || (e.data.to !== undefined ? `→ ${e.data.to || "unassigned"}` : "") || (e.data.proposal ? `suggestion #${e.data.proposal}` : ""))}</div>`).join("")}
            <form class="filters" style="margin-top:6px"><input name="c" placeholder="Add a comment" style="flex:1"><button class="btn">Comment</button></form></td></tr>`);
          tr.nextElementSibling.querySelector("form").onsubmit = async (ev) => { ev.preventDefault(); await api("PATCH", `todos/${t.id}`, { comment: ev.target.c.value }); load(); };
          return;
        }
        load();
      } catch (e) { alert(e.status === 409 ? "Someone else changed this to-do; the list will refresh." : e.message); load(); }
    }
    document.querySelectorAll("#td-filters [data-f]").forEach((b) => b.onclick = () => {
      filter = b.dataset.f;
      document.querySelectorAll("#td-filters [data-f]").forEach((x) => x.classList.toggle("primary", x === b));
      load();
    });
    const form = document.getElementById("td-form");
    document.getElementById("td-new").onclick = () => (form.hidden = !form.hidden);
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const f = form.elements, m = (f.person.value.match(/\(([^)]+)\)\s*$/) || [])[1];
      try {
        await api("POST", "todos", { task: f.task.value, person: m || undefined, where: f.where.value || undefined, priority: f.priority.value, assignee: f.mine.checked ? "me" : undefined });
        form.reset(); form.hidden = true; load();
      } catch (e) { alert(e.message); }
    };
    load();
  }

  function wireQueue() {
    const out = document.getElementById("q-out");
    let status = "open";
    async function load() {
      out.innerHTML = `<p class="muted">Loading…</p>`;
      try {
        const { proposals } = await api("GET", `proposals?status=${status}`);
        out.innerHTML = proposals.length ? proposals.map(card).join("") : `<div class="empty">Nothing ${status === "open" ? "waiting for review" : "here"}.</div>`;
        out.querySelectorAll("[data-pa]").forEach((b) => b.onclick = () => decide(+b.dataset.id, b.dataset.pa));
      } catch (e) { out.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
    }
    function card(pr) {
      const b = pr.payload || {};
      const parts = [];
      if (pr.kind === "edit") parts.push(`<h4>Proposed changes${b.origin ? ` <span class="small muted">(${esc(b.origin)})</span>` : ""}</h4><ol>${(b.ops || []).map((o) => `<li>${window.FamilyWork ? window.FamilyWork.opText(CTX(), o) : esc(o.op)}</li>`).join("")}</ol>${b.reason ? `<p class="small"><b>Why:</b> ${esc(b.reason)}</p>` : ""}${(b.sources || []).map((s) => `<p class="small">Source: ${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>` : esc(s.title)}</p>`).join("")}`);
      if ((b.findings || []).length) parts.push(`<h4>Findings</h4>${b.findings.map((f) => findingHtml(Object.assign({}, f, { branch: f.branch || b.branch }))).join("")}`);
      if (Object.keys(b.people_status || {}).length) parts.push(`<h4>Status changes</h4><ul>${Object.entries(b.people_status).map(([id, s]) => `<li>${P[id] ? plink(id) : esc(id)}: <b>${esc(s.status)}</b> ${esc(s.note || "")}</li>`).join("")}</ul>`);
      if ((b.todo || []).length) parts.push(`<h4>New to-dos</h4><ul>${b.todo.map((t) => `<li>[${esc(t.priority)}] ${t.person && P[t.person] ? plink(t.person) + ": " : ""}${esc(t.task)}</li>`).join("")}</ul>`);
      if ((b.todo_done || []).length) parts.push(`<h4>Closes</h4><ul>${b.todo_done.map((t) => `<li>${esc(t.task || `to-do #${t.id}`)}: ${esc(t.outcome || "")}</li>`).join("")}</ul>`);
      if ((b.log || []).length) parts.push(`<details><summary>${b.log.length} searches logged</summary><ul>${b.log.map((l) => `<li>${esc(l.result)}: ${esc(l.searched)}${l.note ? ` <span class="muted">(${esc(l.note)})</span>` : ""}</li>`).join("")}</ul></details>`);
      const btns = pr.status === "open" ? [
        EDITOR ? `<button class="btn primary" data-pa="approve" data-id="${pr.id}">Approve</button><button class="btn" data-pa="reject" data-id="${pr.id}">Reject…</button>` : "",
        ME && pr.author === ME.principal ? `<button class="btn" data-pa="withdraw" data-id="${pr.id}">Withdraw</button>` : "",
      ].join("") : `<span class="small muted">${esc(pr.status)} by ${who(pr.reviewed_by)}${pr.review_note ? `: ${esc(pr.review_note)}` : ""}</span>`;
      return `<section class="card" style="margin-bottom:14px"><div class="eyebrow">Suggestion #${pr.id} · ${who(pr.author)} · ${esc(pr.created_at.slice(0, 10))}${pr.todo_id ? ` · for to-do #${pr.todo_id}` : ""}</div>
        ${pr.rationale ? `<p>${esc(pr.rationale)}</p>` : ""}${parts.join("")}<div class="btn-row" style="margin-top:10px">${btns}</div></section>`;
    }
    async function decide(id, action) {
      let note;
      if (action === "reject") { note = prompt("Why? (the author sees this)"); if (note === null) return; }
      try { await api("POST", `proposals/${id}/${action}`, { note }); if (action === "approve") location.reload(); else load(); }
      catch (e) { alert(e.message); }
    }
    document.querySelectorAll("[data-q]").forEach((b) => b.onclick = () => {
      status = b.dataset.q;
      document.querySelectorAll("[data-q]").forEach((x) => x.classList.toggle("primary", x === b));
      load();
    });
    load();
  }

  // ---------------------------------------------------------------- about
  function viewAbout() {
    setTitle("How this site works");
    app.innerHTML = `<div class="wrap page"><article class="prose" style="max-width:760px">
      <h1>How this site works</h1>
      <p>The app (<code>site/</code>) contains no family data. A Cloudflare Worker serves the tree from a private D1 database, only to people let in by Cloudflare Access. The data is built from two private inputs:</p>
      <p><b>1. The GEDCOM file</b> (<code>*.ged</code>) — the structure of the tree: people, families, events and the Ancestry citations. Keep editing the tree in Ancestry (or Gramps), then export a new GEDCOM and replace the file.</p>
      <p><b>2. The research file</b> (<code>research.json</code>) — everything Ancestry can’t hold well: verification status for each person, research findings with links to sources, corrections, written stories, historical context and the to-do list. It is keyed by the GEDCOM person IDs, so it survives re-exports.</p>
      <p>Run <code>python3 tools/build.py</code> to produce <code>build/seed.sql</code>, then load it into the Cloudflare D1 database (see the README). The build also runs automatic checks (duplicates, impossible ages, people with two sets of parents, misfiled events, bad dates) which appear under <a href="#/research/review">Research → Data problems</a>.</p>
      <h2>Verification levels</h2>
      <p><span class="badge st-verified">Verified</span> independent records confirm identity and key dates. <span class="badge st-partly-verified">Partly verified</span> some facts confirmed. <span class="badge st-unverified">Unverified</span> only Ancestry tree data. <span class="badge st-disputed">Disputed</span> the evidence contradicts what the tree says.</p>
      <h2>Photos</h2>
      <p>The Ancestry export references ${Object.keys(D.media).length} photos and documents but doesn’t include the files. Download them, upload them to the R2 bucket (or <code>family-data/media/</code> for local preview) and list them under <code>media</code> in <code>research.json</code>, e.g. <code>{"I123": [{"file": "photos/name.jpg", "portrait": true}]}</code>.</p>
    </article></div>`;
  }
  function viewNotFound() {
    setTitle("Not found");
    app.innerHTML = `<div class="wrap page"><h1>Not found</h1><p><a href="#/">Go home</a></p></div>`;
  }

  route();
}

(function boot() {
  const app = document.getElementById("app");
  app.innerHTML = `<div class="wrap page"><p class="muted">Loading the family tree…</p></div>`;
  const get = (path) => fetch(path, { credentials: "same-origin", headers: { Accept: "application/json" } })
    .then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) }));
  get("api/me")
    .then(async (me) => {
      let tree = null, account = null;
      if (me.ok) { // the Cloudflare Worker (tools/serve.py has no /api/me)
        account = me.body;
        if (!account.trees.length) throw new Error("No family trees have been shared with you yet. Ask the owner to invite you.");
        let saved = null; try { saved = localStorage.getItem("tree"); } catch {}
        tree = (account.trees.find((t) => t.id === saved) || account.trees[0]).id;
      } else if (me.status === 403) throw new Error(me.body.error || "Not signed in.");
      let preview = null; try { preview = account && account.isOwner ? sessionStorage.getItem("previewView") : null; } catch {}
      const r = await get(`api/tree${tree ? `?tree=${encodeURIComponent(tree)}` : ""}${preview ? `&preview_view=${encodeURIComponent(preview)}` : ""}`);
      if (!r.ok) throw new Error(r.body.error || `The server answered ${r.status}.`);
      r.body.account = account;
      if (preview) r.body.previewView = preview;
      return r.body;
    })
    .then(startFamilyApp)
    .catch((e) => {
      app.innerHTML = `<div class="wrap page"><h1>Can’t load the tree</h1><p>${String(e.message).replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"))}</p>
        <p class="muted small">Locally: run <code>python3 tools/build.py</code> then <code>python3 tools/serve.py</code>. On Cloudflare: check the D1 binding, that the seed was loaded, and that you came in through Cloudflare Access.</p></div>`;
    });
})();
