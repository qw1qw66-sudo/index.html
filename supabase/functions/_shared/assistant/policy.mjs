// policy.mjs — authoritative application policy for the assistant. These are
// NOT editable model outputs; they are fixed rules the deterministic layer
// enforces before any action, plus evaluation of owner-promoted memory
// hard-blocks. Memory is context, not authority — only 'active' memory with
// enforcement_level 'hard_block' can block, and it can only ever ADD a block,
// never grant a capability.

export const OWNER_POLICY_SEED = Object.freeze({
  language: "ar",
  dialect: "sa-gulf",
  style: "concise",
  priority: "reduce_owner_effort",
  business_objective: "fill_empty_periods",
  business_metric: "attributed_bookings_and_revenue",
  saas: false,
  workspace_isolation: true,
  no_auto_write_without_validation: true,
  sensitive_actions_require_confirmation: true,
  automatic_marketing_default: "disabled",
  no_message_after_opt_out: true,
  no_repeated_spam: true,
  enforce_minimum_price: true,
  no_marketing_after_booked: true,
  no_payment_success_without_evidence: true,
  reuse_existing_systems: true,
  no_repeated_audits: true,
  no_invented_completed_work: true,
});

// Confirmation classes per tool are declared in tools.mjs; this evaluates
// whether an otherwise-valid action is blocked by an active hard-block memory
// or by a fixed policy invariant.
//
// activeMemories: [{ memory_type, enforcement_level, content_json }]
//   content_json may carry { block_tools: [...], block_action_types: [...] }.
export function evaluatePolicy({ toolName, actionType, activeMemories = [] }) {
  const warnings = [];
  for (const m of activeMemories) {
    if (m.status && m.status !== "active") continue;
    const c = m.content_json || {};
    const blocksTool = Array.isArray(c.block_tools) && c.block_tools.includes(toolName);
    const blocksAction = Array.isArray(c.block_action_types) && c.block_action_types.includes(actionType);
    if (m.enforcement_level === "hard_block" && (blocksTool || blocksAction)) {
      return {
        allowed: false,
        error: "BLOCKED_BY_MEMORY",
        reason_ar: String(c.reason_ar || "هذا الإجراء ممنوع بحسب سياسة محفوظة."),
      };
    }
    if (m.enforcement_level === "warning" && (blocksTool || blocksAction)) {
      warnings.push(String(c.reason_ar || "تنبيه: راجع سياسة محفوظة قبل المتابعة."));
    }
    if (m.memory_type === "mistake" && (blocksTool || blocksAction)) {
      warnings.push(String(c.reason_ar || "تنبيه: حدث خطأ سابق مشابه — راجع قبل المتابعة."));
    }
  }
  return { allowed: true, warnings };
}

// A model-proposed memory must always start non-authoritative.
export function normalizeProposedMemory(raw) {
  return {
    memory_type: ["fact", "preference", "decision", "policy", "mistake", "lesson"].includes(raw?.memory_type)
      ? raw.memory_type
      : "fact",
    status: "proposed", // NEVER active from the model
    content_json: raw?.content_json && typeof raw.content_json === "object" ? raw.content_json : {},
    enforcement_level: "advisory", // model cannot self-assign a stronger level
    source_type: "model",
  };
}
