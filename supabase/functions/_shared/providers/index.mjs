// providers/index.mjs — payment provider adapter factory.
//
// Adapter interface (all methods; see test-adapter.mjs for the reference
// implementation):
//   createPaymentSession(order)                -> { providerOrderId, paymentUrl, expiresAt }
//   verifyWebhookSignature(rawBody, headers)   -> boolean
//   parseWebhookEvent(rawBody)                 -> normalized event object
//   getPaymentStatus(providerOrderId)          -> normalized status string
//   refundPayment(providerTxnId, amountHalalas)-> { providerRefundId }
//
// THIS BRANCH SHIPS NO REAL PROVIDER. Real payments are not operational.
// To add one (e.g. Moyasar, Tap, HyperPay — all support SAR):
//   1. Implement the five methods in providers/<name>-adapter.mjs using the
//      provider's SANDBOX and verify signature handling against their docs.
//   2. Register it in the switch below.
//   3. Configure secrets via `supabase secrets set` (never in the repo):
//        PAYMENT_PROVIDER=<name>
//        PAYMENT_PROVIDER_API_BASE=...
//        PAYMENT_PROVIDER_SECRET_KEY=...        (server-side only)
//        PAYMENT_PROVIDER_PUBLISHABLE_KEY=...   (safe for checkout pages)
//        PAYMENT_WEBHOOK_SECRET=...             (signature verification)
//        PAYMENTS_ALLOW_PARTIAL=true|false
//   4. Test the full webhook matrix against the provider sandbox BEFORE
//      any production credential exists anywhere.

import { TestProviderAdapter } from "./test-adapter.mjs";

function readEnv(env, key) {
  if (env && typeof env === "object") return env[key];
  return undefined;
}

/**
 * Create the configured provider adapter.
 * @param {object} env environment map (pass Deno.env.toObject() in Edge
 *   Functions, or a plain object in tests). Nothing is read implicitly.
 * @returns {{ ok:true, adapter } | { ok:false, error:string }}
 */
export function createProviderAdapter(env) {
  const provider = String(readEnv(env, "PAYMENT_PROVIDER") || "").toLowerCase();

  if (!provider) {
    return { ok: false, error: "NO_PROVIDER_CONFIGURED" };
  }

  switch (provider) {
    case "test": {
      // Hard guard: the fake adapter must never run where real users are.
      const allow = String(readEnv(env, "PAYMENTS_ALLOW_TEST_PROVIDER") || "") === "true";
      const runtimeEnv = String(
        readEnv(env, "DENO_ENV") || readEnv(env, "NODE_ENV") || "",
      ).toLowerCase();
      if (!allow || runtimeEnv === "production") {
        return { ok: false, error: "TEST_PROVIDER_BLOCKED" };
      }
      const webhookSecret = readEnv(env, "PAYMENT_WEBHOOK_SECRET");
      if (!webhookSecret) return { ok: false, error: "MISSING_WEBHOOK_SECRET" };
      return { ok: true, adapter: new TestProviderAdapter({ webhookSecret }) };
    }
    default:
      return { ok: false, error: "UNKNOWN_PROVIDER" };
  }
}
