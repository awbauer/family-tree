// One-time upload links. MCP tools can only take a file as base64 text inside the tool call, which the AI has to
// write out in full (about 1.4 million characters per MB): fine for a few kilobytes, hopeless for a scan or a photo.
// get_upload_link (worker/mcp.js) creates a slot here instead and returns a link; the AI sends the file to it from its
// own workspace with one PUT (`curl -T file '<link>'`), and the upload goes through the site's own routes as the
// member who asked, exactly as if it had come through add_attachment or upload_media.
//
// /upload/* has to be reachable without a Cloudflare Access sign-in (a Bypass application on that path), because a
// command-line tool in the AI's workspace has no Access session. The token is the credential: 32 random bytes, only
// its hash stored, good for one upload within SLOT_MINUTES, and the member's access is checked again when it's used.
import { S } from "../strings/index.ts";
import { now } from "./db.js";
import { FILE_LIMIT } from "./documents.ts";
import { stripImageMetadata } from "./image-meta.js";
import { sniffType } from "./media-types.js";
export { sniffType };

const L = S.api.uploadLinks;
export const SLOT_MINUTES = 15;
const MAX_OPEN = 50; // unused, unexpired links per member
export const isUploadPath = (p) => /^\/upload\/[\w-]{20,}$/.test(p);

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const hash = async (token) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
const json = (body, status) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

/** A new slot for `principal` in `tree`; returns the link and when it expires. */
export async function createSlot(env, origin, { principal, tree, kind, params }) {
  const t = now();
  const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM upload_slots WHERE principal = ? AND used_at IS NULL AND expires_at > ?").bind(principal, t).first();
  if (open && open.n >= MAX_OPEN) return { error: L.tooManyOpen(MAX_OPEN) };
  const token = new Uint8Array(32);
  crypto.getRandomValues(token);
  const text = token.toBase64({ alphabet: "base64url", omitPadding: true });
  const expires = new Date(Date.now() + SLOT_MINUTES * 60_000).toISOString();
  await env.DB.prepare("DELETE FROM upload_slots WHERE expires_at < ?").bind(new Date(Date.now() - 86_400_000).toISOString()).run();
  await env.DB.prepare("INSERT INTO upload_slots (token_hash, principal, tree_id, kind, params, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(await hash(text), principal, tree, kind, JSON.stringify(params), t, expires).run();
  return { url: `${origin}/upload/${text}`, expires_at: expires };
}

async function readBody(request) {
  if (Number(request.headers.get("Content-Length")) > FILE_LIMIT) return null;
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > FILE_LIMIT) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

/**
 * PUT (or POST) /upload/<token>. `deps.run(principal, kind, path, bytes, headers)` sends the file through the site's
 * own route as that member and returns the Response; the caller (worker/index.js) builds that member's access.
 */
export async function handleUpload(request, env, deps) {
  if (request.method !== "PUT" && request.method !== "POST") return json({ error: L.putOnly }, 405);
  const token = new URL(request.url).pathname.split("/").pop();
  const key = await hash(token);
  const t = now();
  // claim the slot first, so two uploads to one link can't both go through
  const claim = await env.DB.prepare("UPDATE upload_slots SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?").bind(t, key, t).run();
  if (!claim.meta || claim.meta.changes !== 1) return json({ error: L.invalid }, 404);
  const slot = await env.DB.prepare("SELECT * FROM upload_slots WHERE token_hash = ?").bind(key).first();
  const release = () => env.DB.prepare("UPDATE upload_slots SET used_at = NULL WHERE token_hash = ?").bind(key).run();
  let res;
  try {
    const raw = await readBody(request);
    if (raw === null) { await release(); return json({ error: S.api.uploads.tooLarge }, 413); }
    if (!raw.byteLength) { await release(); return json({ error: S.api.uploads.emptyFile }, 400); }
    const bytes = stripImageMetadata(raw);
    const p = JSON.parse(slot.params);
    const qs = (o) => "?" + new URLSearchParams(Object.entries({ ...o, tree: slot.tree_id }).filter(([, v]) => v)).toString();
    if (slot.kind === "photo") {
      const type = sniffType(bytes);
      if (!type) { await release(); return json({ error: S.api.uploads.fileType }, 415); }
      res = await deps.run(slot.principal, `/api/media/upload${qs({ name: p.name })}`, bytes, { "Content-Type": type });
    } else {
      res = await deps.run(slot.principal, `/api/attachments${qs({ person: p.people.join(","), type: "attachment", source: p.source })}`, bytes, {
        "X-Document-Name": encodeURIComponent(p.name),
        "X-Document-Title": encodeURIComponent(p.title || ""),
      });
    }
  } catch (e) {
    await release();
    throw e;
  }
  const body = await res.text();
  if (res.status >= 400) { await release(); return new Response(body, { status: res.status, headers: { "Content-Type": "application/json" } }); }
  await env.DB.prepare("UPDATE upload_slots SET result = ? WHERE token_hash = ?").bind(body, key).run();
  return new Response(body, { status: res.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
