// Images returned over MCP must fit what AI clients accept (worker/mcp-images.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fitImage, imageSize, MAX_EDGE, MAX_BYTES } from "../worker/mcp-images.js";

const be16 = (n) => [(n >> 8) & 255, n & 255], be32 = (n) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
const le16 = (n) => [n & 255, (n >> 8) & 255], le24 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
/** Just enough of each format's header to carry a size (the rest isn't read). */
export const fake = {
  png: (w, h) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be32(w), ...be32(h), 8, 2, 0, 0, 0]),
  gif: (w, h) => new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...le16(w), ...le16(h), 0, 0, 0]),
  // SOI, an APP0 segment to skip, then SOF2 (progressive) with the size
  jpeg: (w, h) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...new Array(14).fill(0), 0xff, 0xc2, 0, 17, 8, ...be16(h), ...be16(w), 3, ...new Array(9).fill(0)]),
  webpX: (w, h) => new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8X"), 10, 0, 0, 0, 0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1), 0, 0]),
};

test("reads the size from PNG, GIF, JPEG and WebP headers", () => {
  assert.deepEqual(imageSize(fake.png(4032, 3024)), { width: 4032, height: 3024 });
  assert.deepEqual(imageSize(fake.gif(640, 480)), { width: 640, height: 480 });
  assert.deepEqual(imageSize(fake.jpeg(3000, 4000)), { width: 3000, height: 4000 });
  assert.deepEqual(imageSize(fake.webpX(5000, 2000)), { width: 5000, height: 2000 });
  assert.equal(imageSize(new Uint8Array([1, 2, 3, 4])), null);
});

test("an image within the limits goes out as it is", async () => {
  const bytes = fake.jpeg(MAX_EDGE, 1000);
  const out = await fitImage({}, bytes, "image/jpeg");
  assert.equal(out.resized, false);
  assert.equal(out.bytes, bytes);
});

test("too big and no Images binding: not sent (the caller links to it instead)", async () => {
  assert.equal(await fitImage({}, fake.jpeg(4032, 3024), "image/jpeg"), null, "a phone photo is over the many-image limit");
  const heavy = new Uint8Array(MAX_BYTES + 1); heavy.set(fake.jpeg(800, 600));
  assert.equal(await fitImage({}, heavy, "image/jpeg"), null, "over 5 MB once base64-encoded");
  assert.equal(await fitImage({}, fake.png(10, 10), "image/heic"), null, "a type clients can't read");
});

/** An Images binding stand-in that records each transform and returns `sizes` bytes in turn. */
function fakeImages(sizes) {
  const calls = [];
  return {
    calls,
    input: () => ({
      transform(t) { calls.push({ ...t }); return this; },
      async output(o) { Object.assign(calls[calls.length - 1], o); const n = sizes.shift(); return { response: () => new Response(new Uint8Array(n)) }; },
    }),
  };
}

test("too big with the Images binding: scaled to the long-edge limit as JPEG, smaller steps until it fits", async () => {
  const IMAGES = fakeImages([200_000]);
  const out = await fitImage({ IMAGES }, fake.png(6000, 4000), "image/png");
  assert.equal(out.resized, true);
  assert.equal(out.type, "image/jpeg");
  assert.deepEqual(out.original, { width: 6000, height: 4000 });
  assert.deepEqual(IMAGES.calls[0], { width: MAX_EDGE, height: MAX_EDGE, fit: "scale-down", format: "image/jpeg", quality: 85 });
  // a first result still over the byte limit is tried again smaller
  const again = fakeImages([MAX_BYTES + 10, 900_000]);
  assert.equal((await fitImage({ IMAGES: again }, fake.jpeg(8000, 6000), "image/jpeg")).bytes.byteLength, 900_000);
  assert.equal(again.calls.length, 2);
  assert.ok(again.calls[1].width < MAX_EDGE);
});

test("the Images binding failing doesn't fail the call: not sent, so the caller links to it", async () => {
  const IMAGES = { input: () => ({ transform() { return this; }, async output() { throw new Error("9422 limit reached"); } }) };
  assert.equal(await fitImage({ IMAGES }, fake.png(6000, 4000), "image/png"), null);
});
