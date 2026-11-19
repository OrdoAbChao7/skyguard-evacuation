#!/usr/bin/env node
/**
 * 采集参赛提交包截图：指挥大屏 → 仿真第 7 步 → 工作人员反馈 → 恢复常态。
 *
 * 前置：
 *   npm run dev（后端 :8010 + 前端 :5173）
 *   SKYGUARD_ADMIN_PASSWORD 环境变量（不写入任何文件）
 *
 * 运行：
 *   node frontend/e2e/capture-submission.mjs --out submission/screenshots
 *   node frontend/e2e/capture-submission.mjs --out submission/demo-run --video --slowmo=300
 *
 * --video        同时录制管理员页（1600×1000）与工作人员页（430×920），
 *                输出 video-admin.webm / video-staff.webm；需要 Playwright 自带 ffmpeg。
 * --slowmo=<ms>  放慢每一步操作，便于录制回看（不影响断言与截图）。
 *
 * 录制前建议用 `RATE_LIMIT_MAX=5000 npm run dev` 启动（仅本地录制；生产保持默认），
 * 并关闭其它正在轮询的大屏标签，避免画面出现“请求过于频繁”的红色错误条。
 *
 * 该脚本会重置并运行一次合成仿真；只操作演示数据，不触碰真实数据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
const outArg = process.argv.indexOf('--out');
const outDir = path.resolve(root, outArg >= 0 ? process.argv[outArg + 1] : 'submission/screenshots');
const frontendUrl = process.env.SKYGUARD_E2E_FRONTEND ?? 'http://localhost:5173';
const adminPassword = process.env.SKYGUARD_ADMIN_PASSWORD;
const videoEnabled = process.argv.includes('--video');
const slowMoArg = process.argv.find(argument => argument.startsWith('--slowmo='));
const slowMo = slowMoArg ? Math.max(0, Number(slowMoArg.split('=')[1]) || 0) : 0;
const videoRawDir = path.join(outDir, 'video-raw');

if (!adminPassword) {
  console.error('缺少 SKYGUARD_ADMIN_PASSWORD 环境变量；请在命令前临时设置，不要写入文件。');
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

function shotPath(name) {
  return path.join(outDir, name);
}

function accessCodeFor(staffId) {
  const match = /^STAFF_GATE_(\d+)$/.exec(staffId);
  return match ? `CODE_G${match[1]}` : null;
}

async function api(page, requestPath, init = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await page.evaluate(async ({ requestPath: target, init: options }) => {
      const token = localStorage.getItem('admin_token') ?? '';
      const headers = { ...(options.headers ?? {}), Authorization: `Bearer ${token}` };
      if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
      const response = await fetch(target, { ...options, headers });
      const text = await response.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: response.status, ok: response.ok, json, text: text.slice(0, 400) };
    }, { requestPath, init });
    // 页面轮询与脚本请求叠加时可能触发 300 次/分钟限流；退避重试，不改变最终状态。
    if (response.status !== 429 || attempt >= 5) return response;
    await page.waitForTimeout(1500 * (attempt + 1));
  }
}

async function waitSimulation(page, predicate, timeoutMs, label) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const response = await api(page, '/api/v1/mvp/simulation');
    if (response.ok && response.json) {
      last = response.json;
      if (predicate(response.json)) return response.json;
    }
    // 面板自身每 1.5s 轮询一次；截图脚本放慢到 4s，避免叠加触发读接口限流。
    await page.waitForTimeout(4000);
  }
  throw new Error(`等待仿真状态超时：${label}；最后状态=${JSON.stringify(last)?.slice(0, 500)}`);
}

const summary = {
  generated_at: new Date().toISOString(),
  frontend_url: frontendUrl,
  screenshots: [],
  steps: [],
  console_errors: [],
  rate_limited: 0,
  page_errors: [],
  video: videoEnabled ? { enabled: true, files: [], errors: [] } : { enabled: false },
  clean: false,
  passed: false,
};

let browser;
let adminContext;
let staffContext;
let adminVideo;
let staffVideo;
try {
  browser = await chromium.launch({ headless: true, slowMo });
  adminContext = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    ...(videoEnabled ? { recordVideo: { dir: videoRawDir, size: { width: 1600, height: 1000 } } } : {}),
  });
  const page = await adminContext.newPage();
  if (videoEnabled) adminVideo = page.video();
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text().slice(0, 500);
    // 本机同时开着其他浏览器标签时，可能叠加触发默认 300 次/分钟读接口限流；
    // 429 只影响本轮轮询，不改变页面最终状态，因此单独计数而不是当作运行时异常。
    if (text.includes('429 (Too Many Requests)')) {
      summary.rate_limited += 1;
      return;
    }
    summary.console_errors.push(text);
  });
  page.on('pageerror', error => summary.page_errors.push(String(error).slice(0, 500)));

  await page.goto(`${frontendUrl}/login`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#username', { timeout: 15000 });
  await page.fill('#username', process.env.SKYGUARD_ADMIN_USERNAME ?? 'admin');
  await page.fill('#password', adminPassword);
  await page.click('button[type="submit"]');
  await page.waitForURL(url => !url.pathname.endsWith('/login'), { timeout: 15000 });
  summary.steps.push({ step: 'admin_login', ok: true });

  // 先清空上一次运行留下的观测，再进入大屏，保证首帧是真正的冷启动。
  const reset = await api(page, '/api/v1/mvp/reset', { method: 'POST', body: '{}' });
  if (!reset.ok) throw new Error(`重置 MVP 失败：${reset.status} ${reset.text}`);

  await page.goto(`${frontendUrl}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.cc-topbar', { timeout: 15000 });
  await page.waitForFunction(() => !document.body.innerText.includes('无法加载场景'), null, { timeout: 15000 });
  await page.waitForTimeout(2200);
  await page.screenshot({ path: shotPath('01-command-center.png'), fullPage: false });
  summary.screenshots.push('01-command-center.png');

  const start = await api(page, '/api/v1/mvp/simulation/start', {
    method: 'POST',
    body: JSON.stringify({ autoplay: true }),
  });
  if (!start.ok) throw new Error(`启动仿真失败：${start.status} ${start.text}`);
  summary.steps.push({ step: 'simulation_started', ok: true });

  const awaiting = await waitSimulation(page, status => status.awaiting_human, 60000, '第 7 步人工介入');
  await page.waitForSelector('section.sim-panel.awaiting', { timeout: 15000 });
  await page.locator('section.sim-panel').scrollIntoViewIfNeeded();
  await page.waitForTimeout(700);
  await page.locator('section.sim-panel').screenshot({ path: shotPath('02-simulation-awaiting.png') });
  summary.screenshots.push('02-simulation-awaiting.png');
  summary.steps.push({
    step: 'simulation_awaiting_human',
    ok: true,
    state: awaiting.state,
    pending_work_orders: awaiting.counts?.pending_work_orders,
  });

  const pending = await api(page, '/api/v1/mvp/work-orders?status=PENDING_APPROVAL');
  if (!pending.ok) throw new Error(`读取待审批工单失败：${pending.status} ${pending.text}`);
  const orders = pending.json?.work_orders ?? [];
  const target = orders.find(order => order.type === 'scene_verification')
    ?? orders.find(order => order.type !== 'uav_observation')
    ?? orders[0];
  if (!target) throw new Error('第 7 步没有待审批工单，无法演示人工闭环');

  const approved = await api(page, `/api/v1/mvp/work-orders/${target.id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ note: '控制台审批通过（仿真演示）' }),
  });
  if (!approved.ok) throw new Error(`批准工单失败：${approved.status} ${approved.text}`);
  const assigned = await api(page, `/api/v1/mvp/work-orders/${target.id}/assign`, { method: 'POST', body: '{}' });
  if (!assigned.ok) throw new Error(`派发工单失败：${assigned.status} ${assigned.text}`);
  const staffId = assigned.json?.work_order?.assigned_staff_id;
  const accessCode = staffId ? accessCodeFor(staffId) : null;
  if (!staffId || !accessCode) throw new Error(`工单派发后没有可用工号：${JSON.stringify(assigned.json).slice(0, 400)}`);
  summary.steps.push({ step: 'work_order_approved_and_assigned', ok: true, order_id: target.id, order_type: target.type, staff_id: staffId });

  staffContext = await browser.newContext({
    viewport: { width: 430, height: 920 },
    ...(videoEnabled ? { recordVideo: { dir: videoRawDir, size: { width: 430, height: 920 } } } : {}),
  });
  const staffPage = await staffContext.newPage();
  if (videoEnabled) staffVideo = staffPage.video();
  staffPage.on('pageerror', error => summary.page_errors.push(String(error).slice(0, 500)));
  await staffPage.goto(`${frontendUrl}/staff`, { waitUntil: 'networkidle' });
  await staffPage.locator('label:has-text("工号") input').fill(staffId);
  await staffPage.locator('label:has-text("登录码") input').fill(accessCode);
  await staffPage.getByRole('button', { name: '登录', exact: true }).click();
  await staffPage.waitForSelector('h1:has-text("我的任务")', { timeout: 15000 });
  await staffPage.waitForSelector('article.staff-order', { timeout: 20000 });

  const accept = staffPage.getByRole('button', { name: '接单', exact: true });
  if (await accept.count()) {
    await accept.first().click();
    await staffPage.waitForTimeout(800);
  }
  const begin = staffPage.getByRole('button', { name: '开始执行', exact: true });
  if (await begin.count()) {
    await begin.first().click();
    await staffPage.waitForTimeout(800);
  }
  const feedbackButton = staffPage.getByRole('button', { name: '提交反馈', exact: true });
  if (!(await feedbackButton.count())) throw new Error('工作人员页没有出现「提交反馈」按钮');
  await feedbackButton.first().click();
  await staffPage.waitForSelector('.staff-modal', { timeout: 10000 });
  await staffPage.locator('.staff-modal label:has-text("现场人数") input').fill('4200');
  await staffPage.locator('.staff-modal label:has-text("置信度") input').fill('0.95');
  await staffPage.locator('.staff-modal label:has-text("说明") textarea').fill('仿真演示：现场核查人数约 4200 人，通行正常。');
  await staffPage.waitForTimeout(400);
  await staffPage.screenshot({ path: shotPath('03-staff-feedback.png'), fullPage: false });
  summary.screenshots.push('03-staff-feedback.png');
  await staffPage.getByRole('button', { name: '提交并完成', exact: true }).click();
  await staffPage.waitForSelector('.staff-notice', { timeout: 15000 });
  summary.steps.push({ step: 'staff_feedback_submitted', ok: true, staff_id: staffId });

  await page.locator('section.sim-panel').scrollIntoViewIfNeeded();
  const resume = page.getByRole('button', { name: /继续仿真/ });
  await resume.waitFor({ state: 'visible', timeout: 15000 });
  await resume.click();
  const finished = await waitSimulation(page, status => status.finished, 30000, '仿真完成');
  await page.waitForTimeout(1800);
  // 不重新加载页面：结束时的 429 会让整页退回“无法加载场景”的加载页。
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForSelector('.cc-topbar', { timeout: 15000 });
  await page.waitForFunction(() => !document.body.innerText.includes('无法加载场景'), null, { timeout: 15000 });
  await page.waitForFunction(() => document.body.innerText.includes('常态运行'), null, { timeout: 15000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: shotPath('04-command-center-normal.png'), fullPage: false });
  summary.screenshots.push('04-command-center-normal.png');
  await page.locator('section.sim-panel').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await page.locator('section.sim-panel').screenshot({ path: shotPath('05-simulation-finished.png') });
  summary.screenshots.push('05-simulation-finished.png');
  summary.steps.push({ step: 'simulation_finished', ok: true, state: finished.state });

  // 限流会在画面里留下“请求过于频繁”的红色错误条，录制素材应视为不合格。
  summary.clean = summary.page_errors.length === 0
    && summary.console_errors.length === 0
    && summary.rate_limited === 0;
  summary.passed = summary.clean;
} catch (error) {
  summary.error = error instanceof Error ? error.message : String(error);
} finally {
  // 先关闭上下文让 Playwright 写完视频，再保存并清理原始录像。
  if (adminContext) {
    await adminContext.close().catch(() => {});
    if (videoEnabled && adminVideo) {
      try {
        await adminVideo.saveAs(path.join(outDir, 'video-admin.webm'));
        summary.video.files.push('video-admin.webm');
      } catch (error) {
        summary.video.errors.push(String(error).slice(0, 300));
      }
    }
  }
  if (staffContext) {
    await staffContext.close().catch(() => {});
    if (videoEnabled && staffVideo) {
      try {
        await staffVideo.saveAs(path.join(outDir, 'video-staff.webm'));
        summary.video.files.push('video-staff.webm');
      } catch (error) {
        summary.video.errors.push(String(error).slice(0, 300));
      }
    }
  }
  if (browser) await browser.close();
  if (videoEnabled) fs.rmSync(videoRawDir, { recursive: true, force: true });
  fs.writeFileSync(path.join(outDir, 'CAPTURE.json'), `${JSON.stringify(summary, null, 2)}\n`);
}

console.log(JSON.stringify(summary, null, 2));
process.exit(summary.passed ? 0 : 1);
