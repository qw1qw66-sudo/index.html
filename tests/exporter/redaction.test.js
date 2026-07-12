import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeAll } from "vitest";
import JSZipModuleCheck from "node:zlib"; // ensure zlib available

// Verifies the public Excel export contains no customer PII. Uses the REAL
// exporter (scripts/export_bookings_excel.py) against a fixture whose bookings
// carry phone numbers, PINs-looking notes, payment URLs and provider refs, then
// unzips the produced workbook and asserts none of those appear.
//
// Skips gracefully if python3/openpyxl are unavailable in the runner (the
// exporter is Python; JS CI without python still runs the rest of the suite).

void JSZipModuleCheck;

const PHONE_RE = /(?:^|\D)(05\d{8}|9665\d{8}|\+9665\d{8})(?:\D|$)/;
const PIN_FIXTURE = "PINSECRET1234";
const URL_FIXTURE = "https://pay.example.com/checkout/SECRET";
const PROVIDER_REF_FIXTURE = "ptx_LIVE_9988776655";
const NOTE_FIXTURE = "INTERNAL_NOTE_DO_NOT_SHARE";

function haveExporterDeps() {
  try {
    execFileSync("python3", ["-c", "import openpyxl"], { stdio: "ignore" });
    return existsSync("templates/booking-template.xlsx") && existsSync("templates/mapping.json");
  } catch {
    return false;
  }
}

const ENABLED = haveExporterDeps();
const d = ENABLED ? describe : describe.skip;

d("8. public Excel export is PII-free", () => {
  let sharedStrings = "";
  let allXml = "";

  beforeAll(() => {
    // Build a fixture whose confirmed bookings land in the template's two
    // supported chalets, each carrying a phone + sensitive fields.
    const mapping = JSON.parse(readFileSync("templates/mapping.json", "utf8"));
    const names = mapping.blocks.map((b) => b.chalet_name);
    const report2026 = JSON.parse(readFileSync("exports/bookings-2026-report.json", "utf8"));
    // Reuse the real chalet/period ids the template maps, from the committed report.
    const blocks = report2026.blocks;
    const chalets = blocks.map((blk, i) => ({
      id: blk.matched_chalet_id,
      name: names[i],
      deleted_at: null,
      periods: Object.keys(blk.periods_mapped).map((pid, j) => ({
        id: pid, label: "P" + j, start: "07:00", end: "12:00", active: true, sort: j + 1,
      })),
    }));
    const firstPeriod = (blk) => Object.keys(blk.periods_mapped)[0];
    const bookings = blocks.map((blk, i) => ({
      id: "bk" + i,
      chalet_id: blk.matched_chalet_id,
      booking_date: "2026-05-1" + i,
      period_id: firstPeriod(blk),
      customer_name: "عميل اختبار",
      customer_phone: i === 0 ? "0501234567" : "+966512345678",
      total: 900,
      status: "confirmed",
      notes: NOTE_FIXTURE,
      remaining_note: NOTE_FIXTURE,
      created_at: "2026-05-01T08:0" + i + ":00Z",
      deleted_at: null,
      _pin: PIN_FIXTURE,
      _url: URL_FIXTURE,
      _ref: PROVIDER_REF_FIXTURE,
    }));
    const dir = mkdtempSync(join(tmpdir(), "exp-"));
    const inputPath = join(dir, "ws.json");
    writeFileSync(inputPath, JSON.stringify({ schema_version: 3, chalets, bookings }));
    execFileSync("python3", [
      "scripts/export_bookings_excel.py",
      "--input", inputPath,
      "--template", "templates/booking-template.xlsx",
      "--mapping", "templates/mapping.json",
      "--output-dir", dir,
    ], { stdio: "ignore" });

    // Unzip the produced workbook and concatenate all XML parts.
    const xlsxPath = join(dir, "bookings-2026.xlsx");
    const listing = execFileSync("python3", ["-c",
      "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);" +
      "print('\\n'.join(z.read(n).decode('utf-8','replace') for n in z.namelist() if n.endswith('.xml')))",
      xlsxPath]).toString();
    // openpyxl may serialize Arabic as literal UTF-8 or numeric XML entities
    // depending on its version. Decode numeric entities before both the PII
    // scan and the booked-marker assertion so the test checks workbook text,
    // not one serializer representation.
    const decoded = listing
      .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)));
    allXml = decoded;
    sharedStrings = decoded;
  });

  it("contains no Saudi mobile-number patterns", () => {
    expect(PHONE_RE.test(allXml)).toBe(false);
    expect(allXml).not.toContain("0501234567");
    expect(allXml).not.toContain("512345678");
  });

  it("contains no PIN, payment URL, provider reference, or private note fixtures", () => {
    expect(allXml).not.toContain(PIN_FIXTURE);
    expect(allXml).not.toContain(URL_FIXTURE);
    expect(allXml).not.toContain(PROVIDER_REF_FIXTURE);
    expect(allXml).not.toContain(NOTE_FIXTURE);
  });

  it("still marks booked slots (the booked marker is present)", () => {
    // The exporter writes the phone_missing marker ("محجوز") for booked slots.
    expect(sharedStrings.includes("محجوز")).toBe(true);
  });
});
