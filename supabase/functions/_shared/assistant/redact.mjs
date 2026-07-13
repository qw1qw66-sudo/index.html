// redact.mjs — strips PII and secrets before anything reaches the model or a
// long-term store. The assistant must NEVER send customer phone numbers to
// DeepSeek merely to draft wording, and must never persist them in memory.

// Arabic-Indic (٠-٩) / Persian (۰-۹) digits -> ASCII, 1:1 per character so
// string indices are preserved. A phone typed on an Arabic keyboard
// («٠٥٠١٢٣٤٥٦٧») otherwise slipped past a digits-only regex straight to the
// model and into thread storage.
function foldDigitsLocal(s) {
  return String(s ?? "")
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0));
}

// KSA mobile, tolerating a single space/dash between digit groups
// («050 123 4567», «050-123-4567») and any optional +966/00966/966 prefix.
// Matched against the digit-folded copy; over-matching a long digit run only
// over-redacts, which is the safe direction for PII.
const SEP = "[\\s\\-]?";

// (a) KSA MOBILE — 05XXXXXXXX, optional +966/00966/966 prefix, inner separators.
const MOBILE_SRC =
  "(?<!\\d)(?:\\+?966|00966)?" + SEP + "0?" + SEP + "5(?:" + SEP + "\\d){8}(?!\\d)";

// (b) KSA LANDLINE — trunk 0 + area code (011/012/013/014/016/017) + 6-7 digit
// subscriber: a standalone 9-10 digit run starting «01» whose 3rd digit is a
// real area code (1-4,6,7 — never 010/015/018/019). «هاتفه 0112345678» leaked
// through the mobile-only matcher and reached the model verbatim.
const LANDLINE_SRC = "(?<!\\d)01[1-467]\\d{6,7}(?!\\d)";

// (c) INTERNATIONAL — a «00»- or «+»-led 9-15 digit run, standalone.
// «جواله 00201002003004», «+201002003004». A +966 KSA mobile is already
// covered by (a); this masks every other country code the customer might send.
const INTL_SRC = "(?<!\\d)(?:00|\\+)\\d{9,15}(?!\\d)";

// (d) FUSED MOBILE — a raw 05XXXXXXXX (10 digits) glued INSIDE a longer digit
// run, e.g. the price+phone fusion «الاجمالي 4500501234567» that the anchored
// shapes above skip because the mobile sits mid-run, not on a digit boundary.
// Mirrors the R10 extractor's embedded-mobile shape (booking-planner.mjs) but
// masks only the 05-prefixed 10-digit sub-span, so a coincidental long number
// is not wholly mangled. Unanchored on purpose — it is meant to fire mid-run.
const FUSED_MOBILE_SRC = "05\\d{8}";

// Order matters: the anchored standalone shapes claim a match at a digit
// boundary first; the unanchored fused-mobile shape is the last resort for a
// mobile that has been concatenated onto adjacent (price/date) digits.
const PHONE_SRC =
  MOBILE_SRC + "|" + LANDLINE_SRC + "|" + INTL_SRC + "|" + FUSED_MOBILE_SRC;
// Built from fragments so this source itself contains no literal secret token
// (keeps repo-wide secret scanners from flagging the redactor).
const SECRETISH_RE = new RegExp(
  "\\b(" + ["sk", "live"].join("_") + "_[A-Za-z0-9]+" +
    "|" + ["sk", "test"].join("_") + "_[A-Za-z0-9]+" +
    "|" + "wh" + "sec_[A-Za-z0-9]+" +
    "|" + ["sb", "secret"].join("_") + "_[A-Za-z0-9]+)\\b",
  "g",
);

// Replace phones in `text`, splicing the ORIGINAL string at the folded-match
// spans (fold is 1:1, so indices line up) — non-phone content, including any
// Arabic-Indic digits elsewhere, is preserved verbatim.
function replacePhones(text, replacement) {
  const orig = String(text ?? "");
  const folded = foldDigitsLocal(orig);
  const re = new RegExp(PHONE_SRC, "g");
  let out = "", last = 0, m;
  while ((m = re.exec(folded)) !== null) {
    if (m[0].length === 0) { re.lastIndex += 1; continue; }
    out += orig.slice(last, m.index) + replacement;
    last = m.index + m[0].length;
  }
  return out + orig.slice(last);
}

export function redactPhones(text) {
  return replacePhones(text, "[هاتف محجوب]");
}

export function redactText(text) {
  return replacePhones(
    String(text ?? "").replace(SECRETISH_RE, "[سر محجوب]"),
    "[هاتف محجوب]",
  );
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

// Canonicalize a KSA number to one form BEFORE hashing so the same customer
// reached via «0501234567» and «+966 50 123 4567» maps to ONE reference —
// otherwise the autopilot's opt-out, cooldown and dedupe silently miss.
function canonicalPhone(phone) {
  let d = foldDigitsLocal(phone).replace(/\D/g, "");
  if (d.startsWith("00966")) d = d.slice(5);
  else if (d.startsWith("966")) d = d.slice(3);
  if (d.startsWith("0")) d = d.slice(1);
  if (/^5\d{8}$/.test(d)) return "966" + d;
  return foldDigitsLocal(phone); // non-KSA: fold only, still deterministic
}

// Stable, non-reversible customer reference for internal use (no raw phone in
// AI tables). Not cryptographically strong — just avoids storing the number.
export function customerReference(workspaceKey, phone) {
  const s = String(workspaceKey || "") + "|" + canonicalPhone(phone);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return "cust_" + (h >>> 0).toString(36);
}

export function hasUnredactedPhone(text) {
  return new RegExp(PHONE_SRC).test(foldDigitsLocal(text));
}
