// chalet-autopilot — Supabase Edge Function (PREPARED, NOT DEPLOYED).
//
// Thin Deno wrapper for the vacancy-marketing planner (runtime-tested in
// Node/vitest via handler.mjs). Intended to be invoked on a schedule
// (supabase cron / pg_cron -> edge). Automation is OFF by default; nothing is
// auto-sent unless a rule is explicitly enabled AND official WhatsApp is
// configured — and even then this planner only QUEUES.
//
// This is an INTERNAL scheduled endpoint. It is NOT browser-facing and does NOT
// use permissive browser CORS. It is protected by AUTOPILOT_CRON_SECRET: the
// caller must present it in the x-autopilot-secret header (constant-time
// compared). With no secret configured the endpoint fails CLOSED.

import { createClient } from "npm:@supabase/supabase-js@2";
import { runAutopilot } from "./handler.mjs";
import { callDeepSeek } from "../_shared/assistant/deepseek.mjs";
import { customerReference } from "../_shared/assistant/redact.mjs";
import { detectMode } from "../_shared/assistant/whatsapp.mjs";
import { CHALET_SYSTEM_PROMPT } from "../_shared/assistant/system-prompt.mjs";
import { riyadhToday } from "../_shared/assistant/availability.mjs";

// deno-lint-ignore no-explicit-any
declare const Deno: any;

// Constant-time string comparison (length-independent) to avoid leaking the
// secret via timing. Never returns true for an empty configured secret.
function constantTimeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(String(a ?? ""));
  const eb = new TextEncoder().encode(String(b ?? ""));
  // Compare against a fixed-length buffer so length differences don't short-circuit.
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length, 1);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

function makeDeps() {
  const env = Deno.env.toObject();
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const nowMs = Date.now();
  const todayIso = riyadhToday(nowMs);
  // Start of the current Saudi day, as a UTC instant, for daily-cap counting.
  const saudiDayStartIso = new Date(`${todayIso}T00:00:00+03:00`).toISOString();

  return {
    nowMs,
    todayIso,
    async listEnabledRules() {
      const { data } = await supabase.from("automation_rules").select("*").eq("enabled", true);
      return data ?? [];
    },
    async getWorkspaceDoc(wsKey: string) {
      const { data } = await supabase.from("shared_workspaces").select("data").eq("workspace_key", wsKey).maybeSingle();
      return data?.data ?? null;
    },
    // Count messages already generated for this rule on the current Saudi day
    // (any status except those that never counted against the budget).
    async messagesSentToday(wsKey: string, ruleId: string, _todayIso: string) {
      const { data: runs } = await supabase.from("automation_runs").select("id").eq("workspace_key", wsKey).eq("rule_id", ruleId);
      const ids = (runs ?? []).map((r: { id: string }) => r.id);
      if (!ids.length) return 0;
      const { count } = await supabase.from("outbound_messages")
        .select("id", { count: "exact", head: true })
        .eq("workspace_key", wsKey).in("automation_run_id", ids)
        .gte("created_at", saudiDayStartIso)
        .not("status", "in", "(stopped_booked,skipped_opt_out)");
      return Number(count) || 0;
    },
    // ATOMIC run creation: insert and let the DB unique constraint decide. A
    // 23505 (unique_violation) means a run already owns this vacancy.
    async createRun(row: Record<string, unknown>) {
      const { data, error } = await supabase.from("automation_runs").insert(row).select("id").single();
      if (error) {
        if ((error as { code?: string }).code === "23505") return { duplicate: true };
        return { ok: false, error: (error as { code?: string }).code ?? "RUN_CREATE_FAILED" };
      }
      return { ok: true, run_id: data?.id };
    },
    async updateRun(runId: string, patch: Record<string, unknown>) {
      const { safe_summary_patch, ...cols } = patch as { safe_summary_patch?: Record<string, unknown> };
      const update: Record<string, unknown> = { ...cols };
      if (["completed", "failed", "sent", "delivered", "stopped_booked"].includes(String(cols.status))) {
        update.completed_at = new Date().toISOString();
      }
      if (safe_summary_patch) {
        const { data } = await supabase.from("automation_runs").select("safe_summary_json").eq("id", runId).maybeSingle();
        update.safe_summary_json = { ...(data?.safe_summary_json ?? {}), ...safe_summary_patch };
      }
      await supabase.from("automation_runs").update(update).eq("id", runId);
    },
    async priorContacts(wsKey: string) {
      const { data } = await supabase.from("outbound_messages")
        .select("customer_reference, sent_at").eq("workspace_key", wsKey).not("sent_at", "is", null);
      const m = new Map<string, number>();
      // Cooldown is measured from a REAL send (sent_at), not a mere draft/queue.
      for (const r of data ?? []) {
        const t = Date.parse(r.sent_at);
        if (!isFinite(t)) continue;
        const prev = m.get(r.customer_reference);
        if (prev === undefined || t > prev) m.set(r.customer_reference, t);
      }
      return m;
    },
    async optedOut(wsKey: string) {
      const { data } = await supabase.from("outbound_messages")
        .select("customer_reference").eq("workspace_key", wsKey).eq("opted_out", true);
      return new Set((data ?? []).map((r: { customer_reference: string }) => r.customer_reference));
    },
    customerRefOf: (wsKey: string, phone: string) => customerReference(wsKey, phone),
    async draftOffer(ctx: Record<string, unknown>) {
      // The context carries NO phone number (privacy). DeepSeek only drafts.
      const r = await callDeepSeek({
        env,
        systemPrompt: CHALET_SYSTEM_PROMPT,
        history: [{ role: "user", content: `اكتب عرضاً عربياً قصيراً وجذاباً لفترة شاليه فاضية بتاريخ ${ctx.date}. النبرة: ${ctx.tone}. لا تذكر أي رقم هاتف.` }],
      });
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, body: r.reply || "لدينا فترة متاحة قد تناسبك — تواصل معنا للحجز." };
    },
    async whatsappMode() { return detectMode(env); },
    async queueMessage(row: Record<string, unknown>) {
      await supabase.from("outbound_messages").insert(row);
    },
  };
}

Deno.serve(async (req: Request) => {
  const env = Deno.env.toObject();
  const configured = env.AUTOPILOT_CRON_SECRET || "";
  const presented = req.headers.get("x-autopilot-secret") || "";
  // Fail closed: no configured secret, or a mismatch, is rejected. Never
  // reveals whether the secret exists.
  if (!configured || !constantTimeEqual(presented, configured)) {
    return new Response(JSON.stringify({ ok: false, error: "UNAUTHORIZED" }), { status: 403, headers: { "content-type": "application/json" } });
  }
  const summary = await runAutopilot(makeDeps());
  return new Response(JSON.stringify({ ok: true, summary }), { headers: { "content-type": "application/json" } });
});
