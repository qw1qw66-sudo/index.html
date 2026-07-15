import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProviderAdapter } from "../../supabase/functions/_shared/providers/index.mjs";
import { TestProviderAdapter } from "../../supabase/functions/_shared/providers/test-adapter.mjs";
import { applyWebhookEvent } from "../../supabase/functions/_shared/ledger-core.mjs";
import { extractFunctions, inlineHtml } from "./helpers/extract-inline.mjs";

// Secret-shaped values that must never appear in committed sources. Built
// dynamically so this test file itself never contains the literal tokens.
const FORBIDDEN_PATTERNS = [
  "sk_live_",
  "sk_test_",
  "whsec_",
  "sb_secret_",
  "service" + "_role", // Supabase privileged key name
  "-----BEGIN " + "PRIVATE KEY",
];
// An env var name in docs is fine; an ASSIGNED literal value is a committed
// secret. Placeholders like <...> or ${...} do not match.
const FORBIDDEN_ASSIGNMENT = /(PAYMENT_PROVIDER_SECRET_KEY|PAYMENT_WEBHOOK_SECRET|SUPABASE_SERVICE[A-Z_]*KEY)\s*[=:]\s*["']?[A-Za-z0-9+/_-]{16,}/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

describe("19. no secrets in the frontend or committed payment sources", () => {
  it("index.html contains no secret-shaped values", () => {
    const html = inlineHtml();
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(html.includes(pattern), `index.html must not contain ${pattern}`).toBe(false);
    }
    expect(html).not.toMatch(FORBIDDEN_ASSIGNMENT);
    // The public anon key is expected and allowed (publishable by design).
    expect(html).toContain("sb_publishable_");
  });

  it("payment foundation sources contain no secret-shaped values", () => {
    const files = [
      ...walk("supabase/functions"),
      "scripts/migrate-legacy-paid.mjs",
      "supabase/migrations/20260701000001_atomic_workspace_save.sql",
      "supabase/migrations/20260701000002_payment_ledger.sql",
    ];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(text.includes(pattern), `${f} must not contain ${pattern}`).toBe(false);
      }
      expect(FORBIDDEN_ASSIGNMENT.test(text), `${f} must not assign secret values`).toBe(false);
    }
  });

  it("frontend payment UI is present with safe Arabic disabled-state messaging", () => {
    const html = inlineHtml();
    expect(html).toContain("سجل المدفوعات");
    expect(html).toContain("سجل المدفوعات غير مفعّل بعد على الخادم");
    expect(html).toContain("لا يوجد مزود دفع مهيأ");
    // A redirect/"success page" is never treated as payment proof.
    expect(html).toContain("فتح الرابط لا يعني الدفع");
  });

  it("frontend keeps the P0 safety guards (create probe, atomic save, beforeunload)", () => {
    const html = inlineHtml();
    expect(html).toContain("save_shared_workspace_v2");
    expect(html).toContain("create_shared_workspace");
    expect(html).toContain("beforeunload");
    expect(html).toContain("STALE_REVISION");
  });

  it("the local push marker never persists the customer document (no PII at rest in localStorage)", () => {
    const html = inlineHtml();
    const start = html.indexOf("function backupBeforePush()");
    const end = html.indexOf("function purgeLegacyLocalPii()");
    expect(start, "backupBeforePush must exist").toBeGreaterThan(-1);
    expect(end, "purgeLegacyLocalPii must exist").toBeGreaterThan(start);
    const region = html.slice(start, end);
    // It writes a marker keyed by this prefix...
    expect(region).toContain('"backup_before_cloud_push_"');
    // ...but NEVER the full document (customer names/phones) at rest.
    expect(region).not.toMatch(/data:\s*state/);
    // And a one-time purge clears any legacy entry that still carries a document.
    expect(html).toMatch(/purgeLegacyLocalPii\(\);/);
  });
});

describe("20. no provider secrets in logs or outputs", () => {
  it("test adapter outputs never contain the webhook secret", async () => {
    const secret = "super-secret-webhook-value-123";
    const adapter = new TestProviderAdapter({ webhookSecret: secret });
    const session = await adapter.createPaymentSession({ amountHalalas: 1000, currency: "SAR" });
    expect(JSON.stringify(session)).not.toContain(secret);
    const { rawBody, headers } = adapter.buildSignedEvent({ id: "e1", type: "payment_succeeded" });
    expect(rawBody).not.toContain(secret);
    // The signature header is an HMAC, not the secret itself.
    expect(Object.values(headers).join("")).not.toContain(secret);
    const parsed = adapter.parseWebhookEvent(rawBody);
    expect(JSON.stringify(parsed)).not.toContain(secret);
  });

  it("webhook decision actions never carry secret material", () => {
    const order = {
      id: "o1", workspace_key: "WS", booking_id: "b1", provider: "test",
      amount_halalas: 1000, status: "pending",
    };
    const { actions } = applyWebhookEvent({
      event: {
        providerEventId: "e1", eventType: "payment_succeeded",
        providerTransactionId: "t1", providerOrderId: "po1",
        amountHalalas: 1000, occurredAt: "2026-01-01T00:00:00Z",
      },
      order,
      existingTransaction: null,
    });
    const text = JSON.stringify(actions);
    expect(text).not.toMatch(/secret|signature|api[_-]?key/i);
  });

  it("edge function sources record only sanitized error codes, never payload or signature material", () => {
    // Logic now lives in the runtime-tested handler; the thin index.ts only wires deps.
    const handler = readFileSync("supabase/functions/payment-webhook/handler.mjs", "utf8");
    const wrapper = readFileSync("supabase/functions/payment-webhook/index.ts", "utf8");
    // error_message is set from a fixed action.error code path only.
    expect(handler).toContain("errorMessage = String(action.error)");
    for (const src of [handler, wrapper]) {
      expect(src).not.toMatch(/error_message[^\n]*payload/);
      expect(src).not.toMatch(/console\.log\([^)]*(secret|signature|pin)/i);
    }
  });
});

describe("test provider environment allowlist (reverse-audit §1.5)", () => {
  // Full config that SHOULD enable the test adapter.
  const good = {
    PAYMENT_PROVIDER: "test",
    APP_ENV: "test",
    PAYMENTS_ALLOW_TEST_PROVIDER: "true",
    PAYMENT_WEBHOOK_SECRET: "x",
  };

  it("enables the test adapter only for APP_ENV in {test, staging} with the opt-in flag", () => {
    expect(createProviderAdapter(good).ok).toBe(true);
    expect(createProviderAdapter({ ...good, APP_ENV: "staging" }).ok).toBe(true);
  });

  it("blocks when APP_ENV is missing", () => {
    const { APP_ENV, ...noEnv } = good;
    void APP_ENV;
    expect(createProviderAdapter(noEnv)).toEqual({ ok: false, error: "TEST_PROVIDER_BLOCKED" });
  });

  it("blocks APP_ENV=production", () => {
    expect(createProviderAdapter({ ...good, APP_ENV: "production" }))
      .toEqual({ ok: false, error: "TEST_PROVIDER_BLOCKED" });
  });

  it("blocks APP_ENV=development (not on the allowlist)", () => {
    expect(createProviderAdapter({ ...good, APP_ENV: "development" }))
      .toEqual({ ok: false, error: "TEST_PROVIDER_BLOCKED" });
  });

  it("blocks an unknown APP_ENV value", () => {
    expect(createProviderAdapter({ ...good, APP_ENV: "prod-2" }))
      .toEqual({ ok: false, error: "TEST_PROVIDER_BLOCKED" });
  });

  it("blocks when the explicit opt-in flag is missing", () => {
    expect(createProviderAdapter({ ...good, PAYMENTS_ALLOW_TEST_PROVIDER: "" }))
      .toEqual({ ok: false, error: "TEST_PROVIDER_BLOCKED" });
  });

  it("does NOT rely on NODE_ENV/DENO_ENV (Supabase does not set them)", () => {
    // Even a benign-looking NODE_ENV must not enable the adapter without APP_ENV.
    const { APP_ENV, ...noEnv } = good;
    void APP_ENV;
    expect(createProviderAdapter({ ...noEnv, NODE_ENV: "staging" }))
      .toEqual({ ok: false, error: "TEST_PROVIDER_BLOCKED" });
  });

  it("reports missing/unknown provider instead of guessing", () => {
    expect(createProviderAdapter({})).toEqual({ ok: false, error: "NO_PROVIDER_CONFIGURED" });
    expect(createProviderAdapter({ PAYMENT_PROVIDER: "unknown-gateway" }))
      .toEqual({ ok: false, error: "UNKNOWN_PROVIDER" });
  });

  it("requires a webhook secret even when otherwise allowed", () => {
    const { PAYMENT_WEBHOOK_SECRET, ...noSecret } = good;
    void PAYMENT_WEBHOOK_SECRET;
    expect(createProviderAdapter(noSecret)).toEqual({ ok: false, error: "MISSING_WEBHOOK_SECRET" });
  });

  it("test adapter payment URLs use the reserved .invalid TLD", async () => {
    const r = createProviderAdapter(good);
    expect(r.ok).toBe(true);
    const session = await r.adapter.createPaymentSession({ amountHalalas: 1000, currency: "SAR" });
    expect(new URL(session.paymentUrl).hostname.endsWith(".invalid")).toBe(true);
  });
});

describe("21/22. existing voucher + WhatsApp behavior (real inline code)", () => {
  const fns = extractFunctions(
    ["normalizePhoneForWhatsApp", "parseMoneyInput", "riyalsInputToHalalas"],
    ["normalizeDigits"],
  );

  it("WhatsApp phone normalization keeps its documented behavior", () => {
    expect(fns.normalizePhoneForWhatsApp("0512345678")).toBe("966512345678");
    expect(fns.normalizePhoneForWhatsApp("512345678")).toBe("966512345678");
    expect(fns.normalizePhoneForWhatsApp("00966512345678")).toBe("966512345678");
    expect(fns.normalizePhoneForWhatsApp("+966 51 234 5678")).toBe("966512345678");
    expect(fns.normalizePhoneForWhatsApp("٠٥١٢٣٤٥٦٧٨")).toBe("966512345678");
    expect(fns.normalizePhoneForWhatsApp("garbage")).toBe("");
    expect(fns.normalizePhoneForWhatsApp("")).toBe("");
  });

  it("legacy money parsing behaves as documented (including the AUD-011 comma caveat)", () => {
    expect(fns.parseMoneyInput("١٠٠٠")).toBe(1000);
    expect(fns.parseMoneyInput("۱۲۳۴")).toBe(1234);
    expect(fns.parseMoneyInput("")).toBe(0);
    expect(fns.parseMoneyInput("abc")).toBeNaN();
    // Documented pre-existing behavior (audit AUD-011): commas are stripped
    // as thousands separators, so decimal-comma input silently scales 10x in
    // the LEGACY field. The new ledger path (riyalsInputToHalalas /
    // parseRiyalsToHalalas) refuses such input instead.
    expect(fns.parseMoneyInput("1,234")).toBe(1234);
    expect(fns.parseMoneyInput("12,5")).toBe(125);
  });

  it("the new ledger input conversion is strict where the legacy field is tolerant", () => {
    expect(fns.riyalsInputToHalalas("12.5")).toBe(1250);
    expect(fns.riyalsInputToHalalas("١٢")).toBe(1200);
    expect(fns.riyalsInputToHalalas("12.345")).toBeNaN();
    expect(fns.riyalsInputToHalalas("-5")).toBeNaN();
  });

  it("voucher text builder still exists and lists paid/remaining lines", () => {
    const html = inlineHtml();
    expect(html).toContain('"المدفوع: " + money(b.paid)');
    expect(html).toContain('"المتبقي: " + money(rem)');
    expect(html).toContain("wa.me/");
    expect(html).toContain("encodeURIComponent");
  });
});
