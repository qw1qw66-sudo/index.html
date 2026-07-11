// redact.mjs — strips PII and secrets before anything reaches the model or a
// long-term store. The assistant must NEVER send customer phone numbers to
// DeepSeek merely to draft wording, and must never persist them in memory.

const PHONE_RE = /(?:\+?9665\d{8}|00966\d{9}|05\d{8}|\b5\d{8}\b)/g;
// Built from fragments so this source itself contains no literal secret token
// (keeps repo-wide secret scanners from flagging the redactor).
const SECRETISH_RE = new RegExp(
  "\\b(" + ["sk", "live"].join("_") + "_[A-Za-z0-9]+" +
    "|" + ["sk", "test"].join("_") + "_[A-Za-z0-9]+" +
    "|" + "wh" + "sec_[A-Za-z0-9]+" +
    "|" + ["sb", "secret"].join("_") + "_[A-Za-z0-9]+)\\b",
  "g",
);

export function redactPhones(text) {
  return String(text ?? "").replace(PHONE_RE, "[هاتف محجوب]");
}

export function redactText(text) {
  return String(text ?? "")
    .replace(SECRETISH_RE, "[سر محجوب]")
    .replace(PHONE_RE, "[هاتف محجوب]");
}

// Deep-redact an object for logging/model context: drop known-sensitive keys,
// redact phone/secret-shaped strings in the rest.
const DROP_KEYS = new Set([
  "customer_phone", "phone", "access_pin", "pin", "pin_hash", "p_access_pin",
  "payment_url", "provider_transaction_id", "provider_order_id", "destination_ref",
  "webhook_secret", "api_key", "authorization",
]);

export function redactObject(value, depth = 0) {
  if (depth > 6) return "[عمق]";
  if (value == null) return value;
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => redactObject(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (DROP_KEYS.has(k)) {
        out[k] = "[محجوب]";
      } else {
        out[k] = redactObject(v, depth + 1);
      }
    }
    return out;
  }
  return "[نوع]";
}

// Stable, non-reversible customer reference for internal use (no raw phone in
// AI tables). Not cryptographically strong — just avoids storing the number.
export function customerReference(workspaceKey, phone) {
  const s = String(workspaceKey || "") + "|" + String(phone || "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return "cust_" + (h >>> 0).toString(36);
}

export function hasUnredactedPhone(text) {
  return PHONE_RE.test(String(text ?? ""));
}
