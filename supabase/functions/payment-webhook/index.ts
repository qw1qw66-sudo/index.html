// payment-webhook — Supabase Edge Function (PREPARED, NOT DEPLOYED).
//
// Thin Deno wrapper: all logic is in handler.mjs (executed in Node/vitest).
// This wires a Supabase service-role client into the handler's `deps`.
//
// No customer secrets or signature material are ever logged; error_message
// stores sanitized codes only.

import { createClient } from "npm:@supabase/supabase-js@2";
import { handleWebhook } from "./handler.mjs";
import { createProviderAdapter } from "../_shared/providers/index.mjs";

// deno-lint-ignore no-explicit-any
declare const Deno: any;

function makeDeps() {
  const env = Deno.env.toObject();
  const supabase = createClient(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  );
  return {
    env,
    createProviderAdapter,
    async insertWebhookEvent(row: Record<string, unknown>) {
      const { data, error } = await supabase
        .from("payment_webhook_events")
        .insert(row)
        .select("id")
        .single();
      if (error) throw { code: (error as { code?: string }).code ?? "INSERT_FAILED" };
      return data;
    },
    async findOrderByProviderRef(provider: string, providerOrderId: string) {
      const { data } = await supabase
        .from("payment_orders")
        .select("id, workspace_key, booking_id, provider, amount_halalas, status")
        .eq("provider", provider)
        .eq("provider_order_id", providerOrderId)
        .maybeSingle();
      return data ?? null;
    },
    async findTxByProviderRef(provider: string, providerTxnId: string) {
      const { data } = await supabase
        .from("payment_transactions")
        .select("id, status")
        .eq("provider", provider)
        .eq("provider_transaction_id", providerTxnId)
        .maybeSingle();
      return data ?? null;
    },
    async insertTransaction(row: Record<string, unknown>) {
      const { error } = await supabase.from("payment_transactions").insert(row);
      if (error) throw { code: (error as { code?: string }).code ?? "INSERT_FAILED" };
    },
    async updateOrderStatus(orderId: string, from: string, to: string) {
      await supabase.from("payment_orders").update({ status: to }).eq("id", orderId).eq("status", from);
    },
    async insertAuditFlag(row: Record<string, unknown>) {
      await supabase.from("payment_audit_log").insert(row);
    },
    async markEventProcessed(eventId: string, status: string, errorMessage: string | null) {
      await supabase
        .from("payment_webhook_events")
        .update({ processing_status: status, processed_at: new Date().toISOString(), error_message: errorMessage })
        .eq("id", eventId);
    },
  };
}

Deno.serve((req: Request) => handleWebhook(req, makeDeps()));
