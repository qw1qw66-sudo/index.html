// cors.mjs — one shared CORS policy for BROWSER-invoked Edge Functions
// (create-payment-session, chalet-assistant). Provider/internal functions
// (payment-webhook, chalet-autopilot) must NOT use this.
//
// Rules:
//   - respond to OPTIONS preflight WITHOUT running business logic;
//   - never blindly reflect an arbitrary Origin — only an explicit allowlist;
//   - allow the app/Pages origin, approved Netlify previews, and localhost;
//   - no cookies / credentialed sessions (Allow-Credentials is never set);
//   - CORS headers go on success AND every error response.

const ALLOWED_HEADERS = "authorization, apikey, content-type, x-client-info";
const ALLOWED_METHODS = "POST, OPTIONS";

// Built-in defaults; extend via env ALLOWED_ORIGINS (comma-separated exact
// origins). GitHub Pages / Netlify site are overridable via env too.
function defaultAllowlist(env) {
  const list = new Set();
  const add = (o) => { if (o) list.add(o.replace(/\/+$/, "")); };
  // Explicit, owner-configured origins.
  for (const o of String(env?.ALLOWED_ORIGINS || "").split(",")) add(o.trim());
  // GitHub Pages project site (owner may override with PAGES_ORIGIN).
  add(env?.PAGES_ORIGIN || "https://qw1qw66-sudo.github.io");
  // Approved Netlify production site (previews handled by the pattern below).
  add(env?.NETLIFY_ORIGIN || "https://helpful-gaufre-edf566.netlify.app");
  return list;
}

// Netlify deploy previews: deploy-preview-<n>--<site>.netlify.app
function isApprovedNetlifyPreview(origin, env) {
  const site = (env?.NETLIFY_SITE || "helpful-gaufre-edf566").replace(/[^a-z0-9-]/gi, "");
  const re = new RegExp("^https://deploy-preview-\\d+--" + site + "\\.netlify\\.app$");
  return re.test(origin);
}

// localhost / 127.0.0.1 on any port, http or https (local dev only).
function isLocalhost(origin) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

export function resolveAllowedOrigin(origin, env) {
  const o = String(origin || "").replace(/\/+$/, "");
  if (!o) return null;
  if (isLocalhost(o)) return o;
  if (isApprovedNetlifyPreview(o, env)) return o;
  if (defaultAllowlist(env).has(o)) return o;
  return null; // NOT reflected
}

export function corsHeaders(origin, env) {
  const allowed = resolveAllowedOrigin(origin, env);
  const h = {
    "access-control-allow-methods": ALLOWED_METHODS,
    "access-control-allow-headers": ALLOWED_HEADERS,
    "access-control-max-age": "86400",
    vary: "Origin",
  };
  if (allowed) h["access-control-allow-origin"] = allowed;
  return { allowed, headers: h };
}

// Returns a preflight Response for OPTIONS, else null. Allowed origin -> 204
// with headers; disallowed origin -> 403 (no allow-origin header).
export function handlePreflight(req, env) {
  if (req.method !== "OPTIONS") return null;
  const { allowed, headers } = corsHeaders(req.headers.get("origin"), env);
  return new Response(null, { status: allowed ? 204 : 403, headers });
}

// Merge CORS headers into an existing Response (success or error).
export function withCors(req, env, response) {
  const { headers } = corsHeaders(req.headers.get("origin"), env);
  const merged = new Headers(response.headers);
  for (const [k, v] of Object.entries(headers)) merged.set(k, v);
  return new Response(response.body, { status: response.status, headers: merged });
}

// Convenience wrapper for a browser-facing Edge Function.
export async function corsWrap(req, env, handler) {
  const pf = handlePreflight(req, env);
  if (pf) return pf;
  const res = await handler();
  return withCors(req, env, res);
}
