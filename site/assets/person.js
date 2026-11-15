/* Person page tools: change diffs, photos, finding remediation, next steps, and fact verification.
   Loaded after work.js and before app.js; work.js calls FamilyPerson.* with a context. Holds no family data.

   Data follows genealogy practice: every change is a recorded edit with a reason and sources; a fact's review
   records the conclusion, who reached it and the evidence (Genealogical Proof Standard); citations carry where in the
   source (GEDCOM PAGE), quality (GEDCOM QUAY 0–3) and the Evidence Explained analysis: source original / derivative
   / authored, information primary / secondary / undetermined, evidence direct / indirect / negative. */
(function () {
  "use strict";
  const X = (window.FamilyPerson = {});

  // ---------------------------------------------------------------- vocabularies (mirrors worker/ops.js)
  X.SOURCE_TYPES = { original: "Original record", derivative: "Derivative (index, transcript, abstract)", authored: "Authored work (tree, book, compiled)" };
  X.INFORMATION = { primary: "Primary: from someone with first-hand knowledge, near the time", secondary: "Secondary: second-hand or recorded later", undetermined: "Undetermined" };
  X.EVIDENCE = { direct: "Direct: answers the question by itself", indirect: "Indirect: answers it only combined with other evidence", negative: "Negative: an absence that tells something" };
  X.QUALITY = { 3: "3 · Direct and primary evidence", 2: "2 · Secondary evidence, officially recorded later", 1: "1 · Questionable reliability", 0: "0 · Unreliable or estimated" };
  X.MEDIA_TYPES = { photo: "Photo", tombstone: "Headstone", newspaper: "Newspaper", manuscript: "Document or letter", card: "Card", map: "Map", book: "Book page", electronic: "Digital record", film: "Film", fiche: "Microfiche", magazine: "Magazine", audio: "Audio", video: "Video", other: "Other" };
  const EVENT_TYPE_FOR_FIELD = { birth: "Birth", death: "Death", burial: "Burial", baptism: "Baptism", christening: "Christening", residence: "Residence", occupation: "Occupation", immigration: "Immigration", emigration: "Emigration", naturalization: "Naturalization", census: "Census", military: "Military", marriage: "Marriage" };
  const KIND_HELP = {
    conflict: "Records disagree. Weigh them (an original over an index, first-hand over second-hand information), then fix the tree, mark the fact disputed, or keep the tree as it is and say why.",
    correction: "A record says the tree is wrong. If the evidence holds, apply the fix; it is cited and can be undone.",
    "data-error": "Something in how the tree records this is wrong (a typo, a misattached record). Fix it in the tree.",
    "new-fact": "A record adds something the tree doesn't have. Add it, citing the record.",
    confirmed: "A record backs up what the tree says. Mark the fact verified with it as the evidence.",
    "new-person": "A relative not yet in the tree. Add them from Edit (parent, spouse or child), citing the record.",
  };

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const ago = (iso) => {
    if (!iso) return "";
    const d = (Date.now() - Date.parse(iso)) / 86400000;
    return d < 1 ? "today" : d < 2 ? "yesterday" : d < 31 ? `${Math.floor(d)} days ago` : iso.slice(0, 10);
  };
  const opts = (map, sel, blank) => (blank != null ? `<option value="">${esc(blank)}</option>` : "") + Object.entries(map).map(([k, v]) => `<option value="${esc(k)}"${String(sel) === String(k) ? " selected" : ""}>${esc(v)}</option>`).join("");

  // ---------------------------------------------------------------- citations
  X.citeLabel = (c, cit) => {
    if (!cit) return "";
    const s = cit.source && c.S[cit.source];
    const title = (s && s.title) || cit.title || cit.url || cit.note || cit.source || "source";
    return `${title}${cit.page ? `, ${cit.page}` : ""}`;
  };
  X.citeHtml = (c, cit) => {
    const label = esc(X.citeLabel(c, cit));
    const meta = [cit.source_type && X.SOURCE_TYPES[cit.source_type] && cit.source_type, cit.information && `${cit.information} info`, cit.evidence && `${cit.evidence} evidence`, cit.quality != null && `QUAY ${cit.quality}`].filter(Boolean);
    return `${cit.url ? `<a href="${esc(cit.url)}" target="_blank" rel="noopener">${label}</a>` : label}${meta.length ? ` <span class="muted small">(${meta.map(esc).join(" · ")})</span>` : ""}`;
  };
  /** Form fields for one structured citation. */
  X.citationFields = (prefix = "c") => `<fieldset class="cite-fields"><legend class="small">Source</legend>
    <input name="${prefix}_title" placeholder="Record or collection (e.g. Leeds parish burials)" style="flex:2;min-width:220px">
    <input name="${prefix}_url" placeholder="Link to the record (https://…)" style="flex:2;min-width:200px">
    <input name="${prefix}_page" placeholder="Where in it (volume, page, entry, image)" style="flex:1;min-width:180px">
    <select name="${prefix}_source_type" title="What kind of source">${opts(X.SOURCE_TYPES, "", "Kind of source…")}</select>
    <select name="${prefix}_information" title="Quality of the information">${opts(X.INFORMATION, "", "Information…")}</select>
    <select name="${prefix}_evidence" title="How it answers the question">${opts(X.EVIDENCE, "", "Evidence…")}</select>
    <select name="${prefix}_quality" title="GEDCOM quality (QUAY)">${opts(X.QUALITY, "", "Quality…")}</select>
    <textarea name="${prefix}_text" rows="2" placeholder="Transcription: what the record actually says (optional)" style="flex-basis:100%"></textarea></fieldset>`;
  X.readCitation = (f, prefix = "c") => {
    const v = (k) => (f[`${prefix}_${k}`] && f[`${prefix}_${k}`].value || "").trim();
    if (!v("title") && !v("url")) return null;
    const cit = { title: v("title") || undefined, url: v("url") || undefined, page: v("page") || undefined, text: v("text") || undefined, accessed: new Date().toISOString().slice(0, 10) };
    for (const k of ["source_type", "information", "evidence", "quality"]) if (v(k)) cit[k] = v(k);
    if (cit.url && !/^https?:\/\//i.test(cit.url)) throw new Error("The link must start with http:// or https://");
    return cit;
  };
  /** A research finding's sources as structured citations (their analysis is unknown until someone assesses it). */
  X.findingCitations = (f) => (f.sources || []).filter((s) => s.title || s.url).map((s) => ({ title: s.title || undefined, url: /^https?:\/\//i.test(s.url || "") ? s.url : undefined, note: s.note || undefined, accessed: f.date || undefined }));

  // ---------------------------------------------------------------- diffs
  const evText = (e) => [e.type, e.date, e.place, e.value].filter(Boolean).join(", ");
  const nameText = (n) => `${n.given || ""} ${n.surname || ""}`.trim() + (n.type ? ` (${n.type})` : "");
  const keyOf = (x) => JSON.stringify(x);
  const listDiff = (a = [], b = []) => ({ added: b.filter((x) => !a.some((y) => keyOf(y) === keyOf(x))), removed: a.filter((x) => !b.some((y) => keyOf(y) === keyOf(x))) });
  const who = (c, id) => (id && c.P[id] ? c.P[id].name : id || "nobody");
  const chg = (label, from, to) => `<li class="d-chg"><b>${esc(label)}</b>: <del>${esc(from || "(none)")}</del> → <ins>${esc(to || "(none)")}</ins></li>`;
  const add = (label, text) => `<li class="d-add">+ <b>${esc(label)}</b> ${text}</li>`;
  const del = (label, text) => `<li class="d-del">− <b>${esc(label)}</b> ${text}</li>`;

  function factDiffs(c, label, a, b) {
    const out = [];
    for (const k of ["date", "place", "value", "note", "age", "address", "type"]) if ((a[k] || "") !== (b[k] || "")) out.push(chg(`${label} · ${k}`, a[k], b[k]));
    const ra = a.review || {}, rb = b.review || {};
    if ((ra.status || "unverified") !== (rb.status || "unverified") || (ra.note || "") !== (rb.note || "")) {
      out.push(`<li class="d-chg"><b>${esc(label)}</b>: marked <span class="badge st-${rb.status === "verified" ? "verified" : rb.status === "disputed" ? "disputed" : "unverified"}">${esc(rb.status || "unverified")}</span>${rb.note ? ` — ${esc(rb.note)}` : ""}${(rb.evidence || []).length ? ` <span class="muted small">(evidence: ${rb.evidence.map((x) => esc(X.citeLabel(c, x))).join("; ")})</span>` : ""}</li>`);
    }
    const cd = listDiff(a.citations, b.citations);
    for (const x of cd.added) out.push(add(`${label} · source`, X.citeHtml(c, x)));
    for (const x of cd.removed) out.push(del(`${label} · source`, esc(X.citeLabel(c, x))));
    return out;
  }
  function factsDiff(c, a = [], b = [], text, label) {
    const out = [], A = new Map(a.map((x) => [x.fid, x])), B = new Map(b.map((x) => [x.fid, x]));
    for (const [fid, x] of B) if (!A.has(fid)) out.push(add(label(x), esc(text(x))));
    for (const [fid, x] of A) if (!B.has(fid)) out.push(del(label(x), esc(text(x))));
    for (const [fid, x] of B) if (A.has(fid)) out.push(...factDiffs(c, label(x), A.get(fid), x));
    return out;
  }
  function mediaDiff(c, a = [], b = []) {
    const out = [], A = new Map((a || []).map((m) => [m.file, m])), B = new Map((b || []).map((m) => [m.file, m]));
    const label = (m) => m.caption || m.file.split("/").pop();
    for (const [f, m] of B) if (!A.has(f)) out.push(add("Photo", esc(label(m)) + (m.portrait ? " (main photo)" : "")));
    for (const [f, m] of A) if (!B.has(f)) out.push(del("Photo", esc(label(m))));
    for (const [f, m] of B) {
      const o = A.get(f);
      if (!o) continue;
      if (!o.portrait && m.portrait) out.push(`<li class="d-chg"><b>Main photo</b> → ${esc(label(m))}</li>`);
      for (const k of ["caption", "date", "place", "type", "note", "source"]) if ((o[k] || "") !== (m[k] || "")) out.push(chg(`Photo · ${k}`, o[k], m[k]));
    }
    return out;
  }
  /** One changed record as a list of human-readable differences. `ch` is {type, id, before, after}. */
  X.diffItems = (c, ch) => {
    const a = ch.before, b = ch.after, t = ch.type;
    if (t === "media" || t === "media_map") return mediaDiff(c, a, b);
    if (t === "finding") return [b ? `<li class="d-chg"><b>Finding</b> ${esc(b.status)}${b.note ? ` — ${esc(b.note)}` : ""}</li>` : `<li class="d-chg"><b>Finding</b> reopened</li>`];
    if (t === "status") return [chg("Research status", a && a.status, b && b.status)];
    if (!a && b) return [add(t === "family" ? "Family" : "Person", esc(t === "family" ? [b.husband, b.wife].filter(Boolean).map((x) => who(c, x)).join(" & ") : (b.names || []).map(nameText).join(" / ")))];
    if (a && !b) return [del(t === "family" ? "Family" : "Person", esc(t === "family" ? ch.id : (a.names || []).map(nameText).join(" / ")))];
    if (!a || !b) return [];
    const out = [];
    if (t === "person") {
      if ((a.sex || "") !== (b.sex || "")) out.push(chg("Sex", a.sex, b.sex));
      out.push(...factsDiff(c, a.names, b.names, nameText, () => "Name"));
      out.push(...factsDiff(c, a.events, b.events, evText, (e) => e.type));
      if (keyOf(a.notes || []) !== keyOf(b.notes || [])) out.push(chg("Notes", (a.notes || []).join(" / "), (b.notes || []).join(" / ")));
      const cd = listDiff(a.citations, b.citations);
      for (const x of cd.added) out.push(add("Source", X.citeHtml(c, x)));
      for (const x of cd.removed) out.push(del("Source", esc(X.citeLabel(c, x))));
      for (const k of ["famc", "fams"]) {
        const d = listDiff(a[k], b[k]);
        for (const f of d.added) out.push(add(k === "famc" ? "Parents' family" : "Own family", esc(f)));
        for (const f of d.removed) out.push(del(k === "famc" ? "Parents' family" : "Own family", esc(f)));
      }
    } else if (t === "family") {
      for (const r of ["husband", "wife"]) if ((a[r] || null) !== (b[r] || null)) out.push(chg(r === "husband" ? "Husband" : "Wife", who(c, a[r]), who(c, b[r])));
      const d = listDiff(a.children, b.children);
      for (const x of d.added) out.push(add("Child", esc(who(c, x))));
      for (const x of d.removed) out.push(del("Child", esc(who(c, x))));
      out.push(...factsDiff(c, a.events, b.events, evText, (e) => e.type));
    } else if (t === "source") {
      for (const k of ["title", "author", "publication", "url", "repository"]) if ((a[k] || "") !== (b[k] || "")) out.push(chg(`Source · ${k}`, a[k], b[k]));
    }
    return out;
  };
  X.diffHtml = (c, changes) => {
    const blocks = (changes || []).map((ch) => {
      const items = X.diffItems(c, ch);
      if (!items.length) return "";
      const title = ch.type === "person" ? who(c, ch.id) : ch.type === "family" ? `Family ${ch.id}` : ch.type === "media" || ch.type === "media_map" ? `Photos of ${who(c, ch.id)}` : ch.type === "finding" ? `Finding #${ch.id}` : ch.type === "status" ? `Status of ${who(c, ch.id)}` : `${ch.type} ${ch.id}`;
      return `<div class="diff"><div class="small muted">${esc(title)}</div><ul>${items.join("")}</ul></div>`;
    }).join("");
    return blocks || `<p class="small muted">No visible differences.</p>`;
  };

  // ---------------------------------------------------------------- photos
  X.photos = function (c, id, ctx) {
    const host = document.getElementById("w-photos");
    if (!host) return;
    const p = c.P[id];
    const list = ((c.R.media || {})[id] || []).slice();
    const gedcomOnly = (p.media || []).length;
    const isPdf = (f) => /\.pdf$/i.test(f);
    const label = (m) => m.caption || (X.MEDIA_TYPES[m.type] || "Photo");
    host.innerHTML = `<h2>Photos and documents${list.length ? ` <span class="count">${list.length}</span>` : ""}</h2>
      ${list.length ? `<div class="photo-grid">${list.map((m, i) => `<figure class="photo${m.portrait ? " main" : ""}" data-i="${i}" tabindex="0" role="button" aria-label="Open ${esc(label(m))}">
          ${isPdf(m.file) ? `<div class="doc">PDF</div>` : `<img loading="lazy" src="${esc(c.mediaUrl(m.file))}" alt="${esc(label(m))}">`}
          <figcaption>${m.portrait ? `<span class="badge st-verified">Main photo</span> ` : ""}${esc(label(m))}<br><span class="muted small">${esc([X.MEDIA_TYPES[m.type], m.date, m.place].filter(Boolean).join(" · "))}</span></figcaption></figure>`).join("")}</div>`
        : `<p class="muted small">No photos or documents yet.</p>`}
      ${gedcomOnly ? `<p class="small muted">${gedcomOnly} more item${gedcomOnly > 1 ? "s are" : " is"} listed in the Ancestry export but not uploaded here.</p>` : ""}
      ${c.LIVE !== false ? `<div class="btn-row"><button class="btn" id="ph-add">${c.EDITOR ? "Add a photo or document" : "Suggest a photo or document"}</button></div>` : ""}`;
    const add = host.querySelector("#ph-add");
    if (add) add.onclick = () => { ctx.actions.photo(); document.getElementById("w-edit").scrollIntoView({ behavior: "smooth", block: "start" }); };
    host.querySelectorAll(".photo").forEach((fig) => {
      const open = () => lightbox(c, id, ctx, list[+fig.dataset.i]);
      fig.onclick = open;
      fig.onkeydown = (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); } };
    });
  };
  function lightbox(c, id, ctx, m) {
    const dlg = document.createElement("dialog");
    dlg.className = "lightbox";
    const isPdf = /\.pdf$/i.test(m.file);
    dlg.innerHTML = `<form method="dialog" class="lb-close"><button class="icon-btn" aria-label="Close">✕</button></form>
      ${isPdf ? `<p><a class="btn" href="${esc(c.mediaUrl(m.file))}" target="_blank" rel="noopener">Open the PDF</a></p>` : `<img src="${esc(c.mediaUrl(m.file))}" alt="${esc(m.caption || "")}">`}
      <div class="lb-meta"><b>${esc(m.caption || "Untitled")}</b>${m.portrait ? ` <span class="badge st-verified">Main photo</span>` : ""}
        <div class="small muted">${esc([X.MEDIA_TYPES[m.type], m.date, m.place].filter(Boolean).join(" · "))}</div>
        ${m.note ? `<p class="small">${esc(m.note)}</p>` : ""}${m.source ? `<p class="small">Source: ${esc((c.S[m.source] || {}).title || m.source)}</p>` : ""}
        <div class="btn-row">${!m.portrait && !isPdf ? `<button class="btn primary" data-a="main">${c.EDITOR ? "Make this the main photo" : "Suggest as main photo"}</button>` : ""}
          <button class="btn" data-a="edit">Edit details</button><button class="btn" data-a="remove">${c.EDITOR ? "Remove from this person" : "Suggest removing"}</button></div>
        <form class="filters lb-edit" hidden>
          <input name="caption" value="${esc(m.caption || "")}" placeholder="Caption" style="flex:2;min-width:200px">
          <select name="type">${opts(X.MEDIA_TYPES, m.type || "", "Kind…")}</select>
          <input name="date" value="${esc(m.date || "")}" placeholder="Date taken (e.g. abt 1925)" style="max-width:170px">
          <input name="place" value="${esc(m.place || "")}" placeholder="Place" style="flex:1;min-width:160px">
          <input name="note" value="${esc(m.note || "")}" placeholder="Note (who is pictured, where it came from)" style="flex-basis:100%">
          <button class="btn primary">${c.EDITOR ? "Save" : "Suggest"}</button></form></div>`;
    document.body.appendChild(dlg);
    dlg.addEventListener("close", () => dlg.remove());
    dlg.showModal();
    const done = () => dlg.close();
    dlg.querySelector('[data-a="main"]')?.addEventListener("click", async () => { if (await ctx.change([{ op: "media.set_primary", person: id, file: m.file }], { reason: "Choose the main photo" })) done(); });
    dlg.querySelector('[data-a="remove"]').onclick = async () => {
      if (!confirm("Remove this from the person? The file stays stored, and the change can be undone from History.")) return;
      if (await ctx.change([{ op: "media.detach", person: id, file: m.file }], { reason: "Remove a photo or document" })) done();
    };
    const form = dlg.querySelector(".lb-edit");
    dlg.querySelector('[data-a="edit"]').onclick = () => (form.hidden = !form.hidden);
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const set = {};
      for (const k of ["caption", "type", "date", "place", "note"]) set[k] = form[k].value.trim();
      if (await ctx.change([{ op: "media.update", person: id, file: m.file, set }], { reason: "Update photo details" })) done();
    };
  }

  // ---------------------------------------------------------------- facts: verification
  X.factBadge = (r) => {
    if (!r || !r.status || r.status === "unverified") return "";
    const tip = `${r.status} by ${r.by || "?"} on ${(r.at || "").slice(0, 10)}${r.note ? `: ${r.note}` : ""}${(r.evidence || []).length ? ` · ${r.evidence.length} source${r.evidence.length > 1 ? "s" : ""}` : ""}`;
    return ` <span class="badge st-${r.status === "verified" ? "verified" : "disputed"}" title="${esc(tip)}">${esc(r.status)}</span>`;
  };
  X.facts = function (c, id, ctx) {
    const p = c.P[id];
    const own = (p.events || []).filter((e) => e.fid);
    // header summary
    const nV = own.filter((e) => e.review && e.review.status === "verified").length, nD = own.filter((e) => e.review && e.review.status === "disputed").length;
    const tags = c.app.querySelector(".person-head .tags");
    if (tags && own.length) tags.insertAdjacentHTML("beforeend", ` <span class="chip" title="Facts reviewed against the records">${nV} of ${own.length} facts verified${nD ? `, ${nD} disputed` : ""}</span>`);
    for (const e of own) {
      const row = c.app.querySelector(`[data-fid="${CSS.escape(e.fid)}"]`);
      if (!row) continue;
      row.insertAdjacentHTML("beforeend", `${X.factBadge(e.review)} <button class="linklike fact-verify" data-fid="${esc(e.fid)}">${e.review && e.review.status !== "unverified" ? "review" : "verify"}</button>`);
    }
    c.app.querySelectorAll(".fact-verify").forEach((b) => (b.onclick = () => X.verifyForm(c, id, ctx, own.find((e) => e.fid === b.dataset.fid), b.closest(".t-body"))));
  };
  X.verifyForm = function (c, id, ctx, e, anchor, preset = {}) {
    document.querySelectorAll(".verify-form").forEach((f) => f.remove());
    const cites = e.citations || [];
    const r = e.review || {};
    const wrap = document.createElement("form");
    wrap.className = "card sub verify-form";
    wrap.innerHTML = `<div class="small"><b>Review: ${esc([e.type, e.dateDisplay || e.date, e.place].filter(Boolean).join(", "))}</b>
        ${r.status ? `<span class="muted"> · currently ${esc(r.status)}${r.by ? ` by ${esc(c.who(r.by))} ${esc(ago(r.at))}` : ""}</span>` : ""}</div>
      <div class="filters" role="radiogroup" aria-label="Conclusion">
        ${[["verified", "Verified: the evidence supports it"], ["disputed", "Disputed: the evidence contradicts it"], ["unverified", "Unverified: not yet checked"]].map(([v, l]) => `<label class="small"><input type="radio" name="status" value="${v}"${(preset.status || r.status || "verified") === v ? " checked" : ""}> ${l}</label>`).join("")}
      </div>
      ${cites.length ? `<div class="small"><div class="muted">Evidence already cited on this fact:</div>${cites.map((ci, i) => `<label style="display:block"><input type="checkbox" name="ev" value="${i}"${(r.evidence || []).some((x) => JSON.stringify(x) === JSON.stringify(ci)) ? " checked" : ""}> ${X.citeHtml(c, ci)}</label>`).join("")}</div>` : `<p class="small muted">No sources are cited on this fact yet. Add the record you checked:</p>`}
      ${X.citationFields("n")}
      <textarea name="note" rows="2" placeholder="Your conclusion: what you compared and why it holds (or doesn't)" style="width:100%">${esc(preset.note || "")}</textarea>
      <div class="btn-row"><button class="btn primary">${c.EDITOR ? "Add to changes" : "Add to suggestion"}</button><button type="button" class="btn" data-cancel>Cancel</button></div>`;
    (anchor || document.getElementById("w-form")).appendChild(wrap);
    if (preset.citation) for (const [k, v] of Object.entries(preset.citation)) if (wrap[`n_${k}`] && v) wrap[`n_${k}`].value = v;
    wrap.querySelector("[data-cancel]").onclick = () => wrap.remove();
    wrap.onsubmit = (ev) => {
      ev.preventDefault();
      try {
        const status = wrap.querySelector("input[name=status]:checked").value;
        const evidence = [...wrap.querySelectorAll("input[name=ev]:checked")].map((x) => ({ index: +x.value }));
        const nc = X.readCitation(wrap, "n");
        if (nc) evidence.push(nc);
        const note = wrap.note.value.trim();
        if (status === "verified" && !evidence.length) throw new Error("Pick or add the source that verifies it.");
        if (status !== "unverified" && !note) throw new Error("Write your conclusion: it is kept with the fact.");
        ctx.queue([{ op: "fact.review", entity: "person", id, fid: e.fid, status, note, evidence, ...(preset.finding != null ? { finding: preset.finding } : {}) }],
          { resolves: preset.resolves, reason: preset.reason || note });
        wrap.remove();
      } catch (err) { alert(err.message); }
    };
    wrap.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  // ---------------------------------------------------------------- findings: remediation
  X.findings = function (c, id, ctx) {
    const p = c.P[id];
    c.app.querySelectorAll(".finding[data-finding]").forEach((el) => {
      const f = (c.R.findings || []).find((x) => String(x.id) === el.dataset.finding);
      if (!f) return;
      const res = f.resolution;
      const bar = document.createElement("div");
      bar.className = "f-actions";
      if (res) {
        bar.innerHTML = `<span class="badge st-${res.status === "resolved" ? "verified" : "unverified"}">${res.status === "resolved" ? "Resolved" : "Kept as is"}</span>
          <span class="small muted">by ${esc(c.who(res.by))} ${esc(ago(res.at))}${res.note ? `: ${esc(res.note)}` : ""}${res.proposal ? ` (suggestion #${res.proposal})` : ""}</span>
          ${c.EDITOR ? ` <button class="linklike" data-a="reopen">reopen</button>` : ""}`;
        el.classList.add("f-closed");
      } else {
        const target = targetFact(p, f);
        const btns = [];
        if (c.EDITOR || c.LIVE) {
          if (f.kind === "confirmed" && target) btns.push(["verify", "Mark the fact verified", true]);
          if ((f.proposed_ops || []).length) btns.push(["apply", "Apply the suggested change", true]);
          if (["correction", "data-error", "conflict", "new-fact"].includes(f.kind)) btns.push(["fix", f.kind === "new-fact" ? "Add it to the tree" : "Fix in the tree", !(f.proposed_ops || []).length]);
          if (f.kind === "conflict" && target) btns.push(["dispute", "Mark the fact disputed", false]);
          if (c.EDITOR) btns.push(["keep", f.kind === "confirmed" ? "Done" : "Keep the tree as is", false]);
        }
        btns.push(["discuss", "Discuss", false]);
        bar.innerHTML = `<p class="small muted f-help">${esc(KIND_HELP[f.kind] || "")}</p><div class="btn-row">${btns.map(([a, l, primary]) => `<button class="btn${primary ? " primary" : ""}" data-a="${a}">${esc(l)}</button>`).join("")}</div>`;
      }
      el.appendChild(bar);
      bar.querySelectorAll("[data-a]").forEach((b) => (b.onclick = () => act(c, id, ctx, f, b.dataset.a, el)));
    });
  };
  function targetFact(p, f) {
    if (f.fact) return (p.events || []).find((e) => e.fid === f.fact) || null;
    const type = EVENT_TYPE_FOR_FIELD[String(f.field || "").toLowerCase()];
    return type ? (p.events || []).find((e) => e.type === type) || null : null;
  }
  async function act(c, id, ctx, f, a, el) {
    const p = c.P[id];
    const target = targetFact(p, f);
    const cites = X.findingCitations(f);
    const reason = `Finding #${f.id}: ${f.finding}`.slice(0, 1000);
    try {
      if (a === "discuss") {
        const box = document.querySelector("#w-c-f input[name=body]");
        if (box) { box.value = `About finding #${f.id} (${f.kind}): `; box.focus(); box.scrollIntoView({ behavior: "smooth", block: "center" }); }
      } else if (a === "keep") {
        const note = prompt(f.kind === "confirmed" ? "Note (optional):" : "Why does the tree stay as it is? (kept with the finding)", "");
        if (note === null) return;
        if (f.kind !== "confirmed" && !note.trim()) return alert("Say why: the reason is the record of your decision.");
        await c.api("PATCH", `findings/${f.id}`, { status: "dismissed", note: note.trim() || "Noted.", version: f.version });
        location.reload();
      } else if (a === "reopen") {
        await c.api("PATCH", `findings/${f.id}`, { status: "open", version: f.version });
        location.reload();
      } else if (a === "verify" || a === "dispute") {
        X.verifyForm(c, id, ctx, target, el, { status: a === "verify" ? "verified" : "disputed", note: a === "verify" ? `Confirmed by ${cites.map((x) => x.title).join("; ") || "the record"}: ${f.finding}` : f.finding,
          citation: cites[0], finding: f.id, resolves: [f.id], reason });
      } else if (a === "apply") {
        ctx.queue(f.proposed_ops, { resolves: [f.id], reason, sources: f.sources });
      } else if (a === "fix") {
        fixForm(c, id, ctx, f, target, el, { cites, reason });
      }
    } catch (e) { alert(e.status === 409 ? "Someone changed this meanwhile. Reload and try again." : e.message); }
  }
  /** A side-by-side "tree says / record says" editor for the fact a finding concerns, citing the finding's sources. */
  function fixForm(c, id, ctx, f, target, el, { cites, reason }) {
    document.querySelectorAll(".fix-form").forEach((x) => x.remove());
    const type = (target && target.type) || EVENT_TYPE_FOR_FIELD[String(f.field || "").toLowerCase()] || "Event";
    const isName = String(f.field || "").toLowerCase() === "name";
    const form = document.createElement("form");
    form.className = "card sub fix-form";
    form.innerHTML = `<div class="fix-cols"><div><div class="eyebrow">Tree says</div><div class="small">${esc(target ? [target.date, target.place, target.value].filter(Boolean).join(", ") : f.claim || "(nothing recorded)")}</div></div>
        <div><div class="eyebrow">Record says</div><div class="small">${esc(f.finding)}</div></div></div>
      ${isName ? `<div class="filters"><input name="given" placeholder="Given names"><input name="surname" placeholder="Surname"><select name="ntype"><option value="">Kind</option><option>birth</option><option>married</option><option>also known as</option></select></div>`
        : `<div class="filters"><b style="min-width:110px">${esc(type)}</b><input name="date" value="${esc(target ? target.date || "" : "")}" placeholder="Date (e.g. 3 Mar 1931, abt 1890)">
          <input name="place" value="${esc(target ? target.place || "" : "")}" placeholder="Place, most specific first" style="flex:1;min-width:200px">
          <input name="value" value="${esc(target ? target.value || "" : "")}" placeholder="Detail (occupation, age…)"></div>`}
      <p class="small muted">${cites.length ? `Cites ${cites.map((x) => esc(x.title)).join("; ")}. Assess it: ` : "Add the record: "}</p>
      ${X.citationFields("fx")}
      <div class="btn-row"><button class="btn primary">${c.EDITOR ? "Add to changes" : "Add to suggestion"}</button><button type="button" class="btn" data-cancel>Cancel</button></div>`;
    el.appendChild(form);
    if (cites[0]) for (const [k, v] of Object.entries(cites[0])) if (form[`fx_${k}`] && v) form[`fx_${k}`].value = v;
    form.querySelector("[data-cancel]").onclick = () => form.remove();
    form.onsubmit = (ev) => {
      ev.preventDefault();
      try {
        const cit = X.readCitation(form, "fx");
        const citations = cit ? [cit, ...cites.slice(1)] : cites;
        if (!citations.length) throw new Error("Cite the record that supports the change.");
        let ops;
        if (isName) {
          if (!form.given.value.trim() && !form.surname.value.trim()) throw new Error("Give the name as the record has it.");
          ops = [{ op: "name.add", person: id, name: { given: form.given.value.trim(), surname: form.surname.value.trim(), type: form.ntype.value } }];
        } else {
          const set = { date: form.date.value.trim(), place: form.place.value.trim(), value: form.value.value.trim() };
          if (target) {
            ops = [{ op: "event.update", entity: "person", id, fid: target.fid, set }];
            for (const ci of citations) ops.push({ op: "citation.add", entity: "person", id, fid: target.fid, citation: ci });
          } else {
            ops = [{ op: "event.add", entity: "person", id, event: { type, ...Object.fromEntries(Object.entries(set).filter(([, v]) => v)), citations } }];
          }
        }
        ctx.queue(ops, { resolves: [f.id], reason, sources: f.sources });
        form.remove();
      } catch (err) { alert(err.message); }
    };
    form.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // ---------------------------------------------------------------- next steps (to-dos)
  const STATUS_TXT = { open: "Open", in_progress: "In progress", needs_review: "Needs review", done: "Done", wont_do: "Won't do" };
  X.todos = function (c, id, ctx) {
    const host = document.getElementById("w-todos");
    if (!host) return;
    const p = c.P[id];
    const mine = (t) => c.ME && t.assignee === c.ME.principal;
    const draw = async () => {
      let todos = [];
      try { todos = (await c.api("GET", `todos?person=${encodeURIComponent(id)}`)).todos; }
      catch (e) { host.innerHTML = `<p class="muted small">${esc(e.message)}</p>`; return; }
      const active = todos.filter((t) => !["done", "wont_do"].includes(t.status)), closed = todos.filter((t) => ["done", "wont_do"].includes(t.status));
      const pr = { high: 0, medium: 1, low: 2 };
      active.sort((a, b) => pr[a.priority] - pr[b.priority] || a.id - b.id);
      const row = (t) => {
        const canStatus = c.EDITOR || mine(t);
        const acts = [];
        if (!t.assignee && !["done", "wont_do"].includes(t.status)) acts.push(`<button class="btn" data-a="claim">I'll do it</button>`);
        if (canStatus && t.status !== "done") acts.push(`<button class="btn" data-a="done">Done…</button>`);
        if (c.AI && !p.living && !["done", "wont_do", "needs_review"].includes(t.status) && (!t.assignee || mine(t))) acts.push(`<button class="btn" data-a="ai" title="A cloud research agent works this and files a suggestion">Research with AI</button>`);
        if (canStatus && !["done", "wont_do"].includes(t.status)) acts.push(`<select data-a="status" aria-label="Status">${Object.entries(STATUS_TXT).filter(([k]) => c.EDITOR || ["open", "in_progress", "needs_review"].includes(k)).map(([k, v]) => `<option value="${k}"${k === t.status ? " selected" : ""}>${v}</option>`).join("")}</select>`);
        acts.push(`<button class="linklike" data-a="history">history</button>`);
        return `<li class="todo-item prio-b-${esc(t.priority)}" data-id="${t.id}">
          <div class="todo-head"><span class="prio-${esc(t.priority)}">${esc(t.priority)}</span>
            <span class="badge st-${t.status === "done" ? "verified" : t.status === "needs_review" ? "partly-verified" : "unverified"}">${STATUS_TXT[t.status]}</span>
            ${t.assignee ? `<span class="small">${esc(c.who(t.assignee))}</span>` : `<span class="small muted">unassigned</span>`}
            <span class="small muted">added ${esc(ago(t.created_at))} by ${esc(c.who(t.created_by))}</span></div>
          <div>${esc(t.task)}</div>
          ${t.where ? `<div class="small">Where to look: ${linkify(t.where)}</div>` : ""}
          ${t.outcome ? `<div class="small"><b>Outcome:</b> ${esc(t.outcome)}</div>` : ""}
          <div class="btn-row todo-acts">${acts.join("")}</div><div class="todo-hist small"></div></li>`;
      };
      host.innerHTML = `${active.length ? `<ul class="todo-list">${active.map(row).join("")}</ul>` : `<p class="muted small">No open next steps.</p>`}
        ${closed.length ? `<details><summary class="small">${closed.length} finished</summary><ul class="todo-list">${closed.map(row).join("")}</ul></details>` : ""}
        <form class="filters todo-new"><input name="task" placeholder="Add a next step for ${esc(p.given || p.name)}…" required style="flex:2;min-width:220px">
          <input name="where" placeholder="Where to look (archive, collection, link)" style="flex:1;min-width:180px">
          <select name="priority"><option>high</option><option selected>medium</option><option>low</option></select>
          <label class="small"><input type="checkbox" name="mine"> mine</label><button class="btn">Add</button></form>`;
      host.querySelectorAll(".todo-item").forEach((li) => {
        const t = todos.find((x) => x.id === +li.dataset.id);
        li.querySelectorAll("[data-a]").forEach((el) => {
          const handler = async () => {
            try {
              const a = el.dataset.a;
              if (a === "claim") await c.api("POST", `todos/${t.id}/claim`);
              else if (a === "done" || (a === "status" && ["done", "wont_do"].includes(el.value))) {
                const outcome = prompt("What was found, or why it was dropped? (kept with the to-do)", t.outcome || "");
                if (outcome === null) { if (a === "status") el.value = t.status; return; }
                await c.api("PATCH", `todos/${t.id}`, { version: t.version, status: a === "done" ? "done" : el.value, outcome });
              } else if (a === "status") await c.api("PATCH", `todos/${t.id}`, { version: t.version, status: el.value });
              else if (a === "ai") {
                const extra = prompt("Anything the agent should know or focus on? (optional)", "");
                if (extra === null) return;
                await c.api("POST", "agent/runs", { todo_id: t.id, instructions: extra || undefined });
              } else if (a === "history") return showHistory(c, t, li.querySelector(".todo-hist"));
              draw();
            } catch (e) { alert(e.status === 409 ? "Someone changed this meanwhile; refreshing." : e.message); draw(); }
          };
          if (el.tagName === "SELECT") el.onchange = handler; else el.onclick = handler;
        });
      });
      host.querySelector(".todo-new").onsubmit = async (ev) => {
        ev.preventDefault();
        const f = ev.target;
        try { await c.api("POST", "todos", { person: id, task: f.task.value, where: f.where.value || undefined, priority: f.priority.value, assignee: f.mine.checked ? "me" : undefined }); draw(); }
        catch (e) { alert(e.message); }
      };
    };
    draw();
  };
  async function showHistory(c, t, box) {
    if (box.innerHTML) { box.innerHTML = ""; return; }
    const { events } = await c.api("GET", `todos/${t.id}/events`);
    const line = (e) => {
      const d = e.data || {};
      const what = e.kind === "status" ? `${STATUS_TXT[d.from] || d.from || "?"} → ${STATUS_TXT[d.to] || d.to}${d.note ? `: ${esc(d.note)}` : ""}`
        : e.kind === "assigned" ? `assigned to ${esc(c.who(d.to) || "nobody")}${d.run ? " (research agent run)" : ""}`
        : e.kind === "proposal" ? `filed <a href="#/research/queue">suggestion #${esc(d.proposal)}</a>`
        : e.kind === "comment" ? `“${esc(d.text)}”` : e.kind === "edited" ? `changed ${esc(d.field)}` : esc(e.kind);
      return `<li>${esc(ago(e.at))} · ${esc(c.who(e.actor))} · ${what}</li>`;
    };
    box.innerHTML = `<ul class="history">${events.map(line).join("")}</ul>
      <form class="filters"><input name="c" placeholder="Add a comment or progress note" style="flex:1"><button class="btn">Comment</button></form>`;
    box.querySelector("form").onsubmit = async (ev) => { ev.preventDefault(); await c.api("PATCH", `todos/${t.id}`, { comment: ev.target.c.value }); box.innerHTML = ""; showHistory(c, t, box); };
  }
  function linkify(s) {
    return esc(s).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u.length > 60 ? u.slice(0, 57) + "…" : u}</a>`);
  }
})();
