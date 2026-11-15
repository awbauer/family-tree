// Encryption for secrets kept in D1 (research site credentials). AES-GCM with a 256-bit key from the Worker secret
// SITE_CREDENTIALS_KEY (32 random bytes, base64), set on both the site Worker (which encrypts on save) and the agents
// Worker (which decrypts at fetch time). Each value is bound to what it belongs to (the AAD), so a ciphertext copied
// onto another row doesn't decrypt. Plain WebCrypto: runs in Workers and in Node's tests alike.
import { S } from "../strings/index.ts";

/** The Worker names in the tracked wrangler configs, for the setup message. */
export const KEY_HELP = S.api.secrets.keyHelp;

export class KeyMissingError extends Error {
  constructor(msg = S.api.secrets.keyMissing) { super(msg); }
}

const b64 = (bytes) => { let s = ""; for (const x of bytes) s += String.fromCharCode(x); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(String(s).trim()), (c) => c.charCodeAt(0));
const enc = new TextEncoder(), dec = new TextDecoder();

/** The raw key bytes, or null when the secret is missing or not 32 bytes of base64. */
function rawKey(env) {
  const v = env && env.SITE_CREDENTIALS_KEY;
  if (!v) return null;
  try { const k = unb64(v); return k.length === 32 ? k : null; } catch { return null; }
}
export const keyConfigured = (env) => !!rawKey(env);

async function key(env, usage) {
  const raw = rawKey(env);
  if (!raw) throw new KeyMissingError(env && env.SITE_CREDENTIALS_KEY ? S.api.secrets.keyInvalid : undefined);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [usage]);
}

/** Encrypt a JSON-able value, bound to `aad` (e.g. the site id). Returns base64(iv || ciphertext). */
export async function encryptSecret(env, aad, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(String(aad)) }, await key(env, "encrypt"), enc.encode(JSON.stringify(value))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv); out.set(ct, iv.length);
  return b64(out);
}

/** Decrypt what encryptSecret wrote for the same `aad`. Throws if the key, the AAD or the data don't match. */
export async function decryptSecret(env, aad, blob) {
  const all = unb64(blob);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12), additionalData: enc.encode(String(aad)) }, await key(env, "decrypt"), all.slice(12));
  return JSON.parse(dec.decode(pt));
}
