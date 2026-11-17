// Read a .jsonc file (wrangler.jsonc): JSON with comments and trailing commas.
// Strip line and block comments and trailing commas (outside strings).
export function parseJsonc(text) {
  let res = "", inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inStr) { res += c; if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; res += c; continue; }
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; res += "\n"; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; continue; }
    res += c;
  }
  return JSON.parse(res.replace(/,(\s*[}\]])/g, "$1"));
}
