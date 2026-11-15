// The app's user-facing text lives in strings/: the site's components and the Worker's API messages read it from
// there. This fails when new text is written straight into a component or handler; move it into strings/en/*.ts
// (or, for text that isn't the app's own words, end the line with `// strings-ok`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkStrings } from "../tools/check_strings.mjs";
import { S, plural, list } from "../strings/index.ts";

test("no user-facing text outside the strings catalog", () => {
  const found = checkStrings();
  assert.deepEqual(found.map((f) => `${f.file}:${f.line} ${f.text}`), [], "move these into strings/en/*.ts (npm run check:strings)");
});

test("the catalog loads in Node and its helpers format as expected", () => {
  for (const area of ["common", "browse", "person", "research", "admin", "api"]) assert.ok(Object.keys(S[area]).length > 0, `${area} has entries`);
  assert.equal(plural(1, "person", "people"), "1 person");
  assert.equal(plural(3, "person", "people"), "3 people");
  assert.equal(list(["A", "B", "C"]), "A, B and C");
});
