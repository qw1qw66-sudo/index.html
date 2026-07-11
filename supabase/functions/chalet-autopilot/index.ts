// chalet-autopilot — Supabase Edge Function (PREPARED, NOT DEPLOYED).
//
// Thin Deno wrapper for the vacancy-marketing planner (runtime-tested in
// Node/vitest via handler.mjs). Intended to be invoked on a schedule
// (supabase cron / pg_cron -> edge). Automation is OFF by default; nothing is
// auto-sent unless a rule is explicitly enabled AND official WhatsApp is
// configured. This is NOT a generic scheduler framework.

import { createClient } from "npm:@supabase/supabase-js@2";
import { runAutopilot } from "./handler.mjs";
import { callDeepSeek } from "../_shared/assistant/deepseek.mjs";
import { customerReference } from "../_shared/assistant/redact.mjs";
import { detectMode } from "../_shared/assistant/whatsapp.mjs";
import { CHALET_SYSTEM_PROMPT } from "../_shared/assistant/system-prompt.mjs";

// deno-lint-ignore no-explicit-any
declare const Deno: any;

function makeDeps() {
  const env = Deno.env.toObject();
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const now = new Date();
  return {
    nowMs: now.getTime(),
    todayIso: now.toISOString().slice(0, 10),
    async listEnabledRules() {
      const { data } = await supabase.from("automation_rules").select("*").eq("enabled", true);
      return data ?? [];
    },
    async getWorkspaceDoc(wsKey: string) {
      const { data } = await supabase.from("shared_workspaces").select("data").eq("workspace_key", wsKey).maybeSingle();
      return data?.data ?? null;
    },
    async findRun(wsKey: string, idempotencyKey: string) {
      const { data } = await supabase.from("automation_runs").select("id")
        .eq("workspace_key", wsKey).eq("idempotency_key", idempotencyKey).maybeSingle();
      return data ?? null;
    },
    async priorContacts(wsKey: string) {
      const { data } = await supabase.from("outbound_messages")
        .select("customer_reference, created_at").eq("workspace_key", wsKey);
      const m = new Map<string, number>();
      for (const r of data ?? []) {
        const t = Date.parse(r.created_at);
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
    async recordRun(row: Record<string, unknown>) {
      const { data } = await supabase.from("automation_runs").insert(row).select("id").single();
      return { run_id: data?.id };
    },
    async queueMessage(row: Record<string, unknown>) {
      await supabase.from("outbound_messages").insert(row);
    },
  };
}

Deno.serve(async (_req: Request) => {
  const summary = await runAutopilot(makeDeps());
  return new Response(JSON.stringify({ ok: true, summary }), { headers: { "content-type": "application/json" } });
});
