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
    async executeConfirmed(_wsKey: string, action: { tool_name: string; payload: { args: Record<string, unknown> } }) {
      // Route to EXISTING contracts — no duplicate engines. (Wired at deploy
      // time with the workspace PIN carried through a short-lived context.)
      return { ok: false, error: "EXECUTOR_NOT_WIRED_IN_SCAFFOLD", tool: action.tool_name };
    },
    async finalizeAction(_wsKey: string, actionId: string, patch: Record<string, unknown>) {
      await supabase.from("assistant_actions").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", actionId);
    },
  };
}

// Minimal read-from-document helpers (server-side, authoritative source).
function readFromDoc(name: string, args: Record<string, unknown>, doc: { chalets?: unknown[]; bookings?: unknown[] }) {
  const bookings = (doc.bookings ?? []) as Array<Record<string, unknown>>;
  const active = bookings.filter((b) => !b.deleted_at);
  const today = new Date().toISOString().slice(0, 10);
  switch (name) {
    case "get_today_bookings":
      return { bookings: active.filter((b) => b.booking_date === today) };
    case "list_outstanding_balances":
      return { bookings: active.filter((b) => (Number(b.total) || 0) - (Number(b.paid) || 0) > 0) };
    case "get_booking_details":
      return active.find((b) => b.id === args.booking_id) ?? { error: "NOT_FOUND" };
    default:
      return { error: "TOOL_NOT_IMPLEMENTED", tool: name };
  }
}

Deno.serve((req: Request) => handleAssistant(req, makeDeps()));
