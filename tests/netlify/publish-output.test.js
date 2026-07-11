import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Item 9: prove the Netlify publish directory contains the app but NOT exports
// or any private development files. Runs the real build script (no external
// Netlify access required).
const OUT = resolve(process.cwd(), "netlify-dist");

describe("9. Netlify publish output excludes private files", () => {
  beforeAll(() => {
    execFileSync("node", ["scripts/build-netlify.mjs"], { stdio: "ignore" });
  });
  afterAll(() => {
    rmSync(OUT, { recursive: true, force: true });
  });

  it("publishes the application entry point", () => {
    expect(existsSync(resolve(OUT, "index.html"))).toBe(true);
    expect(existsSync(resolve(OUT, "404.html"))).toBe(true);
  });

  it("does NOT publish exports/ (customer data)", () => {
    expect(existsSync(resolve(OUT, "exports"))).toBe(false);
  });

  it("does NOT publish database/, docs/, tests/, scripts/, or supabase/", () => {
    for (const d of ["database", "docs", "tests", "scripts", "supabase", "e2e", "archive", "templates"]) {
      expect(existsSync(resolve(OUT, d)), `${d} must be absent`).toBe(false);
    }
  });

  it("does NOT publish env example or any *.sql", () => {
    expect(existsSync(resolve(OUT, ".env.example"))).toBe(false);
    // spot-check the known committed SQL is not copied
    expect(existsSync(resolve(OUT, "chalets-supabase-schema.sql"))).toBe(false);
  });
});
