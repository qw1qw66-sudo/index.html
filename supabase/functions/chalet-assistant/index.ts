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
//
// ASSISTANT_CONFIRM_SECRET is MANDATORY for any sensitive action (there is no
// fallback); without it the handler fails those closed.

import { createClient } from "npm:@supabase/supabase-js@2";
import { handleAssistant } from "./handler.mjs";
import { callDeepSeek } from "../_shared/assistant/deepseek.mjs";
import { redactObject } from "../_shared/assistant/redact.mjs";
import { executeConfirmedAction } from "../_shared/assistant/executors.mjs";
import { corsWrap } from "../_shared/cors.mjs";
import { riyadhToday, addDays, availablePeriodsOn, isSlotAvailable } from "../_shared/assistant/availability.mjs";
import { chaletCatalog, resolveBookingCreateArgs as resolveBookingCreateSelection, resolveChaletReference } from "../_shared/assistant/booking-resolution.mjs";

// deno-lint-ignore no-explicit-any
declare const Deno: any;

function makeDeps() {
  const env = Deno.env.toObject();
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const nowMs = Date.now();

  async function workspaceDoc(wsKey: string) {
    const { data } = await supabase.from("shared_workspaces").select("data, updated_at").eq("workspace_key", wsKey).maybeSingle();
    return data;
  }

  // Net-paid halalas per booking straight from the ledger view (NOT booking.paid).
  async function ledgerTotals(wsKey: string) {
    const { data } = await supabase.from("v_booking_payment_totals")
      .select("booking_id, net_paid_halalas, gross_paid_halalas, refunded_halalas").eq("workspace_key", wsKey);
    const m = new Map<string, { net: number; gross: number; refunded: number }>();
    for (const r of data ?? []) m.set(String(r.booking_id), { net: Number(r.net_paid_halalas) || 0, gross: Number(r.gross_paid_halalas) || 0, refunded: Number(r.refunded_halalas) || 0 });
    return m;
  }

  // Ledger-backed outstanding balances (source of truth = payment_transactions).
  async function outstandingFromLedger(wsKey: string) {
    const d = await workspaceDoc(wsKey);
    const bookings = ((d?.data?.bookings ?? []) as Array<Record<string, unknown>>).filter((b) => !b.deleted_at && b.status !== "cancelled");
    const totals = await ledgerTotals(wsKey);
    const rows = bookings.map((b) => {
      const totalHalalas = Math.round((Number(b.total) || 0) * 100);
      const net = totals.get(String(b.id))?.net ?? 0;
      const remaining = totalHalalas - net;
      return { booking_id: b.id, customer_name: b.customer_name, booking_date: b.booking_date, chalet_id: b.chalet_id, total_halalas: totalHalalas, net_paid_halalas: net, remaining_halalas: remaining };
    }).filter((r) => r.remaining_halalas > 0)
      .sort((a, b) => b.remaining_halalas - a.remaining_halalas);
    return { source: "ledger", bookings: rows };
  }

  async function recentPayments(wsKey: string, args: Record<string, unknown>) {
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 10));
    const { data } = await supabase.from("payment_transactions")
      .select("id, booking_id, transaction_type, payment_method, direction, amount_halalas, currency, status, occurred_at, provider")
      .eq("workspace_key", wsKey).order("occurred_at", { ascending: false }).limit(limit);
    return { source: "ledger", payments: data ?? [] };
  }

  async function automationStatus(wsKey: string) {
    const { data } = await supabase.from("automation_rules")
      .select("id, chalet_id, enabled, scan_days_ahead, minimum_price_halalas, maximum_daily_messages, contact_cooldown_hours, automatic_send_enabled, owner_approval_required, updated_at")
      .eq("workspace_key", wsKey);
    return { rules: data ?? [] };
  }

  async function campaignResults(wsKey: string, args: Record<string, unknown>) {
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 5));
    const { data } = await supabase.from("automation_runs")
      .select("id, rule_id, vacancy_key, status, eligible_contacts, drafted_messages, approved_messages, sent_messages, converted_booking_id, attributed_revenue_halalas, started_at, completed_at")
      .eq("workspace_key", wsKey).order("started_at", { ascending: false }).limit(limit);
    return { runs: data ?? [] };
  }

  async function attributedRevenue(wsKey: string) {
    const { data } = await supabase.from("automation_runs")
      .select("attributed_revenue_halalas, converted_booking_id, sent_messages").eq("workspace_key", wsKey);
    let revenue = 0; let conversions = 0; let sent = 0;
    for (const r of data ?? []) {
      revenue += Number(r.attributed_revenue_halalas) || 0;
      if (r.converted_booking_id) conversions++;
      sent += Number(r.sent_messages) || 0;
    }
    return { attributed_revenue_halalas: revenue, conversions, messages_sent: sent };
  }

  async function outboundStatus(wsKey: string, args: Record<string, unknown>) {
    const { data } = await supabase.from("outbound_messages")
      .select("id, booking_id, channel, mode, status, created_at, sent_at, delivered_at, failed_at")
      .eq("workspace_key", wsKey).eq("id", args.message_id).maybeSingle();
    return data ?? { error: "NOT_FOUND" };
  }

  // Ledger-aware facts for message drafting (remaining from the ledger).
  async function bookingDraftFacts(wsKey: string, bookingId: string, intent?: string) {
    const d = await workspaceDoc(wsKey);
    const doc = (d?.data ?? {}) as { chalets?: Array<Record<string, unknown>>; bookings?: Array<Record<string, unknown>> };
    const b = (doc.bookings ?? []).find((x) => x.id === bookingId && !x.deleted_at);
    if (!b) return { error: "NOT_FOUND" };
    const chalet = (doc.chalets ?? []).find((c) => c.id === b.chalet_id);
    const period = ((chalet?.periods ?? []) as Array<Record<string, unknown>>).find((p) => p.id === b.period_id);
    const totalHalalas = Math.round((Number(b.total) || 0) * 100);
    const net = (await ledgerTotals(wsKey)).get(String(b.id))?.net ?? 0;
    return {
      booking_id: b.id, customer_name: b.customer_name, booking_date: b.booking_date,
      chalet_name: chalet?.name ?? "", period_label: period?.label ?? "",
      total_halalas: totalHalalas, net_paid_halalas: net, remaining_halalas: totalHalalas - net,
      intent: intent ?? "",
    };
  }

  return {
    env,
    newId: () => crypto.randomUUID(),
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

    // ---- thread lifecycle (workspace-scoped) ----
    async createThread(wsKey: string, title: string) {
      const { data, error } = await supabase.from("assistant_threads")
        .insert({ workspace_key: wsKey, title: String(title || "").slice(0, 120) }).select("id").single();
      if (error || !data) return { ok: false, error: "THREAD_CREATE_FAILED" };
      return { ok: true, thread_id: data.id };
    },
    async listThreads(wsKey: string) {
      const { data } = await supabase.from("assistant_threads")
        .select("id, title, status, updated_at").eq("workspace_key", wsKey)
        .order("updated_at", { ascending: false }).limit(50);
      return data ?? [];
    },
    async archiveThread(wsKey: string, threadId: string) {
      const { data, error } = await supabase.from("assistant_threads")
        .update({ status: "archived", updated_at: new Date().toISOString() })
        .eq("workspace_key", wsKey).eq("id", threadId).select("id");
      if (error) return { ok: false, error: "THREAD_ARCHIVE_FAILED" };
      if (!data || data.length !== 1) return { ok: false, error: "THREAD_NOT_FOUND" };
      return { ok: true };
    },
    async threadBelongsToWorkspace(wsKey: string, threadId: string) {
      const { data } = await supabase.from("assistant_threads")
        .select("id").eq("workspace_key", wsKey).eq("id", threadId).maybeSingle();
      return Boolean(data);
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
      const { error } = await supabase.from("assistant_messages").insert(rows.map((r) => ({ ...r, workspace_key: wsKey, thread_id: threadId })));
      if (error) throw { code: (error as { code?: string }).code ?? "APPEND_FAILED" };
    },
    async getWorkspaceRevision(wsKey: string) {
      const d = await workspaceDoc(wsKey);
      return d?.updated_at ?? null;
    },

    async resolveBookingCreateArgs(wsKey: string, args: Record<string, unknown>) {
      const d = await workspaceDoc(wsKey);
      if (!d?.data) return { ok: false, error: "WORKSPACE_NOT_FOUND", reason_ar: "تعذّر قراءة بيانات المساحة. لم يتم تجهيز أي حجز." };
      return resolveBookingCreateSelection(d.data, args);
    },

    // ---- read tools: real data only; unimplemented tools cannot exist (every
    // registered read tool is handled). The PIN is forwarded so ledger RPCs
    // re-authenticate the SAME workspace/pin the request already proved. ----
    async runReadTool(wsKey: string, name: string, args: Record<string, unknown>, pin: string) {
      switch (name) {
        case "get_booking_payment_history":
        case "get_payment_link_status": {
          const { data } = await supabase.rpc("get_booking_payments", {
            p_workspace_key: wsKey, p_access_pin: pin, p_booking_id: args.booking_id,
          });
          return redactObject(data ?? { error: "NO_DATA" });
        }
        case "list_outstanding_balances": return redactObject(await outstandingFromLedger(wsKey));
        case "list_recent_payments": return redactObject(await recentPayments(wsKey, args));
        case "get_automation_status": return redactObject(await automationStatus(wsKey));
        case "get_campaign_results": return redactObject(await campaignResults(wsKey, args));
        case "get_attributed_revenue": return redactObject(await attributedRevenue(wsKey));
        case "get_outbound_message_status": return redactObject(await outboundStatus(wsKey, args));
        case "draft_payment_reminder": {
          const facts = await bookingDraftFacts(wsKey, String(args.booking_id || ""));
          return redactObject(buildDraft("draft_payment_reminder", facts));
        }
        case "draft_booking_confirmation": {
          const facts = await bookingDraftFacts(wsKey, String(args.booking_id || ""));
          return redactObject(buildDraft("draft_booking_confirmation", facts));
        }
        case "draft_customer_message": {
          const facts = await bookingDraftFacts(wsKey, String(args.booking_id || ""), String(args.intent || ""));
          return redactObject(buildDraft("draft_customer_message", facts));
        }
        default: {
          const d = await workspaceDoc(wsKey);
          const doc = d?.data ?? {};
          return redactObject(readFromDoc(name, args, doc, nowMs));
        }
      }
    },

    async prepareSensitive(wsKey: string, spec: Record<string, unknown>) {
      const { data, error } = await supabase.from("assistant_actions").insert({
        workspace_key: wsKey,
        action_type: spec.actionType,
        tool_name: spec.name,
        normalized_payload_json: { tool: spec.name, args: spec.args },
        payload_hash: spec.payloadHash,
        confirmation_token_hash: spec.tokenHash,
        confirmation_expires_at: new Date(spec.expiresAtMs as number).toISOString(),
        expected_workspace_revision: spec.expectedRevision ?? null,
        thread_id: (spec.threadId as string | null) ?? null,
        status: "prepared",
      }).select("id").single();
      if (error || !data) throw { code: (error as { code?: string })?.code ?? "PREPARE_FAILED" };
      return { action_id: data.id };
    },
    // The booking pipeline reads the authoritative document once per turn.
    async getWorkspaceData(wsKey: string) {
      const d = await workspaceDoc(wsKey);
      return d ? { data: d.data, updated_at: d.updated_at } : null;
    },
    async getConfirmationContext(wsKey: string, actionId: string) {
      const { data } = await supabase.from("assistant_actions")
        .select("id, tool_name, action_type, normalized_payload_json, workspace_key, status, thread_id, payload_hash, confirmation_expires_at, expected_workspace_revision")
        .eq("id", actionId).eq("workspace_key", wsKey).maybeSingle();
      if (!data) return null;
      return {
        action: data,
        tool_name: data.tool_name,
        action_type: data.action_type,
        normalized_payload: data.normalized_payload_json,
        thread_id: data.thread_id,
        payload_hash: data.payload_hash,
        confirmation_expires_at: data.confirmation_expires_at,
        expected_workspace_revision: data.expected_workspace_revision,
        status: data.status,
      };
    },
    // Latest still-pending prepared action for refresh recovery (§ pending
    // work must survive a reload WITHOUT tokens ever touching storage). When a
    // threadId is given (typed «سجل» inside a conversation), only THAT
    // thread's pending action is considered — never another conversation's.
    async getLatestPreparedAction(wsKey: string, threadId?: string | null) {
      let q = supabase.from("assistant_actions")
        .select("id, tool_name, action_type, normalized_payload_json, thread_id, confirmation_expires_at, expected_workspace_revision, status, confirmation_used_at")
        .eq("workspace_key", wsKey).eq("status", "prepared").is("confirmation_used_at", null);
      if (threadId) q = q.eq("thread_id", threadId);
      const { data } = await q.order("created_at", { ascending: false }).limit(1).maybeSingle();
      return data ?? null;
    },
    // Rotate the confirmation credentials of a still-prepared action in place
    // (fresh token + expiry; same payload hash, same expected revision). The
    // old token stops working because only the new hash is stored.
    async rotateConfirmation(wsKey: string, actionId: string, patch: { tokenHash: string; expiresAtMs: number }) {
      const { data, error } = await supabase.from("assistant_actions")
        .update({ confirmation_token_hash: patch.tokenHash, confirmation_expires_at: new Date(patch.expiresAtMs).toISOString(), updated_at: new Date().toISOString() })
        .eq("id", actionId).eq("workspace_key", wsKey).eq("status", "prepared").is("confirmation_used_at", null)
        .select("id");
      if (error || !data || data.length !== 1) return { ok: false, error: "ROTATE_FAILED" };
      return { ok: true };
    },
    // ------- Booking Draft store (server-owned, thread-scoped; private jsonb
    // carries ONLY the phone and is never selected into model/history paths).
    async getActiveDraft(wsKey: string, threadId: string) {
      const { data } = await supabase.from("assistant_booking_drafts")
        .select("id, fields, status, linked_action_id, updated_at")
        .eq("workspace_key", wsKey).eq("thread_id", threadId).eq("status", "active").maybeSingle();
      return data ?? null;
    },
    async getDraftPrivate(wsKey: string, threadId: string) {
      const { data } = await supabase.from("assistant_booking_drafts")
        .select("private").eq("workspace_key", wsKey).eq("thread_id", threadId).eq("status", "active").maybeSingle();
      return (data && (data.private as Record<string, unknown>)) || {};
    },
    async upsertDraft(wsKey: string, threadId: string, fields: Record<string, unknown>, privateFields: Record<string, unknown> | null, linkedActionId?: string | null) {
      const existing = await this.getActiveDraft(wsKey, threadId);
      if (existing) {
        const patch: Record<string, unknown> = { fields, updated_at: new Date().toISOString() };
        if (privateFields) patch.private = privateFields;
        if (linkedActionId !== undefined) patch.linked_action_id = linkedActionId;
        const { error } = await supabase.from("assistant_booking_drafts")
          .update(patch).eq("id", (existing as { id: string }).id).eq("workspace_key", wsKey);
        if (error) throw { code: "DRAFT_SAVE_FAILED" };
        return { draft_id: (existing as { id: string }).id };
      }
      const { data, error } = await supabase.from("assistant_booking_drafts")
        .insert({ workspace_key: wsKey, thread_id: threadId, fields, private: privateFields || {}, linked_action_id: linkedActionId ?? null, status: "active" })
        .select("id").single();
      if (error || !data) throw { code: "DRAFT_SAVE_FAILED" };
      return { draft_id: data.id };
    },
    async closeDraft(wsKey: string, threadId: string, status: "completed" | "cancelled") {
      await supabase.from("assistant_booking_drafts")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("workspace_key", wsKey).eq("thread_id", threadId).eq("status", "active");
    },
    async consumeConfirmation(wsKey: string, actionId: string, tokenHash: string, payloadHash: string, currentRevision: string | null) {
      const { data } = await supabase.rpc("assistant_consume_confirmation", {
        p_action_id: actionId, p_workspace_key: wsKey, p_token_hash: tokenHash,
        p_payload_hash: payloadHash, p_current_workspace_revision: currentRevision,
      });
      return data ?? { ok: false, error: "CONSUME_FAILED" };
    },
    async getActionOutcome(wsKey: string, actionId: string) {
      const { data } = await supabase.from("assistant_actions")
        .select("status, safe_result_json, error_code").eq("id", actionId).eq("workspace_key", wsKey).maybeSingle();
      return data ? { status: data.status, safe_result: data.safe_result_json, error_code: data.error_code } : {};
    },
    // Recover an action left "running" by a crash between confirm and finalize:
    // report its stored outcome so the caller can replay safely.
    async getRunningAction(wsKey: string, actionId: string) {
      const { data } = await supabase.from("assistant_actions")
        .select("status, tool_name, action_type, normalized_payload_json").eq("id", actionId).eq("workspace_key", wsKey).maybeSingle();
      return data ?? null;
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
          const { data, error } = await supabase.rpc("get_booking_payments", { p_workspace_key: k, p_access_pin: pin, p_booking_id: bookingId });
          if (error) return { ok: false, error: "PAYMENT_READ_" + ((error as { code?: string }).code ?? "FAILED") };
          if (!data) return { ok: false, error: "PAYMENT_READ_EMPTY" };
          return data;
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
    // Finalize an action's outcome — ALWAYS scoped to (workspace_key, id) and
    // verified to touch exactly one row.
    async finalizeAction(wsKey: string, actionId: string, patch: Record<string, unknown>) {
      const { data, error } = await supabase.from("assistant_actions")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", actionId).eq("workspace_key", wsKey).select("id");
      if (error) throw { code: (error as { code?: string }).code ?? "FINALIZE_FAILED" };
      if (!data || data.length !== 1) throw { code: "FINALIZE_ROW_MISMATCH" };
    },
  };
}

// Deterministic Arabic drafts from ledger-aware facts. The model may refine
// these in the second stage; even without it the owner gets usable text.
function riyals(halalas: unknown) { return ((Number(halalas) || 0) / 100).toFixed(2); }
function buildDraft(kind: string, facts: Record<string, unknown>) {
  if (facts && (facts as { error?: string }).error) return facts;
  const name = String(facts.customer_name || "").trim() || "عميلنا الكريم";
  const date = String(facts.booking_date || "");
  const chalet = String(facts.chalet_name || "");
  const period = String(facts.period_label || "");
  const remaining = Number(facts.remaining_halalas) || 0;
  let draft = "";
  if (kind === "draft_booking_confirmation") {
    draft = `مرحباً ${name}، تم تأكيد حجزك في ${chalet}${period ? ` (${period})` : ""} بتاريخ ${date}. بانتظارك، وأي استفسار نحن في الخدمة.`;
  } else if (kind === "draft_payment_reminder") {
    draft = remaining > 0
      ? `مرحباً ${name}، تذكير ودّي بخصوص حجز ${date}: المبلغ المتبقّي ${riyals(remaining)} ر.س. نقدّر إتمام السداد قبل الموعد. شكراً لك.`
      : `مرحباً ${name}، شكراً لك — لا يوجد مبلغ متبقٍ على حجز ${date}.`;
  } else {
    const intent = String(facts.intent || "").trim();
    draft = `مرحباً ${name}${intent ? `، بخصوص: ${intent}` : ""}. بخصوص حجزك بتاريخ ${date}${chalet ? ` في ${chalet}` : ""}، نحن في الخدمة لأي استفسار.`;
  }
  return { ...facts, draft };
}

// Pure document reads (authoritative source). All REAL workspace data; phone
// numbers are redacted by the caller before anything is returned/sent to the
// model. "today"/date math use Asia/Riyadh, and availability uses time-overlap.
function readFromDoc(name: string, args: Record<string, unknown>, doc: { chalets?: unknown[]; bookings?: unknown[] }, nowMs: number) {
  const bookings = (doc.bookings ?? []) as Array<Record<string, unknown>>;
  const chalets = (doc.chalets ?? []) as Array<Record<string, unknown>>;
  const activeB = bookings.filter((b) => !b.deleted_at);
  const activeC = chalets.filter((c) => !c.deleted_at);
  const today = riyadhToday(nowMs);
  switch (name) {
    case "get_today_bookings":
      return { date: today, bookings: activeB.filter((b) => b.booking_date === today) };
    case "list_chalets":
      return chaletCatalog(doc);
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
    case "get_booking_details":
      return activeB.find((b) => b.id === args.booking_id) ?? { error: "NOT_FOUND" };
    case "find_bookings": {
      // Owner lookup by a name fragment or the LAST digits of a phone.
      // Phones never leave masked: «05••••1234». Cap 5 rows, newest first.
      const nameQ = String(args.customer_name || "").trim().toLowerCase();
      const suffix = String(args.phone_suffix || "").replace(/\D/g, "");
      if (!nameQ && !suffix) return { bookings: [], hint: "EMPTY_QUERY" };
      const maskPhone = (p: unknown) => {
        // Same semantics as booking-planner.maskPhone: numbers shorter than 7
        // digits are FULLY hidden (2+4 revealed digits would disclose them).
        const d = String(p || "").replace(/\D/g, "");
        if (!d) return "";
        if (d.length < 7) return "•".repeat(d.length);
        return d.slice(0, 2) + "••••" + d.slice(-4);
      };
      const hits = activeB
        .filter((b) => {
          const nm = String(b.customer_name || "").toLowerCase();
          const ph = String(b.customer_phone || "").replace(/\D/g, "");
          if (nameQ && !nm.includes(nameQ)) return false;
          if (suffix && !(ph && ph.endsWith(suffix))) return false;
          return true;
        })
        .sort((a, b) => String(b.booking_date).localeCompare(String(a.booking_date)))
        .slice(0, 5)
        .map((b) => ({
          booking_id: b.id,
          customer_name: b.customer_name,
          phone_masked: maskPhone(b.customer_phone),
          booking_date: b.booking_date,
          chalet_id: b.chalet_id,
          period_id: b.period_id,
          status: b.status,
          total: b.total,
          paid: b.paid,
        }));
      return { bookings: hits, masked: true };
    }
    case "get_chalet_details":
      return activeC.find((c) => c.id === args.chalet_id) ?? { error: "NOT_FOUND" };
    case "find_available_periods": {
      const date = String(args.date || today);
      const resolved = resolveChaletReference(doc, args);
      if (!resolved.ok) return resolved;
      const result = availablePeriodsOn(doc as never, String(resolved.chalet.id || ""), date);
      return { ...result, chalet_name: resolved.chalet.name };
    }
    case "find_empty_dates": {
      const daysAhead = Math.max(1, Math.min(120, Number(args.days_ahead) || 14));
      let selected = activeC;
      if (args.chalet_id || args.chalet_name) {
        const resolved = resolveChaletReference(doc, args);
        if (!resolved.ok) return resolved;
        selected = [resolved.chalet];
      }
      const out: Array<Record<string, unknown>> = [];
      for (let i = 0; i < daysAhead && out.length < 100; i++) {
        const dt = addDays(today, i);
        for (const chalet of selected) {
          const cid = String(chalet.id || "");
          for (const p of ((chalet.periods ?? []) as Array<Record<string, unknown>>).filter((x) => x.active !== false)) {
            if (isSlotAvailable(doc as never, cid, dt, p)) out.push({ chalet_id: cid, chalet_name: chalet.name, date: dt, period_id: p.id, period_label: p.label });
          }
        }
      }
      return { empty: out.slice(0, 100) };
    }
    case "draft_vacancy_offer": {
      const chalet = activeC.find((c) => c.id === args.chalet_id);
      if (!chalet) return { error: "NOT_FOUND" };
      const date = String(args.date || "");
      return { chalet_id: chalet.id, chalet_name: chalet.name, date, draft: `فرصة متاحة في ${chalet.name}${date ? ` بتاريخ ${date}` : ""} — تواصل معنا للحجز قبل نفاد الموعد.` };
    }
    default:
      // Every registered read tool is handled above; anything else is a
      // programming error (a tool advertised but not implemented).
      return { error: "TOOL_NOT_IMPLEMENTED", tool: name };
  }
}

// Browser-facing: preflight + CORS on every response (allowlisted origins).
Deno.serve((req: Request) => corsWrap(req, Deno.env.toObject(), () => handleAssistant(req, makeDeps())));
