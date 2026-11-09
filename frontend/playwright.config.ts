import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

const dataRoot = process.env.E2E_DATA_ROOT || path.join(os.tmpdir(), 'skyguard-e2e-data');

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:8010',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm --prefix .. start',
    url: 'http://127.0.0.1:8010/health',
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      NODE_ENV: 'test',
      PORT: '8010',
      DATA_ROOT: dataRoot,
      MVP_STATE_FILE: path.join(dataRoot, 'e2e-state.json'),
      SKYGUARD_ADMIN_USERNAME: 'admin',
      SKYGUARD_ADMIN_PASSWORD: 'e2e-strong-password',
      SKYGUARD_PYTHON: process.env.SKYGUARD_PYTHON ?? '',
    },
  },
});
