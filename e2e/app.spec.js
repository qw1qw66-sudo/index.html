import { expect, test } from '@playwright/test';

const appState = {
  chalets: [
    { id: 'tulum', name: 'تولوم', capacity: 8, price: 600, description: '', color: 0, is_active: true, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', deleted_at: null }
  ],
  bookings: [
    { id: 'booking-1', booking_no: '2026-0001', chalet_id: 'tulum', customer_name: 'Ali', customer_phone: '0500000000', check_in: '2026-06-01', check_out: '2026-06-03', nights: 2, guests: 4, total: 1200, paid: 200, status: 'confirmed', notes: '', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', deleted_at: null }
  ],
  settings: { name: 'Test Resort', tag: 'QA', phone: '', checkIn: '15:00', checkOut: '12:00', terms: '', supabaseUrl: '', supabaseAnon: '' },
  theme: 'dark',
  lastSync: null
};

test.beforeEach(async ({ page }) => {
  await page.goto('/app.html');
  await page.evaluate((state) => {
    localStorage.setItem('chalets_app_state_v5', JSON.stringify(state));
    localStorage.removeItem('chalets_sync_queue_v2');
  }, appState);
  await page.reload();
});

test('app shell loads core Arabic UI', async ({ page }) => {
  await expect(page.locator('#brandName')).toContainText('Test Resort');
  await expect(page.locator('text=لوحة التحكم')).toBeVisible();
  await expect(page.locator('text=الحجوزات')).toBeVisible();
});

test('editing an existing booking name does not create false duplicate conflict', async ({ page }) => {
  await page.locator('[data-view="book"]').click();
  await expect(page.locator('text=Ali')).toBeVisible();
  await page.getByRole('button', { name: /تعديل/ }).first().click();
  await page.locator('#bkName').fill('Ali Updated');
  await page.locator('#saveBooking').click();
  await expect(page.locator('#toast')).toContainText('تم الحفظ');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('chalets_app_state_v5')));
  expect(saved.bookings).toHaveLength(1);
  expect(saved.bookings[0].customer_name).toBe('Ali Updated');
});

test('new overlapping confirmed booking is rejected', async ({ page }) => {
  await page.locator('[data-view="book"]').click();
  await page.locator('[data-open-booking]').first().click();
  await page.locator('#bkName').fill('Other Customer');
  await page.locator('#bkPhone').fill('0511111111');
  await page.locator('#bkChalet').selectOption('tulum');
  await page.locator('#bkIn').fill('2026-06-02');
  await page.locator('#bkOut').fill('2026-06-04');
  await page.locator('#saveBooking').click();
  await expect(page.locator('#toast')).toContainText('يوجد حجز مؤكد');
});

test('PWA manifest is linked', async ({ page }) => {
  const manifest = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(manifest).toBe('manifest.webmanifest');
});
