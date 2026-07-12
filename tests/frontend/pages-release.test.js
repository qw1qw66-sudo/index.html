import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toolCatalogForModel } from "../../supabase/functions/_shared/assistant/tools.mjs";

// GitHub Pages release + assistant-UX guarantees, checked against the real
// index.html source and a simulated Pages artifact build.

const html = readFileSync("index.html", "utf8");

// Region between the JS marker and the next helper, holding the chat helpers.
function jsRegion(from, to) {
  const a = html.indexOf(from);
  const b = html.indexOf(to, a);
  return html.slice(a, b === -1 ? a + 4000 : b);
}

describe("build version", () => {
  it("uses the __APP_BUILD__ placeholder and drops the old static version", () => {
    expect(html).toContain("__APP_BUILD__");
    expect(html).not.toContain("final-808d67d");
    // The copy/open-current-version button exists.
    expect(html).toContain('data-action="open-current-version"');
    expect(html).toContain("__APP_BUILD_SHA__");
  });
});

describe("robots + no accidental indexing", () => {
  it("declares noindex,nofollow", () => {
    expect(html).toMatch(/<meta\s+name="robots"\s+content="noindex,nofollow"\s*\/?>/);
  });
});

describe("chat renders one clean answer", () => {
  const region = jsRegion("function renderToolResults", "async function assistantCall");
  it("read tools produce no chat bubble and never show a tool name or «تم جلب البيانات»", () => {
    expect(region).not.toContain("تم جلب البيانات");
    // No bubble is appended for read results (only prepared/completed actions).
    expect(region).not.toMatch(/assistantAppend\([^)]*r\.tool/);
    // Failures are logged to the hidden debug section, not shown as a bubble.
    expect(region).toContain("log(");
    expect(region).toContain('r.kind === "prepared_action"');
    expect(region).toContain('r.kind === "completed_action"');
  });
});

describe("assistant connection states", () => {
  it("uses the five distinct states and never labels an unavailable model as connected", () => {
    for (const s of ["متصل", "جارٍ التفكير", "غير متاح مؤقتاً", "وظائف الخادم غير منشورة", "فشل التحقق من الدخول"]) {
      expect(html).toContain(s);
    }
    // The assistant_unavailable branch must NOT set "متصل".
    const region = jsRegion("if (body.assistant_unavailable)", "} else if (body.ok)");
    expect(region).toContain("غير متاح مؤقتاً");
    expect(region).not.toContain('setAssistantConn("متصل"');
  });
});

describe("suggested commands", () => {
  const catalog = new Set(toolCatalogForModel().map((t) => t.name));
  // Parse the tool bindings from ASSISTANT_SUGGESTIONS.
  const block = jsRegion("const ASSISTANT_SUGGESTIONS", "function renderAssistantSuggestions");
  const tools = [...block.matchAll(/tool:\s*"([a-z_]+)"/g)].map((m) => m[1]);

  it("every visible suggestion maps to a genuinely registered read/prepare tool", () => {
    expect(tools.length).toBeGreaterThanOrEqual(8);
    for (const t of tools) {
      expect(catalog.has(t), `suggestion tool ${t} must be in the model catalog`).toBe(true);
    }
  });

  it("removes the automation-write suggestions (marketing stays disabled)", () => {
    expect(html).not.toContain("شغل التسويق التلقائي");
    expect(html).not.toContain("وقف التسويق التلقائي");
  });
});

describe("environment badge", () => {
  it("reads app_env and shows the staging test badge (never calls staging production)", () => {
    expect(html).toContain("بيئة التجربة — Staging");
    expect(html).toContain("applyEnvBadge");
    // Driven by the setup-status app_env value.
    expect(html).toMatch(/applyEnvBadge\(\s*body\.app_env\s*\)/);
  });
});

describe("canonical environment routing (no ?env=staging needed)", () => {
  it("the DEFAULT constants point at the approved project with only public values", () => {
    expect(html).toMatch(/APP_SUPABASE_URL = "https:\/\/fkqidesfrtpwzjcimjoe\.supabase\.co"/);
    expect(html).toMatch(/APP_SUPABASE_ANON_KEY = "sb_publishable_/);
    // The misleading PROD_-named split is gone.
    expect(html).not.toContain("PROD_SUPABASE_URL");
    expect(html).not.toContain("PROD_SUPABASE_ANON_KEY");
  });

  it("a full setup check runs automatically after login (rows + badge, no manual tap)", () => {
    expect(html).toMatch(/checkSetupConnection\(\{\s*quiet:\s*true\s*\}\)/);
  });
});

describe("setup status states are distinct and honest", () => {
  it("initial rows read «لم يُفحص بعد» — never a false «غير مربوط» before any probe", () => {
    const rowsBlock = jsRegion('<div class="setup-rows"', "setupCheckResult");
    expect(rowsBlock).toContain("لم يُفحص بعد");
    expect(rowsBlock).not.toContain("غير مربوط");
  });

  it("the state map distinguishes probe-failure from server-confirmed-missing", () => {
    const map = jsRegion("function setSetupRow", "async function checkSetupConnection");
    expect(map).toContain("تعذّر الفحص"); // unknown (probe failed)
    expect(map).toContain("لم يُفحص بعد"); // unchecked (no probe yet)
    expect(map).toContain("غير متاح مؤقتاً"); // model_down (observed outage)
    expect(map).toContain("غير مربوط"); // reserved: server said it's missing
  });

  it("a network failure never repaints rows as «غير مربوط» and auth/server errors are distinct", () => {
    const fn = jsRegion("async function checkSetupConnection", "function normalizeWorkspaceKey");
    // network branch uses the unknown state, not unlinked
    expect(fn).toMatch(/outcome === "network"[\s\S]{0,400}setSetupRow\("setupStatusDeepseek", "unknown"\)/);
    expect(fn).toContain('outcome = "auth"');
    expect(fn).toContain('outcome = "server"');
    expect(fn).toContain("فشل التحقق من الدخول أثناء الفحص");
    // «غير مربوط» is applied ONLY from server booleans, never in a failure
    // branch: the whole failure region (network → server, before the success
    // mapping) must not contain the unlinked state.
    const from = fn.indexOf('if (outcome === "network")');
    const to = fn.indexOf("تعذّر الفحص من الخادم");
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    expect(fn.slice(from, to)).not.toContain('"unlinked"');
  });

  it("an observed assistant outage mirrors onto the DeepSeek row as «غير متاح مؤقتاً»", () => {
    const branch = jsRegion("if (body.assistant_unavailable)", "} else if (body.ok)");
    expect(branch).toContain('setSetupRow("setupStatusDeepseek", "model_down")');
  });
});

describe("booking agent frontend (structured card + safe errors)", () => {
  it("renders the structured card rows with LTR isolation and the three buttons", () => {
    const region = jsRegion("const ASSISTANT_CONFIRM_LABELS", "function renderToolResults");
    expect(region).toContain("booking-rows");
    expect(region).toContain('data-action="assistant-confirm"');
    expect(region).toContain('data-action="assistant-edit"');
    expect(region).toContain('data-action="assistant-cancel-draft"');
    expect(region).toContain("حفظ الحجز");
    expect(region).toContain("تعديل");
    expect(region).toContain("إلغاء");
    expect(region).toContain('role", "group'.replace('", "', '", "')); // role=group set via setAttribute
    // No raw action id/token rendered as text content.
    expect(region).not.toContain("confirmation_token +");
  });

  it("never concatenates body.error into the DOM anywhere", () => {
    expect(html).not.toMatch(/\+\s*\(?\s*body\.error/);
    expect(html).not.toMatch(/\+\s*\(?\s*r\.error/);
    expect(html).toContain("function assistantSafeError");
  });

  it("typed confirmation words re-display the card client-side (never execute)", () => {
    expect(html).toContain("ASSISTANT_CONFIRM_WORDS");
    const region = jsRegion("async function assistantSend", "assistantBusy = true");
    expect(region).toContain("assistantLatestCard()");
    expect(region).toContain("راجع البطاقة واضغط حفظ الحجز");
  });

  it("pending work is recovered after login without tokens in storage", () => {
    expect(html).toContain("assistantRecoverPending");
    expect(html).toMatch(/pending_action:\s*"latest"/);
    // Tokens never persisted: no assistantTokens writes to any storage API.
    expect(html).not.toMatch(/localStorage[^\n]{0,60}assistantTokens/);
    expect(html).not.toMatch(/sessionStorage[^\n]{0,60}assistantTokens/);
  });

  it("Settings carries the read-only data-quality report", () => {
    expect(html).toContain('id="dataQualitySection"');
    expect(html).toContain("جودة البيانات");
    expect(html).toContain("renderDataQuality");
    expect(html).toContain("وقت الفترة غير مكتمل");
  });

  it("dates display as DD-MM-YYYY inside .ltr and today() is Riyadh-anchored", () => {
    expect(html).toContain("function formatDateDisplay");
    expect(html).toMatch(/RIYADH_OFFSET_MS = 3 \* 60 \* 60 \* 1000/);
    expect(html).toMatch(/<span class="ltr">' \+ esc\(formatDateDisplay\(b\.booking_date\)\)/);
  });

  it("a terminal confirm failure removes the dead card + its token (never re-arms)", () => {
    const region = jsRegion("async function assistantConfirm", "async function assistantDraftAction");
    // The completed_action-failure branch must clear the card and its token…
    const failBranch = region.slice(region.indexOf('body.kind === "completed_action"'));
    expect(failBranch).toContain("delete assistantTokens[actionId]");
    expect(failBranch).toContain("card.remove()");
    // …while non-terminal failures still just unlock the card.
    expect(region).toContain("setCardBusy(card, false, btn)");
  });

  it("switching tabs never emits visible debug text (the «فتح تبويب» bubble)", () => {
    expect(html).not.toContain("فتح تبويب");
  });

  it("connection failures are honest and self-healing (network vs server fault)", () => {
    // Network-level failure and server-side crash carry DIFFERENT wordings…
    expect(html).toContain("تعذّر الوصول إلى الخادم");
    expect(html).toContain("خلل مؤقت في الخادم");
    // …the dead-air wording from the live incident is gone from the send path…
    expect(html).not.toContain("تعذّر الاتصال بالمساعد. لم يتغيّر شيء.");
    // …and a red badge re-probes on backoff + is tappable for an instant check.
    expect(html).toContain("function scheduleAssistantReprobe");
    expect(html).toContain("assistantReprobeNow");
    expect(html).toMatch(/thread_action:\s*"list"/); // side-effect-free ping
  });

  it("conflict alternatives render as one-tap chips in BOTH reply paths", () => {
    expect(html).toContain("function renderNextActionChips");
    // Chips reuse the auto-send suggestion delegation (tap sends «١»).
    const fn = jsRegion("function renderNextActionChips", "function setAssistantConn");
    expect(fn).toContain('data-action="assistant-suggest"');
    expect(fn).toContain("chat-options");
    // Called after a normal bot reply AND after a terminal confirm failure.
    const sendRegion = jsRegion("async function assistantSend", "async function assistantConfirm");
    expect(sendRegion).toContain("renderNextActionChips(body.next_actions)");
    const confirmRegion = jsRegion("async function assistantConfirm", "async function assistantDraftAction");
    expect(confirmRegion).toContain("renderNextActionChips(body.next_actions)");
  });
});

// ---- Pages artifact: simulate the workflow build (copy + sed) ----
describe("Pages artifact", () => {
  const FAKE_SHA = "abcdef0123456789abcdef0123456789abcdef01";
  const short = FAKE_SHA.slice(0, 7);
  const dist = html
    .replace(/__APP_BUILD__/g, "main-" + short)
    .replace(/__APP_BUILD_SHA__/g, FAKE_SHA);

  it("index.html and 404.html exist as the only app files", () => {
    expect(existsSync("index.html")).toBe(true);
    expect(existsSync("404.html")).toBe(true);
  });

  it("contains the assistant tab, setup card and six-tab navigation", () => {
    expect(dist).toContain('id="tab-assistant"');
    expect(dist).toContain('id="setupCard"');
    const tabs = [...dist.matchAll(/<button class="tab-button[^"]*" data-tab="([a-z]+)"/g)].map((m) => m[1]);
    expect(tabs).toEqual(["home", "bookings", "chalets", "reports", "assistant", "settings"]);
  });

  it("carries the injected main-<sha> version and no leftover placeholder", () => {
    expect(dist).toContain("main-" + short);
    expect(dist).not.toContain("__APP_BUILD__");
    expect(dist).not.toContain("__APP_BUILD_SHA__");
  });

  it("contains no secret-shaped value (publishable anon key is allowed)", () => {
    expect(dist).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
    expect(dist).not.toMatch(/sb_secret_[A-Za-z0-9]{10,}/);
    expect(dist).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    // A real leak is an assigned value on ONE line (`KEY="sk-..."`). The empty
    // `"DEEPSEEK_API_KEY="` setup template is safe, so bound the value to a
    // single line (mirrors the workflow's line-based grep).
    expect(dist).not.toMatch(/DEEPSEEK_API_KEY\s*[:=]\s*["'][^"'\n]{8,}/);
    // No service-role JWT assignment.
    expect(dist).not.toMatch(/service_role[^\n]{0,40}ey[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/);
    expect(dist).toContain("sb_publishable_"); // expected public key
  });

  it("the workflow uploads only index.html + 404.html (no exports/supabase/tests/database)", () => {
    const wf = readFileSync(".github/workflows/pages.yml", "utf8");
    expect(wf).toContain("cp index.html dist/index.html");
    expect(wf).toContain("cp 404.html dist/404.html");
    expect(wf).toMatch(/find dist -type f \| wc -l.*-eq 2/s);
    // Nothing but the two app files is copied into the artifact: no `cp` of a
    // sensitive tree, and the guard that asserts those trees are absent stays.
    expect(wf).not.toMatch(/cp\s+[^\n]*\b(database|supabase|exports|tests|scripts|node_modules)\b[^\n]*dist/);
    expect(wf).toContain("test ! -e dist/database");
    expect(wf).toContain("test ! -e dist/supabase");
    // The guard must check only the exact replaceable tokens. A broad
    // "__APP_BUILD" prefix also exists intentionally in the local-dev helper.
    expect(wf).toContain('grep -qF "__APP_BUILD__" dist/index.html');
    expect(wf).toContain('grep -qF "__APP_BUILD_SHA__" dist/index.html');
    expect(wf).not.toContain('grep -qF "__APP_BUILD" dist/index.html');
    expect(wf).toContain('grep -qF "const APP_BUILD = \\"main-${short}\\";" dist/index.html');
    expect(wf).toContain('grep -qF "const APP_BUILD_SHA = \\"${GITHUB_SHA}\\";" dist/index.html');
    // github-pages environment fix (the concrete cause of the failed run).
    expect(wf).toContain("environment:");
    expect(wf).toContain("name: github-pages");
    expect(wf).toContain("url: ${{ steps.deployment.outputs.page_url }}");
    expect(wf).not.toMatch(/^\s*pull_request:/m);
  });
});
