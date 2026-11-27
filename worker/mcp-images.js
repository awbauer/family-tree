// Fit photos and scans to what AI clients accept before returning them over MCP.
//
// Claude rejects (doesn't shrink) an image in a tool result that is over 10 MB once base64-encoded, over 8000 px on
// a side, or over 3000 px on a side once a conversation holds more than 20 images; Bedrock and some Google Cloud
// deployments allow only 5 MB. Claude's newest models read images at up to 2576 px on the long edge, so nothing
// larger helps. So images go out at most MAX_EDGE px and MAX_BYTES (5 MB base64), scaled down with the Images
// binding when they're bigger. Without the binding (local runs, tests) a too-big image isn't sent at all: the
// caller returns a link to it instead, which is better than an image the client refuses.
export const MAX_EDGE = 2576;
export const MAX_BYTES = 3_750_000;
const SENDABLE = /^image\/(jpeg|png|webp|gif)$/;
// Tried in order until the result fits.
const STEPS = [{ edge: MAX_EDGE, quality: 85 }, { edge: 2000, quality: 75 }, { edge: 1568, quality: 70 }];

/** Width and height from a PNG, GIF, JPEG or WebP header, or null if it can't tell. */
export function imageSize(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  const u16 = (i) => (b[i] << 8) | b[i + 1], u16le = (i) => b[i] | (b[i + 1] << 8);
  const u32 = (i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { width: u32(16), height: u32(20) };
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { width: u16le(6), height: u16le(8) };
  if (b.length >= 30 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") {
    const kind = String.fromCharCode(...b.subarray(12, 16));
    if (kind === "VP8X") return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (kind === "VP8L") return { width: 1 + (((b[22] & 0x3f) << 8) | b[21]), height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) };
    if (kind === "VP8 ") return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { i += marker === 0xff ? 1 : 2; continue; }
      // start-of-frame markers carry the size (C0-CF except C4 DHT, C8 JPG, CC DAC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: u16(i + 7), height: u16(i + 5) };
      i += 2 + u16(i + 2);
    }
  }
  return null;
}

const fits = (bytes, type) => {
  if (!SENDABLE.test(type) || bytes.byteLength > MAX_BYTES) return false;
  const size = imageSize(bytes);
  return !!size && Math.max(size.width, size.height) <= MAX_EDGE;
};

/**
 * An image ready to send: { bytes, type, resized, original } where original is the source's size when it was scaled,
 * or null when it's too big to send and couldn't be scaled (no Images binding, or the binding failed).
 */
export async function fitImage(env, input, type) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (fits(bytes, type)) return { bytes, type, resized: false };
  if (!env || !env.IMAGES) return null;
  const original = imageSize(bytes);
  for (const { edge, quality } of STEPS) {
    try {
      const result = await env.IMAGES.input(new Blob([bytes]).stream())
        .transform({ width: edge, height: edge, fit: "scale-down" })
        .output({ format: "image/jpeg", quality });
      const out = new Uint8Array(await result.response().arrayBuffer());
      if (out.byteLength <= MAX_BYTES) return { bytes: out, type: "image/jpeg", resized: true, original };
    } catch (e) {
      console.error("mcp image resize", e && e.message ? e.message : e);
      return null;
    }
  }
  return null;
}
