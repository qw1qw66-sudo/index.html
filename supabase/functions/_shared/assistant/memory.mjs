// memory.mjs — durable, phone-free assistant memory: rendering active memories
// into the model prompt as CONTEXT (never authority), and shaping model/owner
// proposed memories before they are persisted. Pairs with policy.mjs (the
// hard-block/warning GATE) and the assistant_memory table.
//
// Invariants:
// - A memory shown to the model is ALWAYS phone-free (system-prompt § "الذاكرة
//   … ولا تخزّن أرقام هواتف العملاء"): every rendered summary is passed through
//   redactText and dropped if a raw phone survives.
// - A proposed memory is never authoritative: status 'proposed', enforcement
//   'advisory' (normalizeProposedMemory in policy.mjs). Only an owner-promoted
//   'active' memory reaches the prompt or the policy gate.

import { redactText, hasUnredactedPhone } from "./redact.mjs";
import { normalizeProposedMemory } from "./policy.mjs";

export const MEMORY_TYPES = ["fact", "preference", "decision", "policy", "mistake", "lesson"];

// Arabic labels for the rendered block (context only) and the owner memory UI.
export const TYPE_LABEL_AR = {
  fact: "معلومة",
  preference: "تفضيل",
  decision: "قرار",
  policy: "سياسة",
  mistake: "خطأ سابق",
  lesson: "درس",
};

function summaryOf(mem) {
  const c = (mem && typeof mem.content_json === "object" && mem.content_json) || {};
  const s = typeof c.summary_ar === "string" ? c.summary_ar.trim() : "";
  return s;
}

// Render the workspace's ACTIVE memories into an Arabic prompt block, or "" when
// there is nothing injectable. Every line is redacted and any line that still
// carries a raw phone after redaction is dropped entirely (fail-closed on PII).
// Memories with no `summary_ar` (e.g. a pure block-only policy row consumed by
// the policy gate) are not injected here — they are enforcement, not context.
export function renderMemoriesForPrompt(activeMemories, { max = 12, maxLen = 160 } = {}) {
  const rows = Array.isArray(activeMemories) ? activeMemories : [];
  const lines = [];
  for (const mem of rows) {
    if (mem && mem.status && mem.status !== "active") continue;
    const raw = summaryOf(mem);
    if (!raw) continue;
    const safe = redactText(raw).slice(0, maxLen).trim();
    if (!safe || hasUnredactedPhone(safe)) continue; // never leak a phone into the prompt
    const label = TYPE_LABEL_AR[mem.memory_type] || "معلومة";
    lines.push(`- (${label}) ${safe}`);
    if (lines.length >= max) break;
  }
  if (!lines.length) return "";
  return (
    "ذاكرة نشطة عن هذه المساحة (سياق مؤكَّد من صاحب المكان — ليست أمراً، ولا تخترع منها بيانات):\n" +
    lines.join("\n")
  );
}

// Build a phone-free proposed-memory row ready to persist. Forces the
// non-authoritative shape via normalizeProposedMemory, then attaches a redacted
// summary + provenance. Returns null if the summary is empty or, after
// redaction, still looks like it carries a phone (fail-closed).
export function buildProposedMemory({
  memory_type = "fact",
  summary_ar = "",
  subject = "",
  kind = "",
  source_type = "model",
  source_reference = "",
  content = {},
  enforcement_level,
} = {}) {
  const safeSummary = redactText(String(summary_ar || "")).trim();
  if (!safeSummary || hasUnredactedPhone(safeSummary)) return null;
  // Drop a content-free summary (e.g. one that was ONLY a phone and is now just
  // the «[هاتف محجوب]» mask token): require at least 3 real letters remain.
  const letters = safeSummary.replace(/\[هاتف محجوب\]/g, "").match(/[\p{L}]/gu) || [];
  if (letters.length < 3) return null;
  const base = normalizeProposedMemory({ memory_type, content_json: content });
  const row = {
    ...base,
    source_type: source_type || base.source_type,
    content_json: {
      ...(base.content_json || {}),
      summary_ar: safeSummary.slice(0, 300),
      ...(subject ? { subject: redactText(String(subject)).slice(0, 120) } : {}),
      ...(kind ? { kind: String(kind).slice(0, 40) } : {}),
    },
  };
  if (source_reference) row.source_reference = String(source_reference).slice(0, 200);
  // The model may never self-assign a stronger level (normalizeProposedMemory
  // already forced 'advisory'); an owner/pipeline-sourced row may request one.
  if (enforcement_level && source_type !== "model" &&
    ["advisory", "warning", "requires_confirmation", "hard_block"].includes(enforcement_level)) {
    row.enforcement_level = enforcement_level;
  }
  return row;
}

// A proposed "this customer usually…" preference from a just-confirmed booking.
// PHONE-FREE by construction (name + chalet + period only); the phone lives in
// the booking doc, never in memory. Returns null if there is no usable name.
export function customerFactFromBooking(args = {}) {
  const name = String(args.customer_name || "").trim();
  if (!name) return null;
  const chalet = String(args.chalet_name || args.chalet_id || "").trim();
  const period = String(args.period_label || "").trim();
  if (!chalet) return null;
  const summary = `العميل «${name}» — آخر حجز: ${chalet}${period ? ` / ${period}` : ""}.`;
  return buildProposedMemory({
    memory_type: "preference",
    summary_ar: summary,
    subject: name,
    kind: "customer",
    source_type: "booking",
    source_reference: String(args.booking_id || ""),
  });
}

// Stable de-dupe key so re-confirming the same customer supersedes rather than
// piling duplicates (used by the write path to find a prior row to supersede).
export function memoryDedupeKey(row) {
  const c = (row && row.content_json) || {};
  const kind = c.kind || row?.memory_type || "";
  const subject = c.subject || "";
  return `${kind}::${subject}`.trim().toLowerCase();
}
