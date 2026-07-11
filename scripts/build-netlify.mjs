// build-netlify.mjs — deterministic Netlify publish build.
//
// Netlify (helpful-gaufre-edf566) previously had NO config, so it published the
// entire repository root — including exports/ with customer data (reverse-audit
// §1.1). This build copies ONLY the public application files into a dedicated
// publish directory, so exports/, database/, docs/, tests/, scripts/ and the
// Supabase functions can never be served by Netlify.
//
// GitHub Pages is unaffected: it uses .github/workflows/pages.yml with its own
// dist/ build. This script is Netlify-only.

import { existsSync, mkdirSync, rmSync, cpSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const OUT = resolve(root, "netlify-dist");

// The ONLY files Netlify is allowed to publish. Everything else is excluded by
// omission (allowlist, not denylist).
const PUBLISH = ["index.html", "404.html", "icon.svg", ".nojekyll"];

// Anything that must NEVER appear in the publish dir — asserted after build so
// a future careless edit to PUBLISH cannot silently leak private files.
const FORBIDDEN = [
  "exports",
  "database",
  "docs",
  "tests",
  "scripts",
  "supabase",
  "e2e",
  "archive",
  "templates",
  ".env.example",
];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const name of PUBLISH) {
  const src = resolve(root, name);
  if (existsSync(src)) {
    cpSync(src, resolve(OUT, name));
  }
}

// Ensure index.html actually made it (the app must be servable).
if (!existsSync(resolve(OUT, "index.html"))) {
  throw new Error("build-netlify: index.html missing from publish dir");
}

for (const bad of FORBIDDEN) {
  if (existsSync(resolve(OUT, bad))) {
    throw new Error(`build-netlify: forbidden path leaked into publish dir: ${bad}`);
  }
}

// A Netlify _headers file to discourage indexing of the preview.
writeFileSync(
  resolve(OUT, "_headers"),
  "/*\n  X-Robots-Tag: noindex\n",
);

console.log(`build-netlify: published ${PUBLISH.join(", ")} to netlify-dist/`);
