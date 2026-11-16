// Types that can appear in the original image gallery or as native MCP media.
export const UPLOAD_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "application/pdf": "pdf" };

export function safeMediaType(value) {
  const type = value?.split(";")[0].trim().toLowerCase();
  return Object.hasOwn(UPLOAD_TYPES, type) ? type : "application/octet-stream";
}
