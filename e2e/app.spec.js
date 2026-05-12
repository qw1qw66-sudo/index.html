import { expect, test } from '@playwright/test';

const cloudState = {
  schema_version: 3,
  updated_at: '2026-01-01T00:00:00.000Z',
  settings: {
    name: 'شاليهات الاختبار',
    tag: 'QA Cloud',
    holidays: []
  },
  chalets: [
    {
      id: 'tulum',
      name: 'تولوم',
      capacity: 10,
      price: 0,
      description: 'شاليه تولوم',
      contactPhone: '0500000000',
      workerPhone: '0511111111',
      workerName: 'عامل تولوم',
      mapUrl: 'https://maps.example/tulum',
      terms: 'شروط تولوم',
      periods: [
        { id: 'morning', label: '٧ صباحاً إلى ٥ العصر', start: '07:00', end: '17:00', weekday_price: 700, weekend_price: 900, active: true, sort: 0 },
        { id: 'night', label: '٧ مساءً إلى ٥ الفجر', start: '19:00', end: '05:00', weekday_price: 800, weekend_price: 1000, active: true, sort: 1 }
      ],
      deleted_at: null,
      updated_at: '2026-01-01T00:00:00.000Z'
    },
    {
      id: 'sky',
      name: 'سكاي',
      capacity: 8,
      price: 0,
      description: 'شاليه سكاي',
      contactPhone: '0522222222',
      workerPhone: '0533333333',
      workerName: 'عامل سكاي',
      mapUrl: 'https://maps.example/sky',
      terms: 'شروط سكاي',
      periods: [
        { id: 'sky-morning', label: 'صباح سكاي', start: '07:00', end: '17:00', weekday_price: 600, weekend_price: 850, active: true, sort: 0 }
      ],
      deleted_at: null,
      updated_at: '2026-01-01T00:00:00.000Z'
    }
  ],
  bookings: [
    {
      id: 'booking-1',
      customer_name: 'Ali',
      customer_phone: '0509999999',
      chalet_id: 'tulum',
      booking_date: '2026-06-01',
      period_id: 'morning',
      guests: 4,
      total: 900,
      paid: 300,
      status: 'confirmed',
      notes: 'internal note must not appear in voucher',
      deleted_at: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z'
    }
  ]
};

async function mockSupabase(page) {
  await page.route('**/@supabase/supabase-js@2', async (route) => {
    await route.fulfill({
      contentType: 'application/javascript',
      body: `
        window.__rpcCalls = [];
        window.__cloudState = ${JSON.stringify(cloudState)};
        window.supabase = {
          createClient: function(){
            return {
              rpc: async function(name, args){
                window.__rpcCalls.push({ name, args });
                if (name === 'get_shared_workspace') return { data: window.__cloudState, error: null };
                if (name === 'save_shared_workspace') { window.__cloudState = args.p_data; return { data: { ok: true }, error: null }; }
                return { data: null, error: { message: 'unknown rpc' } };
              }
            };
          }
        };
      `
    });
  });
}

async function loadFinal(page) {
  await mockSupabase(page);
  await page.goto('/sync-cloud/final.html');
}

async function connectWorkspace(page) {
  await page.locator('#workspaceKey').fill('ALI6');
  await page.locator('#accessPin').fill('1234');
  await page.locator('#connectBtn').click();
  await expect(page.locator('#appView')).toBeVisible();
}

test('final app opens with workspace gate only and no seed or legacy auth UI', async ({ page }) => {
  await loadFinal(page);
  await expect(page.locator('#lockView')).toBeVisible();
  await expect(page.locator('#workspaceKey')).toBeVisible();
  await expect(page.locator('#accessPin')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('email@example.com');
  await expect(page.locator('body')).not.toContainText('إرسال رابط الدخول');
  await expect(page.locator('body')).not.toContainText('شاليه الواحة');
  await expect(page.locator('body')).not.toContainText('شاليه الياسمين');
  const calls = await page.evaluate(() => window.__rpcCalls);
  expect(calls).toEqual([]);
});

test('workspace pull shows only cloud chalets and bookings', async ({ page }) => {
  await loadFinal(page);
  await connectWorkspace(page);
  await expect(page.locator('#brandName')).toContainText('شاليهات الاختبار');
  await expect(page.locator('body')).toContainText('تولوم');
  await expect(page.locator('body')).toContainText('سكاي');
  await expect(page.locator('body')).toContainText('Ali');
  const calls = await page.evaluate(() => window.__rpcCalls.map((x) => x.name));
  expect(calls).toEqual(['get_shared_workspace']);
});

test('confirmed overlap in same chalet and period is blocked', async ({ page }) => {
  await loadFinal(page);
  await connectWorkspace(page);
  await page.locator('.tab [data-view="bookings"]').click();
  await page.locator('#fab').click();
  await page.locator('#bkName').fill('Other Customer');
  await page.locator('#bkPhone').fill('0511111111');
  await page.locator('#bkChalet').selectOption('tulum');
  await page.locator('#bkDate').fill('2026-06-01');
  await page.locator('#bkPeriod').selectOption('morning');
  await page.locator('#saveBookingBtn').click();
  await expect(page.locator('#toast')).toContainText('يوجد حجز مؤكد متعارض');
});

test('voucher hides booking id and internal notes while showing chalet-specific data', async ({ page }) => {
  await loadFinal(page);
  await connectWorkspace(page);
  await page.locator('.tab [data-view="bookings"]').click();
  await page.locator('[data-voucher="booking-1"]').click();
  await expect(page.locator('#voucherBox')).toContainText('تولوم');
  await expect(page.locator('#voucherBox')).toContainText('عامل تولوم');
  await expect(page.locator('#voucherBox')).toContainText('https://maps.example/tulum');
  await expect(page.locator('#voucherBox')).not.toContainText('booking-1');
  await expect(page.locator('#voucherBox')).not.toContainText('internal note');
});

test('app.html redirects to final app and manifest points to final app', async ({ page }) => {
  await mockSupabase(page);
  await page.goto('/app.html');
  await expect(page).toHaveURL(/sync-cloud\/final\.html/);
  await page.goto('/manifest.webmanifest');
  const manifest = JSON.parse(await page.textContent('body'));
  expect(manifest.start_url).toBe('./sync-cloud/final.html');
});
