/* Family history: editing, suggestions, history, comments, uploads, relationships and admin.
   Loaded before app.js; app.js calls FamilyWork.* with a context object. Holds no family data. */
(function () {
  "use strict";
  const W = (window.FamilyWork = {});

  // ---------------------------------------------------------------- helpers
  const h = (ctx) => ctx.esc;
  const OP_LABEL = {
    "person.create": (o, c) => `add a new person: ${c.esc(o.names.map((n) => `${n.given} ${n.surname}`).join(" / "))}`,
    "person.update": (o, c) => `set ${Object.keys(o.set || {}).join(", ")} on ${who(c, o.id)}`,
    "person.delete": (o, c) => `delete ${who(c, o.id)}`,
    "person.merge": (o, c) => `merge ${who(c, o.drop)} into ${who(c, o.keep)}`,
    "name.add": (o, c) => `add the name “${c.esc(`${o.name.given} ${o.name.surname}`)}” to ${who(c, o.person)}`,
    "name.update": (o, c) => `change name ${o.fid} of ${who(c, o.person)}`,
    "name.remove": (o, c) => `remove name ${o.fid} from ${who(c, o.person)}`,
    "event.add": (o, c) => `add ${c.esc(o.event.type)}${o.event.date ? ` ${c.esc(o.event.date)}` : ""}${o.event.place ? `, ${c.esc(o.event.place)}` : ""}${o.event.value ? ` (${c.esc(o.event.value)})` : ""} to ${o.entity === "person" ? who(c, o.id) : `family ${c.esc(o.id)}`}`,
    "event.update": (o, c) => `${o.conflict ? "<b>conflict</b>: " : ""}change ${c.esc(o.entity === "person" ? factName(c, o.id, o.fid) : o.fid)} of ${o.entity === "person" ? who(c, o.id) : `family ${c.esc(o.id)}`}: ${Object.entries(o.set || {}).filter(([, v]) => v !== "").map(([k, v]) => `${k} → “${c.esc(v)}”`).join(", ")}`,
    "event.remove": (o, c) => `remove ${c.esc(o.entity === "person" ? factName(c, o.id, o.fid) : o.fid)} from ${o.entity === "person" ? who(c, o.id) : `family ${c.esc(o.id)}`}`,
    "fact.review": (o, c) => `mark ${c.esc(factName(c, o.id, o.fid))} of ${who(c, o.id)} as <b>${c.esc(o.status)}</b>${o.note ? `: ${c.esc(o.note)}` : ""}${(o.evidence || []).length ? ` <span class="muted">(${o.evidence.length} source${o.evidence.length > 1 ? "s" : ""})</span>` : ""}`,
    "citation.add": (o, c) => `cite ${c.esc(o.citation.title || o.citation.url || o.citation.note || (c.S[o.citation.source] || {}).title || o.citation.source)} on ${o.fid ? `${c.esc(factName(c, o.id, o.fid))} of ` : ""}${who(c, o.id)}`,
    "citation.remove": (o, c) => `remove a citation from ${who(c, o.id)}`,
    "family.create": (o, c) => `create a family: ${[o.husband, o.wife].filter(Boolean).map((x) => who(c, x)).join(" & ") || "(no spouses)"}${(o.children || []).length ? `, children ${o.children.map((x) => who(c, x)).join(", ")}` : ""}`,
    "family.set_spouse": (o, c) => `set ${o.role} of family ${c.esc(o.family)} to ${o.person ? who(c, o.person) : "nobody"}`,
    "family.swap_spouses": (o, c) => `swap husband and wife in family ${c.esc(o.family)}`,
    "family.add_child": (o, c) => `add ${who(c, o.person)} as a child of family ${c.esc(o.family)}`,
    "family.remove_child": (o, c) => `remove ${who(c, o.person)} from family ${c.esc(o.family)}`,
    "family.delete": (o, c) => `delete family ${c.esc(o.family)}`,
    "family.merge": (o, c) => `merge family ${c.esc(o.drop)} into ${c.esc(o.keep)}`,
    "source.upsert": (o, c) => `add/update source “${c.esc(o.data.title)}”`,
    "media.attach": (o, c) => `attach a photo/document to ${who(c, o.person)}${o.caption ? `: ${c.esc(o.caption)}` : ""}`,
    "media.detach": (o, c) => `detach a photo/document from ${who(c, o.person)}`,
    "media.update": (o, c) => `update photo details on ${who(c, o.person)}: ${Object.entries(o.set || {}).filter(([, v]) => v).map(([k, v]) => `${k} “${c.esc(v)}”`).join(", ") || "clear details"}`,
    "media.set_primary": (o, c) => `make a photo the main photo of ${who(c, o.person)}`,
  };
  function factName(c, pid, fid) {
    const p = c.P[pid];
    const e = p && [...(p.events || []), ...(p.names || [])].find((x) => x.fid === fid);
    return e ? (e.type ? [e.type, e.date].filter(Boolean).join(" ") : `name ${`${e.given || ""} ${e.surname || ""}`.trim()}`) : fid;
  }
  function who(c, id) { if (!id) return "—"; if (String(id).startsWith("$")) return "the new person"; return c.P[id] ? c.plink(id) : c.esc(id); }
  W.opText = (c, o) => (OP_LABEL[o.op] ? OP_LABEL[o.op](o, c) : c.esc(o.op));
  const personOptions = (c) => c.people.filter((p) => !c.isUnknown(p)).map((p) => `<option value="${c.esc(p.name)} (${p.id})">`).join("");
  const pickId = (v) => (String(v || "").match(/\(([^)]+)\)\s*$/) || [])[1] || null;
  const say = (msg) => alert(msg);

  /** Strip metadata (GPS, camera, dates) by re-encoding images in the browser before upload. */
  async function stripImage(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
    const bmp = await createImageBitmap(file);
    const cv = document.createElement("canvas");
    cv.width = bmp.width; cv.height = bmp.height;
    cv.getContext("2d").drawImage(bmp, 0, 0);
    const type = file.type === "image/png" ? "image/png" : "image/jpeg";
    return await new Promise((res) => cv.toBlob((b) => res(new File([b], file.name, { type })), type, 0.92));
  }

  // ---------------------------------------------------------------- person page
  W.person = function (c, id) {
    const esc = c.esc, p = c.P[id];
    const host = c.app.querySelector(".wrap");
    const canEdit = c.EDITOR, verb = canEdit ? "Edit" : "Suggest a change";
    host.insertAdjacentHTML("beforeend", `<div class="work-grid">
      <section class="card" id="w-rel"><h2>How are we related?</h2>
        <form class="filters" id="w-rel-f"><input name="to" list="w-people" placeholder="Pick anyone (default: you)" style="flex:1;min-width:200px"><button class="btn">Show</button>
        ${c.ME && c.ACCOUNT && c.ACCOUNT.personId !== id ? `<button type="button" class="btn" id="w-me" title="Link your account to this person">This is me</button>` : ""}</form>
        <div id="w-rel-out" class="small"></div></section>
      <section class="card" id="w-edit"><h2>${verb}</h2>
        <p class="small muted">${canEdit ? "Changes are saved with a reason and appear in the history below; any change can be undone." : "Your suggestion goes to the editors for review."}</p>
        <div class="btn-row" id="w-actions">
          <button class="btn" data-w="event">Add or correct a fact</button>
          <button class="btn" data-w="name">Add a name</button>
          <button class="btn" data-w="sex">Sex</button>
          <button class="btn" data-w="parent">Add a parent</button>
          <button class="btn" data-w="spouse">Add a spouse</button>
          <button class="btn" data-w="child">Add a child</button>
          <button class="btn" data-w="photo">Add a photo or document</button>
          <button class="btn" data-w="merge">Merge a duplicate into this person</button>
          ${canEdit ? `<button class="btn" data-w="review">Review facts</button>` : ""}
        </div>
        <div id="w-form"></div>
        <div id="w-pending"></div>
      </section>
      <section class="card" id="w-comments"><h2>Discussion</h2><div id="w-c-out" class="small"></div>
        <form id="w-c-f" class="filters" style="margin-top:8px"><select name="fid"><option value="">About this person</option>${(p.events || []).filter((e) => e.fid).map((e) => `<option value="${e.fid}">${esc(e.type)} ${esc(e.dateDisplay || e.date || "")}</option>`).join("")}</select>
          <input name="body" placeholder="Add a comment, a memory, a question…" style="flex:1;min-width:200px"><button class="btn">Post</button></form></section>
      <section class="card" id="w-history"><h2>History</h2><div id="w-h-out" class="small"><p class="muted">Loading…</p></div></section>
      ${c.AI && !p.living ? `<section class="card" id="w-ai"><h2>Research with AI</h2>
        <p class="small muted">A cloud research agent searches and reads the web for ${esc(p.name)} and files what it finds as a suggestion for review. It never changes the tree itself.</p>
        <form id="w-ai-f" class="filters"><input name="instructions" placeholder="What should it look for? (optional)" style="flex:1;min-width:220px"><button class="btn primary">Start</button></form>
        <div id="w-ai-out" class="small"></div></section>` : ""}
      <datalist id="w-people">${personOptions(c)}</datalist>
    </div>`);

    // relationships (#15)
    const rel = async (to) => {
      const out = document.getElementById("w-rel-out");
      try {
        const from = to ? id : (c.ACCOUNT && c.ACCOUNT.personId) || c.D.home;
        const target = to || id;
        if (from === target) { out.innerHTML = "<p>That's you.</p>"; return; }
        const r = await c.api("GET", `graph/path?from=${encodeURIComponent(from)}&to=${encodeURIComponent(target)}`);
        const X = window.FamilyPerson;
        out.innerHTML = r.found
          ? `<p><b>${esc(r.label || "")}</b>${r.label ? " · " : ""}${esc(r.sentence || "")}</p>${X ? X.pathChain(c, r, from) : `<p>${[from, ...r.steps.map((s) => s.to)].map((x) => c.plink(x)).join(" → ")}</p>`}${(r.commonAncestors || []).length ? `<p class="muted">Common ancestors: ${r.commonAncestors.map((a) => c.plink(a.id || a)).join(", ")}</p>` : ""}
            ${X && X.highlightPath ? `<button class="linklike" id="w-rel-show">show it in the family graph</button>` : ""}`
          : `<p class="muted">No connection found among the people you can see.</p>`;
        const show = document.getElementById("w-rel-show");
        if (show) show.onclick = () => { X.highlightPath(r); document.getElementById("w-graph").scrollIntoView({ behavior: "smooth", block: "start" }); };
      } catch (e) { out.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
    };
    rel();
    document.getElementById("w-rel-f").onsubmit = (ev) => { ev.preventDefault(); const t = pickId(ev.target.to.value); rel(t); };
    const meBtn = document.getElementById("w-me");
    if (meBtn) meBtn.onclick = async () => { if (!confirm(`Link your account to ${p.name}? Relationships will then be shown relative to them.`)) return; await c.api("PUT", "me/person", { person_id: id }); location.reload(); };

    // pending ops, saved together with a reason. Other tools (photos, findings, fact reviews) add to the same list,
    // and every change is previewed as a diff of the records it will touch before it is saved.
    const pending = [], meta = { resolves: new Set(), reason: "", sources: [] };
    let previewSeq = 0;
    const drawPending = () => {
      const el = document.getElementById("w-pending");
      if (!pending.length) { el.innerHTML = ""; meta.resolves.clear(); meta.reason = ""; meta.sources = []; return; }
      const src0 = meta.sources[0] || {};
      el.innerHTML = `<div class="pending"><h3>${pending.length} change${pending.length > 1 ? "s" : ""} to ${canEdit ? "save" : "suggest"}</h3><ol>${pending.map((o, i) => `<li>${W.opText(c, o)} <button class="linklike" data-undo="${i}">remove</button></li>`).join("")}</ol>
        ${meta.resolves.size ? `<p class="small">Resolves finding ${[...meta.resolves].map((x) => `#${x}`).join(", ")}.</p>` : ""}
        <details open><summary class="small">What will change</summary><div id="w-diff" class="small muted">Working out the differences…</div></details>
        <form id="w-save" class="filters"><input name="reason" required placeholder="Why? What's the evidence?" value="${esc(meta.reason)}" style="flex:2;min-width:220px"><input name="src" placeholder="Source title (optional)" value="${esc(src0.title || "")}" style="flex:1;min-width:160px"><input name="url" placeholder="Link (optional)" value="${esc(src0.url || "")}" style="flex:1;min-width:160px">
        <button class="btn primary">${canEdit ? "Save changes" : "Send suggestion"}</button></form></div>`;
      el.querySelectorAll("[data-undo]").forEach((b) => (b.onclick = () => { pending.splice(+b.dataset.undo, 1); drawPending(); }));
      const seq = ++previewSeq;
      c.api("POST", "edit/preview", { ops: pending }).then((r) => {
        if (seq !== previewSeq) return;
        document.getElementById("w-diff").innerHTML = window.FamilyPerson ? window.FamilyPerson.diffHtml(c, r.touched) : "";
      }).catch((e) => { if (seq === previewSeq) document.getElementById("w-diff").innerHTML = `<span class="sev-error">This can't be applied: ${esc(e.message)}</span>`; });
      el.querySelector("#w-save").onsubmit = async (ev) => {
        ev.preventDefault();
        const f = ev.target;
        const sources = f.src.value || f.url.value ? [{ title: f.src.value || f.url.value, url: f.url.value || undefined }, ...meta.sources.slice(1)] : meta.sources.length ? meta.sources : undefined;
        const resolves = meta.resolves.size ? [...meta.resolves] : undefined;
        try {
          if (canEdit) await c.api("POST", "edit", { reason: f.reason.value, sources, ops: pending, resolves });
          else await c.api("POST", "proposals", { kind: "edit", payload: { reason: f.reason.value, sources, ops: pending, resolves }, rationale: f.reason.value });
          if (!canEdit) say("Thanks. Your suggestion is waiting for an editor.");
          location.reload();
        } catch (e) { say(e.status === 409 ? "Someone else changed this person meanwhile. Reload and try again." : e.message); }
      };
    };
    const add = (o) => { pending.push(o); drawPending(); document.getElementById("w-form").innerHTML = ""; };
    /** Add ops to the pending list (with what they resolve and the evidence), and show the editor where they are. */
    const queue = (ops, m = {}) => {
      pending.push(...ops);
      for (const r of m.resolves || []) meta.resolves.add(r);
      if (m.reason && !meta.reason) meta.reason = m.reason;
      if (m.sources) meta.sources = (m.sources || []).filter((x) => x && (x.title || x.url));
      drawPending();
      document.getElementById("w-pending").scrollIntoView({ behavior: "smooth", block: "center" });
    };
    /** Save one small change right away (editors), or queue it as a suggestion (members). Returns true when done. */
    const change = async (ops, m = {}) => {
      if (!canEdit) { queue(ops, m); return true; }
      try { await c.api("POST", "edit", { reason: m.reason || "Edit", ops }); location.reload(); return true; }
      catch (e) { say(e.message); return false; }
    };
    const form = (html, onsubmit) => {
      const el = document.getElementById("w-form");
      el.innerHTML = `<form class="card sub filters">${html}<button class="btn primary">Add to list</button><button type="button" class="btn" data-cancel>Cancel</button></form>`;
      el.querySelector("[data-cancel]").onclick = () => (el.innerHTML = "");
      el.querySelector("form").onsubmit = (ev) => { ev.preventDefault(); try { onsubmit(ev.target); } catch (e) { say(e.message); } };
    };
    const EVENT_TYPES = ["Birth", "Baptism", "Christening", "Death", "Burial", "Marriage", "Residence", "Occupation", "Census", "Immigration", "Emigration", "Arrival", "Departure", "Naturalization", "Military", "Education", "Religion", "Event"];
    const newPersonFields = `<input name="given" placeholder="Given names"><input name="surname" placeholder="Surname"><select name="sex"><option value="">Sex?</option><option value="M">Male</option><option value="F">Female</option></select><input name="born" placeholder="Born (date)" style="max-width:130px">`;
    const personOrNew = (f, tmp) => {
      const existing = pickId(f.existing && f.existing.value);
      if (existing) return existing;
      if (!f.given.value.trim() && !f.surname.value.trim()) throw new Error("Pick an existing person, or give a name for a new one.");
      pending.push({ op: "person.create", id: tmp, names: [{ given: f.given.value.trim(), surname: f.surname.value.trim() }], sex: f.sex.value || undefined, events: f.born.value ? [{ type: "Birth", date: f.born.value }] : [] });
      return tmp;
    };
    let tmpN = 0;
    const actions = {
      event: () => form(`<select name="fid"><option value="">New fact</option>${(p.events || []).filter((e) => e.fid).map((e) => `<option value="${e.fid}">Correct: ${esc(e.type)} ${esc(e.date || "")} ${esc(e.place || "")}</option>`).join("")}</select>
          <select name="type">${EVENT_TYPES.map((t) => `<option>${t}</option>`).join("")}</select><input name="date" placeholder="Date (e.g. 12 Sep 1891, abt 1890)"><input name="place" placeholder="Place"><input name="value" placeholder="Detail (occupation, etc.)"><input name="note" placeholder="Note"><label class="small"><input type="checkbox" name="remove"> remove this fact</label>`,
        (f) => {
          if (f.fid.value && f.remove.checked) return add({ op: "event.remove", entity: "person", id, fid: f.fid.value });
          const ev = { type: f.type.value, date: f.date.value || undefined, place: f.place.value || undefined, value: f.value.value || undefined, note: f.note.value || undefined };
          if (f.fid.value) { const set = Object.fromEntries(Object.entries(ev).filter(([, v]) => v)); return add({ op: "event.update", entity: "person", id, fid: f.fid.value, set }); }
          add({ op: "event.add", entity: "person", id, event: ev });
        }),
      name: () => form(`<input name="given" placeholder="Given names"><input name="surname" placeholder="Surname"><select name="type"><option value="">Kind</option><option>birth</option><option>married</option><option>also known as</option><option>immigrant</option></select>`,
        (f) => add({ op: "name.add", person: id, name: { given: f.given.value, surname: f.surname.value, type: f.type.value } })),
      sex: () => form(`<select name="sex"><option value="M">Male</option><option value="F">Female</option><option value="U">Unknown</option></select>`, (f) => add({ op: "person.update", id, set: { sex: f.sex.value } })),
      parent: () => form(`<input name="existing" list="w-people" placeholder="Existing person…" style="min-width:220px"> or new: ${newPersonFields}`, (f) => {
        const pid = personOrNew(f, `$n${++tmpN}`);
        const sex = pid.startsWith("$") ? f.sex.value : (c.P[pid] || {}).sex;
        const role = sex === "F" ? "wife" : "husband";
        const fam = (p.famc || [])[0];
        if (fam && !c.F[fam][role]) add({ op: "family.set_spouse", family: fam, role, person: pid });
        else if (fam) throw new Error(`This person already has a ${role === "wife" ? "mother" : "father"} recorded. Correct that first.`);
        else add({ op: "family.create", [role]: pid, children: [id] });
      }),
      spouse: () => form(`<input name="existing" list="w-people" placeholder="Existing person…" style="min-width:220px"> or new: ${newPersonFields}<input name="married" placeholder="Married (date)" style="max-width:140px">`, (f) => {
        const pid = personOrNew(f, `$n${++tmpN}`);
        const meH = p.sex !== "F";
        add({ op: "family.create", husband: meH ? id : pid, wife: meH ? pid : id, events: f.married.value ? [{ type: "Marriage", date: f.married.value }] : [] });
      }),
      child: () => form(`<select name="fam">${(p.fams || []).map((fid) => { const fm = c.F[fid]; const sp = fm.husband === id ? fm.wife : fm.husband; return `<option value="${fid}">with ${esc(sp && c.P[sp] ? c.P[sp].name : "unknown partner")}</option>`; }).join("")}<option value="">with an unknown partner (new family)</option></select>
          <input name="existing" list="w-people" placeholder="Existing person…" style="min-width:220px"> or new: ${newPersonFields}`, (f) => {
        const pid = personOrNew(f, `$n${++tmpN}`);
        if (f.fam.value) add({ op: "family.add_child", family: f.fam.value, person: pid });
        else add({ op: "family.create", [p.sex === "F" ? "wife" : "husband"]: id, children: [pid] });
      }),
      merge: () => form(`<input name="existing" list="w-people" placeholder="The duplicate…" style="min-width:260px" required>`, (f) => {
        const d = pickId(f.existing.value);
        if (!d || d === id) throw new Error("Pick the duplicate person.");
        if (!confirm(`Merge ${c.P[d].name} into ${p.name}? Their names, facts and family links move here, and the duplicate is removed.`)) return;
        add({ op: "person.merge", keep: id, drop: d });
      }),
      review: () => form(`<select name="fid">${(p.events || []).filter((e) => e.fid).map((e) => `<option value="${e.fid}">${esc(e.type)} ${esc(e.date || "")} ${esc(e.place || "")}${e.review ? ` · ${e.review.status}` : ""}</option>`).join("")}</select>
          <select name="status"><option value="verified">Verified</option><option value="disputed">Disputed</option><option value="unverified">Unverified</option></select><input name="note" placeholder="How you checked" style="flex:1"><input name="url" placeholder="Record link (optional)">`,
        (f) => {
          if (f.url.value) pending.push({ op: "citation.add", entity: "person", id, fid: f.fid.value, citation: { url: f.url.value, note: f.note.value || undefined } });
          add({ op: "fact.review", entity: "person", id, fid: f.fid.value, status: f.status.value, note: f.note.value });
        }),
      photo: () => {
        const el = document.getElementById("w-form");
        const TYPES = (window.FamilyPerson && window.FamilyPerson.MEDIA_TYPES) || { photo: "Photo" };
        el.innerHTML = `<form class="card sub filters"><input type="file" name="file" accept="image/jpeg,image/png,image/webp,application/pdf" required><input name="caption" placeholder="Caption: who and what" style="flex:1;min-width:200px">
          <select name="type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select>
          <input name="date" placeholder="Date taken" style="max-width:130px"><input name="place" placeholder="Place" style="max-width:180px">
          <label class="small"><input type="checkbox" name="portrait"> main photo</label><button class="btn primary">Upload</button></form><p class="small muted">Location and camera data are removed from photos in your browser before upload.</p>`;
        el.querySelector("form").onsubmit = async (ev) => {
          ev.preventDefault();
          const f = ev.target, file = await stripImage(f.file.files[0]);
          try {
            const r = await fetch(`api/media/upload?tree=${encodeURIComponent(c.TREE)}&name=${encodeURIComponent(file.name)}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": file.type }, body: file });
            const d = await r.json();
            if (!r.ok) throw new Error(d.error || `Upload failed (${r.status})`);
            add({ op: "media.attach", person: id, file: d.key, caption: f.caption.value || undefined, type: f.type.value || undefined, date: f.date.value || undefined, place: f.place.value || undefined, portrait: f.portrait.checked || undefined });
          } catch (e) { say(e.message); }
        };
      },
    };
    document.querySelectorAll("#w-actions [data-w]").forEach((b) => (b.onclick = () => actions[b.dataset.w]()));

    // cloud research runs for this person
    const aiForm = document.getElementById("w-ai-f");
    if (aiForm) {
      const STATE = { queued: "queued", running: "running", succeeded: "done", failed: "failed", cancelled: "stopped" };
      const loadRuns = async () => {
        try {
          const { runs } = await c.api("GET", `agent/runs?person=${encodeURIComponent(id)}`);
          document.getElementById("w-ai-out").innerHTML = runs.length ? `<ul>${runs.slice(0, 5).map((r) => `<li>${esc(r.created_at.slice(0, 10))} · ${STATE[r.status]}${r.proposals.length ? ` · <a href="#/research/queue">suggestion #${r.proposals.join(", #")}</a>` : ""}${r.error ? ` · <span class="muted">${esc(r.error)}</span>` : ""}</li>`).join("")}</ul><a href="#/research/agents">All runs →</a>` : "";
        } catch (e) { document.getElementById("w-ai-out").textContent = e.message; }
      };
      aiForm.onsubmit = async (ev) => {
        ev.preventDefault();
        try { await c.api("POST", "agent/runs", { person: id, instructions: ev.target.instructions.value || undefined }); ev.target.reset(); loadRuns(); }
        catch (e) { say(e.message); }
      };
      loadRuns();
    }

    // comments (#6)
    const loadComments = async () => {
      const out = document.getElementById("w-c-out");
      try {
        const { comments } = await c.api("GET", `comments?type=person&id=${encodeURIComponent(id)}`);
        const factName = (fid) => { const e = (p.events || []).find((x) => x.fid === fid); return e ? `${e.type} ${e.dateDisplay || e.date || ""}` : fid; };
        out.innerHTML = comments.length ? comments.map((m) => `<div class="comment${m.resolved_at ? " resolved" : ""}"><span class="muted">${esc(c.who(m.author))} · ${esc(m.created_at.slice(0, 10))}${m.fid ? ` · on ${esc(factName(m.fid))}` : ""}</span><div>${esc(m.body)}</div>
          ${!m.resolved_at && (c.EDITOR || (c.ME && m.author === c.ME.principal)) ? `<button class="linklike" data-resolve="${m.id}">resolve</button>` : m.resolved_at ? `<span class="muted">resolved</span>` : ""}</div>`).join("") : `<p class="muted">No comments yet.</p>`;
        out.querySelectorAll("[data-resolve]").forEach((b) => (b.onclick = async () => { await c.api("POST", `comments/${b.dataset.resolve}/resolve`); loadComments(); }));
      } catch (e) { out.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
    };
    document.getElementById("w-c-f").onsubmit = async (ev) => {
      ev.preventDefault();
      try { await c.api("POST", "comments", { type: "person", id, fid: ev.target.fid.value || undefined, body: ev.target.body.value }); ev.target.reset(); loadComments(); } catch (e) { say(e.message); }
    };
    loadComments();

    // history (#5)
    (async () => {
      const out = document.getElementById("w-h-out");
      try {
        const { history } = await c.api("GET", `history?id=${encodeURIComponent(id)}`);
        const OPS = { edit: "edited", revert: "undid a change", resolve: "resolved a finding", dismissed: "kept the tree as is", reopen: "reopened a finding", set: "set the research status", import: "imported" };
        const diffs = (b) => window.FamilyPerson && b.entities.some((e) => e.before !== undefined || e.after !== undefined)
          ? window.FamilyPerson.diffHtml(c, b.entities.map((e) => ({ type: e.type, id: e.id, before: e.before, after: e.after })))
          : `<span class="muted">(${b.entities.map((e) => `${e.change} ${e.type}`).join(", ")})</span>`;
        out.innerHTML = history.length ? `<ul class="history">${history.map((b) => `<li><div><span class="muted">${esc(b.at.slice(0, 16).replace("T", " "))} · ${esc(c.who(b.actor))}${b.on_behalf_of ? ` on behalf of ${esc(c.who(b.on_behalf_of))}` : ""}${b.proposal ? ` · suggestion #${b.proposal}` : ""}</span> <b>${esc(OPS[b.op] || b.op)}</b>${b.reason ? `: ${esc(b.reason)}` : ""}
          ${c.EDITOR && b.batch && b.op !== "revert" && b.op !== "import" ? ` <button class="linklike" data-revert="${b.batch}">undo</button>` : ""}</div>
          <details><summary class="small">details</summary>${diffs(b)}</details></li>`).join("")}</ul>` : `<p class="muted">No changes since the import.</p>`;
        out.querySelectorAll("[data-revert]").forEach((btn) => (btn.onclick = async () => {
          if (!confirm("Undo this change?")) return;
          try { await c.api("POST", `changes/${btn.dataset.revert}/revert`); location.reload(); }
          catch (e) { say(e.status === 409 ? "Later changes touched the same records. Undo those first." : e.message); }
        }));
      } catch (e) { out.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
    })();

    // photos, fact verification, finding remediation and next steps (site/assets/person.js)
    const X = window.FamilyPerson;
    if (X) {
      const ctx = { queue, change, actions };
      c.LIVE = true;
      X.graph(c, id);
      X.photos(c, id, ctx);
      X.facts(c, id, ctx);
      X.findings(c, id, ctx);
      X.todos(c, id, ctx);
    }
  };

  // ---------------------------------------------------------------- admin (#9, owner only)
  W.admin = async function (c, tab = "access") {
    const esc = c.esc;
    const tabs = `<nav class="tabs">${[["access", "Access", "#/admin"], ["audit", "Audit history", "#/admin/audit"]].map(([k, l, h]) => `<a href="${h}" class="${k === tab ? "on" : ""}"${k === tab ? ' aria-current="page"' : ""}>${l}</a>`).join("")}</nav>`;
    if (tab === "audit") {
      c.app.innerHTML = `<div class="wrap page"><h1>Admin</h1>${tabs}<p class="muted">Every change to every tree and to the sharing settings, newest first: who made it (and on whose behalf), what changed and why. Select a row for the full detail.</p><div id="audit"><p class="muted">Loading…</p></div></div>`;
      return W.audit(c, document.getElementById("audit"));
    }
    c.app.innerHTML = `<div class="wrap page"><h1>Admin</h1>${tabs}<p class="muted">Who can see which tree, and how much of it. Signing in happens through Cloudflare Access; a person also needs a grant here, or they see nothing.</p><div id="adm"><p class="muted">Loading…</p></div></div>`;
    const draw = async () => {
      const a = await c.api("GET", "admin");
      const viewOpts = (sel) => `<option value="">Full view</option>${a.views.map((v) => `<option value="${esc(v.id)}"${v.id === sel ? " selected" : ""}>${esc(v.name)}</option>`).join("")}`;
      const treeOpts = a.trees.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
      const members = Object.fromEntries(a.members.map((m) => [m.principal, m]));
      const principals = [...new Set([...a.grants.map((g) => g.principal), ...a.members.map((m) => m.principal)])].sort();
      document.getElementById("adm").innerHTML = `
        <section class="card"><h2>People and access</h2>
          <div class="table-wrap"><table class="data"><thead><tr><th>Who</th><th>Tree</th><th>Role</th><th>View</th><th></th></tr></thead><tbody>
          ${principals.flatMap((pr) => { const gs = a.grants.filter((g) => g.principal === pr); const m = members[pr] || {};
            const label = `${esc(m.display_name || pr)}${m.is_owner ? " <span class='badge st-verified'>owner</span>" : ""}${m.kind === "agent" ? " 🤖" : ""}${m.person_id && c.P[m.person_id] ? `<br><span class="small muted">is ${c.plink(m.person_id)}</span>` : ""}`;
            return gs.length ? gs.map((g) => `<tr><td>${label}</td><td>${esc((a.trees.find((t) => t.id === g.tree_id) || {}).name || g.tree_id)}</td><td>${esc(g.role)}</td>
              <td><select data-view="${esc(pr)}|${esc(g.tree_id)}|${esc(g.role)}">${viewOpts(g.view_id)}</select></td>
              <td><button class="btn" data-revoke="${esc(pr)}|${esc(g.tree_id)}">Remove</button></td></tr>`) : [`<tr><td>${label}</td><td colspan="4" class="muted small">${m.is_owner ? "sees everything" : "no trees"}</td></tr>`]; }).join("")}
          </tbody></table></div>
          <form id="adm-g" class="filters" style="margin-top:12px"><input name="principal" placeholder="Email, or agent:name" required style="min-width:220px"><select name="tree">${treeOpts}</select>
            <select name="role"><option value="member">Member: view, suggest, comment</option><option value="editor">Editor: edit and review</option><option value="agent">Agent: research suggestions only</option></select>
            <select name="view">${viewOpts("")}</select><label class="small"><input type="checkbox" name="invite" checked> add to Access</label><button class="btn primary">Grant</button></form>
          <div id="adm-msg" class="small"></div></section>
        <section class="card"><h2>Views</h2><p class="small muted">A view filters what someone sees. Preview it to check before you share.</p>
          ${a.views.map((v) => `<div class="view-row"><b>${esc(v.name)}</b> <code class="small">${esc(JSON.stringify(v.filter))}</code> <button class="linklike" data-preview="${esc(v.id)}">preview</button> <button class="linklike" data-editview="${esc(v.id)}">edit</button></div>`).join("") || `<p class="muted">No views yet; everyone sees their tree in full.</p>`}
          <form id="adm-v" class="filters" style="margin-top:10px"><input name="id" placeholder="id (e.g. cousins)" required pattern="[a-z0-9-]+"><input name="name" placeholder="Name" required>
            <select name="living"><option value="full">Living: full</option><option value="names-only">Living: names only</option><option value="anonymous">Living: “Living Surname”</option><option value="hidden">Living: hidden</option></select>
            <input name="branches" placeholder="Branches (comma-separated; empty = all)"><input name="max_generations" type="number" min="1" placeholder="Max generations" style="max-width:150px">
            ${["research", "notes", "media", "sources"].map((k) => `<label class="small"><input type="checkbox" name="${k}" checked> ${k}</label>`).join("")}
            <input name="exclude" placeholder="Exclude people (IDs)"><button class="btn primary">Save view</button></form></section>
        <section class="card" id="adm-storage"><h2>Data storage</h2>
          <p class="small muted">The tree is stored as GEDCOM X: people as Persons, families as Couple and Parent–Child relationships, sources as Source Descriptions. A database created before that change can be moved over here, in one step, after a check that every record converts back exactly.</p>
          <div class="btn-row"><button class="btn" id="st-check">Check</button><button class="btn primary" id="st-go" hidden>Move to GEDCOM X storage</button></div><div id="st-out" class="small"></div></section>
        <section class="card"><h2>Trees</h2>
          ${a.trees.map((t) => `<form class="filters tree-def" data-tree="${esc(t.id)}"><b style="min-width:160px">${esc(t.name)}</b><input name="name" value="${esc(t.name)}"><textarea name="def" rows="2" style="flex:1;min-width:260px;font-family:monospace;font-size:.8rem">${esc(JSON.stringify(t.definition))}</textarea><button class="btn">Save</button></form>`).join("")}
          <p class="small muted">A tree is <code>{"branches": ["*"] or [keys], "include": [ids], "exclude": [ids], "root": id}</code>. Branch keys: ${(c.R.branches || []).map((b) => `<code>${esc(b.key)}</code>`).join(" ")}</p></section>`;
      const msg = (t) => (document.getElementById("adm-msg").innerHTML = t);
      const stOut = document.getElementById("st-out"), stGo = document.getElementById("st-go");
      const stReport = (r) => r.report.already ? "Stored as GEDCOM X." : `${!r.report.ok ? "<b>Not safe to move</b>" : r.report.dryRun ? "Ready to move" : "Moved"}: ${r.report.persons} people, ${r.report.families} families → ${r.report.relationships} relationships (${Object.entries(r.report.relationshipTypes || {}).map(([k, v]) => `${v} ${esc(k)}`).join(", ")}), ${r.report.sourceDescriptions} sources and media.${(r.report.mismatched || []).length ? ` These wouldn't convert back exactly: ${r.report.mismatched.map(esc).join(", ")}` : ""}`;
      document.getElementById("st-check").onclick = async () => {
        try { const r = await c.api("POST", "admin/storage", { dry_run: true }); stOut.innerHTML = stReport(r); stGo.hidden = !(r.report.ok && !r.report.already); }
        catch (e) { stOut.textContent = e.message; }
      };
      stGo.onclick = async () => {
        if (!confirm("Move the tree to GEDCOM X storage now? It runs as one transaction; D1 Time Travel can restore the previous state.")) return;
        try { const r = await c.api("POST", "admin/storage", { dry_run: false }); stOut.innerHTML = stReport(r); stGo.hidden = true; }
        catch (e) { stOut.textContent = e.message; }
      };
      document.getElementById("adm-g").onsubmit = async (ev) => {
        ev.preventDefault(); const f = ev.target;
        try {
          if (f.principal.value.startsWith("agent:")) await c.api("PUT", `admin/members/${encodeURIComponent(f.principal.value)}`, { kind: "agent", display_name: f.principal.value });
          const r = await c.api("PUT", "admin/grants", { principal: f.principal.value, tree_id: f.tree.value, role: f.role.value, view_id: f.view.value || null, invite: f.invite.checked });
          await draw();
          if (r.access && r.access.todo) msg(`Granted. <b>One more step:</b> ${esc(r.access.todo)}`);
          else if (r.access && r.access.automated) msg(r.access.ok ? "Granted and added to Access." : `Granted, but Access wasn't updated: ${esc(r.access.error || "")}`);
        } catch (e) { say(e.message); }
      };
      document.querySelectorAll("[data-revoke]").forEach((b) => (b.onclick = async () => {
        const [principal, tree_id] = b.dataset.revoke.split("|");
        if (!confirm(`Remove ${principal}'s access to this tree?`)) return;
        const r = await c.api("DELETE", `admin/grants?principal=${encodeURIComponent(principal)}&tree_id=${encodeURIComponent(tree_id)}&revoke_access=1`);
        await draw();
        if (r.access && r.access.todo) msg(esc(r.access.todo));
      }));
      document.querySelectorAll("[data-view]").forEach((s) => (s.onchange = async () => {
        const [principal, tree_id, role] = s.dataset.view.split("|");
        await c.api("PUT", "admin/grants", { principal, tree_id, role, view_id: s.value || null });
      }));
      document.querySelectorAll("[data-preview]").forEach((b) => (b.onclick = () => { try { sessionStorage.setItem("previewView", b.dataset.preview); } catch {} location.hash = "#/"; location.reload(); }));
      document.querySelectorAll("[data-editview]").forEach((b) => (b.onclick = () => {
        const v = a.views.find((x) => x.id === b.dataset.editview), f = document.getElementById("adm-v");
        f.id.value = v.id; f.name.value = v.name; f.living.value = v.filter.living || "full";
        f.branches.value = (v.filter.branches || []).join(", "); f.max_generations.value = v.filter.max_generations || "";
        for (const k of ["research", "notes", "media", "sources"]) f[k].checked = v.filter[k] !== false;
        f.exclude.value = (v.filter.exclude_people || []).join(", ");
      }));
      document.getElementById("adm-v").onsubmit = async (ev) => {
        ev.preventDefault(); const f = ev.target, list = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);
        const filter = { living: f.living.value, research: f.research.checked, notes: f.notes.checked, media: f.media.checked, sources: f.sources.checked };
        if (list(f.branches.value).length) filter.branches = list(f.branches.value);
        if (f.max_generations.value) filter.max_generations = +f.max_generations.value;
        if (list(f.exclude.value).length) filter.exclude_people = list(f.exclude.value);
        try { await c.api("PUT", `admin/views/${encodeURIComponent(f.id.value)}`, { name: f.name.value, filter }); await draw(); } catch (e) { say(e.message); }
      };
      document.querySelectorAll("form.tree-def").forEach((f) => (f.onsubmit = async (ev) => {
        ev.preventDefault();
        let def; try { def = JSON.parse(f.def.value); } catch { return say("The definition isn't valid JSON."); }
        try { await c.api("PUT", `admin/trees/${encodeURIComponent(f.dataset.tree)}`, { name: f.name.value, definition: def }); await draw(); } catch (e) { say(e.message); }
      }));
    };
    try { await draw(); } catch (e) { document.getElementById("adm").innerHTML = `<p>${esc(e.message)}</p>`; }
  };

  // ---------------------------------------------------------------- audit history (owner only)
  const AUDIT_OPS = { edit: "Edit", revert: "Undo", import: "Import", "storage-upgrade": "Storage move", resolve: "Finding resolved", resolved: "Finding resolved", dismissed: "Finding dismissed", reopen: "Finding reopened",
    create: "Created", update: "Updated", put: "Set", delete: "Removed", set: "Status set", revise: "Story revised", approve: "Approved", reject: "Rejected", withdraw: "Withdrawn" };
  const AUDIT_TYPES = { person: ["person", "people"], family: ["family", "families"], source: ["source", "sources"], config: ["setting", "settings"], media: ["photo", "photos"], todo: ["to-do", "to-dos"], finding: ["finding", "findings"],
    proposal: ["suggestion", "suggestions"], story: ["story", "stories"], status: ["status", "statuses"], grant: ["grant", "grants"], view: ["view", "views"], tree: ["tree", "trees"], member: ["member", "members"], comment: ["comment", "comments"] };
  const typeName = (t, n) => { const x = AUDIT_TYPES[t] || [t, `${t}s`]; return n === 1 ? x[0] : x[1]; };

  W.audit = function (c, el) {
    const esc = c.esc, P = c.P;
    const state = { actor: "", type: "", q: "", rows: [], next: null, actors: [], types: [] };
    const fmt = (iso) => (iso ? iso.slice(0, 16).replace("T", " ") : "");
    const who = (x) => esc(c.who(x));
    const entityLink = (e) => {
      const name = e.label ? esc(e.label) : esc(e.id);
      if (e.type === "person" && P[e.id]) return c.plink(e.id, e.label || undefined);
      if (e.type === "story") return `<a href="#/story/${esc(e.id)}">${name}</a>`;
      return name;
    };
    function summary(b) {
      const parts = Object.entries(b.types).map(([t, n]) => `${n} ${typeName(t, n)}`);
      const names = b.entities.filter((e) => e.label || ["person", "family", "story", "grant", "tree", "view"].includes(e.type)).slice(0, 4).map(entityLink);
      return `<span class="badge">${esc(AUDIT_OPS[b.op] || b.op)}</span> ${esc(parts.join(", "))}${names.length ? `<br><span class="small">${names.join(", ")}${b.count > names.length ? ", …" : ""}</span>` : ""}`;
    }
    const row = (b) => `<tr class="audit-row" data-key="${esc(b.key)}" tabindex="0" aria-expanded="false">
      <td class="small nowrap">${esc(fmt(b.at))}</td>
      <td class="small">${who(b.actor)}${b.on_behalf_of ? `<br><span class="muted">for ${who(b.on_behalf_of)}</span>` : ""}</td>
      <td>${summary(b)}</td>
      <td class="small">${esc((b.reason || "").slice(0, 160))}${(b.reason || "").length > 160 ? "…" : ""}</td>
      <td class="small muted audit-caret" aria-hidden="true">▸</td></tr>`;
    function draw() {
      el.innerHTML = `<form class="filters" id="au-f">
          <select name="actor" aria-label="Who"><option value="">Anyone</option>${state.actors.map((a) => `<option value="${esc(a.v)}"${a.v === state.actor ? " selected" : ""}>${esc(c.who(a.v))} (${a.n})</option>`).join("")}</select>
          <select name="type" aria-label="What"><option value="">Any record</option>${state.types.map((t) => `<option value="${esc(t.v)}"${t.v === state.type ? " selected" : ""}>${esc(typeName(t.v, 2))} (${t.n})</option>`).join("")}</select>
          <input name="q" type="search" placeholder="Search reasons, ids, edit ids" value="${esc(state.q)}" style="flex:1;min-width:180px"><button class="btn">Filter</button></form>
        ${state.rows.length ? `<div class="table-wrap"><table class="data audit"><thead><tr><th>When (UTC)</th><th>Who</th><th>What</th><th>Why</th><th></th></tr></thead><tbody>${state.rows.map(row).join("")}</tbody></table></div>` : `<div class="empty">No changes match.</div>`}
        ${state.next ? `<p><button class="btn" id="au-more">Load older changes</button></p>` : ""}`;
      el.querySelector("#au-f").onsubmit = (ev) => { ev.preventDefault(); const f = ev.target; state.actor = f.actor.value; state.type = f.type.value; state.q = f.q.value.trim(); load(true); };
      const more = el.querySelector("#au-more");
      if (more) more.onclick = () => load(false);
      el.querySelectorAll(".audit-row").forEach((tr) => {
        tr.onclick = (ev) => { if (!ev.target.closest("a")) toggle(tr); };
        tr.onkeydown = (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(tr); } };
      });
    }
    async function load(reset) {
      const qs = new URLSearchParams({ limit: "40" });
      if (state.actor) qs.set("actor", state.actor);
      if (state.type) qs.set("type", state.type);
      if (state.q) qs.set("q", state.q);
      if (!reset && state.next) qs.set("before", String(state.next));
      try {
        const r = await c.api("GET", `admin/audit?${qs}`);
        if (r.actors) state.actors = r.actors;
        if (r.types) state.types = r.types;
        state.rows = reset ? r.batches : [...state.rows, ...r.batches];
        state.next = r.next;
        draw();
      } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
    }

    // ---- one batch in full
    const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s == null ? "—" : s.length > 140 ? s.slice(0, 137) + "…" : s; };
    function fieldDiff(a, b) {
      if (a == null || b == null || typeof a !== "object" || typeof b !== "object") return "";
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
      return keys.length ? `<ul class="diff-fields">${keys.map((k) => `<li><b>${esc(k)}</b>: <span class="d-from">${esc(short(a[k]))}</span> → <span class="d-to">${esc(short(b[k]))}</span></li>`).join("")}</ul>` : "";
    }
    function rowDetail(r) {
      const X = window.FamilyPerson;
      const label = r.type === "person" && P[r.entity] ? c.plink(r.entity) : esc(r.entity);
      let body = "";
      if (X && ["person", "family", "source", "media", "finding", "status"].includes(r.type)) {
        try { body = X.diffHtml(c, [{ type: r.type, id: r.entity, before: r.before, after: r.after }]); } catch { body = ""; }
      }
      if (!body || /No visible differences/.test(body)) body = (r.change === "updated" ? fieldDiff(r.before, r.after) : "") || body;
      const raw = `<details class="small"><summary>Stored values</summary><div class="audit-raw"><div><b>Before</b><pre>${esc(JSON.stringify(r.before, null, 1) || "—")}</pre></div><div><b>After</b><pre>${esc(JSON.stringify(r.after, null, 1) || "—")}</pre></div></div></details>`;
      return `<div class="audit-entity"><div class="small"><b>${esc(typeName(r.type, 1))}</b> ${label} · ${esc(r.change)}${r.op !== "edit" ? ` (${esc(AUDIT_OPS[r.op] || r.op)})` : ""}${r.version_after ? ` · version ${esc(r.version_after)}` : ""}</div>${body}${raw}</div>`;
    }
    function detailHtml(d) {
      const first = d.rows[0];
      const sources = first.sources || d.rows.find((r) => r.sources) && d.rows.find((r) => r.sources).sources;
      const reasons = [...new Set(d.rows.map((r) => r.reason).filter(Boolean))];
      const undoable = d.batch && !d.rows.some((r) => r.op === "revert") && d.rows.some((r) => ["person", "family", "source", "config", "finding"].includes(r.type));
      return `<div class="audit-detail">
        <dl class="audit-meta small">
          <dt>When</dt><dd>${esc(fmt(first.at))} UTC</dd>
          <dt>Who</dt><dd>${who(first.actor)}${first.actor_kind === "agent" ? " (agent)" : ""}${first.on_behalf_of ? `, on behalf of ${who(first.on_behalf_of)}` : ""}</dd>
          ${first.via ? `<dt>Via</dt><dd>${/^run-/.test(first.via) ? `<a href="#/research/agents">agent run ${esc(first.via)}</a>` : esc(first.via)}</dd>` : ""}
          ${d.batch ? `<dt>Edit id</dt><dd><code>${esc(d.batch)}</code></dd>` : ""}
          ${reasons.length ? `<dt>Why</dt><dd>${reasons.map(esc).join("<br>")}</dd>` : ""}
          ${(sources || []).length ? `<dt>Sources</dt><dd>${sources.map((s) => s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a>` : esc(s.title || "")).join("; ")}</dd>` : ""}
          ${d.proposals.map((p) => `<dt>Suggestion</dt><dd><a href="#/research/queue">#${esc(p.id)}</a> (${esc(p.kind)}) by ${who(p.author)}, ${esc(p.status)}${p.reviewed_by ? ` by ${who(p.reviewed_by)}` : ""}${p.rationale ? `<br><span class="muted">${esc(p.rationale.slice(0, 300))}</span>` : ""}</dd>`).join("")}
          ${d.runs.map((r) => `<dt>Run</dt><dd>${esc(r.kind || "research")} run started by ${who(r.started_by)}${r.instructions ? `: ${esc(r.instructions)}` : ""} (${esc(r.status)})</dd>`).join("")}
        </dl>
        <div>${d.rows.map(rowDetail).join("")}</div>
        ${undoable ? `<p><button class="btn" data-undo="${esc(d.batch)}">Undo this change</button> <span class="small muted">Records changed since then can't be undone this way.</span></p>` : ""}</div>`;
    }
    async function toggle(tr) {
      const next = tr.nextElementSibling;
      const caret = tr.querySelector(".audit-caret");
      if (next && next.classList.contains("audit-detail-row")) { next.remove(); tr.setAttribute("aria-expanded", "false"); tr.classList.remove("open"); caret.textContent = "▸"; return; }
      tr.setAttribute("aria-expanded", "true"); tr.classList.add("open"); caret.textContent = "▾";
      const d = document.createElement("tr");
      d.className = "audit-detail-row";
      d.innerHTML = `<td colspan="5"><p class="small muted">Loading…</p></td>`;
      tr.after(d);
      try {
        const r = await c.api("GET", `admin/audit/${encodeURIComponent(tr.dataset.key)}`);
        d.firstElementChild.innerHTML = detailHtml(r);
        const u = d.querySelector("[data-undo]");
        if (u) u.onclick = async () => {
          if (!confirm("Undo this change? The records go back to how they were before it; the undo is itself logged.")) return;
          try { await c.api("POST", `changes/${encodeURIComponent(u.dataset.undo)}/revert`, {}); u.replaceWith(Object.assign(document.createElement("span"), { className: "small", textContent: "Undone. Reload to see the tree as it is now." })); load(true); }
          catch (e) { alert(e.message); }
        };
      } catch (e) { d.firstElementChild.innerHTML = `<p class="small">${esc(e.message)}</p>`; }
    }
    load(true);
  };
})();
