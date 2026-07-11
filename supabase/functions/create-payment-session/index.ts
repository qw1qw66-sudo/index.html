// create-payment-session — Supabase Edge Function (PREPARED, NOT DEPLOYED).
//
// Thin Deno wrapper: all logic is in handler.mjs (executed in Node/vitest).
// This wires a Supabase service-role client into the handler's `deps`.
//
// POST JSON: { workspace_key, access_pin, booking_id, amount_halalas?, idempotency_key }
//
// Deploy (owner, staging first — NOT done by this branch):
//   supabase functions deploy create-payment-session
//   supabase secrets set APP_ENV=staging PAYMENT_PROVIDER=... PAYMENT_WEBHOOK_SECRET=... ...
//
// The service-role key is platform-injected as SUPABASE_SERVICE_ROLE_KEY; it
// never exists in this repository or any browser-visible surface.

import { createClient } from "npm:@supabase/supabase-js@2";
import { handleCreatePaymentSession } from "./handler.mjs";
import { createProviderAdapter } from "../_shared/providers/index.mjs";
import { corsWrap } from "../_shared/cors.mjs";

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
    async auth(workspaceKey: string, pin: string) {
      const { data } = await supabase
        .rpc("workspace_auth", { p_workspace_key: workspaceKey, p_access_pin: pin })
        .single();
      return data ?? { ok: false, error_code: "AUTH_FAILED" };
    },
    async findOrderByIdempotency(wsKey: string, key: string) {
      const { data } = await supabase
        .from("payment_orders")
        .select("id, booking_id, status, amount_halalas, currency, payment_url, expires_at")
        .eq("workspace_key", wsKey)
        .eq("idempotency_key", key)
        .maybeSingle();
      return data ?? null;
    },
    async expireStaleOrders(wsKey: string, bookingId: string) {
      await supabase.rpc("expire_stale_payment_orders", {
        p_workspace_key: wsKey,
        p_booking_id: bookingId,
      });
    },
    async bookingFromWorkspace(wsKey: string, bookingId: string) {
      const { data } = await supabase.rpc("booking_from_workspace", {
        p_workspace_key: wsKey,
        p_booking_id: bookingId,
      });
      return data ?? null;
    },
    async netPaidHalalas(wsKey: string, bookingId: string) {
      const { data } = await supabase
        .from("v_booking_payment_totals")
        .select("net_paid_halalas")
        .eq("workspace_key", wsKey)
        .eq("booking_id", bookingId)
        .maybeSingle();
      return Number(data?.net_paid_halalas ?? 0);
    },
    async hasActivePendingOrder(wsKey: string, bookingId: string) {
      const { data } = await supabase
        .from("payment_orders")
        .select("id")
        .eq("workspace_key", wsKey)
        .eq("booking_id", bookingId)
        .eq("status", "pending")
        .maybeSingle();
      return Boolean(data);
    },
    async insertOrder(row: Record<string, unknown>) {
      const { data, error } = await supabase
        .from("payment_orders")
        .insert(row)
        .select("id, booking_id, status, amount_halalas, currency, payment_url, expires_at")
        .single();
      if (error) throw { code: (error as { code?: string }).code ?? "INSERT_FAILED" };
      return data;
    },
  };
}

// Browser-facing: preflight + CORS on every response (allowlisted origins).
Deno.serve((req: Request) => corsWrap(req, Deno.env.toObject(), () => handleCreatePaymentSession(req, makeDeps())));
