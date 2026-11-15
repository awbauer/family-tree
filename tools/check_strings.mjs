// Finds user-facing text written into components and API handlers instead of the strings catalog (strings/).
//   npm run check:strings            list what should move into the catalog (exit 1 if anything does)
//   node tools/check_strings.mjs web/src/pages/People.tsx   only these files
// What counts: in the site, JSX text, the title/placeholder/aria-label/alt/label attributes, alert/confirm/prompt
// messages, and prose-looking string literals (several words, a capital or end punctuation); in the Worker, messages
// passed to fail(), new OpError() and { error | message } in responses. A line ending in `// strings-ok` is skipped
// (for text that isn't the app's own words, e.g. an example value in a format hint).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE_DIRS = ["web/src"], WORKER_FILES = ["worker", "worker/agent"];
const ATTRS = new Set(["title", "placeholder", "aria-label", "alt", "label", "aria-description"]);
const SKIP_ATTRS = new Set(["className", "style", "key", "id", "href", "to", "type", "name", "rel", "target", "role", "htmlFor", "pattern", "inputMode", "autoComplete", "accept", "method", "d", "transform", "viewBox", "fill", "stroke", "data-pa", "lang"]);
const SQL = /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|WITH|PRAGMA|ALTER|DROP|REPLACE)\b/i;
const letters = (s) => /[A-Za-z]{2,}/.test(s);
const prose = (s) => letters(s) && !SQL.test(s) && (/\s\S/.test(s.trim()) && (/^[A-Z“"‘']/.test(s.trim()) || /[.?!:…)]$/.test(s.trim())));

function files(dir, exts) {
  const abs = join(ROOT, dir);
  let out = [];
  for (const f of readdirSync(abs)) {
    const p = join(abs, f), st = statSync(p);
    if (st.isDirectory()) { if (dir.startsWith("web")) out = out.concat(files(join(dir, f), exts)); }
    else if (exts.some((e) => f.endsWith(e))) out.push(join(dir, f));
  }
  return out;
}
const textOf = (n) => n.type === "StringLiteral" ? n.value : n.type === "TemplateLiteral" ? n.quasis.map((q) => q.value.cooked).join("{…}") : null;

function scan(file, { site }) {
  const src = readFileSync(join(ROOT, file), "utf8"), lines = src.split("\n");
  const ast = parse(src, { sourceType: "module", plugins: site ? ["typescript", "jsx"] : [], errorRecovery: true });
  const found = [];
  const report = (node, text, why) => {
    const line = node.loc.start.line;
    if (/\/\/\s*strings-ok\b/.test(lines[line - 1] || "")) return;
    found.push({ file, line, why, text: text.replace(/\s+/g, " ").trim().slice(0, 90) });
  };
  const walk = (node, parent, parentKey) => {
    if (!node || typeof node.type !== "string") return;
    if (site) {
      if (node.type === "JSXText" && letters(node.value)) report(node, node.value, "JSX text");
      if (node.type === "JSXAttribute") {
        const name = node.name && (node.name.name || node.name.namespace && `${node.name.namespace.name}:${node.name.name.name}`);
        if (SKIP_ATTRS.has(name)) return;
        const v = node.value && (node.value.type === "JSXExpressionContainer" ? node.value.expression : node.value);
        const t = v && textOf(v);
        if (t && ATTRS.has(name) && letters(t)) report(node, t, `${name}=`);
      }
      if (node.type === "CallExpression" && node.callee.type === "Identifier" && ["alert", "confirm", "prompt"].includes(node.callee.name)) {
        const t = node.arguments[0] && textOf(node.arguments[0]);
        if (t && letters(t)) { report(node, t, `${node.callee.name}()`); return; }
      }
      if ((node.type === "StringLiteral" || node.type === "TemplateLiteral") && !(parent && parent.type === "JSXAttribute")
        && !(parent && (parent.type === "ImportDeclaration" || parent.type === "ExportNamedDeclaration" || parent.type === "ExportAllDeclaration"))
        && !(parent && parent.type === "ObjectProperty" && parentKey === "key")
        && !(parent && parent.type === "TSLiteralType")) {
        const t = textOf(node);
        if (t && prose(t)) report(node, t, "text");
      }
    } else {
      const isCall = (n, name) => n.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === name;
      if (isCall(node, "fail")) { const t = node.arguments[1] && textOf(node.arguments[1]); if (t && letters(t)) report(node, t, "fail()"); }
      if (node.type === "NewExpression" && node.callee.name === "OpError") { const t = node.arguments[0] && textOf(node.arguments[0]); if (t && letters(t)) report(node, t, "OpError"); }
      if (node.type === "ObjectProperty" && ["error", "message"].includes(node.key.name || node.key.value)) { const t = textOf(node.value); if (t && letters(t) && !SQL.test(t)) report(node, t, `${node.key.name || node.key.value}:`); }
    }
    for (const k of Object.keys(node)) {
      if (k === "loc" || k === "leadingComments" || k === "trailingComments") continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach((c) => walk(c, node, k));
      else if (v && typeof v.type === "string") walk(v, node, k);
    }
  };
  walk(ast.program, null, null);
  return found;
}

export function checkStrings(only = []) {
  const site = SITE_DIRS.flatMap((d) => files(d, [".tsx", ".ts"])).filter((f) => !f.endsWith(".d.ts"));
  const worker = WORKER_FILES.flatMap((d) => files(d, [".js"])).filter((f) => /(^worker\/(index|ops|sites|audit|auth|store|bundle|research|scope)\.js$)|(^worker\/agent\/(routes|chat-routes)\.js$)/.test(f));
  const pick = (fs) => (only.length ? fs.filter((f) => only.some((o) => relative(ROOT, join(ROOT, o)) === f)) : fs);
  return [...pick(site).flatMap((f) => scan(f, { site: true })), ...pick(worker).flatMap((f) => scan(f, { site: false }))];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const found = checkStrings(process.argv.slice(2));
  for (const f of found) console.log(`${f.file}:${f.line}  [${f.why}]  ${f.text}`);
  const byFile = {};
  for (const f of found) byFile[f.file] = (byFile[f.file] || 0) + 1;
  console.error(found.length ? `\n${found.length} strings to move into strings/ (${Object.keys(byFile).length} files)` : "check_strings: everything user-facing comes from strings/");
  process.exit(found.length ? 1 : 0);
}
