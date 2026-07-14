import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { extractFunctionSource } from "./helpers/extract-inline.mjs";

// H2 — the browser half of the unified "business data present" definition.
// Drives the REAL counts() + hasBusinessData() extracted from index.html, plus
// the REAL BUSINESS_COLLECTIONS declaration, proving the empty-overwrite upload
// guard now treats expenses as business data. Before H2 the guard counted only
// chalets + bookings, so an expenses-only workspace was (A) wrongly blocked from
// uploading and (B) at risk of being silently wiped by an empty local doc.
// Mirrors workspace_has_business_data() in migration 0009 (SQL half proven in
// tests/payments/sql-contracts.test.js and integration-postgres.test.js).

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const html = readFileSync(resolve(root, "index.html"), "utf8");

// Pull the REAL const declaration (not a re-typed copy) so a regression that
// drops a collection from the production list fails this test.
const declMatch = html.match(/const BUSINESS_COLLECTIONS = \[[^\]]*\];/);
if (!declMatch) throw new Error("BUSINESS_COLLECTIONS declaration not found in index.html");
const decl = declMatch[0];

function makeGuard() {
  const src =
    decl +
    "\n" +
    extractFunctionSource("counts") +
    "\n" +
    extractFunctionSource("hasBusinessData");
  // `let state = {}` satisfies counts()'s `doc = state` default; every call
  // below passes an explicit doc, so the default is never actually taken.
  const factory = new Function(
    `let state = {};\n${src}\nreturn { counts, hasBusinessData, BUSINESS_COLLECTIONS };`,
  );
  return factory();
}

const g = makeGuard();
const doc = (o) => ({ chalets: [], bookings: [], expenses: [], ...o });

describe("H2: BUSINESS_COLLECTIONS is the single source of truth (browser)", () => {
  it("the production list includes expenses (the H2 correction)", () => {
    expect(decl).toContain("expenses");
    expect(g.BUSINESS_COLLECTIONS).toEqual(["chalets", "bookings", "expenses"]);
  });
});

describe("H2: counts() counts every protected collection", () => {
  it("counts expenses, not just chalets/bookings", () => {
    const c = g.counts(doc({ expenses: [{ id: "e1" }, { id: "e2" }] }));
    expect(c.expenses).toBe(2);
    expect(c.chalets).toBe(0);
    expect(c.bookings).toBe(0);
  });
  it("ignores soft-deleted rows in every collection", () => {
    const c = g.counts(
      doc({
        chalets: [{ id: "c1" }, { id: "c2", deleted_at: "2026-01-01" }],
        expenses: [{ id: "e1" }, { id: "e2", deleted_at: "2026-01-01" }],
      }),
    );
    expect(c.chalets).toBe(1);
    expect(c.expenses).toBe(1);
  });
  it("tolerates a document missing a collection key (reads as zero)", () => {
    const c = g.counts({ chalets: [{ id: "c1" }] });
    expect(c.chalets).toBe(1);
    expect(c.bookings).toBe(0);
    expect(c.expenses).toBe(0);
  });
});

describe("H2: hasBusinessData() is true for ANY protected collection", () => {
  it("expenses-only is business data (was FALSE before H2 → the bug)", () => {
    expect(g.hasBusinessData(g.counts(doc({ expenses: [{ id: "e1" }] })))).toBe(true);
  });
  it("chalets-only and bookings-only remain business data", () => {
    expect(g.hasBusinessData(g.counts(doc({ chalets: [{ id: "c1" }] })))).toBe(true);
    expect(g.hasBusinessData(g.counts(doc({ bookings: [{ id: "b1" }] })))).toBe(true);
  });
  it("a truly empty document is NOT business data", () => {
    expect(g.hasBusinessData(g.counts(doc({})))).toBe(false);
  });
  it("tolerates a legacy counts object missing the expenses key", () => {
    // A restored old snapshot (lastCloudCounts) may predate the expenses key.
    expect(g.hasBusinessData({ chalets: 1, bookings: 0 })).toBe(true);
    expect(g.hasBusinessData({ chalets: 0, bookings: 0 })).toBe(false);
    expect(g.hasBusinessData(null)).toBe(false);
  });
});

// The upload guard's exact production predicate (index.html uploadChanges):
//   if (!hasBusinessData(counts(state)) && hasBusinessData(lastCloudCounts)) block
const blocked = (local, cloud) =>
  !g.hasBusinessData(g.counts(local)) && g.hasBusinessData(cloud);

describe("H2: the empty-overwrite upload guard predicate", () => {
  it("(A fix) expenses-only local over a full cloud is NOT blocked", () => {
    // Before H2 the local expenses-only doc read as empty → wrongly blocked.
    expect(blocked(doc({ expenses: [{ id: "e1" }] }), g.counts(doc({ chalets: [{ id: "c1" }], bookings: [{ id: "b1" }] })))).toBe(false);
  });
  it("(B fix) empty local over an expenses-only cloud IS blocked (wipe protection)", () => {
    // Before H2 the cloud expenses-only doc read as empty → the guard let an
    // empty local doc silently wipe it.
    expect(blocked(doc({}), g.counts(doc({ expenses: [{ id: "e1" }] })))).toBe(true);
  });
  it("empty local over a chalets cloud is still blocked (original protection intact)", () => {
    expect(blocked(doc({}), g.counts(doc({ chalets: [{ id: "c1" }] })))).toBe(true);
  });
  it("empty local over an empty cloud is not blocked (nothing to protect)", () => {
    expect(blocked(doc({}), g.counts(doc({})))).toBe(false);
  });
  it("a normal populated local upload is never blocked", () => {
    expect(blocked(doc({ chalets: [{ id: "c1" }], bookings: [{ id: "b1" }] }), g.counts(doc({ chalets: [{ id: "c1" }] })))).toBe(false);
  });
});
