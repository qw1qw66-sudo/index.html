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

test('source has no old public auth or redirect patterns', async ({ page }) => {
  await mockRpc(page);
  await page.goto('/');
  const html = await page.content();
  for (const pattern of ['signInWithOtp', 'Magic Link', 'email login', 'service_role', 'serviceWorker', 'sync-cloud', 'location.replace']) {
    expect(html).not.toContain(pattern);
  }
});
