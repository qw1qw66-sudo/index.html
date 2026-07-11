import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The staging deployment surface: the workflow must be manual-only, secrets
// must be runner-generated (never echoed/stored), the CLI migration chain in
// supabase/migrations must be complete and ordered, and the baseline must be
// byte-identical to the published database/shared_workspace_sync.sql.

const wf = readFileSync(".github/workflows/deploy-supabase-staging.yml", "utf8");

describe("deploy-supabase-staging workflow", () => {
  it("is manual-only (workflow_dispatch) and never triggers on push/PR", () => {
    expect(wf).toContain("workflow_dispatch:");
    expect(wf).not.toMatch(/^\s*push:/m);
    expect(wf).not.toMatch(/^\s*pull_request:/m);
    expect(wf).not.toMatch(/^\s*schedule:/m);
    expect(wf).toContain("deploy_ref:");
    expect(wf).toContain('default: "main"');
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

  it("contains exactly the baseline + three migrations, in apply order", () => {
    expect(files).toEqual([
      "20260601000000_shared_workspace_baseline.sql",
      "20260701000001_atomic_workspace_save.sql",
      "20260701000002_payment_ledger.sql",
      "20260711000003_chalet_assistant.sql",
      "20260711000004_pgcrypto_search_path.sql",
      "20260711000005_payment_reads_volatile.sql",
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
    expect(m1).toContain("create or replace function public.save_shared_workspace_v2");
    expect(m1).toContain("create or replace function public.create_shared_workspace");
    expect(m2).toContain("create or replace function public.record_manual_payment");
    expect(m2).toContain("payment_transactions");
    expect(m3).toContain("create or replace function public.assistant_consume_confirmation");
    // Rollback documentation preserved.
    for (const m of [m1, m2, m3]) expect(m).toMatch(/ROLLBACK/);
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
      "booking_confirmed_created", "booking_exactly_one", "booking_cancelled",
      "automation_rules_all_disabled", "payment_webhook_fails_closed", "autopilot_gated",
    ]) {
      expect(smoke, `step ${step}`).toContain(step);
    }
  });
});
