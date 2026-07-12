import { readFileSync } from "node:fs";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { handleAssistant } from "../../supabase/functions/chalet-assistant/handler.mjs";
import { executeConfirmedAction } from "../../supabase/functions/_shared/assistant/executors.mjs";
import { randomUUID } from "node:crypto";

// REAL end-to-end: the actual chalet-assistant handler + the real
// executeConfirmedAction dispatcher, driven against a REAL PostgreSQL 16 with
// the migration chain needed by these contracts (through 0007) and the ACTUAL
// RPCs (workspace_auth, assistant_consume_confirmation, save_shared_workspace_v2,
// record_manual_payment, get_booking_payments). Proves confirmed actions write
// real rows — not a scaffold, not only mocks.
//
// Skips gracefully when no local Postgres is reachable (e.g. default CI, which
// has no database). Point it at a cluster with:
//   ASSIST_PG_HOST (socket dir or host, default /home/pguser/pgsock)
//   ASSIST_PG_PORT (default 5433)   ASSIST_PG_USER (default postgres)
const HOST = process.env.ASSIST_PG_HOST || "/home/pguser/pgsock";
const PORT = Number(process.env.ASSIST_PG_PORT || 5433);
const USER = process.env.ASSIST_PG_USER || "postgres";
const DB = "assist_it";
const SECRET = "it-secret";

async function canConnect() {
  const c = new pg.Client({ host: HOST, port: PORT, user: USER, database: "postgres", connectionTimeoutMillis: 1500 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

const AVAILABLE = await canConnect();
const d = AVAILABLE ? describe : describe.skip;

d("REAL Postgres: confirmed assistant actions write real rows", () => {
  let pool;

  beforeAll(async () => {
    const admin = new pg.Client({ host: HOST, port: PORT, user: USER, database: "postgres" });
    await admin.connect();
    await admin.query(`drop database if exists ${DB}`);
    await admin.query(`create database ${DB}`);
    await admin.end();
    pool = new pg.Pool({ host: HOST, port: PORT, user: USER, database: DB });
    for (const f of [
      "database/shared_workspace_sync.sql",
      "supabase/migrations/20260701000001_atomic_workspace_save.sql",
      "supabase/migrations/20260701000002_payment_ledger.sql",
      "supabase/migrations/20260711000003_chalet_assistant.sql",
      "supabase/migrations/20260712000007_grandfather_existing_booking_conflicts.sql",
    ]) {
      await pool.query(readFileSync(f, "utf8"));
    }
    // Seed a workspace with one chalet/period and one confirmed booking.
    const doc = {
      schema_version: 3, settings: {},
      chalets: [{ id: "c1", name: "شاليه", deleted_at: null, periods: [{ id: "p1", label: "صباحي", start: "07:00", end: "17:00", active: true, sort: 1 }] }],
      bookings: [{ id: "b1", customer_name: "علي", customer_phone: "0501234567", chalet_id: "c1", booking_date: "2099-06-01", period_id: "p1", total: 900, paid: 0, status: "confirmed", deleted_at: null }],
    };
    await pool.query("select public.create_shared_workspace($1,$2,$3::jsonb)", ["WSREAL", "123456", JSON.stringify(doc)]);
  });

  afterAll(async () => { if (pool) await pool.end(); });

  // deps wired to the REAL RPCs.
  function makeDeps() {
    const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);
    const execDeps = {
      env: {},
      newId: () => randomUUID(),
      async getWorkspaceDoc(k) {
        // Read updated_at as TEXT to preserve Postgres microsecond precision
        // (the node-pg driver would truncate a timestamptz to ms via JS Date;
        // supabase-js returns the full ISO string, so production is unaffected).
        const rows = await q("select data, updated_at::text as updated_at from public.shared_workspaces where workspace_key=$1", [k]);
        return rows[0] ? { data: rows[0].data, updated_at: rows[0].updated_at } : null;
      },
      async saveWorkspaceV2(k, pin, data, expectedRevision) {
        const rows = await q("select public.save_shared_workspace_v2($1,$2,$3::jsonb,$4::timestamptz) as r", [k, pin, JSON.stringify(data), expectedRevision]);
        const r = rows[0].r;
        return r.ok ? { ok: true, updated_at: r.updated_at } : { ok: false, error: r.error };
      },
      async recordManualPayment(k, pin, p) {
        const rows = await q("select public.record_manual_payment($1,$2,$3,$4,$5,$6,$7,now(),$8,false) as r",
          [k, pin, p.booking_id, p.amount_halalas, p.payment_method, p.actor_label, p.reason, p.idempotency_key]);
        const r = rows[0].r;
        return r.ok ? { ok: true, transaction_id: r.transaction_id, duplicate: Boolean(r.duplicate) } : { ok: false, error: r.error };
      },
      async createPaymentSession() { return { ok: false, error: "NO_PROVIDER_CONFIGURED" }; },
      async getBookingPayments(k, pin, bookingId) {
        const rows = await q("select public.get_booking_payments($1,$2,$3) as r", [k, pin, bookingId]);
        return rows[0].r;
      },
      async resolveCustomerPhone(k, _pin, bookingId) {
        const rows = await q("select b->>'customer_phone' as phone from public.shared_workspaces w, jsonb_array_elements(w.data->'bookings') b where w.workspace_key=$1 and b->>'id'=$2", [k, bookingId]);
        return rows[0] ? rows[0].phone : "";
      },
      async recordOutbound() {},
    };
    return {
      env: { ASSISTANT_CONFIRM_SECRET: SECRET },
      async auth(k, pin) {
        const rows = await q("select ok, error_code, workspace_key from public.workspace_auth($1,$2)", [k, pin]);
        return rows[0];
      },
      async callModel() { return { ok: true, reply: "", toolCalls: [] }; },
      async activeMemories() { return []; },
      async loadHistory() { return []; },
      async appendMessages() {},
      async getWorkspaceRevision(k) {
        const rows = await q("select updated_at::text as updated_at from public.shared_workspaces where workspace_key=$1", [k]);
        return rows[0] ? rows[0].updated_at : null;
      },
      async runReadTool() { return { ok: true }; },
      async prepareSensitive(k, spec) {
        const rows = await q(
          `insert into public.assistant_actions
           (workspace_key, action_type, tool_name, normalized_payload_json, payload_hash,
            confirmation_token_hash, confirmation_expires_at, expected_workspace_revision, status)
           values ($1,$2,$3,$4::jsonb,$5,$6,$7::timestamptz,$8::timestamptz,'prepared') returning id`,
          [k, spec.actionType, spec.name, JSON.stringify({ tool: spec.name, args: spec.args }), spec.payloadHash,
           spec.tokenHash, new Date(spec.expiresAtMs).toISOString(), spec.expectedRevision]);
        return { action_id: rows[0].id };
      },
      async getConfirmationContext(k, id) {
        const rows = await q("select id, tool_name, action_type, normalized_payload_json, workspace_key, status from public.assistant_actions where id=$1 and workspace_key=$2", [id, k]);
        if (!rows[0]) return null;
        return { action: rows[0], tool_name: rows[0].tool_name, action_type: rows[0].action_type, normalized_payload: rows[0].normalized_payload_json };
      },
      async consumeConfirmation(k, id, tokenHash, payloadHash, currentRevision) {
        const rows = await q("select public.assistant_consume_confirmation($1,$2,$3,$4,$5::timestamptz) as r", [id, k, tokenHash, payloadHash, currentRevision]);
        return rows[0].r;
      },
      async getActionOutcome(k, id) {
        const rows = await q("select status, safe_result_json, error_code from public.assistant_actions where id=$1 and workspace_key=$2", [id, k]);
        return rows[0] ? { status: rows[0].status, safe_result: rows[0].safe_result_json, error_code: rows[0].error_code } : {};
      },
      async executeConfirmed(k, action) {
        return await executeConfirmedAction({ wsKey: k, pin: action.pin, toolName: action.tool_name, payload: action.payload, actionId: action.action_id }, execDeps);
      },
      async finalizeAction(k, id, patch) {
        await pool.query("update public.assistant_actions set status=$2, safe_result_json=coalesce($3::jsonb, safe_result_json), error_code=coalesce($4, error_code), updated_at=now() where id=$1",
          [id, patch.status, patch.safe_result_json ? JSON.stringify(patch.safe_result_json) : null, patch.error_code ?? null]);
      },
    };
  }

  const call = (body) => handleAssistant(new Request("https://edge.local/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), makeDeps());
  const prep = async (name, args) => (await (await call({ workspace_key: "WSREAL", access_pin: "123456", invoke_tool: { name, arguments: args } })).json());
  const conf = async (name, action_id, confirmation_token) => (await (await call({ workspace_key: "WSREAL", access_pin: "123456", invoke_tool: { name, arguments: { action_id, confirmation_token } } })).json());

  it("confirmed manual payment writes a real payment_transactions row", async () => {
    const p = await prep("prepare_manual_payment", { booking_id: "b1", amount_halalas: 20000, payment_method: "cash", actor_label: "أبو علي" });
    const r = await conf("confirm_manual_payment", p.action_id, p.confirmation_token);
    expect(r.ok).toBe(true);
    expect(r.result.transaction_id).toBeTruthy();
    const rows = (await pool.query("select count(*)::int n, coalesce(sum(amount_halalas),0)::int s from public.payment_transactions where workspace_key='WSREAL' and booking_id='b1'")).rows[0];
    expect(rows.n).toBe(1);
    expect(rows.s).toBe(20000);
  });

  it("a replayed confirmation does NOT create a second real transaction", async () => {
    const p = await prep("prepare_manual_payment", { booking_id: "b1", amount_halalas: 10000, payment_method: "cash" });
    await conf("confirm_manual_payment", p.action_id, p.confirmation_token);
    const second = await conf("confirm_manual_payment", p.action_id, p.confirmation_token);
    expect(second.ok).toBe(true); // replayed stored result
    const n = (await pool.query("select count(*)::int n from public.payment_transactions where workspace_key='WSREAL' and idempotency_key=$1", ["assist:" + p.action_id])).rows[0].n;
    expect(n).toBe(1);
  });

  it("confirmed booking create writes a real booking through save_shared_workspace_v2", async () => {
    const p = await prep("prepare_booking_create", { customer_name: "عميل جديد", chalet_id: "c1", booking_date: "2099-12-25", period_id: "p1", guests: 2, total: 750 });
    const r = await conf("confirm_booking_create", p.action_id, p.confirmation_token);
    expect(r.ok).toBe(true);
    const rows = (await pool.query("select count(*)::int n from public.shared_workspaces w, jsonb_array_elements(w.data->'bookings') b where w.workspace_key='WSREAL' and b->>'customer_name'='عميل جديد'")).rows[0];
    expect(rows.n).toBe(1);
  });

  it("the assistant_actions row ends in status=succeeded with a safe result", async () => {
    const p = await prep("prepare_manual_payment", { booking_id: "b1", amount_halalas: 5000, payment_method: "cash" });
    await conf("confirm_manual_payment", p.action_id, p.confirmation_token);
    const row = (await pool.query("select status, safe_result_json from public.assistant_actions where id=$1", [p.action_id])).rows[0];
    expect(row.status).toBe("succeeded");
    expect(row.safe_result_json.action).toBe("manual_payment_recorded");
    // no PIN anywhere in the stored action
    expect(JSON.stringify(row)).not.toContain("123456");
  });

  it("a wrong PIN cannot execute against the real RPCs", async () => {
    const p = await prep("prepare_manual_payment", { booking_id: "b1", amount_halalas: 5000, payment_method: "cash" });
    const res = await call({ workspace_key: "WSREAL", access_pin: "000000", invoke_tool: { name: "confirm_manual_payment", arguments: { action_id: p.action_id, confirmation_token: p.confirmation_token } } });
    expect(res.status).toBe(401);
  });

  it("real save v2 allows an unrelated write beside a seeded legacy pair but rejects a new pair", async () => {
    const seeded = (await pool.query("select data from public.shared_workspaces where workspace_key='WSREAL'")).rows[0].data;
    seeded.chalets[0].periods.push({ id: "p2", label: "متداخلة", start: "16:00", end: "22:00", active: true, sort: 2 });
    seeded.bookings.push(
      { id: "legacy-a", customer_name: "قديم أ", chalet_id: "c1", booking_date: "2099-11-01", period_id: "p1", guests: 2, total: 100, paid: 0, status: "confirmed", deleted_at: null },
      { id: "legacy-b", customer_name: "قديم ب", chalet_id: "c1", booking_date: "2099-11-01", period_id: "p2", guests: 2, total: 100, paid: 0, status: "confirmed", deleted_at: null },
    );
    // Test fixture setup only: simulate a conflict that predates migration 0007.
    await pool.query("update public.shared_workspaces set data=$2::jsonb, updated_at=statement_timestamp() where workspace_key=$1", ["WSREAL", JSON.stringify(seeded)]);

    let snap = (await pool.query("select data, updated_at::text as rev from public.shared_workspaces where workspace_key='WSREAL'")).rows[0];
    const safe = structuredClone(snap.data);
    safe.bookings.push({ id: "safe-new", customer_name: "جديد آمن", chalet_id: "c1", booking_date: "2099-11-02", period_id: "p1", guests: 2, total: 100, paid: 0, status: "confirmed", deleted_at: null });
    let saved = (await pool.query("select public.save_shared_workspace_v2($1,$2,$3::jsonb,$4::timestamptz) r", ["WSREAL", "123456", JSON.stringify(safe), snap.rev])).rows[0].r;
    expect(saved.ok).toBe(true);

    snap = (await pool.query("select data, updated_at::text as rev from public.shared_workspaces where workspace_key='WSREAL'")).rows[0];
    const unsafe = structuredClone(snap.data);
    unsafe.bookings.push({ id: "bad-new", customer_name: "جديد متعارض", chalet_id: "c1", booking_date: "2099-11-01", period_id: "p1", guests: 2, total: 100, paid: 0, status: "confirmed", deleted_at: null });
    saved = (await pool.query("select public.save_shared_workspace_v2($1,$2,$3::jsonb,$4::timestamptz) r", ["WSREAL", "123456", JSON.stringify(unsafe), snap.rev])).rows[0].r;
    expect(saved.ok).toBe(false);
    expect(saved.error).toMatch(/^BOOKING_CONFLICT:/);
  });

  it("composite workspace FK blocks a message referencing another workspace's thread (Stage 5)", async () => {
    await pool.query("select public.create_shared_workspace($1,$2,$3::jsonb)", ["WS2", "654321", JSON.stringify({ schema_version: 3, settings: {}, chalets: [], bookings: [] })]);
    const t1 = (await pool.query("insert into public.assistant_threads(workspace_key,title) values('WSREAL','t') returning id")).rows[0].id;
    // Same workspace: allowed.
    await expect(pool.query("insert into public.assistant_messages(workspace_key,thread_id,role,safe_content) values('WSREAL',$1,'user','hi')", [t1])).resolves.toBeTruthy();
    // Cross-workspace: the composite (workspace_key, thread_id) FK rejects it.
    await expect(pool.query("insert into public.assistant_messages(workspace_key,thread_id,role,safe_content) values('WS2',$1,'user','x')", [t1])).rejects.toThrow();
  });

  it("automation_runs uniqueness is atomic and outbound links stay in-workspace (Stage 8)", async () => {
    const ruleId = (await pool.query("insert into public.automation_rules(workspace_key,chalet_id) values('WSREAL','cX') returning id")).rows[0].id;
    await pool.query("insert into public.automation_runs(workspace_key,rule_id,vacancy_key,idempotency_key) values('WSREAL',$1,'v','dupkey')", [ruleId]);
    // A second run with the same (workspace_key, idempotency_key) is rejected —
    // this uniqueness is the authoritative duplicate guard the planner relies on.
    await expect(pool.query("insert into public.automation_runs(workspace_key,rule_id,vacancy_key,idempotency_key) values('WSREAL',$1,'v','dupkey')", [ruleId])).rejects.toThrow();
    const runId = (await pool.query("select id from public.automation_runs where workspace_key='WSREAL' and idempotency_key='dupkey'")).rows[0].id;
    // An outbound message can link that run within the same workspace...
    await expect(pool.query("insert into public.outbound_messages(workspace_key,automation_run_id,status) values('WSREAL',$1,'awaiting_approval')", [runId])).resolves.toBeTruthy();
    // ...but not from a different workspace (composite FK).
    await expect(pool.query("insert into public.outbound_messages(workspace_key,automation_run_id,status) values('WS2',$1,'awaiting_approval')", [runId])).rejects.toThrow();
  });
});
