// Static MCP App resource. The host supplies the tool result over the MCP Apps bridge.
import { S } from "../strings/index.ts";

const L = S.api.mcp.cards;

// Keep the sandbox script self-contained when Wrangler bundles the Worker.
const cardScript = String.raw`
function mountCards(labels) {
  const root = document.querySelector("main");
  let requestId = 1;
  let hostOrigin = "*";
  let hostOpensLinks = false;
  const send = (method, params, id) => parent.postMessage({ jsonrpc: "2.0", method, params, id }, hostOrigin);
  const resize = () => send("ui/notifications/size-changed", {
    width: document.documentElement.clientWidth,
    height: Math.ceil(root.getBoundingClientRect().height),
  });
  const element = (tag, text) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    return node;
  };
  const status = (text) => root.replaceChildren(element("p", text));
  let shown = false; // a result (or cancellation) has been drawn
  function render(result) {
    shown = true;
    if (result?.isError) return status(result.content?.[0]?.text || labels.failed);
    const cards = result?.structuredContent?.cards;
    if (!cards?.length) return status(labels.empty);
    const image = result.content?.find((item) => item.type === "image" && /^image\/(jpeg|png|webp|gif)$/.test(item.mimeType));
    root.replaceChildren(...cards.map((card, index) => {
      const article = element("article");
      article.append(element("h2", card.title || labels.title));
      if (card.summary) article.append(element("p", card.summary));
      if (!index && image) {
        const img = element("img");
        img.alt = card.title || labels.photo;
        img.src = "data:" + image.mimeType + ";base64," + image.data;
        article.append(img);
      }
      if (card.detail) article.append(element("p", card.detail));
      if (/^https?:\/\//.test(card.page_url || "")) {
        const open = element("a", labels.open);
        open.href = card.page_url;
        open.target = "_blank";
        open.rel = "noopener noreferrer";
        // Checked at click time: a result can arrive before the initialize answer that says whether the host opens links.
        open.addEventListener("click", (event) => {
          if (!hostOpensLinks) return;
          event.preventDefault();
          send("ui/open-link", { url: card.page_url }, ++requestId);
        });
        article.append(open);
      }
      return article;
    }));
  }

  let active = false;
  const observer = new ResizeObserver(() => { if (active) resize(); });
  observer.observe(root);
  addEventListener("message", (event) => {
    if (event.source !== parent || (hostOrigin !== "*" && hostOrigin !== event.origin) || event.data?.jsonrpc !== "2.0") return;
    const message = event.data;
    // Any answer to ui/initialize starts the card, an error too (e.g. a host that doesn't know this protocol version):
    // waiting for a result that never comes would leave "Loading" up for good.
    if (message.id === 1 && ("result" in message || "error" in message) && !message.method && !active) {
      hostOrigin = event.origin === "null" ? "*" : event.origin;
      hostOpensLinks = Boolean(message.result?.hostCapabilities?.openLinks);
      active = true;
      send("ui/notifications/initialized", {});
      resize();
    } else if (message.method === "ui/notifications/tool-result") { render(message.params); resize(); } // even if it beats the handshake
    else if (message.method === "ui/notifications/tool-cancelled") { shown = true; status(labels.cancelled); resize(); }
    else if (active && message.method === "ping") parent.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, hostOrigin);
    else if (active && message.method === "ui/resource-teardown") {
      active = false;
      observer.disconnect();
      root.replaceChildren();
      parent.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, hostOrigin);
    }
  });
  status(labels.loading);
  // Some hosts show the card but never send the result (for example when it scrolls into view after the call). Say
  // so instead of loading forever; the records are in the reply text either way.
  setTimeout(() => { if (!shown) { status(labels.unavailable); resize(); } }, 8000);
  send("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "family-tree-records", version: "1.0.0" }, appCapabilities: { availableDisplayModes: ["inline"] } }, 1);
}
`;

export const cardHtml = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:">
<style>
:root { color-scheme: light dark; font-family: system-ui, sans-serif; color: CanvasText; }
body { margin: 0; }
main { box-sizing: border-box; display: grid; gap: .55rem; max-height: 32rem; overflow-y: auto; padding: .15rem; }
article { border: 1px solid color-mix(in srgb, CanvasText 20%, Canvas); padding: .75rem .9rem; border-radius: .65rem; overflow-wrap: anywhere; }
h2 { font-size: 1rem; margin: 0; }
p { font-size: .9rem; line-height: 1.5; margin: .4rem 0; white-space: pre-wrap; }
img { display: block; max-width: 100%; max-height: 14rem; margin: .5rem 0; object-fit: contain; }
a { display: inline-block; font: inherit; font-size: .85rem; color: LinkText; background: Canvas; border: 1px solid currentColor; border-radius: .45rem; cursor: pointer; margin-top: .4rem; padding: .35rem .6rem; }
a:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
</style>
<main aria-live="polite"></main>
<script>${cardScript}
mountCards(${JSON.stringify(L)});</script>
</html>`;

// The card's address carries a hash of its HTML: clients may keep a card by its address, so a changed card gets a new
// one and is fetched again instead of an old copy being shown (an old copy without the "didn't load" timeout stays on
// "Loading records…" for good).
const hash = (text) => { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193); return (h >>> 0).toString(36); };
export const cardResource = {
  uri: `ui://family-tree/records-${hash(cardHtml)}.html`,
  name: "family-tree-records",
  title: L.title,
  mimeType: "text/html;profile=mcp-app",
};
export const isCardUri = (uri) => /^ui:\/\/family-tree\/records(-[a-z0-9]+)?\.html$/.test(String(uri || ""));
