import { describe, expect, it } from "vitest";
import { resolveAllowedOrigin, handlePreflight, withCors, corsWrap } from "../../supabase/functions/_shared/cors.mjs";
import { handleCreatePaymentSession } from "../../supabase/functions/create-payment-session/handler.mjs";

const ENV = { ALLOWED_ORIGINS: "https://app.example.com", PAGES_ORIGIN: "https://qw1qw66-sudo.github.io", NETLIFY_SITE: "helpful-gaufre-edf566" };

function req(method, origin, body) {
  const headers = { "content-type": "application/json" };
  if (origin) headers.origin = origin;
  return new Request("https://edge.local/create-payment-session", { method, headers, body: body ? JSON.stringify(body) : undefined });
}

describe("CORS allowlist", () => {
  it("allows the configured app origin, Pages, Netlify preview, and localhost", () => {
    expect(resolveAllowedOrigin("https://app.example.com", ENV)).toBe("https://app.example.com");
    expect(resolveAllowedOrigin("https://qw1qw66-sudo.github.io", ENV)).toBe("https://qw1qw66-sudo.github.io");
    expect(resolveAllowedOrigin("https://deploy-preview-73--helpful-gaufre-edf566.netlify.app", ENV)).toBe("https://deploy-preview-73--helpful-gaufre-edf566.netlify.app");
    expect(resolveAllowedOrigin("http://localhost:5173", ENV)).toBe("http://localhost:5173");
    expect(resolveAllowedOrigin("http://127.0.0.1:4173", ENV)).toBe("http://127.0.0.1:4173");
  });
  it("does NOT reflect an arbitrary origin", () => {
    expect(resolveAllowedOrigin("https://evil.example.net", ENV)).toBeNull();
    expect(resolveAllowedOrigin("https://helpful-gaufre-edf566.netlify.app.evil.com", ENV)).toBeNull();
    expect(resolveAllowedOrigin("https://deploy-preview-1--other-site.netlify.app", ENV)).toBeNull();
  });
});

describe("preflight (OPTIONS)", () => {
  it("returns 204 + headers for an allowed origin, without business logic", () => {
    const res = handlePreflight(req("OPTIONS", "https://app.example.com"), ENV);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    // Never allow credentials.
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });
  it("returns 403 (no allow-origin) for a disallowed origin", () => {
    const res = handlePreflight(req("OPTIONS", "https://evil.example.net"), ENV);
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("returns null for non-OPTIONS (so business logic runs)", () => {
    expect(handlePreflight(req("POST", "https://app.example.com"), ENV)).toBeNull();
  });
});

describe("withCors adds headers to success and error responses", () => {
  it("merges the allow-origin header on any status", () => {
    const ok = withCors(req("POST", "https://app.example.com"), ENV, new Response("{}", { status: 200 }));
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    const err = withCors(req("POST", "https://app.example.com"), ENV, new Response("{}", { status: 401 }));
    expect(err.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
  });
  it("omits allow-origin for a disallowed origin but still returns the response", () => {
    const r = withCors(req("POST", "https://evil.example.net"), ENV, new Response("{}", { status: 200 }));
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    expect(r.status).toBe(200);
  });
});

describe("corsWrap around the real create-payment-session handler", () => {
  const deps = {
    env: {},
    createProviderAdapter: () => ({ ok: false, error: "NO_PROVIDER_CONFIGURED" }),
    auth: async () => ({ ok: false, error_code: "WORKSPACE_NOT_FOUND_OR_PIN_INVALID" }),
    findOrderByIdempotency: async () => null,
    expireStaleOrders: async () => {},
    bookingFromWorkspace: async () => null,
    netPaidHalalas: async () => 0,
    hasActivePendingOrder: async () => false,
    insertOrder: async () => ({}),
  };
  it("preflight short-circuits (no handler call)", async () => {
    let called = false;
    const res = await corsWrap(req("OPTIONS", "https://app.example.com"), ENV, () => { called = true; return new Response("{}"); });
    expect(res.status).toBe(204);
    expect(called).toBe(false);
  });
  it("a real 401 response still carries CORS headers", async () => {
    const res = await corsWrap(req("POST", "https://app.example.com", { booking_id: "b1", idempotency_key: "idem-0001", access_pin: "x", workspace_key: "WS" }), ENV,
      () => handleCreatePaymentSession(req("POST", "https://app.example.com", { booking_id: "b1", idempotency_key: "idem-0001", access_pin: "x", workspace_key: "WS" }), deps));
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
  });
});
