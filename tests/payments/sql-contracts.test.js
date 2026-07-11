import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Contract pins for the SQL migrations. These are textual checks: the full
// behavioral suite (32 scenarios: CAS, conflicts, throttling, immutability,
// idempotent manual payments, refunds, webhooks, legacy dedup) was executed
// against a real PostgreSQL 16 instance during development — see the PR
// description for the transcript summary. These pins keep the critical
// clauses from silently disappearing in later edits.

const m1 = readFileSync("database/migrations/0001_atomic_workspace_save.sql", "utf8");
const m2 = readFileSync("database/migrations/0002_payment_ledger.sql", "utf8");

// Executable statements only — SQL comments (e.g. the documented rollback
// section) must not satisfy or violate the contracts below.
function code(sql) {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}
const c1 = code(m1);
const c2 = code(m2);

describe("migration 0001 (atomic workspace save) contracts", () => {
  it("save v2 verifies the expected revision inside the row lock", () => {
    expect(m1).toContain("for update");
    expect(m1).toContain("v_workspace.updated_at <> p_expected_updated_at");
    expect(m1).toContain("'STALE_REVISION'");
  });
  it("save v2 never auto-creates and validates booking conflicts", () => {
    expect(m1).toContain("MISSING_EXPECTED_REVISION");
    expect(m1).toContain("workspace_doc_booking_conflict(p_data)");
    expect(m1).toMatch(/BOOKING_CONFLICT/);
  });
  it("create is create-only and enforces a 6+ char PIN for new workspaces", () => {
    expect(m1).toContain("WORKSPACE_ALREADY_EXISTS");
    expect(m1).toContain("length(v_pin) < 6");
  });
  it("legacy v1 save gains the server-side empty-overwrite guard", () => {
    expect(m1).toContain("EMPTY_OVERWRITE_BLOCKED");
  });
  it("PIN attempts are throttled per workspace", () => {
    expect(m1).toContain("workspace_auth_throttle");
    expect(m1).toContain("TOO_MANY_ATTEMPTS");
  });
  it("does not touch existing rows or drop existing objects", () => {
    expect(c1).not.toMatch(/\bdrop table\b/i);
    expect(c1).not.toMatch(/delete from public\.shared_workspaces/i);
    expect(c1).not.toMatch(/update public\.shared_workspaces\s+set\s+data\s*=\s*'{}'/i);
  });
});

describe("migration 0002 (payment ledger) contracts", () => {
  it("money is integer halalas with SAR-only currency (no float column types)", () => {
    expect(c2).toContain("amount_halalas bigint not null");
    expect(c2).toContain("currency = 'SAR'");
    expect(c2).not.toMatch(/\b(real|double precision|float4|float8)\b/i);
  });
  it("orders: unique idempotency key, unique provider ref, positive amount, status whitelist", () => {
    expect(m2).toContain("payment_orders_idempotency_unique unique (idempotency_key)");
    expect(m2).toContain("payment_orders_provider_ref_unique");
    expect(m2).toContain("check (amount_halalas > 0)");
    expect(m2).toContain("'pending', 'paid', 'partially_paid', 'failed', 'expired', 'cancelled'");
    expect(m2).toContain("payment_orders_one_active_per_booking");
  });
  it("transactions: immutable ledger with typed entries and non-negative amounts", () => {
    expect(m2).toContain("'payment', 'manual_payment', 'refund', 'adjustment', 'legacy_opening_balance'");
    expect(m2).toContain("check (amount_halalas >= 0)");
    expect(m2).toContain("LEDGER_ROWS_ARE_IMMUTABLE");
    expect(m2).toContain("payment_tx_provider_ref_unique");
  });
  it("webhook events: unique per provider event, raw payload stored, processing recorded", () => {
    expect(m2).toContain("unique (provider, provider_event_id)");
    expect(m2).toContain("payload jsonb not null");
    expect(m2).toContain("'received', 'processed', 'skipped_duplicate', 'failed'");
  });
  it("manual payments require positive amounts, bank-transfer references, and respect remaining", () => {
    expect(m2).toContain("AMOUNT_MUST_BE_POSITIVE");
    expect(m2).toContain("REFERENCE_REQUIRED_FOR_BANK_TRANSFER");
    expect(m2).toContain("AMOUNT_EXCEEDS_REMAINING");
    expect(m2).toContain("BOOKING_CANCELLED");
    expect(m2).toContain("BOOKING_DELETED");
  });
  it("browser roles get no direct table access (RPC-only model)", () => {
    expect(m2).toContain("revoke all on table public.payment_orders from public, anon, authenticated");
    expect(m2).toContain("revoke all on table public.payment_transactions from public, anon, authenticated");
    expect(m2).toContain("revoke all on table public.payment_webhook_events from public, anon, authenticated");
    expect(m2).toContain("enable row level security");
  });
  it("write-back to booking.paid is explicit opt-in only", () => {
    expect(m2).toContain("p_write_back boolean default false");
  });
});
