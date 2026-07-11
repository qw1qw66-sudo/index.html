// whatsapp.mjs — one communication adapter, three modes, one normalized
// outbound-message object. Automatic sending is NEVER performed without
// explicit owner activation, and only the official Cloud API mode can report
// "sent" (after a real API acknowledgement).

export const WHATSAPP_MODES = Object.freeze(["disconnected", "open_manual_whatsapp", "official_cloud_api"]);

// Normalize a KSA phone to wa.me digits (same rules as the app's normalizer).
export function normalizePhone(phone) {
  const digits = String(phone || "").replace(/[\s\-()+]/g, "").replace(/[^\d]/g, "");
  if (!digits) return "";
  if (/^00966\d{9}$/.test(digits)) return digits.slice(2);
  if (/^05\d{8}$/.test(digits)) return "966" + digits.slice(1);
  if (/^5\d{8}$/.test(digits)) return "966" + digits;
  if (/^966\d{9}$/.test(digits)) return digits;
  return "";
}

export function detectMode(env) {
  if (env && env.WHATSAPP_CLOUD_TOKEN && env.WHATSAPP_PHONE_ID) return "official_cloud_api";
  // Manual mode is available whenever the frontend can open wa.me; the server
  // treats "official not configured" as disconnected for AUTOMATIC sending.
  return "disconnected";
}

/**
 * Resolve what happens for an outbound message in the current mode. Pure —
 * returns an intent the caller executes; it never claims delivery itself.
 *
 * @returns one of:
 *   { action: "blocked", reason_ar }                         (disconnected auto)
 *   { action: "manual_link", url }                           (owner opens it; NOT "sent")
 *   { action: "api_send", to, body }                         (caller calls Cloud API)
 */
export function resolveOutbound({ mode, phone, body, automatic }) {
  if (mode === "official_cloud_api") {
    const to = normalizePhone(phone);
    if (!to) return { action: "blocked", reason_ar: "رقم غير صالح للإرسال." };
    return { action: "api_send", to, body: String(body || "") };
  }
  if (mode === "open_manual_whatsapp") {
    const to = normalizePhone(phone);
    if (!to) return { action: "blocked", reason_ar: "رقم غير صالح للإرسال." };
    return { action: "manual_link", url: `https://wa.me/${to}?text=${encodeURIComponent(String(body || ""))}` };
  }
  // disconnected
  if (automatic) {
    return { action: "blocked", reason_ar: "واتساب التلقائي غير مربوط — لا يمكن الإرسال التلقائي." };
  }
  return { action: "blocked", reason_ar: "واتساب التلقائي غير مربوط" };
}

// The status that should be recorded for each resolution — critically, a
// manually opened link is NEVER "sent".
export function statusForResolution(res) {
  if (res.action === "api_send") return "queued";          // becomes "sent" only after API ack
  if (res.action === "manual_link") return "opened_manual"; // NOT "sent"
  return "skipped_opt_out"; // or blocked; caller decides the precise reason
}
