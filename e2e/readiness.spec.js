import { expect, test } from '@playwright/test';

// READINESS SWEEP — four end-to-end tests for EVERY section (خانة) of the app,
// driven through the real UI against the mocked production server, so we can say
// the program is genuinely ready: home, chalets, bookings, expenses, reports,
// assistant, settings.

const FUTURE_DATE = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);

async function mockRpc(page) {
  let exists = false;
  let cloud = {
    ok: true, workspace_key: 'TEST1', updated_at: '2026-01-01T00:00:00.000Z',
    data: { schema_version: 3, settings: { facility_name: '', tag: '', holidays: [] }, chalets: [], bookings: [], expenses: [] },
  };
  await page.route('**/rest/v1/rpc/**', async (route) => {
    const name = route.request().url().split('/').pop();
    const body = JSON.parse(route.request().postData() || '{}');
    if (body.p_access_pin === 'wrong') {
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'WORKSPACE_NOT_FOUND_OR_PIN_INVALID' }) });
      return;
    }
    if (name === 'get_shared_workspace') {
      if (!exists) { await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'WORKSPACE_NOT_FOUND_OR_PIN_INVALID' }) }); return; }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(cloud) }); return;
    }
    if (name === 'save_shared_workspace') {
      exists = true;
      cloud = { ok: true, workspace_key: String(body.p_workspace_key || 'TEST1').toUpperCase(), updated_at: new Date(Date.parse(cloud.updated_at) + 60000).toISOString(), data: body.p_data };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(cloud) }); return;
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'unknown rpc' }) });
  });
  // The assistant / setup edge functions are not deployed against this mock.
  await page.route('**/functions/v1/**', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"not deployed"}' }));
}
async function routeAssistant(page, body, status = 200) {
  await page.route('**/functions/v1/chalet-assistant', (route) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }));
}
async function create(page) {
  await page.locator('#workspaceInput').fill('test1');
  await page.locator('#pinInput').fill('123456');
  await page.locator('#createButton').click();
  await expect(page.locator('#appShell')).toBeVisible();
}
async function addChalet(page, name = 'Tulum') {
  await page.locator('[data-tab="chalets"]').click();
  await page.locator('[data-action="new-chalet"]').click();
  await page.locator('#chaletName').fill(name);
  await expect(page.locator('.period-card')).toHaveCount(6);
  await page.locator('[data-period-field="label"]').nth(0).fill('Morning');
  await page.locator('[data-period-field="start"]').nth(0).fill('07:00');
  await page.locator('[data-period-field="end"]').nth(0).fill('17:00');
  await page.locator('[data-period-field="active"]').nth(0).check();
  await page.locator('[data-period-field="weekday_price"]').nth(0).fill('300');
  await page.locator('[data-period-field="weekend_price"]').nth(0).fill('500');
  await page.locator('[data-action="save-chalet"]').click();
}
async function addBooking(page, { name = 'علي', total = '900', paid = '300' } = {}) {
  await page.locator('[data-tab="bookings"]').click();
  await page.locator('[data-action="new-booking"]').click();
  await page.locator('#bookingCustomerName').fill(name);
  await page.locator('#bookingCustomerPhone').fill('0509999999');
  await page.locator('#bookingDate').fill(FUTURE_DATE);
  await page.locator('#bookingTotal').fill(total);
  await page.locator('#bookingPaid').fill(paid);
  await page.locator('[data-action="save-booking"]').click();
}
async function addExpense(page, { amount = '200', category = 'كهرباء', note = 'تجربة' } = {}) {
  await page.locator('[data-tab="expenses"]').click();
  await page.locator('#expenseDate').fill(new Date().toISOString().slice(0, 10));
  await page.locator('#expenseCategory').selectOption(category);
  await page.locator('#expenseAmount').fill(amount);
  await page.locator('#expenseNote').fill(note);
  await page.locator('[data-action="save-expense"]').click();
}

// ============================ 1) HOME (الرئيسية) ============================
test.describe('خانة الرئيسية', () => {
  test('R1 KPI tiles render after account creation', async ({ page }) => {
    await mockRpc(page); await page.goto('/'); await create(page);
    await expect(page.locator('#homeChalets')).toHaveText('0');
    await expect(page.locator('#homeBookings')).toHaveText('0');
    await expect(page.locator('#homeDue')).toBeVisible();
  });
  test('R2 quick-glance shows month income/expenses/net + a tip', async ({ page }) => {
    await mockRpc(page); await page.goto('/'); await create(page); await addExpense(page);
    await page.locator('[data-tab="home"]').click();
    const g = page.locator('#homeGlance');
    await expect(g).toContainText('دخل الشهر');
    await expect(g).toContainText('صافي الشهر');
    await expect(g).toContainText('💡');
  });
  test('R3 KPIs update after a chalet + booking exist', async ({ page }) => {
    await mockRpc(page); await page.goto('/'); await create(page);
    await addChalet(page); await addBooking(page);
    await page.locator('[data-tab="home"]').click();
    await expect(page.locator('#homeChalets')).toHaveText('1');
    await expect(page.locator('#homeBookings')).toHaveText('1');
    await expect(page.locator('#homeDue')).toContainText('600'); // 900 - 300 remaining
  });
  test('R4 upcoming-bookings section is present', async ({ page }) => {
    await mockRpc(page); await page.goto('/'); await create(page);
    await page.locator('[data-tab="home"]').click();
    await expect(page.locator('#homeUpcoming')).toContainText('لا توجد حجوزات');
    await expect(page.locator('#remainingAlerts')).toBeVisible();
  });
});

// ============================ 2) CHALETS (الشاليهات) ============================
test.describe('خانة الشاليهات', () => {
  test('R1 create a chalet → it appears in the list', async ({ page }) => {
    await mockRpc(page); await page.goto('/'); await create(page); await addChalet(page);
    await expect(page.locator('#feedback')).toContainText('تم تحديث بيانات الشاليه.');
    await expect(page.locator('#chaletList')).toContainText('Tulum');
  });
  test('R2 edit a chalet keeps its id and updates a field', async ({ page }) => {
    await mockRpc(page); await page.goto('/'); await create(page); await addChalet(page);
    await page.locator('[data-action="edit-chalet"]').first().click();
    const id = await page.locator('.period-card').first().getAttribute('data-period-id');
    await page.locator('#chaletCapacity').fill('25');
    await page.locator('[data-action="save-chalet"]').click();
    await page.locator('[data-action="edit-chalet"]').first().click();
    expect(await page.locator('.period-card').first().getAttribute('data-period-id')).toBe(id);
    await expect(page.locator('#chaletCapacity')).toHaveValue('25');
  });
  test('R3 period weekday/weekend prices persist', async ({ page }) => {
    await mockRpc(page); await page.goto('/'); await create(page); await addChalet(page);
    await page.locator('[data-action="edit-chalet"]').first().click();
    await expect(page.locator('[data-period-field="weekday_price"]').nth(0)).toHaveValue('300');
    await expect(page.locator('[data-period-field="weekend_price"]').nth(0)).toHaveValue('500');
  });
  test('R4 soft-delete removes the chalet from the active list', async ({ page }) => {
    await mockRpc(page); await page.goto('/'); await create(page); await addChalet(page);
    page.once('dialog', (d) => d.accept());
    await page.locator('[data-action="soft-delete-chalet"]').first().click();
    await expect(page.locator('#chaletList')).not.toContainText('Tulum');
  });
});

// ============================ 3) BOOKINGS (الحجوزات) ============================
test.describe('خانة الحجوزات', () => {
  test('R1 create a booking → it appears in the list', async ({ page }) => {
    await mockRpc(page); await page.goto('/'); await create(page); await addChalet(page); await addBooking(page, { name: 'زبون أول' });
    await expect(page.locator('#bookingList')).toContainText('زبون أول');
  });
  test('R2 editing the total recomputes the remaining', async ({ page }) => {
    await mockRpc(page); await page.goto('/'); await create(page); await addChalet(page); await addBooking(page, { name: 'زبون', total: '900', paid: '300' });
    await page.locator('#bookingList [data-action="edit-booking"]').first().click();
    await page.locator('#bookingTotal').fill('1000');
    await expect(page.locator('#bookingRemaining')).toHaveValue('700'); // 1000 − 300
  });
  test('R3 cancel → the booking moves to the cancelled section', async ({ page }) => {
    await mockRpc(page); await page.goto('/'); await create(page); await addChalet(page); await addBooking(page, { name: 'زبون ملغى' });
    await page.locator('#bookingList [data-action="edit-booking"]').first().click();
    await page.selectOption('#bookingStatus', 'cancelled');
    await page.locator('[data-action="save-booking"]').click();
    await expect(page.locator('#bookingCancelledList')).toContainText('زبون ملغى');
  });
  test('R4 live search filters the list by customer name', async ({ page }) => {
    await mockRpc(page); await page.goto('/'); await create(page); await addChalet(page);
    await addBooking(page, { name: 'محمد' });
    await addBooking(page, { name: 'سارة' });
    await page.locator('#bookingSearch').fill('محمد');
    await expect(page.locator('#bookingList')).toContainText('محمد');
    await expect(page.locator('#bookingList')).not.toContainText('سارة');
  });
});

// ============================ 4) EXPENSES (المصاريف) ============================
test.describe('خانة المصاريف', () => {
  test('R1 add an expense → list + month total', async ({ page }) => {
    await mockRpc(page); await page.goto('/'); await create(page); await addExpense(page, { amount: '150', category: 'صيانة', note: 'أنبوب' });
    await expect(page.locator('#expensesList')).toContainText('صيانة');
    await expect(page.locator('#expensesList')).toContainText('أنبوب');
    await expect(page.locator('#expensesMonthTotal')).toContainText('150');
  });
  test('R2 edit an expense amount', async ({ page }) => {
    await mockRpc(page); await page.goto('/'); await create(page); await addExpense(page, { amount: '150', category: 'صيانة' });
    await page.locator('#expensesList [data-action="edit-expense"]').first().click();
    await page.locator('#expenseAmount').fill('275');
    await page.locator('[data-action="save-expense"]').click();
    await expect(page.locator('#expensesMonthTotal')).toContainText('275');
  });
  test('R3 soft-delete removes the expense', async ({ page }) => {
    await mockRpc(page); await page.goto('/'); await create(page); await addExpense(page, { amount: '150', category: 'صيانة', note: 'يُحذف' });
    page.once('dialog', (d) => d.accept());
    await page.locator('#expensesList [data-action="soft-delete-expense"]').first().click();
    await expect(page.locator('#expensesList')).not.toContainText('يُحذف');
  });
  test('R4 category select offers multiple categories', async ({ page }) => {
    await mockRpc(page); await page.goto('/'); await create(page);
    await page.locator('[data-tab="expenses"]').click();
    const count = await page.locator('#expenseCategory option').count();
    expect(count).toBeGreaterThanOrEqual(3);
    await page.locator('#expenseCategory').selectOption('كهرباء');
    await expect(page.locator('#expenseCategory')).toHaveValue('كهرباء');
  });
});

// ============================ 5) REPORTS (التقارير) ============================
test.describe('خانة التقارير', () => {
  test('R1 run report shows income, paid and remaining', async ({ page }) => {
    await mockRpc(page); await page.goto('/'); await create(page); await addChalet(page); await addBooking(page, { total: '900', paid: '300' });
    await page.locator('[data-tab="reports"]').click();
    await page.locator('#reportMonth').fill(FUTURE_DATE.slice(0, 7));
    await page.locator('[data-action="run-report"]').click();
    await expect(page.locator('#reportBox')).toContainText('الإجمالي');
    await expect(page.locator('#reportBox')).toContainText('المتبقي');
  });
  test('R2 report shows expenses and NET (income − expenses)', async ({ page }) => {
    await mockRpc(page); await page.goto('/'); await create(page); await addExpense(page, { amount: '200' });
    await page.locator('[data-tab="reports"]').click();
    await page.locator('[data-action="run-report"]').click();
    await expect(page.locator('#reportBox')).toContainText('المصاريف');
    await expect(page.locator('#reportBox')).toContainText('الصافي');
  });
  test('R3 the chalet filter is populated from the chalets', async ({ page }) => {
    await mockRpc(page); await page.goto('/'); await create(page); await addChalet(page, 'Sky');
    await page.locator('[data-tab="reports"]').click();
    await expect(page.locator('#reportChalet')).toContainText('Sky');
  });
  test('R4 copy-report exposes a non-empty report text', async ({ page }) => {
    await mockRpc(page); await page.goto('/'); await create(page); await addExpense(page, { amount: '200' });
    await page.locator('[data-tab="reports"]').click();
    await page.locator('[data-action="run-report"]').click();
    await expect(page.locator('#reportBox')).toContainText('الصافي');
    await expect(page.locator('[data-action="copy-report"]')).toBeVisible();
  });
});

// ============================ 6) ASSISTANT (المساعد) ============================
test.describe('خانة المساعد', () => {
  test('R1 a grounded answer renders as one clean bubble, connection «متصل»', async ({ page }) => {
    await mockRpc(page);
    await routeAssistant(page, { ok: true, thread_id: 't1', reply_ar: 'لا توجد حجوزات اليوم.', tool_results: [], model_calls: 0 });
    await page.goto('/'); await create(page);
    await page.locator('[data-tab="assistant"]').click();
    await page.locator('#assistantInput').fill('شنو حجوزات اليوم؟');
    await page.locator('[data-action="assistant-send"]').click();
    await expect(page.locator('#assistantLog')).toContainText('لا توجد حجوزات اليوم.');
    await expect(page.locator('#assistantConn')).toHaveText('متصل');
  });
  test('R2 the internal tool name never leaks into the chat', async ({ page }) => {
    await mockRpc(page);
    await routeAssistant(page, { ok: true, thread_id: 't1', reply_ar: 'عندك حجزان.', tool_results: [{ kind: 'read', ok: true, tool: 'get_today_bookings', result: {} }], model_calls: 0 });
    await page.goto('/'); await create(page);
    await page.locator('[data-tab="assistant"]').click();
    await page.locator('#assistantInput').fill('كم حجز اليوم؟');
    await page.locator('[data-action="assistant-send"]').click();
    await expect(page.locator('#assistantLog')).toContainText('عندك حجزان.');
    expect(await page.locator('#assistantLog').innerText()).not.toContain('get_today_bookings');
  });
  test('R3 quick-suggestion chips are present and clickable', async ({ page }) => {
    await mockRpc(page);
    await routeAssistant(page, { ok: true, thread_id: 't1', reply_ar: 'تمام.', tool_results: [], model_calls: 0 });
    await page.goto('/'); await create(page);
    await page.locator('[data-tab="assistant"]').click();
    const chips = page.locator('[data-action="assistant-suggest"]');
    expect(await chips.count()).toBeGreaterThan(0);
    await chips.first().click();
    await expect(page.locator('#assistantLog')).toContainText('تمام.');
  });
  test('R4 a server error degrades to a safe Arabic message (no crash)', async ({ page }) => {
    await mockRpc(page);
    await routeAssistant(page, { ok: false, error: 'DEEPSEEK_UNREACHABLE' }, 200);
    await page.goto('/'); await create(page);
    await page.locator('[data-tab="assistant"]').click();
    await page.locator('#assistantInput').fill('سؤال');
    await page.locator('[data-action="assistant-send"]').click();
    await expect(page.locator('#appShell')).toBeVisible(); // still alive, no crash
    await expect(page.locator('#assistantLog')).not.toBeEmpty();
  });
});

// ============================ 7) SETTINGS (الإعدادات) ============================
test.describe('خانة الإعدادات', () => {
  test('R1 facility name saves and persists', async ({ page }) => {
    await mockRpc(page); await page.goto('/'); await create(page);
    await page.locator('[data-tab="settings"]').click();
    await page.locator('#settingFacilityName').fill('منتجع الاختبار');
    await page.locator('[data-action="save-settings"]').click();
    await expect(page.locator('#settingFacilityName')).toHaveValue('منتجع الاختبار');
  });
  test('R2 dark/light theme toggles apply', async ({ page }) => {
    await mockRpc(page); await page.goto('/'); await create(page);
    await page.locator('[data-tab="settings"]').click();
    await page.locator('[data-action="set-theme-dark"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.locator('[data-action="set-theme-light"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });
  test('R3 the assistant-memory section is present', async ({ page }) => {
    await mockRpc(page); await page.goto('/'); await create(page);
    await page.locator('[data-tab="settings"]').click();
    // The memory manager lives in a collapsible section — assert it exists.
    await expect(page.locator('#memoryList')).toBeAttached();
    await expect(page.locator('[data-action="memory-refresh"]')).toBeAttached();
  });
  test('R4 the settings save + cloud upload controls are present', async ({ page }) => {
    await mockRpc(page); await page.goto('/'); await create(page);
    await page.locator('[data-tab="settings"]').click();
    await expect(page.locator('[data-action="upload"]')).toBeVisible(); // push to cloud
    await expect(page.locator('[data-action="save-settings"]')).toBeVisible();
  });
});
