/* The page assistant: a chat panel on every page, for editors when the agents Worker is set up.
   Each message carries the page you're on. The assistant drafts changes; each one shows here as a card with exactly
   what would change, and nothing happens until you press Apply. Holds no family data: everything comes from /api. */
(function () {
  "use strict";
  const X = (window.FamilyChat = {});
  const POLL_MS = 1000;

  X.mount = function (c) {
    const { esc, api, TREE, P } = c;
    const key = `chat:${TREE || ""}`;
    const store = {
      get: (k, s = localStorage) => { try { return s.getItem(k); } catch { return null; } },
      set: (k, v, s = localStorage) => { try { v == null ? s.removeItem(k) : s.setItem(k, v); } catch {} },
    };
    let chatId = store.get(key), state = { messages: [], changes: [], busy: false }, timer = null, sending = false;
    const previews = {};

    const fab = document.createElement("button");
    fab.className = "chat-fab";
    fab.type = "button";
    fab.setAttribute("aria-label", "Ask the assistant");
    fab.innerHTML = `<span aria-hidden="true">✦</span> Ask`;
    const panel = document.createElement("section");
    panel.className = "chat-panel";
    panel.setAttribute("aria-label", "Assistant");
    panel.hidden = true;
    panel.innerHTML = `
      <header class="chat-head">
        <b>Assistant</b>
        <span class="small muted chat-where"></span>
        <button type="button" class="icon-btn chat-new" title="Start a new conversation">New</button>
        <button type="button" class="icon-btn chat-close" aria-label="Close">✕</button>
      </header>
      <div class="chat-log" aria-live="polite"></div>
      <form class="chat-form">
        <textarea name="text" rows="2" placeholder="Ask about this page, or describe a change…" aria-label="Message"></textarea>
        <div class="chat-actions">
          <span class="small muted">Changes wait for your OK.</span>
          <button type="button" class="btn chat-stop" hidden>Stop</button>
          <button class="btn primary chat-send">Send</button>
        </div>
      </form>`;
    document.body.append(fab, panel);
    const log = panel.querySelector(".chat-log"), form = panel.querySelector("form"), ta = form.text;
    const sendBtn = panel.querySelector(".chat-send"), stopBtn = panel.querySelector(".chat-stop");

    // ---------------------------------------------------------------- page context
    function page() {
      const app = document.getElementById("app");
      return { path: location.hash.replace(/^#\/?/, ""), title: document.title, text: app ? app.innerText.slice(0, 4000) : "" };
    }
    function where() {
      const m = location.hash.match(/^#\/(person|tree)\/([^/?]+)/);
      const p = m && P[decodeURIComponent(m[2])];
      panel.querySelector(".chat-where").textContent = p ? `· on ${p.name}` : "";
    }

    // ---------------------------------------------------------------- rendering
    const linkIds = (html) => html.replace(/\b(I\d+)\b/g, (m) => (P[m] ? `<a href="#/person/${m}">${m}</a>` : m));
    function md(text) {
      const blocks = esc(text).split(/\n{2,}/).map((b) => {
        const lines = b.split("\n");
        if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${l.replace(/^\s*([-*]|\d+\.)\s+/, "")}</li>`).join("")}</ul>`;
        return `<p>${lines.join("<br>")}</p>`;
      }).join("");
      return linkIds(blocks.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>").replace(/`([^`]+)`/g, "<code>$1</code>"));
    }
    const TOOL = { get_person: "Read", search_people: "Searched for", relationship_path: "Traced", person_history: "Read the history of", propose_change: "Drafted a change" };

    function changeCard(ch) {
      if (!ch) return "";
      const st = ch.status;
      const head = { pending: "Proposed change", applied: "Applied", dismissed: "Dismissed", superseded: "Replaced by a newer draft", failed: "Couldn't apply", undone: "Undone" }[st] || st;
      const src = (ch.sources || []).map((s) => s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a>` : esc(s.title)).join(" · ");
      let actions = "";
      if (st === "pending") actions = `<div class="btn-row"><button class="btn primary" data-apply="${ch.id}">Apply</button><button class="btn" data-dismiss="${ch.id}">Dismiss</button></div>`;
      else if (st === "applied") actions = `<div class="btn-row"><button class="btn" data-undo="${ch.id}">Undo</button></div>`;
      return `<div class="chat-change st-${esc(st)}" data-change="${ch.id}">
        <div class="small chat-change-head"><b>${esc(head)}</b> <span class="muted">#${ch.id}</span></div>
        <div class="chat-change-sum">${linkIds(esc(ch.summary))}</div>
        <div class="small muted">Why: ${linkIds(esc(ch.reason))}${src ? `<br>Source: ${src}` : ""}</div>
        ${st === "pending" ? `<div class="chat-diff small">${previews[ch.id] || '<span class="muted">Working out what would change…</span>'}</div>` : ""}
        ${ch.error ? `<div class="small sev-error">${esc(ch.error)}</div>` : ""}
        ${actions}</div>`;
    }

    function render() {
      const shown = new Set();
      const byId = Object.fromEntries(state.changes.map((x) => [x.id, x]));
      let html = state.messages.map((m) => {
        if (m.role === "user") return `<div class="chat-msg me">${md(m.text)}</div>`;
        if (m.role === "notice") return `<div class="chat-note small muted">${esc(m.text)}</div>`;
        return m.parts.map((p) => {
          if (p.type === "text") return `<div class="chat-msg bot">${md(p.text)}</div>`;
          if (p.change) { shown.add(p.change); return changeCard(byId[p.change]); }
          return `<div class="chat-tool small muted">${p.state === "running" ? "…" : p.state === "error" ? "⚠" : "·"} ${esc(TOOL[p.tool] || p.tool)}${p.about ? ` ${linkIds(esc(p.about))}` : ""}</div>`;
        }).join("");
      }).join("");
      // drafts whose message has scrolled out of the window still need an answer
      html += state.changes.filter((x) => !shown.has(x.id) && x.status === "pending").map(changeCard).join("");
      if (state.busy) html += `<div class="chat-typing small muted" aria-label="The assistant is replying"><span></span><span></span><span></span></div>`;
      if (!html) html = `<div class="chat-empty small muted"><p>Ask about the page you're on, or describe something that needs updating. For example:</p>
        <ul><li>“What do we know about this person's parents?”</li><li>“She was a schoolteacher from about 1920; add that.”</li><li>“Make the second photo the main one.”</li></ul>
        <p>The assistant drafts changes; you check each one and press Apply.</p></div>`;
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
      log.innerHTML = html;
      if (atBottom || sending) log.scrollTop = log.scrollHeight;
      sendBtn.hidden = state.busy; stopBtn.hidden = !state.busy;
      for (const ch of state.changes) if (ch.status === "pending" && !(ch.id in previews)) preview(ch);
    }

    async function preview(ch) {
      previews[ch.id] = null;
      try {
        const r = await api("POST", "edit/preview", { ops: ch.ops });
        previews[ch.id] = window.FamilyPerson ? window.FamilyPerson.diffHtml(c, r.touched) : "";
      } catch (e) {
        const ops = window.FamilyWork && window.FamilyWork.opText ? `<ol>${ch.ops.map((o) => `<li>${window.FamilyWork.opText(c, o)}</li>`).join("")}</ol>` : "";
        previews[ch.id] = `<span class="sev-error">This can't be applied as it stands: ${esc(e.message)}</span>${ops}`;
      }
      const el = log.querySelector(`[data-change="${ch.id}"] .chat-diff`);
      if (el) el.innerHTML = previews[ch.id];
    }

    // ---------------------------------------------------------------- talking to the server
    async function load() {
      clearTimeout(timer);
      if (!chatId) { state = { messages: [], changes: [], busy: false }; render(); return; }
      try {
        const r = await api("GET", `chat/${chatId}`);
        // never let a reply that went missing wipe what the editor just sent
        const lost = !r.busy && state.messages.length > r.messages.length && !r.messages.some((m) => m.role !== "user");
        state = { messages: lost ? [...state.messages.filter((m) => m.role === "user"), { role: "notice", text: "The assistant didn't reply. Try again in a moment." }] : r.messages, changes: r.changes, busy: r.busy };
      } catch (e) {
        if (e.status === 404 || e.status === 403) { chatId = null; store.set(key, null); state = { messages: [], changes: [], busy: false }; }
        else state.messages = [...state.messages, { role: "notice", text: `Couldn't reach the assistant: ${e.message}` }];
      }
      render();
      if (state.busy && !panel.hidden) timer = setTimeout(load, POLL_MS);
    }

    async function send(text) {
      sending = true;
      try {
        if (!chatId) { chatId = (await api("POST", "chat", {})).chat.id; store.set(key, chatId); }
        state.messages = [...state.messages, { role: "user", text }];
        state.busy = true;
        render();
        await api("POST", `chat/${chatId}/messages`, { text, page: page() });
        ta.value = "";
        store.set(`${key}:draft`, null, sessionStorage);
      } catch (e) {
        state.busy = false;
        state.messages = [...state.messages, { role: "notice", text: e.message }];
        render();
        return;
      } finally { sending = false; }
      timer = setTimeout(load, 400);
    }

    async function decide(id, action) {
      const btns = log.querySelectorAll(`[data-change="${id}"] button`);
      btns.forEach((b) => (b.disabled = true));
      try {
        await api("POST", `chat/changes/${id}/${action}`, {});
        // the page's data was loaded before the change: reload it to show the result (the panel reopens as it was)
        if (action !== "dismiss") { location.reload(); return; }
      } catch (e) {
        state.messages = [...state.messages, { role: "notice", text: e.message }];
      }
      await load();
      // the outcome goes to the assistant, which replies briefly: look again once its reply has started
      setTimeout(load, 1500);
    }

    // ---------------------------------------------------------------- wiring
    function open(on) {
      panel.hidden = !on; fab.hidden = on;
      store.set("chat:open", on ? "1" : null, sessionStorage);
      if (on) { ta.focus(); where(); load(); } else clearTimeout(timer);
    }
    fab.onclick = () => open(true);
    panel.querySelector(".chat-close").onclick = () => open(false);
    panel.querySelector(".chat-new").onclick = () => { chatId = null; store.set(key, null); load(); ta.focus(); };
    stopBtn.onclick = () => chatId && api("POST", `chat/${chatId}/abort`, {}).then(load, load);
    form.onsubmit = (ev) => {
      ev.preventDefault();
      const text = ta.value.trim();
      if (text && !state.busy && !sending) send(text);
    };
    ta.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); form.requestSubmit(); }
      if (ev.key === "Escape") open(false);
    });
    ta.addEventListener("input", () => store.set(`${key}:draft`, ta.value || null, sessionStorage));
    log.addEventListener("click", (ev) => {
      const b = ev.target.closest("button");
      if (!b) return;
      if (b.dataset.apply) decide(b.dataset.apply, "apply");
      else if (b.dataset.dismiss) decide(b.dataset.dismiss, "dismiss");
      else if (b.dataset.undo) decide(b.dataset.undo, "undo");
    });
    window.addEventListener("hashchange", where);
    ta.value = store.get(`${key}:draft`, sessionStorage) || "";
    if (store.get("chat:open", sessionStorage)) open(true);
  };
})();
