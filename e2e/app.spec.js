import { expect, test } from '@playwright/test';

async function mockRpc(page) {
  const calls = [];
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
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(cloud) });
      return;
    }

    if (name === 'save_shared_workspace') {
      cloud = {
        ok: true,
        workspace_key: String(body.p_workspace_key || 'TEST1').toUpperCase(),
        updated_at: new Date(Date.parse(cloud.updated_at) + 60000).toISOString(),
        data: body.p_data
      };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(cloud) });
      return;
    }

    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'unknown rpc' }) });
  });

  return { calls, cloud: () => cloud };
}

async function create(page) {
  await page.locator('#workspaceInput').fill('test1');
  await page.locator('#pinInput').fill('1234');
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
  await page.locator('#bookingDate').fill('2026-06-01');
  await page.locator('#bookingTotal').fill('900');
  await page.locator('#bookingPaid').fill('300');
  await page.locator('[data-action="save-booking"]').click();

  await page.locator('[data-action="new-booking"]').click();
  await page.locator('#bookingCustomerName').fill('Other');
  await page.locator('#bookingCustomerPhone').fill('0555555555');
  await page.locator('#bookingDate').fill('2026-06-01');
  await page.locator('[data-action="save-booking"]').click();
  await expect(page.locator('#feedback')).toContainText('يوجد حجز مؤكد متعارض في نفس الشاليه والفترة.');

  await page.locator('[data-action="voucher"]').first().click();
  await expect(page.locator('#voucherBox')).toContainText('QA Facility');
  await expect(page.locator('#voucherBox')).toContainText('Tulum');
  await expect(page.locator('#voucherBox')).toContainText('Morning');
  await expect(page.locator('#voucherBox')).toContainText('07:00');
  await expect(page.locator('#voucherBox')).toContainText('17:00');
});

test('source has no old public auth or redirect patterns', async ({ page }) => {
  await mockRpc(page);
  await page.goto('/');
  const html = await page.content();
  for (const pattern of ['signInWithOtp', 'Magic Link', 'email login', 'service_role', 'serviceWorker', 'sync-cloud', 'location.replace']) {
    expect(html).not.toContain(pattern);
  }
});
