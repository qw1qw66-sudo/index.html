// CI guard (R12/R2 — reverse audit): the PUBLIC Excel export must NEVER run
// with --no-redact, which would re-publish raw customer phones to the public
// artifact. This locks the convention so a future workflow edit can't silently
// re-introduce the leak. The exporter also redacts by default.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

describe("export redaction guard", () => {
  it("the export-bookings workflow never passes --no-redact", () => {
    const yml = readFileSync(new URL("../.github/workflows/export-bookings.yml", import.meta.url), "utf8");
    expect(yml).not.toMatch(/--no-redact/);
    expect(yml).not.toMatch(/\bno[_-]redact\b/);
  });

  it("the exporter redacts by default (redact = not args.no_redact)", () => {
    const py = readFileSync(new URL("../scripts/export_bookings_excel.py", import.meta.url), "utf8");
    expect(py).toMatch(/redact\s*=\s*not\s+args\.no_redact/);
  });
});
