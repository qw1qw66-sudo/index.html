import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The deployment surface: the workflow deploys only intentionally (manual
// dispatch or a "[deploy]"-marked push — never a silent auto-deploy), secrets
// must be runner-generated (never echoed/stored), the CLI migration chain in
// supabase/migrations must be complete and ordered, and the baseline must be
// byte-identical to the published database/shared_workspace_sync.sql.

const wf = readFileSync(".github/workflows/deploy-supabase-staging.yml", "utf8");

describe("deploy-supabase-staging workflow", () => {
  it("deploys ONLY intentionally: manual dispatch, or a push whose commit says [deploy] (H1)", () => {
    expect(wf).toContain("workflow_dispatch:");
    expect(wf).toContain("deploy_ref:");
    expect(wf).toContain('default: "main"');
    // A push to main is a candidate (path-filtered to server code)…
    expect(wf).toMatch(/push:\s*\n\s*branches:\s*\n\s*- main/);
    expect(wf).toContain('- "supabase/**"');
    expect(wf).toContain('- ".github/workflows/deploy-supabase-staging.yml"');
    // …but the job runs on a push ONLY when the commit message opts in with
    // "[deploy]" (H1 safety gate: a normal merge never auto-runs migrations on
    // the live DB). A manual workflow_dispatch is always an explicit deploy.
    expect(wf).toContain("github.event_name == 'workflow_dispatch'");
    expect(wf).toMatch(/contains\(github\.event\.head_commit\.message, '\[deploy\]'\)/);
    // Frontend-only pushes must NOT deploy the backend.
    expect(wf).not.toMatch(/paths:[\s\S]{0,200}index\.html/);
    expect(wf).not.toMatch(/^\s*pull_request:/m);
    expect(wf).not.toMatch(/^\s*schedule:/m);
  });

  it("uses the staging GitHub Environment and guards the repository (no forks)", () => {
    expect(wf).toContain("environment: staging");
    expect(wf).toContain("github.repository == 'qw1qw66-sudo/index.html'");
    expect(wf).toContain("permissions:");
    expect(wf).toContain("contents: read");
  });

  it("reuses existing secrets, requires the two new ones, never a service-role key", () => {
    // Reused (already configured for the export workflow):
    expect(wf).toContain("secrets.SUPABASE_URL");
    expect(wf).toContain("secrets.SUPABASE_ANON_KEY");
    // New owner-provided:
    expect(wf).toContain("secrets.SUPABASE_ACCESS_TOKEN");
    expect(wf).toContain("secrets.SUPABASE_DB_PASSWORD");
    // Optional explicit override:
    expect(wf).toContain("secrets.SUPABASE_PROJECT_ID");
    // The service-role KEY is never referenced as a secret (granting to the
    // service_role DATABASE ROLE in SQL is unrelated and fine).
    expect(wf).not.toMatch(/secrets\.\s*SUPABASE_SERVICE_ROLE/i);
    expect(wf).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("pins the Supabase CLI and applies migrations with status shown first", () => {
    expect(wf).toMatch(/npm install -g supabase@\d+\.\d+\.\d+/);
    expect(wf).toContain("supabase migration list --linked");
    expect(wf).toContain("supabase db push --linked");
  });

  it("generates internal secrets on the runner: masked, conditional, never echoed", () => {
    expect(wf).toContain("openssl rand -hex 32");
    expect(wf).toContain("::add-mask::");
    // Only names are extracted from `secrets list` (column 1) — digests never printed.
    expect(wf).toContain("awk '{print $1}'");
    expect(wf).toContain("ASSISTANT_CONFIRM_SECRET");
    expect(wf).toContain("AUTOPILOT_CRON_SECRET");
    // The generated value variable is never echoed.
    expect(wf).not.toMatch(/echo\s+"?\$v/);
    // No workflow line echoes a secrets.* expression.
    expect(wf).not.toMatch(/echo[^\n]*\$\{\{\s*secrets\./);
  });

  it("deploys the five functions with API bundling and runs the sanitized smoke tests", () => {
    for (const f of ["create-payment-session", "payment-webhook", "chalet-assistant", "chalet-setup-status", "chalet-autopilot"]) {
      expect(wf).toContain(f);
    }
    expect(wf).toContain("--no-verify-jwt");
    expect(wf).toContain("--use-api");
    expect(wf).toContain("node scripts/staging-smoke.mjs");
    expect(wf).toContain("staging-smoke-report.json");
  });
});

describe("supabase/migrations — single, ordered source of truth", () => {
  const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort();

  it("contains exactly the known migration chain, in apply order", () => {
    expect(files).toEqual([
      "20260601000000_shared_workspace_baseline.sql",
      "20260701000001_atomic_workspace_save.sql",
      "20260701000002_payment_ledger.sql",
      "20260711000003_chalet_assistant.sql",
      "20260711000004_pgcrypto_search_path.sql",
      "20260711000005_payment_reads_volatile.sql",
      // Booking Agent: server-owned per-thread drafts (additive only).
      "20260712000006_assistant_booking_drafts.sql",
      // Existing conflict pairs stay untouched; only NEW pairs block a save.
      "20260712000007_grandfather_existing_booking_conflicts.sql",
      // Night anchor: a pre-06:00 non-wrapping period counts on its date's NIGHT.
      "20260712000008_night_anchor_booking_conflicts.sql",
      // Unified "has business data" guard: expenses now count (chalets+bookings+expenses).
      "20260712000009_unified_business_data_guard.sql",
    ]);
  });

  it("baseline is byte-identical to the published shared_workspace_sync.sql (no drift)", () => {
    const baseline = readFileSync("supabase/migrations/20260601000000_shared_workspace_baseline.sql", "utf8");
    const published = readFileSync("database/shared_workspace_sync.sql", "utf8");
    expect(baseline).toBe(published);
  });

  it("each migration still carries its core contract (contents preserved by the move)", () => {
    const m1 = readFileSync("supabase/migrations/20260701000001_atomic_workspace_save.sql", "utf8");
    const m2 = readFileSync("supabase/migrations/20260701000002_payment_ledger.sql", "utf8");
    const m3 = readFileSync("supabase/migrations/20260711000003_chalet_assistant.sql", "utf8");
    const m7 = readFileSync("supabase/migrations/20260712000007_grandfather_existing_booking_conflicts.sql", "utf8");
    expect(m1).toContain("create or replace function public.save_shared_workspace_v2");
    expect(m1).toContain("create or replace function public.create_shared_workspace");
    expect(m2).toContain("create or replace function public.record_manual_payment");
    expect(m2).toContain("payment_transactions");
    expect(m3).toContain("create or replace function public.assistant_consume_confirmation");
    expect(m7).toContain("create or replace function public.workspace_doc_new_booking_conflict");
    expect(m7).toContain("workspace_doc_new_booking_conflict(v_workspace.data, v_data)");
    // Rollback documentation preserved.
    for (const m of [m1, m2, m3, m7]) expect(m).toMatch(/ROLLBACK/);
  });

  it("no old database/migrations copies remain (references were updated)", () => {
    let leftover = [];
    try { leftover = readdirSync("database/migrations"); } catch { /* removed entirely is fine */ }
    expect(leftover.filter((f) => f.endsWith(".sql"))).toEqual([]);
  });
});

describe("supabase/config.toml", () => {
  it("disables platform JWT verification for every in-function-authenticated endpoint", () => {
    const cfg = readFileSync("supabase/config.toml", "utf8");
    for (const f of ["create-payment-session", "payment-webhook", "chalet-assistant", "chalet-setup-status", "chalet-autopilot"]) {
      expect(cfg).toContain(`[functions.${f}]`);
    }
    expect((cfg.match(/verify_jwt = false/g) || []).length).toBe(5);
  });
});

describe("staging smoke script safety", () => {
  const smoke = readFileSync("scripts/staging-smoke.mjs", "utf8");
  it("uses synthetic data only and never prints bodies or secrets", () => {
    expect(smoke).toContain("عميل تجريبي");
    expect(smoke).toContain("0500000000"); // fake phone constant
    expect(smoke).not.toMatch(/console\.log\([^)]*\.text\b/);
    expect(smoke).not.toMatch(/console\.log\([^)]*JSON\.stringify\(\s*(r|res|b|body)\b/);
    // The leak scan covers PIN, anon key, phone, API-key shapes, service-role.
    for (const marker of ["PIN", "ANON_KEY", "PHONE", "API_KEY_SHAPE", "SERVICE_ROLE"]) {
      expect(smoke).toContain(`"${marker}"`);
    }
  });
  it("verifies CORS, auth gates, DeepSeek grounding, booking create+cancel, and disabled automation", () => {
    for (const step of [
      "cors_assistant_preflight_allowed", "cors_assistant_preflight_denied", "cors_payment_preflight_allowed",
      "setup_status_rejects_bad_auth", "synthetic_workspace_created", "setup_status_booleans",
      "deepseek_real_grounded_read", "assistant_thread_persisted", "booking_prepared",
      "booking_confirmed_created", "booking_save_echo_verified", "booking_exactly_one", "booking_cancelled",
      "agent_reported_transcript_exact",
      "automation_rules_all_disabled", "payment_webhook_fails_closed", "autopilot_gated",
    ]) {
      expect(smoke, `step ${step}`).toContain(step);
    }
  });
});
