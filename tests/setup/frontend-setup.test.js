import { describe, expect, it } from "vitest";
import { inlineHtml } from "../payments/helpers/extract-inline.mjs";

// Static guarantees about the mobile setup section: NO secret is ever entered
// or stored by the chalet app (only the two explicitly NON-secret staging
// values: Project Ref + publishable key), the official Supabase/GitHub pages
// are opened in a new tab, the copied template carries no secret values, and
// nothing secret is written to local/session storage or the workspace doc.

const html = inlineHtml();

// Extract the setup card markup (id="setupCard" up to the bottom-nav comment).
function setupCardHtml() {
  const start = html.indexOf('id="setupCard"');
  expect(start, "setupCard must exist").toBeGreaterThan(-1);
  const end = html.indexOf("HTML: bottom navigation", start);
  return html.slice(start, end === -1 ? start + 20000 : end);
}

// The setup JS region (helpers between the marker and normalizeWorkspaceKey).
function setupJs() {
  const start = html.indexOf("JS: mobile setup");
  const end = html.indexOf("function normalizeWorkspaceKey", start);
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, end);
}

describe("mobile setup page — security & structure", () => {
  it("renders the setup card with the required Arabic title and 6 status rows", () => {
    const card = setupCardHtml();
    expect(card).toContain("إعداد المساعد الذكي");
    for (const id of ["setupStatusSupabase", "setupStatusFunctions", "setupStatusDeepseek", "setupStatusConfirm", "setupStatusAutopilot", "setupStatusWhatsapp"]) {
      expect(card, `row ${id}`).toContain(id);
    }
    for (const label of ["مشروع Supabase", "وظائف الخادم", "DeepSeek", "مفتاح التأكيد", "الأوتوبايلوت", "واتساب الرسمي"]) {
      expect(card).toContain(label);
    }
  });

  it("the ONLY inputs in the setup card are the two non-secret staging fields", () => {
    const card = setupCardHtml();
    const inputs = card.match(/<input\b[^>]*>/gi) || [];
    expect(inputs).toHaveLength(2);
    expect(inputs.join(" ")).toContain("stagingRefInput");
    expect(inputs.join(" ")).toContain("stagingAnonInput");
    // Neither is a password/secret field.
    for (const tag of inputs) {
      expect(tag).not.toMatch(/type\s*=\s*["']password["']/i);
      expect(tag).not.toMatch(/(deepseek|api[_-]?key|db[_-]?password|secret|token|service[_-]?role)/i);
    }
    expect(card).not.toMatch(/<textarea\b/i);
    // All required action buttons exist.
    for (const action of [
      "setup-open-secrets", "setup-copy-template", "setup-check", "setup-open-deploy",
      "setup-open-staging-project", "setup-staging-created", "setup-open-github-secrets",
      "setup-save-staging-config", "setup-open-staging", "setup-try-assistant",
    ]) {
      expect(card, `button ${action}`).toContain(action);
    }
  });

  it("no input anywhere in the app collects an API key / secret", () => {
    const inputs = html.match(/<input\b[^>]*>/gi) || [];
    const forbidden = /(deepseek|api[_-]?key|secret|whatsapp[_-]?token|cloud[_-]?token|confirm[_-]?secret|cron[_-]?secret|service[_-]?role|db[_-]?password)/i;
    for (const tag of inputs) {
      expect(forbidden.test(tag), `input must not collect a secret: ${tag}`).toBe(false);
    }
  });

  it("opens the OFFICIAL Supabase/GitHub pages (secrets, new project, deploy, actions secrets)", () => {
    expect(html).toContain("https://supabase.com/dashboard/project/_/functions/secrets");
    expect(html).toContain("https://supabase.com/dashboard/new");
    expect(html).toContain("https://supabase.com/dashboard/account/tokens");
    expect(html).toContain("https://github.com/qw1qw66-sudo/index.html/actions");
    expect(html).toContain("https://github.com/qw1qw66-sudo/index.html/settings/secrets/actions");
    expect(html).toMatch(/window\.open\(\s*SETUP_SECRETS_URL/);
    expect(html).toMatch(/window\.open\(\s*SETUP_DEPLOY_URL/);
    expect(html).toMatch(/window\.open\(\s*SETUP_NEW_PROJECT_URL/);
    expect(html).toMatch(/window\.open\(\s*SETUP_GITHUB_SECRETS_URL/);
  });

  it("the copied key template is names + non-secret defaults ONLY (internal secrets are runner-generated)", () => {
    for (const key of ["DEEPSEEK_API_KEY=", "DEEPSEEK_MODEL=deepseek-v4-pro", "DEEPSEEK_BASE_URL=https://api.deepseek.com", "APP_ENV=staging"]) {
      expect(html).toContain(`"${key}"`);
    }
    // The owner never types these — the GitHub runner generates them.
    const js = setupJs();
    const template = js.slice(js.indexOf("SETUP_SECRET_TEMPLATE"), js.indexOf("].join"));
    expect(template).not.toContain("ASSISTANT_CONFIRM_SECRET");
    expect(template).not.toContain("AUTOPILOT_CRON_SECRET");
    expect(template).not.toContain("WHATSAPP_CLOUD_TOKEN");
    // The DeepSeek value field is blank (no example secret value).
    expect(js).toContain('"DEEPSEEK_API_KEY=",');
  });

  it("local storage from the setup flow holds ONLY the two non-secret staging values", () => {
    const js = setupJs();
    const writes = js.match(/localStorage\.setItem\(/g) || [];
    expect(writes.length).toBe(2);
    expect(js).toContain("localStorage.setItem(STAGING_REF_STORAGE_KEY");
    expect(js).toContain("localStorage.setItem(STAGING_PUBLISHABLE_STORAGE_KEY");
    expect(js).not.toMatch(/sessionStorage\.setItem/);
    // No secret-shaped value anywhere in the setup code.
    expect(js).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    expect(js).not.toMatch(/whsec_[A-Za-z0-9]+/);
  });

  it("the staging connect flow REJECTS secret-shaped keys and bad refs", () => {
    const js = setupJs();
    // Explicit guard against pasting a secret key into the publishable field
    // (pattern built from fragments so no secret-shaped literal exists).
    expect(js).toContain('new RegExp("^sb_" + "secret_")');
    expect(js).toContain("مفتاح سرّي");
    // Ref restricted to a safe shape that can only build <ref>.supabase.co.
    expect(html).toMatch(/\^\[a-z0-9\]\{15,30\}\$/);
  });

  it("staging mode is opt-in (?env=staging) and never redirects the canonical default", () => {
    expect(html).toContain('get("env") === "staging"');
    expect(html).toContain("APP_SUPABASE_URL");
    // The approved default URL remains the default assignment.
    expect(html).toMatch(/IS_STAGING_MODE\s*\?\s*"https:\/\/"\s*\+\s*STAGING_CONFIG\.ref[\s\S]{0,120}APP_SUPABASE_URL/);
  });
});
