/**
 * V7.5 Phase 6：生产工程检查（Docker/CI/负载/API 契约）。
 *
 *   npm run benchmark:v75 --prefix backend -- --only=production
 *
 * 需要后端已在 localhost:8010 运行（npm run dev:backend）。
 * Docker daemon 不可用时记录 BLOCKED，不伪造构建结果。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const RUN_ID = process.env.V75_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(__dirname, '../../evaluation/v75', RUN_ID);
const ROOT = path.resolve(__dirname, '../..');
fs.mkdirSync(OUT, { recursive: true });

function run(command: string, args: string[], timeout = 120000) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', timeout });
  return { status: result.status, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
}

async function main(): Promise<void> {
const docker = run(process.platform === 'win32' ? 'docker.exe' : 'docker', ['info', '--format', '{{.ServerVersion}}'], 20000);
const dockerfileExists = fs.existsSync(path.join(ROOT, 'Dockerfile'));
const ciYaml = run('python', ['-c', "import yaml; yaml.safe_load(open('.github/workflows/ci.yml')); print('ok')"], 20000);

const apiChecks: Array<{ path: string; status: number; ok: boolean }> = [];
for (const endpoint of ['/health', '/api/v1/safety/status', '/api/v1/safety/scenario']) {
  try {
    const response = await fetch(`http://localhost:8010${endpoint}`);
    apiChecks.push({ path: endpoint, status: response.status, ok: response.ok });
  } catch {
    apiChecks.push({ path: endpoint, status: 0, ok: false });
  }
}

async function loadTest(iterations = 100, concurrency = 10): Promise<Record<string, unknown>> {
  const latencies: number[] = [];
  let errors = 0;
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < iterations) {
      cursor += 1;
      const started = performance.now();
      try {
        const response = await fetch('http://localhost:8010/api/v1/safety/status');
        if (!response.ok) errors += 1;
      } catch {
        errors += 1;
      }
      latencies.push(performance.now() - started);
    }
  });
  await Promise.all(workers);
  latencies.sort((a, b) => a - b);
  const pick = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? 0;
  return {
    iterations,
    concurrency,
    errors,
    p50_ms: Number(pick(0.5).toFixed(3)),
    p95_ms: Number(pick(0.95).toFixed(3)),
    max_ms: Number((latencies[latencies.length - 1] ?? 0).toFixed(3)),
  };
}
const load = await loadTest();

const evidence = {
  generated_at: new Date().toISOString(),
  run_id: RUN_ID,
  host: { platform: process.platform, arch: process.arch, node: process.version, cpus: os.cpus().length },
  docker: {
    status: docker.status === 0 ? 'available' : 'blocked',
    server_version: docker.status === 0 ? docker.stdout : null,
    dockerfile_exists: dockerfileExists,
    build_attempted: false,
    note: docker.status === 0
      ? 'Docker daemon available; build not run in this check.'
      : 'Docker daemon 不可用；未执行 docker build，不得声称镜像已验证。',
  },
  ci: {
    workflow_exists: fs.existsSync(path.join(ROOT, '.github/workflows/ci.yml')),
    yaml_parse: ciYaml.status === 0 ? 'ok' : 'failed',
    stderr: ciYaml.stderr.slice(0, 500),
  },
  api_contract: apiChecks,
  load_test: load,
  browser_e2e: {
    script: 'frontend/e2e/smoke.mjs',
    status: 'see browser_e2e.json',
    note: '登录 → 指挥中心 → 代理 API；需要 dev servers 与 Playwright。',
  },
  boundaries: [
    'Docker daemon 未运行；镜像/容器部署未验证。',
    '负载测试为单机本地状态端点，不代表真实并发或疏散规划吞吐。',
    '浏览器 E2E 只覆盖冒烟路径，不覆盖全部业务写操作。',
  ],
};
fs.writeFileSync(path.join(OUT, 'production_checks.json'), `${JSON.stringify(evidence, null, 2)}\n`);

const report = `# V7.5 生产工程检查

> 运行 ID：\`${RUN_ID}\`。

## 1. Docker

- Dockerfile：${dockerfileExists}
- Daemon：${evidence.docker.status}${evidence.docker.server_version ? ` (${evidence.docker.server_version})` : ''}
- 说明：${evidence.docker.note}

## 2. CI

- Workflow 存在：${evidence.ci.workflow_exists}
- YAML 解析：${evidence.ci.yaml_parse}

## 3. API 契约

| 路径 | HTTP | 通过 |
| --- | --- | --- |
${apiChecks.map(item => `| ${item.path} | ${item.status} | ${item.ok} |`).join('\n')}

## 4. 负载（本地状态端点）

- ${load.iterations} 次 / 并发 ${load.concurrency}；错误 ${load.errors}
- p50 ${load.p50_ms}ms，p95 ${load.p95_ms}ms，max ${load.max_ms}ms

## 5. 浏览器 E2E

- 脚本：\`frontend/e2e/smoke.mjs\`
- 结果：见 \`browser_e2e.json\`（登录、指挥中心、代理 API）

## 6. 边界

- Docker daemon 不可用：镜像/容器未验证；
- 负载为本地单机状态端点，不代表真实并发；
- E2E 只覆盖冒烟路径。
`;
fs.writeFileSync(path.join(OUT, 'production_checks_README.md'), report);
const files = fs.readdirSync(OUT).filter(name => name.startsWith('production_checks')).sort();
const manifest = files.map(name => {
  const bytes = fs.readFileSync(path.join(OUT, name));
  return { path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
});
fs.writeFileSync(path.join(OUT, 'production_checks_MANIFEST.json'), `${JSON.stringify({ version: 1, run_id: RUN_ID, note: 'V7.5 生产工程检查。', file_count: manifest.length, files: manifest }, null, 2)}\n`);

console.log(`V7.5 production checks complete: evaluation/v75/${RUN_ID}/`);
console.log(`docker=${evidence.docker.status} ci=${evidence.ci.yaml_parse} api=${apiChecks.filter(item => item.ok).length}/${apiChecks.length} p95=${load.p95_ms}ms`);
}

main().catch(error => { console.error(error); process.exit(1); });
