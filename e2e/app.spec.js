import { expect, test } from '@playwright/test';

// A booking date safely in the future relative to "today". The bookings list
// only shows booking_date >= today, so hard-coded dates rot (this exact
// failure happened on main with 2026-06-01 — see audit AUD-010).
const FUTURE_DATE = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);

// Mock of the CURRENT production server (v1 RPCs only): a workspace does not
// exist until first saved, get fails for missing workspaces exactly like the
// real SQL does, and the new v2/payment RPCs return 404 so the app's
// graceful-fallback paths are what these tests exercise.
async function mockRpc(page) {
  const calls = [];
  let exists = false;
  let cloud = {
    ok: true,
    workspace_key: 'TEST1',
    updated_at: '2026-01-01T00:00:00.000Z',
    data: { schema_version: 3, settings: { facility_name: '', tag: '', holidays: [] }, chalets: [], bookings: [] }
  };

  await page.route('**/rest/v1/rpc/**', async (route) => {
    const name = route.request().url().split('/').pop();
    const body = JSON.parse(route.request().postData() || '{}');
    calls.push({ name, body });

    if (body.p_access_pin === 'wrong') {
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'WORKSPACE_NOT_FOUND_OR_PIN_INVALID' }) });
      return;
    }

    if (name === 'get_shared_workspace') {
      if (!exists) {
        await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'WORKSPACE_NOT_FOUND_OR_PIN_INVALID' }) });
        return;
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(cloud) });
      return;
    }

    if (name === 'save_shared_workspace') {
      exists = true;
      cloud = {
        ok: true,
        workspace_key: String(body.p_workspace_key || 'TEST1').toUpperCase(),
        updated_at: new Date(Date.parse(cloud.updated_at) + 60000).toISOString(),
        data: body.p_data
      };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(cloud) });
      return;
    }

    // create_shared_workspace / save_shared_workspace_v2 / payment RPCs do
    // not exist on the un-migrated production server.
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'unknown rpc' }) });
  });

  return { calls, cloud: () => cloud };
}

async function create(page) {
  await page.locator('#workspaceInput').fill('test1');
  // New accounts require a 6+ character PIN (create-flow hardening).
  await page.locator('#pinInput').fill('123456');
  await page.locator('#createButton').click();
  await expect(page.locator('#appShell')).toBeVisible();
}

async function createChaletWithSixPeriods(page) {
  await page.locator('[data-tab="chalets"]').click();
  await page.locator('[data-action="new-chalet"]').click();
  await page.locator('#chaletName').fill('Tulum');
  await expect(page.locator('.period-card')).toHaveCount(6);
  await page.locator('[data-period-field="label"]').first().fill('Morning');
  await page.locator('[data-period-field="start"]').first().fill('07:00');
  await page.locator('[data-period-field="end"]').first().fill('17:00');
  await page.locator('[data-action="save-chalet"]').click();
}

test('T11 account login screen and create account', async ({ page }) => {
  const rpc = await mockRpc(page);
  await page.goto('/');
  await expect(page.locator('#connectScreen')).toBeVisible();
  await expect(page.locator('body')).toContainText('اسم المستخدم / رمز المساحة');
  await expect(page.locator('body')).toContainText('الرقم السري');
  await expect(page.locator('#debugLog')).toContainText('Ready');
  expect(rpc.calls).toEqual([]);
  await create(page);
  expect(rpc.calls.filter((call) => call.name === 'save_shared_workspace')).toHaveLength(1);
  expect(rpc.cloud().data.chalets).toEqual([]);
  expect(rpc.cloud().data.bookings).toEqual([]);
});

test('wrong password stays on login screen', async ({ page }) => {
  await mockRpc(page);
  await page.goto('/');
  await page.locator('#workspaceInput').fill('test1');
  await page.locator('#pinInput').fill('wrong');
  await page.locator('#pullButton').click();
  await expect(page.locator('#appShell')).toBeHidden();
  await expect(page.locator('#loginMessage')).toContainText('فشل الدخول');
});

test('T12/T13 chalet edit keeps id and exposes exactly six editable periods', async ({ page }) => {
  await mockRpc(page);
  await page.goto('/');
  await create(page);
  await createChaletWithSixPeriods(page);
  await expect(page.locator('#feedback')).toContainText('تم تحديث بيانات الشاليه.');

  await page.locator('[data-action="edit-chalet"]').click();
  await expect(page.locator('.period-card')).toHaveCount(6);
  const firstPeriodId = await page.locator('.period-card').first().getAttribute('data-period-id');
  await page.locator('#chaletCapacity').fill('20');
  await page.locator('[data-period-field="label"]').nth(1).fill('Evening');
  await page.locator('[data-period-field="active"]').nth(1).uncheck();
  await page.locator('[data-action="save-chalet"]').click();
  await page.locator('[data-action="edit-chalet"]').click();
  await expect(page.locator('.period-card')).toHaveCount(6);
  await expect(page.locator('.period-card').first()).toHaveAttribute('data-period-id', firstPeriodId || '');
});

test('T14 booking period dropdown uses only selected chalet active periods', async ({ page }) => {
  await mockRpc(page);
  await page.goto('/');
  await create(page);
  await createChaletWithSixPeriods(page);
  await page.locator('[data-tab="bookings"]').click();
  await page.locator('[data-action="new-booking"]').click();
  await expect(page.locator('#bookingPeriodId option')).toHaveCount(6);
  await page.locator('[data-tab="chalets"]').click();
  await page.locator('[data-action="edit-chalet"]').click();
  await page.locator('[data-period-field="active"]').nth(1).uncheck();
  await page.locator('[data-action="save-chalet"]').click();
  await page.locator('[data-tab="bookings"]').click();
  await page.locator('[data-action="new-booking"]').click();
  await expect(page.locator('#bookingPeriodId option')).toHaveCount(5);
  await expect(page.locator('#bookingPeriodId')).not.toContainText('الفترة 2');
});

test('conflict and voucher use selected period exactly', async ({ page }) => {
  await mockRpc(page);
  await page.goto('/');
  await create(page);
  await page.locator('[data-tab="settings"]').click();
  await page.locator('#settingFacilityName').fill('QA Facility');
  await page.locator('[data-action="save-settings"]').click();
  await createChaletWithSixPeriods(page);
  await page.locator('[data-tab="bookings"]').click();
  await page.locator('[data-action="new-booking"]').click();
  await page.locator('#bookingCustomerName').fill('Ali');
  await page.locator('#bookingCustomerPhone').fill('0509999999');
  await page.locator('#bookingDate').fill(FUTURE_DATE);
  await page.locator('#bookingTotal').fill('900');
  await page.locator('#bookingPaid').fill('300');
  await page.locator('[data-action="save-booking"]').click();

  await page.locator('[data-action="new-booking"]').click();
  await page.locator('#bookingCustomerName').fill('Other');
  await page.locator('#bookingCustomerPhone').fill('0555555555');
  await page.locator('#bookingDate').fill(FUTURE_DATE);
  await page.locator('[data-action="save-booking"]').click();
  await expect(page.locator('#feedback')).toContainText('يوجد حجز مؤكد متعارض في نفس الشاليه والفترة.');

  await page.locator('#bookingList [data-action="voucher"]').first().click();
  await expect(page.locator('#voucherBox')).toContainText('QA Facility');
  await expect(page.locator('#voucherBox')).toContainText('Tulum');
  await expect(page.locator('#voucherBox')).toContainText('Morning');
  // The voucher displays the selected period's times in the app's 12h Arabic
  // format (formatTime12): 07:00 -> "7:00 ص", 17:00 -> "5:00 م".
  await expect(page.locator('#voucherBox')).toContainText('7:00 ص');
  await expect(page.locator('#voucherBox')).toContainText('5:00 م');
});

test('payment panel is safely disabled while the payments backend is missing', async ({ page }) => {
  await mockRpc(page);
  await page.goto('/');
  await create(page);
  await createChaletWithSixPeriods(page);
  await page.locator('[data-tab="bookings"]').click();
  await page.locator('[data-action="new-booking"]').click();
  await page.locator('#bookingCustomerName').fill('Ali');
  await page.locator('#bookingCustomerPhone').fill('0509999999');
  await page.locator('#bookingDate').fill(FUTURE_DATE);
  await page.locator('#bookingTotal').fill('900');
  await page.locator('[data-action="save-booking"]').click();

  await page.locator('#bookingList [data-action="edit-booking"]').first().click();
  await page.locator('#paymentSection summary').click();
  // Clear Arabic explanation + disabled actions: no ledger backend, no
  // provider => no payment links, no manual ledger entries, no silent
  // changes to the legacy paid field.
  await expect(page.locator('#paymentPanelNotice')).toContainText('سجل المدفوعات غير مفعّل بعد على الخادم');
  await expect(page.locator('#createPaymentLinkButton')).toBeDisabled();
  await expect(page.locator('#showManualPaymentButton')).toBeDisabled();
  // The legacy paid/total fields still work exactly as before.
  await expect(page.locator('#bookingPaid')).toBeEnabled();
});

test('mobile viewport: booking editor and payment panel stay usable (iPhone size)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockRpc(page);
  await page.goto('/');
  await create(page);
  await createChaletWithSixPeriods(page);
  await page.locator('[data-tab="bookings"]').click();
  await page.locator('[data-action="new-booking"]').click();
  await expect(page.locator('#bookingEditor')).toBeVisible();
  await page.locator('#bookingCustomerName').fill('Ali');
  await page.locator('#bookingDate').fill(FUTURE_DATE);
  await page.locator('#bookingTotal').fill('900');
  await page.locator('#bookingPaid').fill('300');
  await expect(page.locator('#bookingRemaining')).toHaveValue('600');
  await page.locator('[data-action="save-booking"]').click();
  await expect(page.locator('#feedback')).toContainText('تم حفظ الحجز محليًا');
  // RTL layout intact and no horizontal overflow on a phone-sized screen.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await page.locator('#bookingList [data-action="edit-booking"]').first().click();
  await page.locator('#paymentSection summary').click();
  await expect(page.locator('#paymentPanelNotice')).toBeVisible();
});

test('assistant tab is present and degrades safely when the backend is absent', async ({ page }) => {
  // The mock only handles /rest/v1/rpc/**; /functions/v1/chalet-assistant is
  // unhandled -> the browser fetch fails, so the tab must show a safe message
  // and never claim any action happened.
  await mockRpc(page);
  await page.route('**/functions/v1/**', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"not deployed"}' }));
  await page.goto('/');
  await create(page);
  await page.locator('[data-tab="assistant"]').click();
  await expect(page.locator('#tab-assistant')).toBeVisible();
  await expect(page.locator('#assistantSuggestions')).toContainText('حجوزات اليوم');
  await page.locator('#assistantInput').fill('شنو حجوزات اليوم؟');
  await page.locator('[data-action="assistant-send"]').click();
  // The user message is echoed and a safe "not enabled" reply appears; no crash.
  await expect(page.locator('#assistantLog')).toContainText('شنو حجوزات اليوم؟');
  await expect(page.locator('#assistantLog')).toContainText('غير مفعّل');
});

// Mock the assistant Edge Function with a scripted JSON reply so the chat DOM
// behaviour (§3 one clean answer, §5 connection states) is verified end-to-end.
async function routeAssistant(page, body, status = 200) {
  await page.route('**/functions/v1/chalet-assistant', (route) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }),
  );
}

test('assistant: a successful read shows ONE natural answer (no tool name, no «تم جلب البيانات»)', async ({ page }) => {
  await mockRpc(page);
  await routeAssistant(page, {
    ok: true,
    thread_id: 'th-1',
    reply_ar: 'لا توجد حجوزات اليوم.',
    tool_results: [
      { kind: 'read', ok: true, tool: 'get_today_bookings', result: { date: '2026-07-11', bookings: [] } },
    ],
    model_calls: 2,
  });
  await page.goto('/');
  await create(page);
  await page.locator('[data-tab="assistant"]').click();
  await page.locator('#assistantInput').fill('شنو حجوزات اليوم؟');
  await page.locator('[data-action="assistant-send"]').click();
  // The single grounded answer appears and the connection reads "متصل".
  await expect(page.locator('#assistantLog')).toContainText('لا توجد حجوزات اليوم.');
  await expect(page.locator('#assistantConn')).toHaveText('متصل');
  // Nothing leaks the internal tool name, a data-fetched filler, or stage-1 wording.
  const logText = await page.locator('#assistantLog').innerText();
  expect(logText).not.toContain('get_today_bookings');
  expect(logText).not.toContain('تم جلب البيانات');
  expect(logText).not.toContain('جاري');
  // A plain read renders no confirmation card.
  await expect(page.locator('#assistantActions .action-card')).toHaveCount(0);
});

test('assistant: an unavailable model is NOT shown as connected (§5)', async ({ page }) => {
  await mockRpc(page);
  await routeAssistant(page, { assistant_unavailable: true });
  await page.goto('/');
  await create(page);
  await page.locator('[data-tab="assistant"]').click();
  await page.locator('#assistantInput').fill('شنو حجوزات اليوم؟');
  await page.locator('[data-action="assistant-send"]').click();
  await expect(page.locator('#assistantConn')).toHaveText('غير متاح مؤقتاً');
  await expect(page.locator('#assistantConn')).not.toHaveText('متصل');
  await expect(page.locator('#assistantLog')).toContainText(
    'تعذّر الوصول إلى المساعد حالياً، ولم يتم تنفيذ أي إجراء.',
  );
});

test('canonical login auto-fills the REAL setup status (no ?env=staging, no manual tap)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockRpc(page);
  await page.route('**/functions/v1/chalet-setup-status', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        assistant_function_deployed: true,
        deepseek_configured: true,
        assistant_confirm_secret_configured: true,
        autopilot_secret_configured: true,
        whatsapp_configured: false,
        app_env: 'staging',
      }),
    }),
  );
  await page.goto('/'); // canonical URL — NO env param, NO stored staging config
  await create(page);
  // The rows populate from the automatic post-login check — no button tap.
  await expect(page.locator('#setupStatusSupabase')).toHaveText('مربوط');
  await expect(page.locator('#setupStatusFunctions')).toHaveText('مربوط');
  await expect(page.locator('#setupStatusDeepseek')).toHaveText('مربوط');
  await expect(page.locator('#setupStatusConfirm')).toHaveText('مربوط');
  await expect(page.locator('#setupStatusAutopilot')).toHaveText('غير مفعل');
  await expect(page.locator('#setupStatusWhatsapp')).toHaveText('غير مفعل');
  // The server says staging → the badge shows, without ?env=staging.
  await expect(page.locator('#stagingBadge')).toBeVisible();
  await expect(page.locator('#stagingBadge')).toContainText('بيئة التجربة');
  // No secret-shaped value may live in browser storage after login.
  const stored = await page.evaluate(() =>
    JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]),
  );
  expect(stored).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
  expect(stored).not.toMatch(/sb_secret_/);
  expect(stored).not.toMatch(/service_?role/i);
});

test('a failed status probe shows «تعذّر الفحص» — never a false «غير مربوط» on every row', async ({ page }) => {
  await mockRpc(page);
  await page.route('**/functions/v1/chalet-setup-status', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false}' }),
  );
  await page.goto('/');
  await create(page);
  await page.locator('[data-tab="settings"]').click();
  await page.locator('[data-action="setup-check"]').click();
  // The project DID answer (HTTP 500) → project row is linked; the rest are
  // "probe failed", explicitly distinct from a server-confirmed «غير مربوط».
  await expect(page.locator('#setupStatusSupabase')).toHaveText('مربوط');
  await expect(page.locator('#setupStatusDeepseek')).toHaveText('تعذّر الفحص');
  await expect(page.locator('#setupStatusConfirm')).toHaveText('تعذّر الفحص');
  await expect(page.locator('#setupCheckResult')).toContainText('أعد المحاولة');
  const bad = await page.locator('.setup-status', { hasText: 'غير مربوط' }).count();
  expect(bad).toBe(0);
});

test('assistant: a prepared action renders a confirmation card (still gated)', async ({ page }) => {
  await mockRpc(page);
  await routeAssistant(page, {
    ok: true,
    thread_id: 'th-1',
    reply_ar: 'جهّزت الحجز، بانتظار تأكيدك.',
    tool_results: [
      {
        kind: 'prepared_action',
        ok: true,
        action_id: 'act-1',
        confirmation_token: 'tok-xyz',
        confirm_tool: 'confirm_booking_create',
        summary_ar: 'حجز جديد لعلي بتاريخ 2099-06-01.',
      },
    ],
  });
  await page.goto('/');
  await create(page);
  await page.locator('[data-tab="assistant"]').click();
  await page.locator('#assistantInput').fill('جهز حجز');
  await page.locator('[data-action="assistant-send"]').click();
  await expect(page.locator('#assistantActions .action-card')).toHaveCount(1);
  await expect(page.locator('#assistantActions')).toContainText('حجز جديد');
  await expect(page.locator('#assistantActions [data-action="assistant-confirm"]')).toBeVisible();
});

// A full structured card as the server now sends it (card rows + buttons).
const BOOKING_CARD_BODY = {
  ok: true,
  thread_id: 'th-1',
  reply_ar: 'جهّزت الحجز — راجع البطاقة ثم اضغط حفظ الحجز.',
  model_calls: 0,
  tool_results: [
    {
      kind: 'prepared_action',
      ok: true,
      action_id: 'act-9',
      confirmation_token: 'tok-live',
      confirm_tool: 'confirm_booking_create',
      summary_ar: 'تجهيز حجز جديد.',
      card: {
        title: 'حجز جديد',
        rows: [
          { k: 'العميل', v: 'علي تجربة', ltr: false },
          { k: 'الجوال', v: '05••••4567', ltr: true },
          { k: 'الشاليه', v: 'شاليه تولوم', ltr: false },
          { k: 'التاريخ', v: '13-07-2026', ltr: true },
          { k: 'الفترة', v: '19:00 → 05:00', ltr: true },
          { k: 'الضيوف', v: '4', ltr: true },
          { k: 'الإجمالي', v: '500 ريال', ltr: true },
          { k: 'الملاحظات', v: 'لا توجد', ltr: false },
        ],
      },
    },
  ],
};

test('booking card: structured rows, LTR values, three buttons, dark theme, above the nav (390x844)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockRpc(page);
  await routeAssistant(page, BOOKING_CARD_BODY);
  await page.goto('/');
  await create(page);
  // Dark theme must render the card too.
  await page.locator('[data-tab="settings"]').click();
  await page.locator('#themeDarkButton').click();
  await page.locator('[data-tab="assistant"]').click();
  await page.locator('#assistantInput').fill('احجز تولوم بكرة بالليل لأربعة بخمسمئة، العميل علي تجربة');
  await page.locator('[data-action="assistant-send"]').click();
  const card = page.locator('#assistantActions .action-card');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('حجز جديد');
  await expect(card).toContainText('علي تجربة');
  // Date/time/phone/amount live in .ltr wrappers.
  await expect(card.locator('.booking-v.ltr')).toHaveCount(5);
  await expect(card.locator('[data-action="assistant-confirm"]')).toHaveText('حفظ الحجز');
  await expect(card.locator('[data-action="assistant-edit"]')).toBeVisible();
  await expect(card.locator('[data-action="assistant-cancel-draft"]')).toBeVisible();
  // No raw ids/tokens/codes anywhere in the visible card.
  const text = await card.innerText();
  expect(text).not.toMatch(/act-9|tok-live|[A-Z]{2,}_[A-Z]/);
  // The buttons are REACHABLE above the fixed bottom nav: after scrolling
  // them into view they must sit fully above it (the page reserves space).
  const saveBtn = card.locator('[data-action="assistant-confirm"]');
  await saveBtn.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, 200)); // push to the very end
  const btnBox = await saveBtn.boundingBox();
  const navBox = await page.locator('.bottom-nav').boundingBox();
  expect(btnBox.y + btnBox.height).toBeLessThanOrEqual(navBox.y + 1);
  // No horizontal overflow in dark RTL mobile.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test('typed «سجل» flashes the card and never fires a request; double-tap confirms once', async ({ page }) => {
  await mockRpc(page);
  let assistantCalls = 0;
  let confirmCalls = 0;
  await page.route('**/functions/v1/chalet-assistant', async (route) => {
    assistantCalls++;
    const body = JSON.parse(route.request().postData() || '{}');
    if (body.invoke_tool && String(body.invoke_tool.name).startsWith('confirm_')) {
      confirmCalls++;
      // Slow response so a double-tap window exists.
      await new Promise((r) => setTimeout(r, 400));
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, kind: 'completed_action', tool: body.invoke_tool.name, result: { action: 'booking_created', booking_id: 'bk-1' } }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(BOOKING_CARD_BODY) });
  });
  await page.goto('/');
  await create(page);
  await page.locator('[data-tab="assistant"]').click();
  await page.locator('#assistantInput').fill('احجز تولوم');
  await page.locator('[data-action="assistant-send"]').click();
  await expect(page.locator('#assistantActions .action-card')).toHaveCount(1);
  const callsAfterCard = assistantCalls;
  // «سجل» -> client-side reminder only, no network call, no execution.
  await page.locator('#assistantInput').fill('سجل');
  await page.locator('[data-action="assistant-send"]').click();
  await expect(page.locator('#assistantLog')).toContainText('راجع البطاقة واضغط حفظ الحجز');
  expect(assistantCalls).toBe(callsAfterCard);
  // Double-tap the save button: exactly ONE confirm request.
  const save = page.locator('[data-action="assistant-confirm"]');
  await save.click();
  await save.click({ force: true }).catch(() => {});
  await expect(page.locator('#assistantLog')).toContainText('تم إنشاء الحجز بنجاح');
  expect(confirmCalls).toBe(1);
});

test('تعديل keeps the draft fields; إلغاء cancels safely (server-driven)', async ({ page }) => {
  await mockRpc(page);
  await page.route('**/functions/v1/chalet-assistant', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    if (body.draft_action === 'reopen') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, reply_ar: 'تمام — ماذا تريد تعديله؟ اكتب التغيير فقط.' }) });
    }
    if (body.draft_action === 'cancel') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, draft_cancelled: true, reply_ar: 'تم الإلغاء، لم يُحفظ شيء.' }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(BOOKING_CARD_BODY) });
  });
  await page.goto('/');
  await create(page);
  await page.locator('[data-tab="assistant"]').click();
  await page.locator('#assistantInput').fill('احجز تولوم');
  await page.locator('[data-action="assistant-send"]').click();
  await expect(page.locator('#assistantActions .action-card')).toHaveCount(1);
  await page.locator('[data-action="assistant-edit"]').click();
  await expect(page.locator('#assistantLog')).toContainText('ماذا تريد تعديله');
  // The retired card leaves with its dead button; the edit yields a NEW card.
  await expect(page.locator('#assistantActions .action-card')).toHaveCount(0);
  await page.locator('#assistantInput').fill('الضيوف ستة');
  await page.locator('[data-action="assistant-send"]').click();
  await expect(page.locator('#assistantActions .action-card')).toHaveCount(1);
  // إلغاء dismisses and closes the draft safely.
  await page.locator('[data-action="assistant-cancel-draft"]').click();
  await expect(page.locator('#assistantActions .action-card')).toHaveCount(0);
  await expect(page.locator('#assistantLog')).toContainText('تم الإلغاء، لم يُحفظ شيء.');
});

test('pending booking card is recovered after a reload (rotated token, nothing in storage)', async ({ page }) => {
  await mockRpc(page);
  await page.route('**/functions/v1/chalet-setup-status', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, assistant_function_deployed: true, deepseek_configured: true, assistant_confirm_secret_configured: true, autopilot_secret_configured: true, whatsapp_configured: false, app_env: 'staging' }) }),
  );
  await page.route('**/functions/v1/chalet-assistant', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    if (body.pending_action === 'latest') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, pending: { ...BOOKING_CARD_BODY.tool_results[0], confirmation_token: 'tok-rotated', thread_id: 'th-1' } }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(BOOKING_CARD_BODY) });
  });
  await page.goto('/');
  await create(page);
  // Reload: the session snapshot restores login; the pending card returns from
  // the SERVER (with a rotated token) — no token ever sits in storage.
  await page.reload();
  await expect(page.locator('#appShell')).toBeVisible();
  await page.locator('[data-tab="assistant"]').click();
  await expect(page.locator('#assistantActions .action-card')).toHaveCount(1);
  await expect(page.locator('#assistantLog')).toContainText('بانتظار تأكيدك');
  const stored = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
  expect(stored).not.toContain('tok-rotated');
  expect(stored).not.toContain('tok-live');
});

test('mobile setup page: iPhone-sized, button-only, opens official pages, checks connection', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockRpc(page);
  // Stub the setup-status Edge Function with a booleans-only response.
  await page.route('**/functions/v1/chalet-setup-status', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        assistant_function_deployed: true,
        deepseek_configured: true,
        assistant_confirm_secret_configured: true,
        autopilot_secret_configured: false,
        whatsapp_configured: false,
        app_env: 'staging',
      }),
    }),
  );
  // Capture window.open targets without navigating away.
  await page.addInitScript(() => {
    window.__opened = [];
    window.open = (u) => {
      window.__opened.push(String(u));
      return null;
    };
  });
  await page.goto('/');
  await create(page);
  await page.locator('[data-tab="settings"]').click();
  await expect(page.locator('#setupCard')).toBeVisible();
  await expect(page.locator('#setupCard')).toContainText('إعداد المساعد الذكي');

  // DOM evidence: the only inputs are the two NON-secret staging fields
  // (Project Ref + publishable key) — no API-key/secret entry exists.
  await expect(page.locator('#setupCard input')).toHaveCount(2);
  await expect(page.locator('#setupCard #stagingRefInput')).toHaveCount(1);
  await expect(page.locator('#setupCard #stagingAnonInput')).toHaveCount(1);
  await expect(page.locator('#setupCard textarea')).toHaveCount(0);
  await expect(page.locator('#setupCard [data-action="setup-check"]')).toBeVisible();

  // Official pages open in a new tab: Supabase secrets, GitHub Actions,
  // new-project, and the repository Actions-secrets page.
  await page.locator('[data-action="setup-open-secrets"]').click();
  await page.locator('[data-action="setup-open-deploy"]').click();
  await page.locator('[data-action="setup-open-staging-project"]').click();
  await page.locator('[data-action="setup-open-github-secrets"]').click();
  const opened = await page.evaluate(() => window.__opened);
  expect(opened).toContain('https://supabase.com/dashboard/project/_/functions/secrets');
  expect(opened).toContain('https://github.com/qw1qw66-sudo/index.html/actions');
  expect(opened).toContain('https://supabase.com/dashboard/new');
  expect(opened).toContain('https://github.com/qw1qw66-sudo/index.html/settings/secrets/actions');

  // "تم إنشاء Staging" reveals the non-secret connect fields; a secret-shaped
  // key is rejected outright; valid non-secret values save.
  await page.locator('[data-action="setup-staging-created"]').click();
  await expect(page.locator('#stagingConnectBox')).toBeVisible();
  await page.locator('#stagingRefInput').fill('abcdefghijklmnopqrst');
  await page.locator('#stagingAnonInput').fill('sb_secret_this_must_be_rejected_123');
  await page.locator('[data-action="setup-save-staging-config"]').click();
  await expect(page.locator('#feedback')).toContainText('مفتاح سرّي');
  await page.locator('#stagingAnonInput').fill('sb_publishable_test_key_0123456789');
  await page.locator('[data-action="setup-save-staging-config"]').click();
  await expect(page.locator('#feedback')).toContainText('تم حفظ إعدادات Staging');

  // "فحص الربط" authenticates + calls setup-status + updates the status rows.
  await page.locator('[data-action="setup-check"]').click();
  await expect(page.locator('#setupStatusDeepseek')).toHaveText('مربوط');
  await expect(page.locator('#setupStatusConfirm')).toHaveText('مربوط');
  await expect(page.locator('#setupStatusFunctions')).toHaveText('مربوط');
  await expect(page.locator('#setupStatusAutopilot')).toHaveText('غير مفعل');
  await expect(page.locator('#setupStatusWhatsapp')).toHaveText('غير مفعل');
  await expect(page.locator('#setupCheckResult')).toContainText('المساعد جاهز للتجربة');

  // Large tap targets and no horizontal overflow on a phone screen.
  const btnBox = await page.locator('[data-action="setup-check"]').boundingBox();
  expect(btnBox.height).toBeGreaterThanOrEqual(44);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test('setup connection check degrades safely when server functions are not deployed', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockRpc(page);
  await page.route('**/functions/v1/**', (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"not deployed"}' }),
  );
  await page.goto('/');
  await create(page);
  await page.locator('[data-tab="settings"]').click();
  await page.locator('[data-action="setup-check"]').click();
  await expect(page.locator('#setupStatusFunctions')).toHaveText('يحتاج نشر');
  await expect(page.locator('#setupCheckResult')).toContainText('غير منشورة');
});

test('staging mode (?env=staging): badge, staging-ready completion, and assistant test button', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockRpc(page); // host-agnostic: also intercepts the staging host RPCs
  await page.route('**/functions/v1/chalet-setup-status', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        assistant_function_deployed: true,
        deepseek_configured: true,
        assistant_confirm_secret_configured: true,
        autopilot_secret_configured: true,
        whatsapp_configured: false,
        app_env: 'staging',
      }),
    }),
  );
  // Non-secret staging config saved beforehand (as the setup page does).
  await page.addInitScript(() => {
    localStorage.setItem('staging_project_ref', 'abcdefghijklmnopqrst');
    localStorage.setItem('staging_publishable_key', 'sb_publishable_test_key_0123456789');
  });
  await page.goto('/?env=staging');
  // The staging banner is unmissable and the app talks to the staging host.
  await expect(page.locator('#stagingBadge')).toBeVisible();
  await expect(page.locator('#stagingBadge')).toContainText('بيئة التجربة');
  await expect(page.locator('#stagingBadge')).toContainText('Staging');
  await create(page);
  await page.locator('[data-tab="settings"]').click();
  await page.locator('[data-action="setup-check"]').click();
  await expect(page.locator('#setupCheckResult')).toContainText('المساعد جاهز للتجربة على بيئة Staging');
  await expect(page.locator('#setupStatusAutopilot')).toHaveText('غير مفعل');
  // The test button appears and pre-fills the assistant input with the question.
  const tryBtn = page.locator('[data-action="setup-try-assistant"]');
  await expect(tryBtn).toBeVisible();
  await tryBtn.click();
  await expect(page.locator('#tab-assistant')).toBeVisible();
  await expect(page.locator('#assistantInput')).toHaveValue('ما هي حجوزات اليوم؟');
});

test('source has no old public auth or redirect patterns', async ({ page }) => {
  await mockRpc(page);
  await page.goto('/');
  const html = await page.content();
  for (const pattern of ['signInWithOtp', 'Magic Link', 'email login', 'service_role', 'serviceWorker', 'sync-cloud', 'location.replace']) {
    expect(html).not.toContain(pattern);
  }
});
