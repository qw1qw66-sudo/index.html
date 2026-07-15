import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  legacyIdempotencyKey,
  planLegacyMigration,
  planToSql,
} from "../../supabase/functions/_shared/legacy-migration-core.mjs";

const WS = "ALI6";

function doc(bookings) {
  return { schema_version: 3, settings: {}, chalets: [], bookings };
}

const paidBooking = (id, paid, over = {}) => ({
  id,
  customer_name: "عميل",
  total: 900,
  paid,
  status: "confirmed",
  created_at: "2026-05-01T10:00:00.000Z",
  deleted_at: null,
  ...over,
});

describe("15. legacy opening-balance migration planning", () => {
  it("creates exactly one legacy transaction per eligible booking, with full report", () => {
    const { plan, report } = planLegacyMigration({
      workspaceKey: WS,
      workspaceDoc: doc([
        paidBooking("b-1", 300),
        paidBooking("b-2", 0), // nothing paid -> skipped
        paidBooking("b-3", 150.5), // valid halala precision
        paidBooking("b-4", 12.345), // ambiguous
        paidBooking("", 100), // invalid id
        paidBooking("b-5", -20), // negative
        paidBooking("b-6", 200, { deleted_at: "2026-06-01T00:00:00Z" }), // deleted -> skipped by default
        paidBooking("b-7", 250, { status: "cancelled" }), // migrated + flagged
      ]),
    });
    expect(report.inspected).toBe(8);
    expect(report.planned).toBe(3); // b-1, b-3, b-7
    expect(report.eligible).toBe(3);
    expect(report.skipped_zero_paid).toBe(1);
    expect(report.skipped_deleted).toBe(1);
    expect(report.invalid).toEqual([
      { id: null, reason: "MISSING_BOOKING_ID" },
      { id: "b-5", reason: "PAID_NEGATIVE" },
    ]);
    expect(report.ambiguous).toEqual([{ id: "b-4", paid: 12.345, reason: "SUB_HALALA_PRECISION" }]);
    expect(report.flags).toEqual([{ id: "b-7", flag: "CANCELLED_WITH_PAID_AMOUNT" }]);
    expect(report.total_planned_halalas).toBe(30000 + 15050 + 25000);

    const t1 = plan.find((t) => t.booking_id === "b-1");
    expect(t1).toMatchObject({
      transaction_type: "legacy_opening_balance",
      direction: "in",
      amount_halalas: 30000,
      idempotency_key: "legacy:ALI6:b-1",
      occurred_at: "2026-05-01T10:00:00.000Z",
    });
    expect(t1.metadata.legacy_paid_riyals).toBe(300);
  });

  it("uses deterministic migration keys", () => {
    expect(legacyIdempotencyKey("ALI6", "b-1")).toBe("legacy:ALI6:b-1");
  });

  it("accepts the RPC response wrapper shape ({ok, data:{bookings}})", () => {
    const wrapped = { ok: true, workspace_key: WS, data: doc([paidBooking("b-1", 100)]) };
    const { report } = planLegacyMigration({ workspaceKey: WS, workspaceDoc: wrapped });
    expect(report.planned).toBe(1);
  });

  it("optionally includes deleted bookings, flagged", () => {
    const { plan, report } = planLegacyMigration({
      workspaceKey: WS,
      workspaceDoc: doc([paidBooking("b-6", 200, { deleted_at: "2026-06-01T00:00:00Z" })]),
      includeDeleted: true,
    });
    expect(report.planned).toBe(1);
    expect(report.flags).toEqual([{ id: "b-6", flag: "DELETED_WITH_PAID_AMOUNT" }]);
    expect(plan[0].metadata.booking_deleted).toBe(true);
  });

  it("reports duplicate booking ids instead of planning them twice", () => {
    const { report } = planLegacyMigration({
      workspaceKey: WS,
      workspaceDoc: doc([paidBooking("b-1", 100), paidBooking("b-1", 100)]),
    });
    expect(report.planned).toBe(1);
    expect(report.invalid).toEqual([{ id: "b-1", reason: "DUPLICATE_BOOKING_ID" }]);
  });
});

describe("16. repeated migration runs cannot duplicate", () => {
  it("re-planning against recorded keys plans nothing new", () => {
    const first = planLegacyMigration({
      workspaceKey: WS,
      workspaceDoc: doc([paidBooking("b-1", 300), paidBooking("b-2", 400)]),
    });
    expect(first.report.planned).toBe(2);
    const second = planLegacyMigration({
      workspaceKey: WS,
      workspaceDoc: doc([paidBooking("b-1", 300), paidBooking("b-2", 400)]),
      existingIdempotencyKeys: new Set(first.plan.map((t) => t.idempotency_key)),
    });
    expect(second.report.planned).toBe(0);
    expect(second.report.already_migrated).toBe(2);
  });

  it("emitted SQL is idempotent (ON CONFLICT DO NOTHING) and applying it twice yields one row per booking", () => {
    const { plan } = planLegacyMigration({
      workspaceKey: WS,
      workspaceDoc: doc([paidBooking("b-1", 300)]),
    });
    const sql = planToSql(plan);
    // Workspace-scoped conflict target (reverse-audit follow-up 1.6).
    expect(sql).toContain("on conflict (workspace_key, idempotency_key) do nothing");
    const statements = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(statements).not.toMatch(/\bupdate\b/i);
    expect(statements).not.toMatch(/\bdelete\b/i);

    // Simulate the unique-key store applying the same file twice.
    const applied = new Map();
    const applyOnce = () => {
      for (const t of plan) {
        if (!applied.has(t.idempotency_key)) applied.set(t.idempotency_key, t);
      }
    };
    applyOnce();
    applyOnce();
    expect(applied.size).toBe(1);
  });

  it("escapes quotes safely in emitted SQL", () => {
    const { plan } = planLegacyMigration({
      workspaceKey: WS,
      workspaceDoc: doc([paidBooking("b-o'brien", 100)]),
    });
    const sql = planToSql(plan);
    expect(sql).toContain("'b-o''brien'");
  });
});

describe("15b. reconciliation-aware seeding (single money source, no double-count)", () => {
  it("seeds only the top-up and never double-counts a booking that already has ledger payments", () => {
    const { plan, report } = planLegacyMigration({
      workspaceKey: WS,
      workspaceDoc: doc([
        paidBooking("b-covered", 300), // ledger already has 300 -> seed nothing
        paidBooking("b-partial", 300), // ledger has 100 -> seed the 200 gap
        paidBooking("b-formonly", 300), // no ledger rows -> seed full 300
        paidBooking("b-exceeds", 300), // ledger has 500 (> form) -> seed nothing
      ]),
      existingLedgerNetByBooking: {
        "b-covered": 30000,
        "b-partial": 10000,
        "b-formonly": 0,
        "b-exceeds": 50000,
      },
    });
    expect(report.planned).toBe(2); // b-partial, b-formonly
    expect(report.already_reconciled).toBe(2); // b-covered, b-exceeds
    expect(report.total_planned_halalas).toBe(20000 + 30000);

    const partial = plan.find((t) => t.booking_id === "b-partial");
    expect(partial.amount_halalas).toBe(20000); // only the gap, not the full 30000
    expect(partial.metadata).toMatchObject({ form_paid_halalas: 30000, existing_ledger_net_halalas: 10000 });

    const formOnly = plan.find((t) => t.booking_id === "b-formonly");
    expect(formOnly.amount_halalas).toBe(30000);
    // b-covered / b-exceeds must NOT appear in the plan (zero double-count).
    expect(plan.find((t) => t.booking_id === "b-covered")).toBeUndefined();
    expect(plan.find((t) => t.booking_id === "b-exceeds")).toBeUndefined();
  });

  it("is backward compatible: omitting the ledger map seeds the full form amount", () => {
    const { plan, report } = planLegacyMigration({
      workspaceKey: WS,
      workspaceDoc: doc([paidBooking("b-1", 300)]),
    });
    expect(report.planned).toBe(1);
    expect(report.already_reconciled).toBe(0);
    expect(plan[0].amount_halalas).toBe(30000);
    // No reconciliation metadata when no ledger snapshot is supplied.
    expect(plan[0].metadata.form_paid_halalas).toBeUndefined();
  });

  it("re-running after the seed (ledger now reflects it) reconciles to zero — effectively idempotent", () => {
    // First pass seeds the form amount; a later dry-run against the resulting
    // ledger net must plan nothing new.
    const afterSeed = planLegacyMigration({
      workspaceKey: WS,
      workspaceDoc: doc([paidBooking("b-1", 300)]),
      existingLedgerNetByBooking: { "b-1": 30000 },
    });
    expect(afterSeed.report.planned).toBe(0);
    expect(afterSeed.report.already_reconciled).toBe(1);
  });
});

describe("25. compatibility with the real workspace document shape", () => {
  it("plans correctly against the repository's sample workspace fixture", () => {
    const sample = JSON.parse(readFileSync("scripts/sample-bookings.json", "utf8"));
    const { report } = planLegacyMigration({ workspaceKey: "SAMPLE", workspaceDoc: sample });
    // The fixture has no paid fields — the app's normalizeData treats that
    // as paid=0, so every booking is inspected and skipped as zero-paid;
    // nothing is invalid and the planner must not throw on the real shape.
    expect(report.inspected).toBe(sample.bookings.length);
    expect(report.planned).toBe(0);
    expect(report.invalid).toEqual([]);
    expect(report.skipped_zero_paid).toBeGreaterThan(0);
    expect(report.errors).toEqual([]);
  });

  it("plans correctly for a realistic mixed workspace document", () => {
    const bookings = [
      paidBooking("9d454757-97ac-435c-9ed0-29f1672437e1", 500, {
        customer_phone: "0501111111",
        chalet_id: "b05eaffe-79c8-46ab-83c9-2209095a61a5",
        booking_date: "2026-05-10",
        period_id: "70021831-83fd-4e7a-aec9-8ed90cb9b438",
        remaining_status: "customer_pending",
        remaining_note: "",
      }),
      paidBooking("5da6058c-d2dc-4e4d-a976-27d7faeac64a", 0),
    ];
    const { plan, report } = planLegacyMigration({ workspaceKey: WS, workspaceDoc: doc(bookings) });
    expect(report.planned).toBe(1);
    expect(plan[0].amount_halalas).toBe(50000);
  });
});
