/** 安全加固回归：限流、可选读鉴权、CORS 与错误脱敏。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { jsonBody, startTestServer } from '../helpers/api-fixtures';
import { resetRateLimiterForTests } from '../../src/config/security';

const ENV_KEYS = ['RATE_LIMIT_MAX', 'RATE_LIMIT_WINDOW_MS', 'READ_AUTH_REQUIRED', 'CORS_ORIGINS', 'NODE_ENV'];
const saved: Record<string, string | undefined> = {};

function saveEnv(): void {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

test('限流：超过阈值返回 429 与 Retry-After', async () => {
  saveEnv();
  resetRateLimiterForTests();
  process.env.RATE_LIMIT_MAX = '2';
  process.env.RATE_LIMIT_WINDOW_MS = '60000';
  const server = await startTestServer();
  try {
    const first = await server.request('/api/v1/mvp/scenario');
    const second = await server.request('/api/v1/mvp/scenario');
    const third = await server.request('/api/v1/mvp/scenario');
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(third.status, 429);
    assert.equal(third.body.error.code, 'RATE_LIMITED');
    assert.ok(third.headers.get('retry-after'));
  } finally {
    await server.close();
    restoreEnv();
    resetRateLimiterForTests();
  }
});

test('可选读鉴权：开启后未登录读取 API 返回 401', async () => {
  saveEnv();
  resetRateLimiterForTests();
  process.env.READ_AUTH_REQUIRED = 'true';
  const server = await startTestServer();
  try {
    const anonymous = await server.request('/api/v1/mvp/scenario');
    assert.equal(anonymous.status, 401);

    const login = await server.request('/api/v1/auth/login', jsonBody({
      username: process.env.SKYGUARD_ADMIN_USERNAME || 'admin',
      password: process.env.SKYGUARD_ADMIN_PASSWORD || 'skyguard2026',
    }));
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const authorized = await server.request('/api/v1/mvp/scenario', {
      headers: { Authorization: `Bearer ${login.body.access_token}` },
    });
    assert.equal(authorized.status, 200);
  } finally {
    await server.close();
    restoreEnv();
    resetRateLimiterForTests();
  }
});

test('CORS 允许来源可配置', async () => {
  saveEnv();
  resetRateLimiterForTests();
  process.env.CORS_ORIGINS = 'https://example.com';
  const server = await startTestServer();
  try {
    const response = await server.request('/api/v1/mvp/scenario', {
      headers: { Origin: 'https://example.com' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://example.com');
  } finally {
    await server.close();
    restoreEnv();
    resetRateLimiterForTests();
  }
});

test('响应包含请求 ID，便于审计关联', async () => {
  saveEnv();
  resetRateLimiterForTests();
  const server = await startTestServer();
  try {
    const response = await server.request('/api/v1/mvp/scenario', {
      headers: { 'X-Request-Id': 'req-test-001' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-request-id'), 'req-test-001');
  } finally {
    await server.close();
    restoreEnv();
    resetRateLimiterForTests();
  }
});
