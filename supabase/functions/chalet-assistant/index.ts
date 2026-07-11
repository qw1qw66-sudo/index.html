// chalet-assistant — Supabase Edge Function (PREPARED, NOT DEPLOYED).
//
// Thin Deno wrapper: all safety logic is in handler.mjs (runtime-tested in
// Node/vitest). This injects DeepSeek + a Supabase service-role data layer.
// The browser NEVER calls DeepSeek directly; only this server function does,
// using DEEPSEEK_API_KEY (platform secret, never in the repo/browser).
//
// Deploy (owner, staging first — NOT done by this branch):
//   supabase functions deploy chalet-assistant
//   supabase secrets set DEEPSEEK_API_KEY=... DEEPSEEK_MODEL=deepseek-v4-flash \
//     DEEPSEEK_BASE_URL=https://api.deepseek.com ASSISTANT_CONFIRM_SECRET=...

import { createClient } from "npm:@supabase/supabase-js@2";
import { handleAssistant } from "./handler.mjs";
import { callDeepSeek } from "../_shared/assistant/deepseek.mjs";
import { redactObject } from "../_shared/assistant/redact.mjs";
import { executeConfirmedAction } from "../_shared/assistant/executors.mjs";

// deno-lint-ignore no-explicit-any
declare const Deno: any;

function makeDeps() {
  const env = Deno.env.toObject();
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  async function workspaceDoc(wsKey: string) {
    const { data } = await supabase.from("shared_workspaces").select("data, updated_at").eq("workspace_key", wsKey).maybeSingle();
    return data;
  }

  return {
    env,
    async auth(k: string, pin: string) {
      const { data } = await supabase.rpc("workspace_auth", { p_workspace_key: k, p_access_pin: pin }).single();
      return data ?? { ok: false, error_code: "AUTH_FAILED" };
    },
    async callModel({ systemPrompt, history }: { systemPrompt: string; history: unknown[] }) {
      return await callDeepSeek({ env, systemPrompt, history });
    },
    async activeMemories(wsKey: string) {
      const { data } = await supabase.from("assistant_memory")
        .select("memory_type, enforcement_level, status, content_json")
        .eq("workspace_key", wsKey).eq("status", "active");
      return data ?? [];
    },
    async loadHistory(wsKey: string, threadId: string | null) {
      if (!threadId) return [];
      const { data } = await supabase.from("assistant_messages")
        .select("role, safe_content").eq("workspace_key", wsKey).eq("thread_id", threadId)
        .order("created_at", { ascending: true }).limit(20);
      return (data ?? []).map((m: { role: string; safe_content: string }) => ({ role: m.role, content: m.safe_content }));
    },
    async appendMessages(wsKey: string, threadId: string | null, rows: Record<string, unknown>[]) {
      if (!threadId) return;
      await supabase.from("assistant_messages").insert(rows.map((r) => ({ ...r, workspace_key: wsKey, thread_id: threadId })));
    },
    async getWorkspaceRevision(wsKey: string) {
      const d = await workspaceDoc(wsKey);
      return d?.updated_at ?? null;
    },
    async runReadTool(wsKey: string, name: string, args: Record<string, unknown>) {
      // Read tools return only redacted, minimal data. Unimplemented tools
      // return an explicit marker — NEVER invented data.
      switch (name) {
        case "get_booking_payment_history":
        case "get_payment_link_status": {
          const { data } = await supabase.rpc("get_booking_payments", {
            p_workspace_key: wsKey, p_access_pin: null, p_booking_id: args.booking_id,
          });
          return redactObject(data ?? { error: "NO_DATA" });
        }
        default: {
          const d = await workspaceDoc(wsKey);
          const doc = d?.data ?? {};
          return redactObject(readFromDoc(name, args, doc));
        }
      }
    },
    async prepareSensitive(wsKey: string, spec: Record<string, unknown>) {
      const { data } = await supabase.from("assistant_actions").insert({
        workspace_key: wsKey,
        action_type: spec.actionType,
        tool_name: spec.name,
        normalized_payload_json: { tool: spec.name, args: spec.args },
        payload_hash: spec.payloadHash,
        confirmation_token_hash: spec.tokenHash,
        confirmation_expires_at: new Date(spec.expiresAtMs as number).toISOString(),
        expected_workspace_revision: spec.expectedRevision ?? null,
        status: "prepared",
      }).select("id").single();
      return { action_id: data?.id };
    },
    async getConfirmationContext(wsKey: string, actionId: string) {
      const { data } = await supabase.from("assistant_actions")
        .select("id, tool_name, action_type, normalized_payload_json, workspace_key, status")
        .eq("id", actionId).eq("workspace_key", wsKey).maybeSingle();
      if (!data) return null;
      return { action: data, tool_name: data.tool_name, action_type: data.action_type, normalized_payload: data.normalized_payload_json };
    },
    async consumeConfirmation(wsKey: string, actionId: string, tokenHash: string, payloadHash: string, currentRevision: string | null) {
      const { data } = await supabase.rpc("assistant_consume_confirmation", {
        p_action_id: actionId, p_workspace_key: wsKey, p_token_hash: tokenHash,
        p_payload_hash: payloadHash, p_current_workspace_revision: currentRevision,
      });
      return data ?? { ok: false, error: "CONSUME_FAILED" };
    },
    async getActionOutcome(_wsKey: string, actionId: string) {
      const { data } = await supabase.from("assistant_actions")
        .select("status, safe_result_json, error_code").eq("id", actionId).eq("workspace_key", _wsKey).maybeSingle();
      return data ? { status: data.status, safe_result: data.safe_result_json, error_code: data.error_code } : {};
    },
    // Route a CONFIRMED action through the shared narrow dispatcher and the
    // EXISTING contracts. No duplicate engines; the PIN is used only here.
    async executeConfirmed(wsKey: string, action: { tool_name: string; action_type: string; payload: { args: Record<string, unknown> }; action_id: string | null; pin: string }) {
      const execDeps = {
        env,
        newId: () => crypto.randomUUID(),
        async getWorkspaceDoc(k: string) {
          const d = await workspaceDoc(k);
          return d ? { data: d.data, updated_at: d.updated_at } : null;
        },
        async saveWorkspaceV2(k: string, pin: string, dataObj: unknown, expectedRevision: string) {
          const { data } = await supabase.rpc("save_shared_workspace_v2", {
            p_workspace_key: k, p_access_pin: pin, p_data: dataObj, p_expected_updated_at: expectedRevision,
          });
          if (data && data.ok) return { ok: true, updated_at: data.updated_at };
          return { ok: false, error: (data && data.error) || "SAVE_FAILED" };
        },
        async recordManualPayment(k: string, pin: string, p: Record<string, unknown>) {
          const { data } = await supabase.rpc("record_manual_payment", {
            p_workspace_key: k, p_access_pin: pin, p_booking_id: p.booking_id, p_amount_halalas: p.amount_halalas,
            p_payment_method: p.payment_method, p_actor_label: p.actor_label, p_reason: p.reason,
            p_idempotency_key: p.idempotency_key,
          });
          if (data && data.ok) return { ok: true, transaction_id: data.transaction_id, duplicate: data.duplicate };
          return { ok: false, error: (data && data.error) || "PAYMENT_FAILED" };
        },
        async createPaymentSession(k: string, pin: string, p: Record<string, unknown>) {
          // Reuse the EXISTING create-payment-session Edge Function (no duplicate).
          const res = await fetch(env.SUPABASE_URL + "/functions/v1/create-payment-session", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer " + env.SUPABASE_ANON_KEY, apikey: env.SUPABASE_ANON_KEY },
            body: JSON.stringify({ workspace_key: k, access_pin: pin, booking_id: p.booking_id, amount_halalas: p.amount_halalas, idempotency_key: p.idempotency_key }),
          });
          if (res.status === 404) return { ok: false, error: "NO_PROVIDER_CONFIGURED" };
          const b = await res.json().catch(() => null);
          return b && b.ok ? { ok: true, order: b.order } : { ok: false, error: (b && b.error) || "PAYMENT_LINK_FAILED" };
        },
        async getBookingPayments(k: string, pin: string, bookingId: string) {
          const { data } = await supabase.rpc("get_booking_payments", { p_workspace_key: k, p_access_pin: pin, p_booking_id: bookingId });
          return data ?? {};
        },
        async resolveCustomerPhone(k: string, _pin: string, bookingId: string) {
          const d = await workspaceDoc(k);
          const b = ((d?.data?.bookings ?? []) as Array<Record<string, unknown>>).find((x) => x.id === bookingId);
          return b ? String(b.customer_phone || "") : "";
        },
        async sendOfficialWhatsApp(_p: { to: string; body: string }) {
          // Official Cloud API send. Requires WHATSAPP_CLOUD_TOKEN + WHATSAPP_PHONE_ID
          // (kept server-side). Not exercised until the owner configures them.
          return { ok: false, error: "OFFICIAL_WHATSAPP_NOT_WIRED" };
        },
        async recordOutbound(k: string, row: Record<string, unknown>) {
          await supabase.from("outbound_messages").insert({ workspace_key: k, customer_reference: "", destination_ref: "", ...row });
        },
      };
      return await executeConfirmedAction(
        { wsKey, pin: action.pin, toolName: action.tool_name, payload: action.payload, actionId: action.action_id },
        execDeps,
      );
    },
    async finalizeAction(_wsKey: string, actionId: string, patch: Record<string, unknown>) {
      await supabase.from("assistant_actions").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", actionId);
    },
  };
}

// Read-from-document helpers (server-side, authoritative source). All return
// REAL workspace data (never demo values); phone numbers are redacted by the
// caller via redactObject before anything is returned or sent to the model.
function readFromDoc(name: string, args: Record<string, unknown>, doc: { chalets?: unknown[]; bookings?: unknown[] }) {
  const bookings = (doc.bookings ?? []) as Array<Record<string, unknown>>;
  const chalets = (doc.chalets ?? []) as Array<Record<string, unknown>>;
  const activeB = bookings.filter((b) => !b.deleted_at);
  const activeC = chalets.filter((c) => !c.deleted_at);
  const today = new Date().toISOString().slice(0, 10);
  const remaining = (b: Record<string, unknown>) => (Number(b.total) || 0) - (Number(b.paid) || 0);
  switch (name) {
    case "get_today_bookings":
      return { bookings: activeB.filter((b) => b.booking_date === today) };
    case "list_bookings": {
      const from = String(args.from || "");
      const to = String(args.to || "");
      const status = String(args.status || "");
      return {
        bookings: activeB.filter((b) =>
          (!from || String(b.booking_date) >= from) &&
          (!to || String(b.booking_date) <= to) &&
          (!status || b.status === status)),
      };
    }
    case "list_outstanding_balances":
      return { bookings: activeB.filter((b) => b.status !== "cancelled" && remaining(b) > 0) };
    case "get_booking_details":
      return activeB.find((b) => b.id === args.booking_id) ?? { error: "NOT_FOUND" };
    case "get_chalet_details":
      return activeC.find((c) => c.id === args.chalet_id) ?? { error: "NOT_FOUND" };
    case "find_available_periods": {
      const chalet = activeC.find((c) => c.id === args.chalet_id);
      if (!chalet) return { error: "NOT_FOUND" };
      const date = String(args.date || "");
      const periods = ((chalet.periods ?? []) as Array<Record<string, unknown>>).filter((p) => p.active);
      const taken = new Set(activeB.filter((b) => b.status === "confirmed" && b.chalet_id === chalet.id && b.booking_date === date).map((b) => b.period_id));
      return { chalet_id: chalet.id, date, available: periods.filter((p) => !taken.has(p.id)) };
    }
    case "find_empty_dates": {
      const daysAhead = Math.max(1, Math.min(120, Number(args.days_ahead) || 14));
      const chaletIds = args.chalet_id ? [String(args.chalet_id)] : activeC.map((c) => String(c.id));
      const out: Array<Record<string, unknown>> = [];
      for (let i = 0; i < daysAhead; i++) {
        const dt = new Date(Date.now() + i * 86400000).toISOString().slice(0, 10);
        for (const cid of chaletIds) {
          const chalet = activeC.find((c) => c.id === cid);
          if (!chalet) continue;
          for (const p of ((chalet.periods ?? []) as Array<Record<string, unknown>>).filter((x) => x.active)) {
            const booked = activeB.some((b) => b.status === "confirmed" && b.chalet_id === cid && b.booking_date === dt && b.period_id === p.id);
            if (!booked) out.push({ chalet_id: cid, date: dt, period_id: p.id });
          }
        }
      }
      return { empty: out.slice(0, 100) };
    }
    default:
      return { error: "TOOL_NOT_IMPLEMENTED", tool: name };
  }
}

Deno.serve((req: Request) => handleAssistant(req, makeDeps()));
