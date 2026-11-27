// Types that can appear in the original image gallery or as native MCP media.
export const UPLOAD_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "application/pdf": "pdf" };

export function safeMediaType(value) {
  const type = value?.split(";")[0].trim().toLowerCase();
  return Object.hasOwn(UPLOAD_TYPES, type) ? type : "application/octet-stream";
}

/** What a file is, from its first bytes: one of the photo types upload_media takes, or null. */
export function sniffType(b) {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  return null;
}

/** An image a browser can show safely (JPEG, PNG, WebP or GIF, never SVG), judged by its bytes; else null. */
export const imageType = (bytes) => { const t = sniffType(bytes); return t && t.startsWith("image/") ? t : null; };
