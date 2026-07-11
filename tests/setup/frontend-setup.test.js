import { describe, expect, it } from "vitest";
import { inlineHtml } from "../payments/helpers/extract-inline.mjs";

// Static guarantees about the mobile setup section: it is button-only (no
// secret input anywhere in the app), it opens the OFFICIAL Supabase secrets
// page and the repo Actions page, its copied template carries no secret values,
// and no secret is written to local/session storage or the workspace document.

const html = inlineHtml();

// Extract the setup card markup (id="setupCard" up to the bottom-nav comment).
function setupCardHtml() {
  const start = html.indexOf('id="setupCard"');
  expect(start, "setupCard must exist").toBeGreaterThan(-1);
  const end = html.indexOf("HTML: bottom navigation", start);
  return html.slice(start, end === -1 ? start + 6000 : end);
}

describe("mobile setup page — security & structure", () => {
  it("renders the setup card with the required Arabic title and 6 status rows", () => {
    const card = setupCardHtml();
    expect(card).toContain("إعداد المساعد الذكي");
    for (const id of ["setupStatusSupabase", "setupStatusFunctions", "setupStatusDeepseek", "setupStatusConfirm", "setupStatusAutopilot", "setupStatusWhatsapp"]) {
      expect(card, `row ${id}`).toContain(id);
    }
    // Each label present.
    for (const label of ["مشروع Supabase", "وظائف الخادم", "DeepSeek", "مفتاح التأكيد", "الأوتوبايلوت", "واتساب الرسمي"]) {
      expect(card).toContain(label);
    }
  });

  it("the setup card contains NO input/textarea/select — it is button-only (no secret entry)", () => {
    const card = setupCardHtml();
    expect(card).not.toMatch(/<input\b/i);
    expect(card).not.toMatch(/<textarea\b/i);
    expect(card).not.toMatch(/<select\b/i);
    // The buttons that exist are the four setup actions only.
    for (const action of ["setup-open-secrets", "setup-copy-template", "setup-check", "setup-open-deploy"]) {
      expect(card).toContain(action);
    }
  });

  it("no input anywhere in the app collects an API key / secret", () => {
    // No <input> in the whole document references a secret-key concept.
    const inputs = html.match(/<input\b[^>]*>/gi) || [];
    const forbidden = /(deepseek|api[_-]?key|secret|whatsapp[_-]?token|cloud[_-]?token|confirm[_-]?secret|cron[_-]?secret|service[_-]?role)/i;
    for (const tag of inputs) {
      expect(forbidden.test(tag), `input must not collect a secret: ${tag}`).toBe(false);
    }
  });

  it("opens the OFFICIAL Supabase secrets page and the repo Actions page", () => {
    expect(html).toContain("https://supabase.com/dashboard/project/_/functions/secrets");
    expect(html).toContain("https://github.com/qw1qw66-sudo/index.html/actions");
    // Both are opened in a new tab via window.open.
    expect(html).toMatch(/window\.open\(\s*SETUP_SECRETS_URL/);
    expect(html).toMatch(/window\.open\(\s*SETUP_DEPLOY_URL/);
  });

  it("the copied key template lists names + non-secret defaults but NO secret values", () => {
    // The exact required key names appear...
    for (const key of ["DEEPSEEK_API_KEY=", "DEEPSEEK_MODEL=deepseek-v4-flash", "DEEPSEEK_BASE_URL=https://api.deepseek.com", "ASSISTANT_CONFIRM_SECRET=", "AUTOPILOT_CRON_SECRET=", "APP_ENV=staging", "WHATSAPP_CLOUD_TOKEN=", "WHATSAPP_PHONE_ID="]) {
      expect(html).toContain(`"${key}"`);
    }
    // ...and the SECRET fields are blank (immediately followed by the closing
    // quote + comma), i.e. no example secret value is shipped.
    for (const secretKey of ["DEEPSEEK_API_KEY", "ASSISTANT_CONFIRM_SECRET", "AUTOPILOT_CRON_SECRET", "WHATSAPP_CLOUD_TOKEN", "WHATSAPP_PHONE_ID"]) {
      expect(html).toContain(`"${secretKey}=",`);
    }
  });

  it("the setup flow never writes a secret to local/session storage or the workspace doc", () => {
    // The setup helpers must not persist anything: no storage writes appear in
    // the setup source region, and the check only sends the session PIN (auth),
    // exactly like the rest of the app — never a DeepSeek/WhatsApp key.
    const start = html.indexOf("JS: mobile setup");
    const end = html.indexOf("function normalizeWorkspaceKey", start);
    const js = html.slice(start, end);
    expect(js).not.toMatch(/localStorage\.setItem/);
    expect(js).not.toMatch(/sessionStorage\.setItem/);
    // The template constant + setup code hold no secret-shaped value.
    expect(js).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    expect(js).not.toMatch(/whsec_[A-Za-z0-9]+/);
  });
});
