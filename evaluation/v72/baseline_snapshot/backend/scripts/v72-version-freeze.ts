/**
 * SkyGuard V7.2 版本冻结（version freeze）。
 *
 *   npx tsx scripts/v72-version-freeze.ts --write    # 生成冻结清单
 *   npx tsx scripts/v72-version-freeze.ts --verify   # 校验冻结清单
 *   npm run freeze:v72 --prefix backend
 *   npm run freeze:verify --prefix backend
 *
 * 冻结内容：源码、测试、脚本、依赖锁、场景/场馆数据、V7.1/V7.2 最终证据、核心文档与 CI 配置。
 * 不包含：node_modules、dist、__pycache__、开发中间运行目录、LATEST 指针、冻结产物自身。
 * 冻结后任何改动都应提升 VERSION 并重新生成清单；校验失败不得直接重写清单。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(__dirname, '../..');
const VERSION_FILE = path.join(ROOT, 'VERSION');
const FREEZE_PATH = path.join(ROOT, 'evaluation/v72/freeze_v72.json');
const BASELINE_PATH = path.join(ROOT, 'evaluation/v72/BASELINE_SHA256');
const SUMS_PATH = path.join(ROOT, 'evaluation/v72/SHA256SUMS');
const V71_RUN = 'v71-final-20261109T211702';
const V72_LATEST = path.join(ROOT, 'evaluation/v72/LATEST.txt');

const EXCLUDED_SEGMENTS = new Set(['node_modules', 'dist', '.git', '__pycache__', '.pytest_cache']);
const EXCLUDED_PATHS = new Set([
  'evaluation/v72/freeze_v72.json',
  'evaluation/v72/BASELINE_SHA256',
  'evaluation/v72/SHA256SUMS',
  'evaluation/v72/LATEST.txt',
  'evaluation/v71/LATEST.txt',
]);

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function isExcluded(relative: string): boolean {
  if (EXCLUDED_PATHS.has(relative)) return true;
  const segments = relative.split('/');
  if (segments.some(segment => EXCLUDED_SEGMENTS.has(segment))) return true;
  return relative.endsWith('.pyc') || relative.endsWith('.tsbuildinfo');
}

function walk(relative: string, out: string[]): void {
  const full = path.join(ROOT, relative);
  if (!fs.existsSync(full)) return;
  const stat = fs.statSync(full);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(full).sort()) {
      walk(toPosix(path.join(relative, name)), out);
    }
    return;
  }
  if (!stat.isFile()) return;
  if (isExcluded(relative)) return;
  out.push(relative);
}

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function normalizedHashes(bytes: Buffer): string[] {
  const LF = String.fromCharCode(10);
  const CRLF = String.fromCharCode(13, 10);
  const text = bytes.toString('utf8');
  const lfText = text.split(CRLF).join(LF);
  const crlfText = lfText.split(LF).join(CRLF);
  return [sha256(bytes), sha256(Buffer.from(lfText, 'utf8')), sha256(Buffer.from(crlfText, 'utf8'))];
}

function git(command: string): string {
  try {
    return execSync(command, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function worktreeStatus(): { staged: number; unstaged: number; untracked_entries: number; status_entries: number } {
  const output = git('git status --porcelain');
  const lines = output ? output.split(/\r?\n/).filter(Boolean) : [];
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const line of lines) {
    if (line.startsWith('??')) {
      untracked += 1;
      continue;
    }
    if (line[0] && line[0] !== ' ') staged += 1;
    if (line[1] && line[1] !== ' ') unstaged += 1;
  }
  return { staged, unstaged, untracked_entries: untracked, status_entries: lines.length };
}

function scopeEntries(frozenRunId: string): string[] {
  return [
    'VERSION',
    'AGENTS.md',
    'CLAUDE.md',
    'README.md',
    'V7.1_INDEPENDENT_AUDIT.md',
    'V7.2_INDEPENDENT_AUDIT.md',
    '.github/workflows/ci.yml',
    'backend/package.json',
    'backend/package-lock.json',
    'backend/tsconfig.json',
    'backend/src',
    'backend/scripts',
    'backend/tests',
    'backend/python',
    'frontend/index.html',
    'frontend/package.json',
    'frontend/package-lock.json',
    'frontend/tsconfig.json',
    'frontend/vite.config.ts',
    'frontend/vitest.config.ts',
    'frontend/src',
    'data/scenarios',
    'data/venues',
    'docs',
    'research',
    'evaluation/v72/README.md',
    `evaluation/v72/${frozenRunId}`,
    'evaluation/v71/README.md',
    `evaluation/v71/${V71_RUN}`,
  ];
}

function collect(scope: string[]): Map<string, { bytes: number; sha256: string; buffer: Buffer }> {
  const paths: string[] = [];
  for (const entry of scope) walk(entry, paths);
  const unique = [...new Set(paths)].sort();
  const result = new Map<string, { bytes: number; sha256: string; buffer: Buffer }>();
  for (const relative of unique) {
    const buffer = fs.readFileSync(path.join(ROOT, relative));
    result.set(relative, { bytes: buffer.length, sha256: sha256(buffer), buffer });
  }
  return result;
}

function writeFreeze(): void {
  const projectVersion = fs.readFileSync(VERSION_FILE, 'utf8').trim();
  const frozenRunId = fs.existsSync(V72_LATEST) ? fs.readFileSync(V72_LATEST, 'utf8').trim() : '';
  if (!frozenRunId || !fs.existsSync(path.join(ROOT, 'evaluation/v72', frozenRunId, 'MANIFEST.json'))) {
    console.error('找不到 V7.2 最终证据运行（evaluation/v72/LATEST.txt 或 MANIFEST.json 缺失）');
    process.exit(1);
  }
  const scope = scopeEntries(frozenRunId);
  const files = collect(scope);
  const entries = [...files.entries()].map(([relative, value]) => ({
    path: relative,
    bytes: value.bytes,
    sha256: value.sha256,
  }));
  const totalBytes = entries.reduce((sum, item) => sum + item.bytes, 0);
  const freeze = {
    version: 1,
    project_version: projectVersion,
    frozen_at: new Date().toISOString(),
    git_head: git('git rev-parse HEAD'),
    branch: git('git branch --show-current') || 'unknown',
    worktree_status: worktreeStatus(),
    runtime: {
      node: process.version,
      npm: git('npm -v'),
      platform: process.platform,
      arch: process.arch,
      python_lock: 'backend/python/ascend/requirements-v72.lock.txt',
    },
    frozen_runs: {
      v71: `evaluation/v71/${V71_RUN}`,
      v72: `evaluation/v72/${frozenRunId}`,
    },
    scope,
    excluded: [...EXCLUDED_PATHS],
    file_count: entries.length,
    total_bytes: totalBytes,
    note: 'V7.2 source/config/evidence/docs baseline. node_modules/dist/__pycache__/LATEST pointers and freeze artifacts are excluded.',
    files: entries,
  };
  fs.writeFileSync(FREEZE_PATH, `${JSON.stringify(freeze, null, 2)}\n`);
  fs.writeFileSync(BASELINE_PATH, `${entries.map(item => `${item.sha256}  ${item.path}`).join('\n')}\n`);
  const runPrefixes = [`evaluation/v72/${frozenRunId}/`, `evaluation/v71/${V71_RUN}/`];
  const runEntries = entries.filter(item => runPrefixes.some(prefix => item.path.startsWith(prefix)));
  fs.writeFileSync(SUMS_PATH, `${runEntries.map(item => `${item.sha256}  ${item.path}`).join('\n')}\n`);

  console.log(`[freeze] version ${projectVersion}`);
  console.log(`[freeze] head ${freeze.git_head.slice(0, 8)} branch ${freeze.branch}`);
  console.log(`[freeze] files ${freeze.file_count}, bytes ${freeze.total_bytes}`);
  console.log(`[freeze] v71 run ${freeze.frozen_runs.v71}`);
  console.log(`[freeze] v72 run ${freeze.frozen_runs.v72}`);
  console.log(`[freeze] written ${path.relative(ROOT, FREEZE_PATH)}, BASELINE_SHA256, SHA256SUMS`);
}

function verifyFreeze(): void {
  if (!fs.existsSync(FREEZE_PATH)) {
    console.error(`[freeze] 缺少冻结清单：${path.relative(ROOT, FREEZE_PATH)}`);
    process.exit(1);
  }
  const freeze = JSON.parse(fs.readFileSync(FREEZE_PATH, 'utf8')) as {
    project_version: string;
    file_count: number;
    total_bytes: number;
    scope: string[];
    files: Array<{ path: string; bytes: number; sha256: string }>;
  };
  const failures: string[] = [];
  const projectVersion = fs.readFileSync(VERSION_FILE, 'utf8').trim();
  if (projectVersion !== freeze.project_version) {
    failures.push(`VERSION=${projectVersion} != frozen ${freeze.project_version}`);
  }
  let missing = 0;
  let changed = 0;
  for (const item of freeze.files) {
    const full = path.join(ROOT, item.path);
    if (!fs.existsSync(full)) {
      missing += 1;
      failures.push(`missing ${item.path}`);
      continue;
    }
    const bytes = fs.readFileSync(full);
    const matched = normalizedHashes(bytes).includes(item.sha256);
    if (bytes.length !== item.bytes || !matched) {
      changed += 1;
      failures.push(`changed ${item.path} (expected ${item.bytes}/${item.sha256.slice(0, 12)}, got ${bytes.length}/${sha256(bytes).slice(0, 12)})`);
    }
  }
  const current = collect(freeze.scope);
  const frozenPaths = new Set(freeze.files.map(item => item.path));
  const extra = [...current.keys()].filter(item => !frozenPaths.has(item));
  for (const item of extra) failures.push(`extra ${item}`);

  if (failures.length > 0) {
    console.error(`[freeze] FAILED: ${failures.length} issue(s)`);
    for (const item of failures.slice(0, 40)) console.error(` - ${item}`);
    if (failures.length > 40) console.error(` ... ${failures.length - 40} more`);
    process.exit(1);
  }
  console.log(`[freeze] OK: ${freeze.files.length} files, ${freeze.total_bytes} bytes, version ${freeze.project_version}`);
}

const mode = process.argv.includes('--verify') ? 'verify' : process.argv.includes('--write') ? 'write' : '';
if (mode === 'write') writeFreeze();
else if (mode === 'verify') verifyFreeze();
else {
  console.error('用法：v72-version-freeze.ts --write | --verify');
  process.exit(2);
}
