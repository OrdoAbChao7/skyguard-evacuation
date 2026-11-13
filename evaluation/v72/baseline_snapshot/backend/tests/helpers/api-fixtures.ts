/** SkyGuard HTTP 测试服务器夹具（独立 DATA_ROOT，不触碰仓库数据）。 */
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type TestServer = {
  dataRoot: string;
  baseUrl: string;
  request: (endpoint: string, init?: RequestInit) => Promise<{ status: number; headers: Headers; body: any; rawBody: Uint8Array }>;
  close: () => Promise<void>;
};

export async function startTestServer(): Promise<TestServer> {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skyguard-api-test-'));
  process.env.DATA_ROOT = dataRoot;

  const { createApp } = await import('../../src/app');
  const server: Server = createServer(createApp());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not expose a port');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    dataRoot,
    baseUrl,
    request: async (endpoint: string, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set('Connection', 'close');
      const response = await fetch(`${baseUrl}${endpoint}`, { ...init, headers });
      const contentType = response.headers.get('content-type') || '';
      const rawBody = new Uint8Array(await response.arrayBuffer());
      const body = contentType.includes('application/json')
        ? JSON.parse(new TextDecoder().decode(rawBody))
        : new TextDecoder().decode(rawBody);
      return { status: response.status, headers: response.headers, body, rawBody };
    },
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(dataRoot, { recursive: true, force: true });
      delete process.env.DATA_ROOT;
    },
  };
}

export function jsonBody(value: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  };
}
