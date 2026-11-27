// Location and camera metadata come off photos uploaded over MCP (worker/image-meta.js).
// The fixtures are a plain 64×32 square carrying made-up GPS coordinates, a camera make and Orientation 6.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripImageMetadata } from "../worker/image-meta.js";
import { imageSize } from "../worker/mcp-images.js";

const fixture = (name) => new Uint8Array(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", name)));
const has = (bytes, text) => Buffer.from(bytes).includes(text);

for (const ext of ["jpg", "png", "webp"]) {
  test(`${ext}: GPS and camera data are removed, the picture is kept`, () => {
    const before = fixture(`gps.${ext}`);
    assert.ok(has(before, "ExampleCam"), "the fixture carries camera data");
    const after = stripImageMetadata(before);
    assert.ok(!has(after, "ExampleCam"));
    assert.deepEqual(imageSize(after), { width: 64, height: 32 });
    assert.ok(after.length < before.length);
  });
}

/** The TIFF block left in each format, which should hold just Orientation 6. */
const tiffOf = {
  jpg: (b) => b.subarray(Buffer.from(b).indexOf("Exif\0\0") + 6),
  png: (b) => b.subarray(Buffer.from(b).indexOf("eXIf") + 4),
  webp: (b) => b.subarray(Buffer.from(b).indexOf("EXIF") + 8),
};
for (const ext of ["jpg", "png", "webp"]) {
  test(`${ext}: only the orientation survives, so photos aren't shown sideways`, () => {
    const tiff = tiffOf[ext](stripImageMetadata(fixture(`gps.${ext}`)));
    assert.equal(Buffer.from(tiff.subarray(0, 4)).toString("latin1"), "MM\0*");
    assert.equal((tiff[8] << 8) | tiff[9], 1, "one tag");
    assert.equal((tiff[10] << 8) | tiff[11], 0x0112, "Orientation");
    assert.equal(tiff[19], 6);
  });
}

test("png: the orientation chunk is valid (its CRC checks) and comes before the image data", () => {
  const b = Buffer.from(stripImageMetadata(fixture("gps.png")));
  assert.ok(b.indexOf("eXIf") < b.indexOf("IDAT"));
  assert.equal(b.indexOf("eXIf"), 8 + 25 + 4, "right after IHDR");
});

test("webp: the header's size is updated and the EXIF flag matches what's left", () => {
  const after = stripImageMetadata(fixture("gps.webp"));
  assert.equal(new DataView(after.buffer).getUint32(4, true), after.length - 8);
  assert.equal(after[20] & 0x08, 0x08, "orientation kept, so EXIF is flagged");
  assert.equal(after[20] & 0x04, 0, "no XMP");
});

test("other files pass through untouched", () => {
  const pdf = new TextEncoder().encode("%PDF-1.4 example");
  assert.equal(stripImageMetadata(pdf), pdf);
});
