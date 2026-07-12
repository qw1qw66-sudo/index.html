// confirmation.mjs — pure two-step confirmation token logic.
//
// prepare() mints a random token, returns it to the OWNER (never the model),
// and returns the hash to persist. The token is bound to the workspace, tool,
// action type, normalized-payload hash, expected workspace revision, expiry
// and a one-time nonce. confirm-side validation is enforced atomically in SQL
// (assistant_consume_confirmation) using these hashes.

import { createHash, createHmac, randomUUID } from "node:crypto";

// Stable JSON: sort object keys so the same logical payload always hashes the
// same regardless of key order.
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
}

export function hashPayload(normalizedPayload) {
  return createHash("sha256").update(stableStringify(normalizedPayload)).digest("hex");
}

export function hashToken(token, secret) {
  // HMAC when a server secret is available; plain sha256 otherwise. The DB
  // stores only the hash, so a leaked DB row cannot reproduce the token.
  return secret
    ? createHmac("sha256", secret).update(String(token)).digest("hex")
    : createHash("sha256").update(String(token)).digest("hex");
}

/**
 * @returns {{ token, tokenHash, payloadHash, nonce, expiresAtMs }}
 *   `token` goes to the owner; `tokenHash`/`payloadHash` are persisted.
 */
export function prepareConfirmation({
  normalizedPayload,
  secret,
  ttlMs = 5 * 60 * 1000,
  nowMs,
}) {
  const nonce = randomUUID();
  const token = `${nonce}.${randomUUID()}`;
  const base = typeof nowMs === "number" ? nowMs : Date.now();
  return {
    token,
    nonce,
    tokenHash: hashToken(token, secret),
    payloadHash: hashPayload(normalizedPayload),
    expiresAtMs: base + ttlMs,
  };
}

/**
 * Re-mint the confirmation credentials for an EXISTING prepared action (same
 * payload hash, fresh token + expiry). Used by refresh recovery and by the
 * typed-«سجل» reminder: the owner gets a working card again without the old
 * token ever being persisted anywhere client-side.
 * @returns {{ token, tokenHash, expiresAtMs }}
 */
export function reissueConfirmation({ secret, ttlMs = 5 * 60 * 1000, nowMs }) {
  const token = `${randomUUID()}.${randomUUID()}`;
  const base = typeof nowMs === "number" ? nowMs : Date.now();
  return { token, tokenHash: hashToken(token, secret), expiresAtMs: base + ttlMs };
}

/**
 * Client-side / handler-side pre-check before calling the SQL consume RPC.
 * The SQL RPC is the AUTHORITATIVE one-time check; this mirrors it so tests and
 * the handler can reason about outcomes without a DB.
 */
export function validateConfirmation({
  action,        // { status, confirmation_token_hash, payload_hash, confirmation_used_at, confirmation_expires_at_ms, expected_revision, workspace_key }
  workspaceKey,
  token,
  secret,
  currentPayloadHash,
  currentRevision,
  nowMs = Date.now(),
}) {
  if (!action || action.workspace_key !== workspaceKey) return { ok: false, error: "ACTION_NOT_FOUND" };
  if (action.status !== "prepared") return { ok: false, error: "ACTION_NOT_PENDING" };
  if (action.confirmation_used_at) return { ok: false, error: "CONFIRMATION_ALREADY_USED" };
  if (!action.confirmation_expires_at_ms || action.confirmation_expires_at_ms < nowMs) {
    return { ok: false, error: "CONFIRMATION_EXPIRED" };
  }
  if (action.confirmation_token_hash !== hashToken(token, secret)) {
    return { ok: false, error: "CONFIRMATION_TOKEN_MISMATCH" };
  }
  if (action.payload_hash !== currentPayloadHash) return { ok: false, error: "PAYLOAD_CHANGED" };
  if (
    action.expected_revision != null &&
    currentRevision != null &&
    action.expected_revision !== currentRevision
  ) {
    return { ok: false, error: "STALE_REVISION" };
  }
  return { ok: true };
}
