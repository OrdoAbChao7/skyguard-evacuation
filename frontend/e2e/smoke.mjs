#!/usr/bin/env node
/**
 * V7.4 浏览器 E2E 冒烟测试（Playwright）。
 *
 * 前置：
 *   npm install --no-save --prefix frontend playwright
 *   npm run dev:backend
 *   npm run dev:frontend
 *
 * 运行：
 *   node frontend/e2e/smoke.mjs --out evaluation/v74/<run>/browser_e2e.json
 *
 * 验证：登录页 → 管理员登录 → 指挥中心加载 → 经前端代理调用安全状态 API。
 * 不修改数据、不触发写操作。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
const outArg = process.argv.indexOf('--out');
const outPath = outArg >= 0 ? path.resolve(root, process.argv[outArg + 1]) : null;
const frontendUrl = process.env.SKYGUARD_E2E_FRONTEND ?? 'http://localhost:5173';
const backendUrl = process.env.SKYGUARD_E2E_BACKEND ?? 'http://localhost:8010';

async function waitFor(url, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // retry
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

const result = {
  generated_at: new Date().toISOString(),
  frontend_url: frontendUrl,
  backend_url: backendUrl,
  steps: [],
  console_errors: [],
  page_errors: [],
  passed: false,
};

try {
  if (!(await waitFor(`${backendUrl}/health`))) throw new Error('backend health timeout');
  if (!(await waitFor(frontendUrl))) throw new Error('frontend timeout');
  result.steps.push({ step: 'servers_ready', ok: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', message => {
    if (message.type() === 'error') result.console_errors.push(message.text().slice(0, 500));
  });
  page.on('pageerror', error => result.page_errors.push(String(error).slice(0, 500)));

  await page.goto(`${frontendUrl}/login`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#username', { timeout: 15000 });
  await page.fill('#username', process.env.SKYGUARD_ADMIN_USERNAME ?? 'admin');
  await page.fill('#password', process.env.SKYGUARD_ADMIN_PASSWORD ?? 'skyguard2026');
  await page.click('button[type="submit"]');
  await page.waitForURL(url => !url.pathname.endsWith('/login'), { timeout: 15000 });
  const token = await page.evaluate(() => localStorage.getItem('admin_token'));
  result.steps.push({ step: 'admin_login', ok: Boolean(token), token_present: Boolean(token) });

  await page.waitForTimeout(800);
  const bodyText = await page.locator('body').innerText();
  result.steps.push({ step: 'command_center_loaded', ok: bodyText.length > 0, body_chars: bodyText.length });

  const api = await page.evaluate(async () => {
    const response = await fetch('/api/v1/safety/status', {
      headers: { Authorization: `Bearer ${localStorage.getItem('admin_token') ?? ''}` },
    });
    return { status: response.status, ok: response.ok };
  });
  result.steps.push({ step: 'api_via_frontend_proxy', ok: api.ok, http_status: api.status });

  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await page.screenshot({ path: outPath.replace(/\.json$/, '.png'), fullPage: true });
  }
  result.passed = Boolean(token) && api.ok && result.page_errors.length === 0;
  await browser.close();
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
}

console.log(JSON.stringify(result, null, 2));
if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
}
process.exit(result.passed ? 0 : 1);
