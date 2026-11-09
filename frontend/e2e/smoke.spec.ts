import { expect, test } from '@playwright/test';

test('管理员登录后可进入指挥中心并加载后端数据', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: /可信安全决策/ })).toBeVisible();
  await page.fill('#username', 'admin');
  await page.fill('#password', 'e2e-strong-password');
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/');
  await expect(page.getByRole('group', { name: '关键指标' })).toBeVisible();
  const token = await page.evaluate(() => localStorage.getItem('admin_token'));
  expect(token).toBeTruthy();
  expect(consoleErrors.filter(text => !/favicon|Failed to load resource/i.test(text))).toEqual([]);
});

test('错误口令显示登录失败且不写入令牌', async ({ page }) => {
  await page.goto('/login');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'wrong-password');
  await page.locator('button[type="submit"]').click();
  await expect(page.getByText(/登录失败|用户名或密码错误/)).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('admin_token'))).toBeNull();
});

test('工作人员使用场景演示工号/登录码进入任务页', async ({ page }) => {
  await page.goto('/staff');
  await page.locator('label:has-text("工号") input').fill('STF-01');
  await page.locator('label:has-text("登录码") input').fill('1001');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的任务' })).toBeVisible();
});
