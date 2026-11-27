// Strip location and camera metadata from photos that reach the server as raw bytes (MCP uploads). The site's own
// upload form already does this in the browser by redrawing the photo; files from AI clients arrive untouched, and
// a phone photo's EXIF carries where it was taken. Removes EXIF and XMP from JPEG (keeping the orientation, so
// photos aren't shown sideways), the eXIf and text chunks from PNG, and the EXIF and XMP chunks from WebP. Anything
// else comes back unchanged.

const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));

/** The EXIF Orientation (1-8) in a TIFF block, or 1 when it has none. */
function orientation(tiff) {
  if (tiff.length < 8) return 1;
  const le = tiff[0] === 0x49;
  const u16 = (i) => (le ? tiff[i] | (tiff[i + 1] << 8) : (tiff[i] << 8) | tiff[i + 1]);
  const u32 = (i) => (le ? (tiff[i] | (tiff[i + 1] << 8) | (tiff[i + 2] << 16)) + tiff[i + 3] * 2 ** 24 : tiff[i] * 2 ** 24 + ((tiff[i + 1] << 16) | (tiff[i + 2] << 8) | tiff[i + 3]));
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return 1;
  const n = u16(ifd);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > tiff.length) break;
    if (u16(e) === 0x0112) { const v = u16(e + 8); return v >= 1 && v <= 8 ? v : 1; }
  }
  return 1;
}

/** An APP1 EXIF segment holding only Orientation. */
function orientationSegment(value) {
  const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, value, 0, 0, 0, 0, 0, 0];
  const body = [...new TextEncoder().encode("Exif"), 0, 0, ...tiff];
  const len = body.length + 2;
  return [0xff, 0xe1, len >> 8, len & 255, ...body];
}

function jpeg(b) {
  const out = [b.subarray(0, 2)];
  let turn = 1, i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { out.push(b.subarray(i, i + 2)); i += 2; continue; }
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xda) break; // start of scan: the image data follows
    const end = i + 2 + ((b[i + 2] << 8) | b[i + 3]);
    if (end > b.length) return b; // malformed: leave it alone rather than guess
    const isExif = marker === 0xe1 && ascii(b, i + 4, 6) === "Exif\0\0";
    const isXmp = marker === 0xe1 && !isExif; // XMP and extended XMP
    if (isExif) turn = orientation(b.subarray(i + 10, end));
    if (!isExif && !isXmp && marker !== 0xed) out.push(b.subarray(i, end)); // 0xED: Photoshop IPTC, which can hold places
    i = end;
  }
  if (turn !== 1) out.splice(1, 0, new Uint8Array(orientationSegment(turn)));
  out.push(b.subarray(i));
  return concat(out);
}

const PNG_DROP = new Set(["eXIf", "tEXt", "zTXt", "iTXt"]);
function png(b) {
  const out = [b.subarray(0, 8)];
  for (let i = 8; i + 12 <= b.length;) {
    const len = ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
    const end = i + 12 + len;
    if (end > b.length) return b;
    if (!PNG_DROP.has(ascii(b, i + 4, 4))) out.push(b.subarray(i, end));
    i = end;
  }
  return concat(out);
}

function webp(b) {
  const out = [];
  let i = 12;
  for (; i + 8 <= b.length;) {
    const id = ascii(b, i, 4), len = b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24);
    const end = i + 8 + len + (len & 1);
    if (end > b.length) return b;
    if (id === "VP8X") { const c = b.slice(i, end); c[8] &= ~0x0c; out.push(c); } // clear the EXIF and XMP flags
    else if (id !== "EXIF" && id !== "XMP ") out.push(b.subarray(i, end));
    i = end;
  }
  const body = concat(out), head = new Uint8Array(12);
  head.set(b.subarray(0, 12));
  new DataView(head.buffer).setUint32(4, body.length + 4, true);
  return concat([head, body]);
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** The same photo without location or camera metadata (a new array), or the input when it isn't a JPEG, PNG or WebP. */
export function stripImageMetadata(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) return jpeg(b);
  if (b.length > 8 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG") return png(b);
  if (b.length > 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return webp(b);
  return b;
}
