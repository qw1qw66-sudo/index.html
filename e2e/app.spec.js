import { expect, test } from '@playwright/test';

function makeCloudState(extraBookings = []) {
  return {
    schema_version: 3,
    updated_at: '2026-01-01T00:00:00.000Z',
    settings: {
      facility_name: 'QA Facility',
      tag: 'QA Cloud',
      holidays: [
        { id: 'h1', date: '2026-06-02', type: 'aramco', label: 'Aramco' },
        { id: 'h2', date: '2026-06-03', type: 'school', label: 'School' },
        { id: 'h3', date: '2026-06-04', type: 'custom', label: 'Custom' }
      ]
    },
    chalets: [
      {
        id: 'tulum',
        name: 'Tulum',
        capacity: 10,
        description: 'Tulum chalet',
        contactPhone: '0500000000',
        workerPhone: '0511111111',
        workerName: 'Tulum Worker',
        mapUrl: 'https://maps.example/tulum',
        terms: 'Tulum terms',
        color: 'gold',
        periods: [
          { id: 'morning', label: 'Morning', start: '07:00', end: '17:00', weekday_price: 700, weekend_price: 900, active: true, sort: 0 },
          { id: 'night', label: 'Night', start: '19:00', end: '05:00', weekday_price: 800, weekend_price: 1000, active: true, sort: 1 }
        ],
        deleted_at: null,
        updated_at: '2026-01-01T00:00:00.000Z'
      },
      {
        id: 'sky',
        name: 'Sky',
        capacity: 8,
        description: 'Sky chalet',
        contactPhone: '0522222222',
        workerPhone: '0533333333',
        workerName: 'Sky Worker',
        mapUrl: 'https://maps.example/sky',
        terms: 'Sky terms',
        color: 'blue',
        periods: [
          { id: 'sky-morning', label: 'Sky Morning', start: '07:00', end: '17:00', weekday_price: 600, weekend_price: 850, active: true, sort: 0 }
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
      },
      ...extraBookings
    ]
  };
}

async function mockSupabase(page, initial = makeCloudState()) {
  await page.route('**/@supabase/supabase-js@2', async (route) => {
    await route.fulfill({
      contentType: 'application/javascript',
      body: `
        window.__rpcCalls = [];
        window.__cloudState = ${JSON.stringify(initial)};
        window.__wrongPin = false;
        window.supabase = {
          createClient: function(){
            return {
              rpc: async function(name, args){
                window.__rpcCalls.push({ name, args });
                if (name === 'get_shared_workspace') {
                  if (window.__wrongPin || args.p_access_pin === 'wrong') return { data: null, error: { message: 'WORKSPACE_NOT_FOUND_OR_PIN_INVALID' } };
                  return { data: JSON.parse(JSON.stringify(window.__cloudState)), error: null };
                }
                if (name === 'save_shared_workspace') {
                  const data = JSON.parse(JSON.stringify(args.p_data));
                  data.updated_at = '2026-01-01T00:01:00.000Z';
                  window.__cloudState = data;
                  return { data, error: null };
                }
                return { data: null, error: { message: 'unknown rpc' } };
              }
            };
          }
        };
      `
    });
  });
}

async function loadApp(page, initial) {
  await mockSupabase(page, initial);
  await page.goto('/app/');
}

async function connect(page, pin = '1234') {
  await page.locator('#workspaceKey').fill('ALI6');
  await page.locator('#accessPin').fill(pin);
  await page.locator('#connectBtn').click();
}

test('T1 app opens on /app/ with no seed and no upload attempted', async ({ page }) => {
  await loadApp(page);
  await expect(page.locator('#connectView')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('الواحة');
  await expect(page.locator('body')).not.toContainText('الياسمين');
  const calls = await page.evaluate(() => window.__rpcCalls);
  expect(calls).toEqual([]);
});

test('T2/T3 valid pull shows data and wrong pin leaks no partial data', async ({ page }) => {
  await loadApp(page);
  await connect(page);
  await expect(page.locator('#appView')).toBeVisible();
  await expect(page.locator('#facilityTitle')).toContainText('QA Facility');
  await expect(page.locator('body')).toContainText('Tulum');
  await expect(page.locator('body')).toContainText('Sky');

  await page.goto('/app/');
  await connect(page, 'wrong');
  await expect(page.locator('#connectMsg')).toContainText('WORKSPACE_NOT_FOUND_OR_PIN_INVALID');
  await expect(page.locator('#appView')).toBeHidden();
});

test('T4/T8/T9/T10 edits preserve names, per-chalet fields, period id and prices after push/pull', async ({ page }) => {
  await loadApp(page);
  await connect(page);
  await page.locator('[data-view="chalets"]').click();
  await page.locator('[data-edit-chalet="tulum"]').click();
  await page.locator('#chWorkerPhone').fill('0555555555');
  await page.locator('[data-pweekday]').first().fill('777');
  await page.locator('[data-pweekend]').first().fill('999');
  const periodId = await page.locator('[data-pid]').first().inputValue();
  await page.locator('#saveChaletBtn').click();
  await page.locator('[data-edit-chalet="sky"]').click();
  await page.locator('#chMap').fill('https://maps.example/sky-new');
  await page.locator('#saveChaletBtn').click();
  await page.locator('#uploadBtn').click();
  await expect(page.locator('#toast')).toContainText('تم رفع');
  await page.reload();
  await connect(page);
  await expect(page.locator('body')).toContainText('Tulum');
  await expect(page.locator('body')).toContainText('Sky');
  const cloud = await page.evaluate(() => window.__cloudState);
  const tulum = cloud.chalets.find((c) => c.id === 'tulum');
  const sky = cloud.chalets.find((c) => c.id === 'sky');
  expect(tulum.name).toBe('Tulum');
  expect(sky.name).toBe('Sky');
  expect(tulum.workerPhone).toBe('0555555555');
  expect(sky.mapUrl).toBe('https://maps.example/sky-new');
  expect(tulum.periods[0].id).toBe(periodId);
  expect(tulum.periods[0].weekday_price).toBe(777);
  expect(tulum.periods[0].weekend_price).toBe(999);
  expect(tulum.periods).toHaveLength(2);
});

test('T5/T6/T7/T16 push guards block failed credentials, empty overwrite, low-count destructive push, stale cloud', async ({ page }) => {
  const moreBookings = [1, 2, 3].map((n) => ({
    id: `b${n + 1}`,
    customer_name: `C${n}`,
    customer_phone: '05',
    chalet_id: 'tulum',
    booking_date: `2026-06-0${n + 1}`,
    period_id: 'night',
    guests: 1,
    total: 100,
    paid: 0,
    status: 'confirmed',
    notes: '',
    deleted_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z'
  }));
  await loadApp(page, makeCloudState(moreBookings));
  await connect(page);

  await page.evaluate(() => { window.__wrongPin = true; window.__APP_TEST__.state.chalets[0].workerPhone = 'x'; window.__APP_TEST__.forceDirty(); });
  await page.locator('#uploadBtn').click();
  await expect(page.locator('#toast')).toContainText('فشل الرفع');
  expect(await page.evaluate(() => window.__rpcCalls.filter((x) => x.name === 'save_shared_workspace').length)).toBe(0);

  await page.evaluate(() => { window.__wrongPin = false; window.__APP_TEST__.state.chalets.length = 0; window.__APP_TEST__.state.bookings.length = 0; window.__APP_TEST__.forceDirty(); });
  await page.locator('#uploadBtn').click();
  await expect(page.locator('#toast')).toContainText('تم إيقاف الرفع: البيانات المحلية فارغة وستحذف بيانات السحابة.');

  await page.evaluate(() => { window.__APP_TEST__.setState(window.__cloudState); window.__APP_TEST__.state.bookings.splice(1); window.__APP_TEST__.forceDirty(); });
  await page.locator('#uploadBtn').click();
  await expect(page.locator('#confirmSheet')).toBeVisible();
  await page.locator('#confirmPhrase').fill('wrong phrase');
  await page.locator('#confirmPushBtn').click();
  await expect(page.locator('#toast')).toContainText('عبارة التأكيد غير صحيحة');

  await page.evaluate(() => { window.__APP_TEST__.setState(window.__cloudState); window.__APP_TEST__.state.chalets[0].workerPhone = 'stale'; window.__APP_TEST__.forceDirty(); window.__cloudState.updated_at = '2026-01-01T00:05:00.000Z'; });
  await page.locator('#uploadBtn').click();
  await expect(page.locator('#toast')).toContainText('توجد نسخة أحدث في السحابة');
});

test('T11/T12 conflict blocks overlap and allows non-overlap', async ({ page }) => {
  await loadApp(page);
  await connect(page);
  await page.locator('[data-view="bookings"]').click();
  await page.locator('#fab').click();
  await page.locator('#bkName').fill('Other Customer');
  await page.locator('#bkPhone').fill('0511111111');
  await page.locator('#bkChalet').selectOption('tulum');
  await page.locator('#bkDate').fill('2026-06-01');
  await page.locator('#bkPeriod').selectOption('morning');
  await page.locator('#saveBookingBtn').click();
  await expect(page.locator('#toast')).toContainText('يوجد حجز مؤكد متعارض');
  await page.locator('#bkPeriod').selectOption('night');
  await page.locator('#saveBookingBtn').click();
  await expect(page.locator('#bookingList')).toContainText('Other Customer');
});

test('T13/T14 voucher uses same chalet fields and share/copy fallback works', async ({ page }) => {
  await loadApp(page);
  await page.addInitScript(() => { delete navigator.share; navigator.clipboard = { writeText: async (text) => { window.__copiedVoucher = text; } }; });
  await connect(page);
  await page.locator('[data-view="bookings"]').click();
  await page.locator('#bookingList [data-voucher="booking-1"]').click();
  await expect(page.locator('#voucherBox')).toContainText('Tulum');
  await expect(page.locator('#voucherBox')).toContainText('Tulum Worker');
  await expect(page.locator('#voucherBox')).toContainText('https://maps.example/tulum');
  await expect(page.locator('#voucherBox')).not.toContainText('Sky Worker');
  await expect(page.locator('#voucherBox')).not.toContainText('booking-1');
  await expect(page.locator('#voucherBox')).not.toContainText('internal note');
  await expect(page.locator('#voucherBox')).not.toContainText('ويكند');
  await page.locator('#shareVoucherBtn').click();
  await expect(page.locator('#toast')).toContainText('تم نسخ السند');
  expect(await page.evaluate(() => window.__copiedVoucher)).toContain('Tulum');
});

test('T17/T18 static source and route checks', async ({ page }) => {
  await page.goto('/app/');
  const html = await page.content();
  expect(html).not.toContain('service_role');
  expect(html).not.toContain('signInWithOtp');
  expect(html).not.toContain('setInterval(');
  await page.goto('/app/manifest.webmanifest');
  const manifest = JSON.parse(await page.textContent('body'));
  expect(manifest.start_url).toBe('/app/');
  await page.goto('/404.html');
  await expect(page.locator('body')).toContainText('هذه الصفحة لم تعد موجودة');
  await expect(page.locator('a[href="/app/"]')).toBeVisible();
});
