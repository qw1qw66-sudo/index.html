// Extracts named function declarations from index.html's inline script so
// the REAL production code (not a re-implementation) can be unit tested.
// Relies on balanced-brace scanning of the prettier-formatted source.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const html = readFileSync(resolve(root, "index.html"), "utf8");

export function extractFunctionSource(name) {
  const marker = `function ${name}(`;
  const start = html.indexOf(marker);
  if (start === -1) throw new Error(`function ${name} not found in index.html`);
  const bodyStart = html.indexOf("{", start);
  let depth = 0;
  for (let i = bodyStart; i < html.length; i++) {
    const ch = html[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

/**
 * Build the named functions (with their dependencies) into a sandbox and
 * return them. deps are other inline functions the targets call.
 */
export function extractFunctions(names, deps = []) {
  const source = [...deps, ...names].map(extractFunctionSource).join("\n");
  const factory = new Function(
    `${source}\nreturn { ${[...deps, ...names].join(", ")} };`,
  );
  return factory();
}

export function inlineHtml() {
  return html;
}
