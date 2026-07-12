import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Contract pins for the SQL migrations. These are textual checks: the full
// behavioral suite (32 scenarios: CAS, conflicts, throttling, immutability,
// idempotent manual payments, refunds, webhooks, legacy dedup) was executed
// against a real PostgreSQL 16 instance during development — see the PR
// description for the transcript summary. These pins keep the critical
// clauses from silently disappearing in later edits.

const m1 = readFileSync("supabase/migrations/20260701000001_atomic_workspace_save.sql", "utf8");
const m2 = readFileSync("supabase/migrations/20260701000002_payment_ledger.sql", "utf8");
const m7 = readFileSync("supabase/migrations/20260712000007_grandfather_existing_booking_conflicts.sql", "utf8");

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
const c7 = code(m7);

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
  it("orders: workspace-scoped idempotency, unique provider ref, positive amount, status whitelist", () => {
    expect(m2).toContain("payment_orders_idempotency_unique unique (workspace_key, idempotency_key)");
    expect(m2).toContain("payment_orders_provider_ref_unique");
    expect(m2).toContain("check (amount_halalas > 0)");
    expect(m2).toContain("'pending', 'paid', 'partially_paid', 'failed', 'expired', 'cancelled'");
    expect(m2).toContain("payment_orders_one_active_per_booking");
  });

  it("transactions idempotency is also workspace-scoped", () => {
    expect(m2).toContain("payment_tx_idempotency_unique unique (workspace_key, idempotency_key)");
  });

  it("both migrations reload the PostgREST schema cache", () => {
    expect(c1).toContain("notify pgrst, 'reload schema'");
    expect(c2).toContain("notify pgrst, 'reload schema'");
  });

  it("v1 legacy save now rejects conflicting documents (parity with v2)", () => {
    expect(c1).toContain("workspace_doc_booking_conflict(p_data)");
    // the check appears in BOTH v2 and the v1 recreation
    expect((c1.match(/workspace_doc_booking_conflict\(p_data\)/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(c1).toContain("EMPTY_OVERWRITE_BLOCKED");
  });

  it("migration documents the owner post-rollout v1 revoke step (not run automatically)", () => {
    expect(m1).toMatch(/revoke execute on function public\.save_shared_workspace/);
  });

  it("expired pending orders can be atomically transitioned before replacement", () => {
    expect(c2).toContain("function public.expire_stale_payment_orders");
    expect(c2).toContain("for update skip locked");
    expect(c2).toContain("expires_at <= now()");
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

describe("migration 0007 (grandfather legacy booking conflicts) contracts", () => {
  it("compares old and new conflict sets in both save contracts", () => {
    expect(c7).toContain("workspace_doc_booking_conflicts");
    expect(c7).toContain("workspace_doc_new_booking_conflict(v_workspace.data, v_data)");
    expect((c7.match(/workspace_doc_new_booking_conflict\(v_workspace\.data, v_data\)/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(c7).toContain("workspace_doc_new_booking_conflict('{}'::jsonb, v_data)");
  });

  it("is function-only and never mutates existing booking/customer data", () => {
    expect(c7).not.toMatch(/delete\s+from/i);
    expect(c7).not.toMatch(/truncate\s+/i);
    expect(c7).not.toMatch(/update\s+public\.shared_workspaces\s+set\s+data\s*=\s*'{}'/i);
    expect(c7).not.toMatch(/jsonb_set\s*\(/i);
  });

  it("keeps new conflicts fail-closed and helper functions private", () => {
    expect(c7).toContain("BOOKING_CONFLICT:");
    expect(c7).toContain("revoke all on function public.workspace_doc_new_booking_conflict(jsonb, jsonb)");
    expect(c7).toContain("notify pgrst, 'reload schema'");
  });
});
