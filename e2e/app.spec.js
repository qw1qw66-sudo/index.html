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
  const starts = ['07:00', '17:00', '18:00', '19:00', '20:00', '21:00'];
  const ends = ['17:00', '18:00', '19:00', '20:00', '21:00', '22:00'];
  for (let i = 0; i < 6; i++) {
    await page.locator('[data-period-field="label"]').nth(i).fill(i === 0 ? 'Morning' : 'Period ' + (i + 1));
    await page.locator('[data-period-field="start"]').nth(i).fill(starts[i]);
    await page.locator('[data-period-field="end"]').nth(i).fill(ends[i]);
    await page.locator('[data-period-field="active"]').nth(i).check();
  }
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
  await expect(page.locator('#feedback')).toContainText('يوجد حجز مؤكد يتعارض زمنيًا مع هذا الحجز في نفس الشاليه.');

  await page.locator('#bookingList [data-action="voucher"]').first().click();
  await expect(page.locator('#voucherBox')).toContainText('QA Facility');
  await expect(page.locator('#voucherBox')).toContainText('Tulum');
  await expect(page.locator('#voucherBox')).toContainText('Morning');
  // The voucher displays the selected period's times in the app's 12h Arabic
  // format (formatTime12): 07:00 -> "7:00 ص", 17:00 -> "5:00 م".
  await expect(page.locator('#voucherBox')).toContainText('7:00 ص');
  await expect(page.locator('#voucherBox')).toContainText('5:00 م');
});

test('a cancelled booking stays reachable in its own section and can be re-confirmed', async ({ page }) => {
  await mockRpc(page);
  await page.goto('/');
  await create(page);
  await createChaletWithSixPeriods(page);
  await page.locator('[data-tab="bookings"]').click();
  await page.locator('[data-action="new-booking"]').click();
  await page.locator('#bookingCustomerName').fill('زبون ملغى');
  await page.locator('#bookingCustomerPhone').fill('0509999999');
  await page.locator('#bookingDate').fill(FUTURE_DATE);
  await page.locator('#bookingTotal').fill('900');
  await page.locator('[data-action="save-booking"]').click();
  await expect(page.locator('#bookingList')).toContainText('زبون ملغى');

  // Cancel it via the status dropdown.
  await page.locator('#bookingList [data-action="edit-booking"]').first().click();
  await page.selectOption('#bookingStatus', 'cancelled');
  await page.locator('[data-action="save-booking"]').click();

  // Gone from the main list, present in the dedicated cancelled section.
  await expect(page.locator('#bookingList')).not.toContainText('زبون ملغى');
  await expect(page.locator('#bookingsCancelledSection summary')).toContainText('الحجوزات الملغاة (1)');
  const cancelledList = page.locator('#bookingCancelledList');
  await expect(cancelledList).toContainText('زبون ملغى');

  // It is re-openable and can be re-confirmed — no longer a dead record.
  await page.locator('#bookingsCancelledSection summary').click(); // expand
  await cancelledList.locator('[data-action="edit-booking"]').first().click();
  await page.selectOption('#bookingStatus', 'confirmed');
  await page.locator('[data-action="save-booking"]').click();
  await expect(page.locator('#bookingList')).toContainText('زبون ملغى');
  await expect(page.locator('#bookingsCancelledSection summary')).toContainText('الحجوزات الملغاة (0)');
});

test('F1: one-tap «إلغاء الحجز» on the card cancels without the delete/backup path', async ({ page }) => {
  await mockRpc(page);
  await page.goto('/');
  await create(page);
  await createChaletWithSixPeriods(page);
  await page.locator('[data-tab="bookings"]').click();
  await page.locator('[data-action="new-booking"]').click();
  await page.locator('#bookingCustomerName').fill('زبون للإلغاء');
  await page.locator('#bookingCustomerPhone').fill('0509999999');
  await page.locator('#bookingDate').fill(FUTURE_DATE);
  await page.locator('#bookingTotal').fill('900');
  await page.locator('[data-action="save-booking"]').click();
  await expect(page.locator('#bookingList')).toContainText('زبون للإلغاء');

  // A confirmed booking's card exposes a one-tap cancel button.
  const card = page.locator('#bookingList [data-booking-card-id]').first();
  const cancelBtn = card.locator('[data-action="cancel-booking-status"]');
  await expect(cancelBtn).toHaveText('إلغاء الحجز');

  // The confirm prompt is a plain cancel confirmation — NOT the delete/backup
  // warning the owner was hitting when forced through the حذف button.
  let dialogText = '';
  page.once('dialog', (d) => { dialogText = d.message(); d.accept(); });
  await cancelBtn.click();
  expect(dialogText).toContain('إلغاء هذا الحجز');
  expect(dialogText).not.toContain('النسخ الاحتياطية');

  // The booking moves to the cancelled section (record kept), and a cancelled
  // card no longer offers the cancel button (only a confirmed booking does).
  await expect(page.locator('#feedback')).toContainText('تم إلغاء الحجز');
  await expect(page.locator('#bookingList')).not.toContainText('زبون للإلغاء');
  await expect(page.locator('#bookingsCancelledSection summary')).toContainText('الحجوزات الملغاة (1)');
  await page.locator('#bookingsCancelledSection summary').click();
  const cancelledCard = page.locator('#bookingCancelledList [data-booking-card-id]').first();
  await expect(cancelledCard).toContainText('زبون للإلغاء');
  await expect(cancelledCard.locator('[data-action="cancel-booking-status"]')).toHaveCount(0);
});

test('a booking saved while an upload is in flight is never lost (mid-flight edit kept)', async ({ page }) => {
  const box = await mockMutableCloud(page);
  // Make the save RPC slow so we can edit during the in-flight window.
  await page.route('**/rest/v1/rpc/save_shared_workspace**', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    box.exists = true;
    box.cloud = { ok: true, workspace_key: 'TEST1', updated_at: '2026-01-01T05:00:00.000Z', data: body.p_data };
    await new Promise((r) => setTimeout(r, 1500));
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(box.cloud) });
  });
  await page.goto('/');
  await create(page);
  await createChaletWithSixPeriods(page);
  await page.locator('[data-tab="bookings"]').click();
  // Booking A saved locally.
  await page.locator('[data-action="new-booking"]').click();
  await page.locator('#bookingCustomerName').fill('حجز أ');
  await page.locator('#bookingDate').fill(FUTURE_DATE);
  await page.locator('#bookingTotal').fill('500');
  await page.locator('[data-action="save-booking"]').click();
  // Start the slow upload from the settings tab (do NOT await — it resolves
  // in 1.5s), then immediately go back and save booking B mid-flight.
  await page.locator('[data-tab="settings"]').click();
  await page.locator('[data-action="upload"]').click();
  await page.locator('[data-tab="bookings"]').click();
  await page.locator('[data-action="new-booking"]').click();
  await page.locator('#bookingCustomerName').fill('حجز ب');
  // A different date so B does not conflict with A on the same slot.
  await page.locator('#bookingDate').fill(new Date(Date.now() + 120 * 86400000).toISOString().slice(0, 10));
  await page.locator('#bookingTotal').fill('600');
  await page.locator('[data-action="save-booking"]').click();
  // Upload resolves: B is kept, both bookings present, still dirty.
  await expect(page.locator('#feedback')).toContainText('غير مرفوع', { timeout: 5000 });
  await expect(page.locator('#bookingList')).toContainText('حجز ب');
  await expect(page.locator('#bookingList')).toContainText('حجز أ');
  await expect(page.locator('#dirtyBadge')).toContainText('تغييرات');
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
  const box = await mockMutableCloud(page);
  let assistantCalls = 0;
  let confirmCalls = 0;
  await page.route('**/functions/v1/chalet-assistant', async (route) => {
    assistantCalls++;
    const body = JSON.parse(route.request().postData() || '{}');
    if (body.invoke_tool && String(body.invoke_tool.name).startsWith('confirm_')) {
      confirmCalls++;
      // Slow response so a double-tap window exists.
      await new Promise((r) => setTimeout(r, 400));
      box.cloud = {
        ...box.cloud,
        updated_at: '2026-01-01T03:30:00.000Z',
        data: freshnessDoc([freshnessBooking('bk-1', 'علي تجربة')]),
      };
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          kind: 'completed_action',
          tool: body.invoke_tool.name,
          result: {
            action: 'booking_created',
            booking_id: 'bk-1',
            updated_at: box.cloud.updated_at,
            booking: freshnessBooking('bk-1', 'علي تجربة'),
          },
        }),
      });
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

test('a confirm-time conflict removes the dead card and shows numbered alternatives', async ({ page }) => {
  await mockRpc(page);
  await page.route('**/functions/v1/chalet-assistant', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    if (body.invoke_tool && String(body.invoke_tool.name).startsWith('confirm_')) {
      // The slot was taken between prepare and confirm: terminal failure with
      // the blocker named + numbered alternatives (server shape post-fix).
      return route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          kind: 'completed_action',
          tool: body.invoke_tool.name,
          public_code: 'conflict',
          recoverable: true,
          reason_ar:
            'هذه الفترة محجوزة بالفعل — تتعارض مع حجز «منافس تجريبي» بتاريخ 13-07-2026 (19:00–05:00). لم يتم حفظ أي تغيير.\nأقرب الخيارات المتاحة:\n1. شاليه تولوم — 13-07-2026 — 07:00–12:00 — 300 ريال\nاكتب رقم الخيار، أو عدّل التاريخ/الفترة.',
          next_actions: [{ pick: 1, chalet_name: 'شاليه تولوم', date: '2026-07-13', start: '07:00', end: '12:00', price: 300 }],
          done_ar: 'لم يكتمل الإجراء. لم يتغيّر شيء بدون تأكيد الخادم.',
        }),
      });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(BOOKING_CARD_BODY) });
  });
  await page.goto('/');
  await create(page);
  await page.locator('[data-tab="assistant"]').click();
  // Tab switches never surface debug text anywhere (the «فتح تبويب» bug).
  await expect(page.locator('#feedback')).not.toContainText('فتح تبويب');
  await page.locator('#assistantInput').fill('احجز تولوم');
  await page.locator('[data-action="assistant-send"]').click();
  await expect(page.locator('#assistantActions .action-card')).toHaveCount(1);
  await page.locator('[data-action="assistant-confirm"]').click();
  // Terminal failure: the reason (with numbered options) appears and the dead
  // card is GONE — no armed «حفظ الحجز» button remains to replay errors.
  await expect(page.locator('#assistantLog')).toContainText('محجوزة بالفعل');
  await expect(page.locator('#assistantLog')).toContainText('منافس تجريبي');
  await expect(page.locator('#assistantLog')).toContainText('أقرب الخيارات المتاحة');
  await expect(page.locator('#assistantActions .action-card')).toHaveCount(0);
  const log = await page.locator('#assistantLog').innerText();
  expect(log).not.toMatch(/BOOKING_CONFLICT|completed_action|[A-Z]{2,}_[A-Z]/);
  expect(log).not.toContain('تم إنشاء الحجز');
  // The alternatives are ONE-TAP chips: tapping sends «١» and a fresh card
  // arrives — the owner never copies option text by hand.
  const chip = page.locator('#assistantLog .chat-options button').first();
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('١');
  await expect(chip).toContainText('شاليه تولوم');
  await chip.click();
  await expect(page.locator('#assistantLog .chat-msg.chat-user').last()).toHaveText('١');
  await expect(page.locator('#assistantActions .action-card')).toHaveCount(1);
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

test('B1 (R12): a TYPED cancel «الغِ الحجز» clears the armed card, like the button', async ({ page }) => {
  await mockRpc(page);
  await page.route('**/functions/v1/chalet-assistant', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    // A TYPED cancel is an ordinary message (NOT draft_action) — the server
    // retires the draft's action and flags draft_cancelled. This is the exact
    // path the button-cancel test does NOT cover: the send handler must clear
    // the card on its own, not rely on the cancel-draft click handler.
    if (typeof body.message === 'string' && /الغ|إلغاء/.test(body.message)) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, draft_cancelled: true, reply_ar: 'تم الإلغاء، لم يُحفظ شيء.' }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(BOOKING_CARD_BODY) });
  });
  await page.goto('/');
  await create(page);
  await page.locator('[data-tab="assistant"]').click();
  await page.locator('#assistantInput').fill('احجز تولوم');
  await page.locator('[data-action="assistant-send"]').click();
  // The armed «حفظ الحجز» card is on screen.
  await expect(page.locator('#assistantActions .action-card')).toHaveCount(1);
  await expect(page.locator('#assistantActions [data-action="assistant-confirm"]')).toBeVisible();
  // Owner TYPES the cancel instead of tapping إلغاء.
  await page.locator('#assistantInput').fill('الغِ الحجز');
  await page.locator('[data-action="assistant-send"]').click();
  // B1: the stale card + its confirm button are gone (previously left armed).
  await expect(page.locator('#assistantActions .action-card')).toHaveCount(0);
  await expect(page.locator('#assistantLog')).toContainText('تم الإلغاء، لم يُحفظ شيء.');
});

test('التعديل بالاختيار: reopen shows field chips; tapping one asks for that field, then a new card arrives', async ({ page }) => {
  await mockRpc(page);
  await page.route('**/functions/v1/chalet-assistant', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    if (body.draft_action === 'reopen') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        ok: true,
        reply_ar: 'تمام — اختر الحقل الذي تريد تعديله، أو اكتب التغيير مباشرةً.',
        edit_fields: [
          { field: 'booking_date', label: 'التاريخ', value: '15-08-2026' },
          { field: 'period', label: 'الفترة', value: 'مسائي' },
          { field: 'guests', label: 'الضيوف', value: '4' },
          { field: 'total', label: 'السعر', value: '300' },
          { field: 'customer_name', label: 'العميل', value: 'تجربة' },
        ],
      }) });
    }
    if (body.draft_action === 'edit_field') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, editing_field: body.field, reply_ar: 'كم عدد الضيوف؟' }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(BOOKING_CARD_BODY) });
  });
  await page.goto('/');
  await create(page);
  await page.locator('[data-tab="assistant"]').click();
  await page.locator('#assistantInput').fill('احجز تولوم');
  await page.locator('[data-action="assistant-send"]').click();
  await expect(page.locator('#assistantActions .action-card')).toHaveCount(1);
  // «تعديل» → field chips appear (edit BY SELECTION); the prepared card leaves.
  await page.locator('[data-action="assistant-edit"]').click();
  await expect(page.locator('#assistantActions .action-card')).toHaveCount(0);
  const chips = page.locator('#assistantLog .chat-edit-fields button');
  await expect(chips).toHaveCount(5);
  await expect(page.locator('#assistantLog .chat-edit-fields button[data-field="guests"]')).toContainText('4');
  // Tapping the guests chip asks only for guests and consumes the chip row.
  await page.locator('#assistantLog .chat-edit-fields button[data-field="guests"]').click();
  await expect(page.locator('#assistantLog')).toContainText('كم عدد الضيوف؟');
  await expect(page.locator('#assistantLog .chat-edit-fields')).toHaveCount(0);
  // Typing just the new value yields a fresh card.
  await page.locator('#assistantInput').fill('٦');
  await page.locator('[data-action="assistant-send"]').click();
  await expect(page.locator('#assistantActions .action-card')).toHaveCount(1);
});

test('العميل المعروف: a returning-customer phone chip appears (masked) and applies by tap', async ({ page }) => {
  await mockRpc(page);
  await page.route('**/functions/v1/chalet-assistant', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    if (typeof body.message === 'string' && body.message.includes('الجوال المحفوظ')) {
      // The server attached the saved phone; re-prepared card, no more offer.
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(BOOKING_CARD_BODY) });
    }
    if (body.message) {
      // Initial booking: card + returning-customer offer (MASKED phone only).
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...BOOKING_CARD_BODY, customer_phone_suggestion: { name: 'خالد', masked_phone: '05••••8888' } }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(BOOKING_CARD_BODY) });
  });
  await page.goto('/');
  await create(page);
  await page.locator('[data-tab="assistant"]').click();
  await page.locator('#assistantInput').fill('احجز تولوم باسم خالد');
  await page.locator('[data-action="assistant-send"]').click();
  await expect(page.locator('#assistantActions .action-card')).toHaveCount(1);
  // The masked-phone chip appears; the raw number is never present in the DOM.
  const chip = page.locator('#assistantLog .chat-phone-suggest button');
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText('05••••8888');
  await expect(page.locator('#assistantLog')).not.toContainText('0559998888');
  // Tapping sends the fixed sentence; the chip clears and a fresh card arrives.
  await chip.click();
  await expect(page.locator('#assistantLog .chat-msg.chat-user').last()).toContainText('الجوال المحفوظ');
  await expect(page.locator('#assistantLog .chat-phone-suggest')).toHaveCount(0);
  await expect(page.locator('#assistantActions .action-card')).toHaveCount(1);
});

test('memory management: Settings lists learned memories; approve/reject update the list', async ({ page }) => {
  await mockRpc(page);
  let memories = [
    { id: 'a1', memory_type: 'preference', type_label: 'تفضيل', status: 'active', enforcement_level: 'advisory', summary_ar: 'العميل «علي» يفضّل المسائي.' },
    { id: 'p1', memory_type: 'fact', type_label: 'معلومة', status: 'proposed', enforcement_level: 'advisory', summary_ar: 'خالد يفضّل الشاليه الكبير.' },
  ];
  await page.route('**/functions/v1/chalet-assistant', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    if (body.memory_action === 'promote') {
      memories = memories.map((m) => (m.id === body.memory_id ? { ...m, status: 'active' } : m));
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }
    if (body.memory_action === 'reject') {
      memories = memories.filter((m) => m.id !== body.memory_id);
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }
    // memory_action:"list" (and any other)
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, memories }) });
  });
  await page.goto('/');
  await create(page);
  await page.locator('[data-tab="settings"]').click();
  await page.locator('#settingsMemoryCard summary').click(); // expand the section
  // Both learned items are listed.
  await expect(page.locator('#memoryList')).toContainText('العميل «علي» يفضّل المسائي.');
  await expect(page.locator('#memoryList')).toContainText('خالد يفضّل الشاليه الكبير.');
  // Only the PROPOSED item offers «اعتماد».
  await expect(page.locator('#memoryList [data-action="memory-promote"][data-id="p1"]')).toHaveCount(1);
  await expect(page.locator('#memoryList [data-action="memory-promote"][data-id="a1"]')).toHaveCount(0);
  // Approve the proposed one → it becomes active (its اعتماد button disappears).
  await page.locator('#memoryList [data-action="memory-promote"][data-id="p1"]').click();
  await expect(page.locator('#memoryList [data-action="memory-promote"][data-id="p1"]')).toHaveCount(0);
  // Reject the other → it leaves the list.
  await page.locator('#memoryList [data-action="memory-reject"][data-id="a1"]').click();
  await expect(page.locator('#memoryList')).not.toContainText('العميل «علي» يفضّل المسائي.');
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

test('the conversation thread SURVIVES a reload so a mid-booking draft continues (id persisted, never a token)', async ({ page }) => {
  await mockRpc(page);
  await page.route('**/functions/v1/chalet-setup-status', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, assistant_function_deployed: true, deepseek_configured: true, assistant_confirm_secret_configured: true, autopilot_secret_configured: true, whatsapp_configured: false, app_env: 'staging' }) }),
  );
  const seenThreadIds = [];
  await page.route('**/functions/v1/chalet-assistant', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    if (body.pending_action === 'latest' || body.thread_action === 'list') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }
    if (typeof body.message === 'string') seenThreadIds.push(body.thread_id || null);
    // Server owns the thread id: it returns th-live and the client must reuse it.
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, thread_id: 'th-live', reply_ar: 'باقي فقط: عدد الضيوف، واسم العميل. أرسلها في رسالة واحدة.', model_calls: 0, tool_results: [] }) });
  });
  await page.goto('/');
  await create(page);
  await page.locator('[data-tab="assistant"]').click();
  // First booking message opens the thread; the id is persisted to localStorage.
  await page.locator('#assistantInput').fill('احجز تولوم بكرة فترة 5');
  await page.locator('#assistantSendButton').click();
  await expect(page.locator('#assistantLog')).toContainText('باقي فقط');
  const persisted = await page.evaluate(() => {
    for (const [k, v] of Object.entries(localStorage)) if (v === 'th-live') return k;
    return '';
  });
  expect(persisted).toContain('chaletAssistantThread');
  // Reload (an iOS PWA restart): the SAME thread must be reused, not a new one.
  await page.reload();
  await expect(page.locator('#appShell')).toBeVisible();
  await page.locator('[data-tab="assistant"]').click();
  await page.locator('#assistantInput').fill('4 ضيوف باسم سالم');
  await page.locator('#assistantSendButton').click();
  await expect(page.locator('#assistantLog')).toContainText('باقي فقط');
  // The message AFTER the reload carried the persisted thread id — the draft
  // continues on the server instead of restarting empty.
  expect(seenThreadIds[seenThreadIds.length - 1]).toBe('th-live');
  // Nothing token-shaped ever entered storage.
  const stored = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
  expect(stored).not.toContain('tok-');
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

// ---- R5 guarded cloud freshness (live bug: «لا توجد حجوزات» while the ----
// ---- server held today's booking — the tab rendered a stale local doc) ----

// Tomorrow in Riyadh time: always >= the app's today(), no midnight flake.
const RIYADH_TOMORROW = new Date(Date.now() + 3 * 3600000 + 86400000).toISOString().slice(0, 10);

function freshnessDoc(bookings) {
  return {
    schema_version: 3,
    settings: { facility_name: '', tag: '', holidays: [] },
    chalets: [{ id: 'c1', name: 'شاليه تولوم', capacity: 10, deleted_at: null, periods: [{ id: 'p1', label: 'مسائي', start: '19:00', end: '05:00', active: true }] }],
    bookings,
  };
}
function freshnessBooking(id, name) {
  return { id, customer_name: name, chalet_id: 'c1', period_id: 'p1', booking_date: RIYADH_TOMORROW, guests: 2, total: 500, paid: 0, status: 'confirmed', deleted_at: null };
}

// A v1-style server whose canonical doc the test can swap mid-run.
async function mockMutableCloud(page) {
  const box = {
    exists: false,
    cloud: { ok: true, workspace_key: 'TEST1', updated_at: '2026-01-01T00:00:00.000Z', data: freshnessDoc([]) },
  };
  await page.route('**/rest/v1/rpc/**', async (route) => {
    const name = route.request().url().split('/').pop();
    const body = JSON.parse(route.request().postData() || '{}');
    if (name === 'get_shared_workspace') {
      if (!box.exists) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'WORKSPACE_NOT_FOUND_OR_PIN_INVALID' }) });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(box.cloud) });
    }
    if (name === 'save_shared_workspace') {
      box.exists = true;
      box.cloud = { ok: true, workspace_key: String(body.p_workspace_key || 'TEST1').toUpperCase(), updated_at: new Date(Date.parse(box.cloud.updated_at) + 60000).toISOString(), data: body.p_data };
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(box.cloud) });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'unknown rpc' }) });
  });
  return box;
}

test('a restored session converges to the server truth without re-login (stale snapshot heals)', async ({ page }) => {
  const box = await mockMutableCloud(page);
  // The SERVER already holds tomorrow's booking…
  box.exists = true;
  box.cloud = { ok: true, workspace_key: 'TEST1', updated_at: '2026-01-01T00:10:00.000Z', data: freshnessDoc([freshnessBooking('b1', 'علي اختبار')]) };
  // …but the tab restores an OLDER cached snapshot without it (live IMG_6705).
  await page.addInitScript(({ snap }) => {
    sessionStorage.setItem('active_workspace_session', JSON.stringify(snap));
    sessionStorage.setItem('active_session_pin', '123456');
  }, { snap: { workspaceKey: 'TEST1', state: freshnessDoc([]), lastCloudCounts: { chalets: 1, bookings: 0 }, lastCloudUpdatedAt: '2026-01-01T00:00:00.000Z', dirty: false } });
  await page.goto('/');
  await expect(page.locator('#appShell')).toBeVisible(); // restored, not re-logged
  await page.locator('[data-tab="bookings"]').click();
  // The quiet refresh adopts the server doc: the booking IS there.
  await expect(page.locator('#bookingList')).toContainText('علي اختبار');
  await expect(page.locator('#bookingList')).not.toContainText('لا توجد حجوزات');
});

test('«تحديث» pulls the server truth; unsaved local edits are never clobbered', async ({ page }) => {
  const box = await mockMutableCloud(page);
  await page.goto('/');
  await create(page);
  await page.locator('[data-tab="bookings"]').click();
  await expect(page.locator('#bookingList')).toContainText('لا توجد حجوزات');
  // Another device adds a booking server-side.
  box.cloud = { ...box.cloud, updated_at: '2026-01-01T01:00:00.000Z', data: freshnessDoc([freshnessBooking('b1', 'ضيف السحابة')]) };
  await page.locator('[data-action="refresh-cloud"]').click();
  await expect(page.locator('#bookingList')).toContainText('ضيف السحابة');
  await expect(page.locator('#feedback')).toContainText('تم تحديث البيانات من السحابة');
  // A LOCAL unsaved edit now exists (new chalet, never uploaded)…
  await page.locator('[data-tab="chalets"]').click();
  await page.locator('[data-action="new-chalet"]').click();
  await page.locator('#chaletName').fill('شاليه محلي');
  await page.locator('[data-action="save-chalet"]').click();
  // …and the server moves again.
  box.cloud = { ...box.cloud, updated_at: '2026-01-01T02:00:00.000Z', data: freshnessDoc([freshnessBooking('b1', 'ضيف السحابة'), freshnessBooking('b2', 'ضيف ثاني')]) };
  await page.locator('[data-tab="bookings"]').click();
  await page.locator('[data-action="refresh-cloud"]').click();
  // Refresh REFUSES (explicit wording) and local data stays intact.
  await expect(page.locator('#feedback')).toContainText('ارفعها أولًا');
  await expect(page.locator('#bookingList')).not.toContainText('ضيف ثاني');
  await page.locator('[data-tab="chalets"]').click();
  await expect(page.locator('#chaletList')).toContainText('شاليه محلي');
});

test('night anchoring: the middle of a booked night is blocked in the manual editor (incl. legacy «7:00» times)', async ({ page }) => {
  // Server doc: a night chalet with a full-night period, a post-midnight
  // period, a LEGACY 1-digit-hour period («7:00» used to parse as Invalid
  // Date and silently disable conflict detection), a free morning slot, and
  // two existing confirmed bookings (the night + the legacy morning).
  const NIGHT_DATE = FUTURE_DATE;
  const doc = {
    schema_version: 3,
    settings: { facility_name: '', tag: '', holidays: [] },
    chalets: [{ id: 'cn', name: 'شاليه الليل', capacity: 10, deleted_at: null, periods: [
      { id: 'pn', label: 'ليلة كاملة', start: '19:00', end: '05:00', active: true, sort: 1 },
      { id: 'pm', label: 'منتصف الليل', start: '00:00', end: '05:00', active: true, sort: 2 },
      { id: 'p7', label: 'صباح قديم', start: '7:00', end: '17:00', active: true, sort: 3 },
      { id: 'pd', label: 'ضحى', start: '09:00', end: '11:00', active: true, sort: 4 },
    ] }],
    bookings: [
      { id: 'bn', customer_name: 'حجز الليل', chalet_id: 'cn', period_id: 'pn', booking_date: NIGHT_DATE, guests: 2, total: 500, paid: 0, status: 'confirmed', deleted_at: null },
      { id: 'b7', customer_name: 'حجز الصباح', chalet_id: 'cn', period_id: 'p7', booking_date: NIGHT_DATE, guests: 2, total: 300, paid: 0, status: 'confirmed', deleted_at: null },
    ],
  };
  await page.route('**/rest/v1/rpc/**', async (route) => {
    const name = route.request().url().split('/').pop();
    if (name === 'get_shared_workspace') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, workspace_key: 'TEST1', updated_at: '2026-01-01T00:00:00.000Z', data: doc }) });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'unknown rpc' }) });
  });
  await page.goto('/');
  await page.locator('#workspaceInput').fill('test1');
  await page.locator('#pinInput').fill('123456');
  await page.locator('#pullButton').click();
  await expect(page.locator('#appShell')).toBeVisible();
  await page.locator('[data-tab="bookings"]').click();
  await expect(page.locator('#bookingList [data-booking-card-id]')).toHaveCount(2);

  // «منتصف الليل» on the SAME date = the same physical night → blocked.
  await page.locator('[data-action="new-booking"]').click();
  await page.locator('#bookingCustomerName').fill('متطفل');
  await page.locator('#bookingDate').fill(NIGHT_DATE);
  await page.selectOption('#bookingPeriodId', 'pm');
  await page.locator('[data-action="save-booking"]').click();
  await expect(page.locator('#feedback')).toContainText('يتعارض زمنيًا');
  await page.locator('[data-action="cancel-booking"]').click().catch(() => {});
  await page.locator('[data-tab="bookings"]').click();
  await expect(page.locator('#bookingList [data-booking-card-id]')).toHaveCount(2);

  // «ضحى» overlaps the LEGACY «7:00» booking: before the padding fix this
  // slipped through silently (NaN interval) — now it must be blocked too.
  await page.locator('[data-action="new-booking"]').click();
  await page.locator('#bookingCustomerName').fill('متطفل ثاني');
  await page.locator('#bookingDate').fill(NIGHT_DATE);
  await page.selectOption('#bookingPeriodId', 'pd');
  await page.locator('[data-action="save-booking"]').click();
  await expect(page.locator('#feedback')).toContainText('يتعارض زمنيًا');
  await page.locator('[data-tab="bookings"]').click();
  await expect(page.locator('#bookingList [data-booking-card-id]')).toHaveCount(2);
});

test('after حفظ الحجز the bookings tab shows the booking — no re-login needed', async ({ page }) => {
  const box = await mockMutableCloud(page);
  await page.route('**/functions/v1/chalet-assistant', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    if (body.invoke_tool && String(body.invoke_tool.name).startsWith('confirm_')) {
      // The booking is written SERVER-side by the edge function.
      box.cloud = { ...box.cloud, updated_at: '2026-01-01T03:00:00.000Z', data: freshnessDoc([freshnessBooking('bk-1', 'علي تجربة')]) };
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, kind: 'completed_action', tool: body.invoke_tool.name, result: { action: 'booking_created', booking_id: 'bk-1' } }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(BOOKING_CARD_BODY) });
  });
  await page.goto('/');
  await create(page);
  await page.locator('[data-tab="assistant"]').click();
  await page.locator('#assistantInput').fill('احجز تولوم بكرة بالليل لشخصين بخمسمئة، العميل علي تجربة');
  await page.locator('[data-action="assistant-send"]').click();
  await expect(page.locator('#assistantActions .action-card')).toHaveCount(1);
  await page.locator('[data-action="assistant-confirm"]').click();
  await expect(page.locator('#assistantLog')).toContainText('تم إنشاء الحجز بنجاح');
  // The post-confirm quiet refresh converged the tab to the server truth.
  await page.locator('[data-tab="bookings"]').click();
  await expect(page.locator('#bookingList')).toContainText('علي تجربة');
  await expect(page.locator('#bookingList')).not.toContainText('لا توجد حجوزات');
});

test('assistant create is not called successful until its exact booking is visible in الحجوزات', async ({ page }) => {
  const box = await mockMutableCloud(page);
  let confirmCalls = 0;
  await page.route('**/functions/v1/chalet-assistant', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    if (body.invoke_tool && String(body.invoke_tool.name).startsWith('confirm_')) {
      confirmCalls++;
      // Simulate a slow cloud projection. The old frontend printed success
      // immediately and left the owner staring at a list without the booking.
      await new Promise((resolve) => setTimeout(resolve, 650));
      box.cloud = { ...box.cloud, updated_at: '2026-01-01T04:00:00.000Z', data: freshnessDoc([freshnessBooking('bk-mahra', 'مهره اختبار')]) };
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        ok: true, kind: 'completed_action',
        result: { action: 'booking_created', booking_id: 'bk-mahra', updated_at: box.cloud.updated_at, booking: { id: 'bk-mahra', customer_name: 'مهره اختبار', booking_date: RIYADH_TOMORROW, chalet_id: 'c1', period_id: 'p1', status: 'confirmed' } },
      }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(BOOKING_CARD_BODY) });
  });
  await page.goto('/');
  await create(page);
  await page.locator('[data-tab="assistant"]').click();
  await page.locator('#assistantInput').fill('سجل حجز تجريبي باسم مهره');
  await page.locator('[data-action="assistant-send"]').click();
  await page.locator('[data-action="assistant-confirm"]').click();
  await expect(page.locator('[data-tab="bookings"]')).toHaveClass(/active/);
  await expect(page.locator('#bookingList [data-booking-card-id="bk-mahra"]')).toContainText('مهره اختبار');
  await expect(page.locator('#assistantLog')).toContainText('تم إنشاء الحجز بنجاح');
  expect(confirmCalls).toBe(1);
});

test('assistant refuses stale cloud answers while local changes are unsaved', async ({ page }) => {
  await mockRpc(page);
  let assistantCalls = 0;
  await page.route('**/functions/v1/chalet-assistant', async (route) => {
    assistantCalls++;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(BOOKING_CARD_BODY) });
  });
  await page.goto('/');
  await create(page);
  await createChaletWithSixPeriods(page); // local, dirty, not uploaded
  await page.locator('[data-tab="assistant"]').click();
  // Opening the tab may perform its own connection probe; the owner's dirty
  // request itself must add zero assistant calls.
  const callsBeforeSend = assistantCalls;
  await page.locator('#assistantInput').fill('جهز حجز مهره');
  await page.locator('[data-action="assistant-send"]').click();
  await expect(page.locator('#assistantLog')).toContainText('تغييرات محلية غير مرفوعة');
  await expect(page.locator('#feedback')).toContainText('رفع التعديلات');
  await expect(page.locator('#assistantActions .action-card')).toHaveCount(0);
  expect(assistantCalls).toBe(callsBeforeSend);
});

test('a new manual booking cannot be hidden as an old booking; historical edits remain possible', async ({ page }) => {
  await mockRpc(page);
  await page.goto('/');
  await create(page);
  await createChaletWithSixPeriods(page);
  await page.locator('[data-tab="bookings"]').click();
  await page.locator('[data-action="new-booking"]').click();
  await page.locator('#bookingCustomerName').fill('مهره ماضي');
  await page.locator('#bookingDate').fill('2025-04-07');
  await page.locator('#bookingTotal').fill('450');
  await page.locator('[data-action="save-booking"]').click();
  await expect(page.locator('#feedback')).toContainText('لا يمكن إنشاء حجز جديد بتاريخ ماض');
  await expect(page.locator('#bookingPastList')).not.toContainText('مهره ماضي');
});

test('period normalization preserves period 7 and does not activate five fake duplicate slots', async ({ page }) => {
  const periods = Array.from({ length: 7 }, (_, i) => ({
    id: 'p' + (i + 1), label: 'فترة ' + (i + 1), start: String(7 + i).padStart(2, '0') + ':00', end: String(8 + i).padStart(2, '0') + ':00', active: true, sort: i + 1,
  }));
  const doc = freshnessDoc([{ id: 'b7', customer_name: 'حجز الفترة السابعة', chalet_id: 'c1', period_id: 'p7', booking_date: RIYADH_TOMORROW, guests: 2, total: 500, paid: 0, status: 'confirmed', deleted_at: null }]);
  doc.chalets[0].periods = periods;
  await page.route('**/rest/v1/rpc/**', async (route) => {
    const name = route.request().url().split('/').pop();
    if (name === 'get_shared_workspace') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, workspace_key: 'TEST1', updated_at: '2026-01-01T00:00:00.000Z', data: doc }) });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"unknown rpc"}' });
  });
  await page.goto('/');
  await page.locator('#workspaceInput').fill('test1');
  await page.locator('#pinInput').fill('123456');
  await page.locator('#pullButton').click();
  await page.locator('[data-tab="bookings"]').click();
  await expect(page.locator('#bookingList')).toContainText('فترة 7');
  await page.locator('[data-tab="chalets"]').click();
  await page.locator('[data-action="edit-chalet"]').click();
  await expect(page.locator('.period-card')).toHaveCount(7);

  await page.locator('[data-action="cancel-chalet"]').click();
  await page.locator('[data-action="new-chalet"]').click();
  await expect(page.locator('.period-card')).toHaveCount(6);
  await expect(page.locator('[data-period-field="active"]:checked')).toHaveCount(1);
});

test('expenses tab: add an expense, list it, and see net in the report', async ({ page }) => {
  await mockRpc(page);
  await page.goto('/');
  await create(page);
  // Add an operational expense (no bookings exist → report shows net = -expenses).
  await page.locator('[data-tab="expenses"]').click();
  const todayIso = new Date().toISOString().slice(0, 10);
  await page.locator('#expenseDate').fill(todayIso);
  await page.locator('#expenseCategory').selectOption('صيانة');
  await page.locator('#expenseAmount').fill('150');
  await page.locator('#expenseNote').fill('تجربة');
  await page.locator('[data-action="save-expense"]').click();
  await expect(page.locator('#expensesList')).toContainText('صيانة');
  await expect(page.locator('#expensesList')).toContainText('تجربة');
  await expect(page.locator('#expensesMonthTotal')).toContainText('150');
  // The report surfaces المصاريف and الصافي (income − expenses), even with no bookings.
  await page.locator('[data-tab="reports"]').click();
  await page.locator('[data-action="run-report"]').click();
  await expect(page.locator('#reportBox')).toContainText('المصاريف');
  await expect(page.locator('#reportBox')).toContainText('الصافي');
});

test('home quick-glance panel shows month totals and an actionable tip (G4)', async ({ page }) => {
  await mockRpc(page);
  await page.goto('/');
  await create(page);
  // Add an expense so the glance has real numbers to summarize.
  await page.locator('[data-tab="expenses"]').click();
  const todayIso = new Date().toISOString().slice(0, 10);
  await page.locator('#expenseDate').fill(todayIso);
  await page.locator('#expenseCategory').selectOption('كهرباء');
  await page.locator('#expenseAmount').fill('200');
  await page.locator('[data-action="save-expense"]').click();
  // The home tab's quick-glance card surfaces month income/expenses/net + a tip.
  await page.locator('[data-tab="home"]').click();
  const glance = page.locator('#homeGlance');
  await expect(glance).toContainText('دخل الشهر');
  await expect(glance).toContainText('مصاريف الشهر');
  await expect(glance).toContainText('صافي الشهر');
  await expect(glance).toContainText('حجوزات قادمة');
  await expect(glance).toContainText('200'); // the expense flows into the month total
  await expect(glance).toContainText('💡'); // the proactive tip
});

test('bookings search filters the list live by customer name', async ({ page }) => {
  await mockRpc(page);
  await page.goto('/');
  await create(page);
  await createChaletWithSixPeriods(page);
  await page.locator('[data-tab="bookings"]').click();
  await page.locator('[data-action="new-booking"]').click();
  await page.locator('#bookingCustomerName').fill('علي المطيري');
  await page.locator('#bookingDate').fill(FUTURE_DATE);
  await page.locator('#bookingTotal').fill('500');
  await page.locator('[data-action="save-booking"]').click();
  await expect(page.locator('#bookingList')).toContainText('علي المطيري');
  // A matching query keeps the booking; a non-matching one shows the empty state.
  await page.locator('#bookingSearch').fill('علي');
  await expect(page.locator('#bookingList')).toContainText('علي المطيري');
  await page.locator('#bookingSearch').fill('زياد');
  await expect(page.locator('#bookingList')).toContainText('لا نتائج مطابقة للبحث');
  await page.locator('#bookingSearch').fill('');
  await expect(page.locator('#bookingList')).toContainText('علي المطيري');
});
