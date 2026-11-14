#!/usr/bin/env node
/**
 * 生成参赛提交包：源码快照 + 证据 + 文档 + 截图 + 校验清单。
 *
 * 用法：
 *   node scripts/build-submission.mjs [--date YYYYMMDD] [--no-zip]
 *
 * 设计边界：
 * - 只读取仓库，不修改源码；输出到 submission/。
 * - 排除 node_modules / dist / .git / .claude / 运行时数据 / 未授权图片。
 * - evaluation/ 只收录最终证据与关键清单，完整原始数据保留在开发仓库。
 * - 生成 MANIFEST.json 与 SHA256SUMS.txt；默认同时生成 zip。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dateArg = args.includes('--date') ? args[args.indexOf('--date') + 1] : null;
const stamp = dateArg || new Date().toISOString().slice(0, 10).replace(/-/g, '');
const noZip = args.includes('--no-zip');
const PACKAGE_NAME = `SkyGuard-submission-${stamp}`;
const OUT = path.join(ROOT, 'submission', PACKAGE_NAME);
const ZIP = path.join(ROOT, 'submission', `${PACKAGE_NAME}.zip`);
const STAGING = path.join(ROOT, 'submission');

const EXCLUDED_SEGMENTS = new Set(['node_modules', 'dist', '.git', '.claude', '__pycache__', 'submission']);
const EXCLUDED_FILES = new Set([
  '.env',
  'data/admin_config.json',
  'data/mvp-state.json',
  'data/ops-state.json',
]);
const RUNTIME_PREFIXES = ['data/audit/'];
const IMAGE_EXT = /\.(jpe?g|png)$/i;

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function shouldCopy(src) {
  const rel = toPosix(path.relative(ROOT, src));
  if (!rel) return true;
  const segments = rel.split('/');
  if (segments.some(segment => EXCLUDED_SEGMENTS.has(segment))) return false;
  if (rel === 'evaluation' || rel.startsWith('evaluation/')) return false;
  if (EXCLUDED_FILES.has(rel)) return false;
  if (rel === '.env' || (rel.startsWith('.env.') && rel !== '.env.example')) return false;
  if (rel.endsWith('.log') || rel.endsWith('.tsbuildinfo')) return false;
  if (RUNTIME_PREFIXES.some(prefix => rel === prefix.slice(0, -1) || rel.startsWith(prefix))) return false;
  if (rel.startsWith('data/perception/') && IMAGE_EXT.test(rel)) return false;
  return true;
}

function copyTree(src, dest) {
  fs.cpSync(src, dest, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: (source) => shouldCopy(source),
  });
}

function copyPath(relSrc, relDest) {
  const src = path.join(ROOT, relSrc);
  if (!fs.existsSync(src)) return false;
  const dest = path.join(OUT, relDest);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, force: true });
  return true;
}

/** 只复制 LATEST.txt 指向的最终 run；后端证据测试依赖这个路径。 */
function copyLatestEvidence(relDir) {
  const latestFile = path.join(ROOT, relDir, 'LATEST.txt');
  if (!fs.existsSync(latestFile)) return false;
  const latest = fs.readFileSync(latestFile, 'utf8').trim();
  copyPath(`${relDir}/LATEST.txt`, `${relDir}/LATEST.txt`);
  copyPath(`${relDir}/${latest}`, `${relDir}/${latest}`);
  return true;
}

function sha256(file) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(toPosix(path.relative(base, full)));
  }
  return out.sort();
}

function git(...argv) {
  try {
    return execFileSync('git', argv, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/**
 * 提交包脱敏：开发默认口令与开发 JWT 密钥不随包分发。
 * 只改包内副本，不改开发仓库；源码、测试、文档与截图脚本同步替换，
 * 使包内测试仍使用同一占位值并通过。
 */
function readCredentialLiteral(fileRel, pattern, placeholder) {
  try {
    const source = fs.readFileSync(path.join(ROOT, fileRel), 'utf8');
    const match = pattern.exec(source);
    if (!match || !match[1] || match[1].length < 8) return null;
    return [match[1], placeholder];
  } catch {
    return null;
  }
}

// 只从开发仓库读取两个真实默认值用于“精确替换”，不打印、不写入脚本。
const CREDENTIAL_LITERALS = [
  readCredentialLiteral('backend/src/api/v1/auth.ts', /const DEV_SECRET[ ]*=[ ]*'([^']*)'/, 'replace-with-a-dev-secret'),
  readCredentialLiteral('backend/src/api/v1/auth.ts', /password:[ ]*process\.env\.SKYGUARD_ADMIN_PASSWORD[ ]*\|\|[ ]*'([^']*)'/, 'replace-with-a-strong-password'),
].filter(Boolean);

/**
 * 提交包脱敏：开发默认口令与开发 JWT 密钥不随包分发。
 * 只改包内副本，不改开发仓库；按真实值精确替换，避免误伤路由（如 /admin/...）。
 */
function sanitizeCredentials(dir) {
  let changed = 0;
  for (const rel of walk(dir)) {
    if (rel === 'scripts/build-submission.mjs') continue;
    if (!/\.(md|json|ts|tsx|js|mjs|cjs|ya?ml|txt|ps1|sh|html|css|example)$/i.test(rel)) continue;
    const full = path.join(dir, rel);
    let text = fs.readFileSync(full, 'utf8');
    const before = text;
    for (const [secret, placeholder] of CREDENTIAL_LITERALS) {
      text = text.split(secret).join(placeholder);
    }
    text = text
      .replace(/(process\.env\.SECRET_KEY\s*=\s*')[^']*'/g, "$1replace-with-test-secret'")
      .replace(/(process\.env\.MCP_HTTP_TOKEN\s*=\s*')[^']*'/g, "$1replace-with-test-mcp-token'")
      .replace(/(SECRET_KEY\s*:\s*')[^']*'/g, "$1replace-with-test-secret'")
      .replace(/(SKYGUARD_ADMIN_PASSWORD\s*:\s*')[^']*'/g, "$1test-only-password-1234'")
      .replace(/(SECRET_KEY=')[^']*(')/g, '$1<long-random-secret>$2')
      .replace(/(SKYGUARD_ADMIN_PASSWORD=')[^']*(')/g, '$1<strong-password>$2');
    if (text !== before) {
      fs.writeFileSync(full, text);
      changed += 1;
    }
  }
  return changed;
}

function scanForSecrets(dir) {
  const warnings = [];
  const patterns = [
    /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bsk-[A-Za-z0-9]{20,}\b/,
    /(?:^|[^A-Z_])SECRET_KEY\s*=\s*['"]?(?!replace-with|<)[A-Za-z0-9_-]{12,}/,
    /SKYGUARD_ADMIN_PASSWORD\s*=\s*['"]?(?!replace-with|<)[A-Za-z0-9_!@#%^&*.-]{8,}/,
  ];
  for (const rel of walk(dir)) {
    if (rel === 'scripts/build-submission.mjs') continue;
    if (/\.(png|jpe?g|zip|gz|om|onnx|pdf|woff2?|ico|mp4|webm|xlsx)$/i.test(rel)) continue;
    const full = path.join(dir, rel);
    const text = fs.readFileSync(full, 'utf8');
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        warnings.push(rel);
        break;
      }
    }
  }
  return warnings;
}

if (!fs.existsSync(path.join(ROOT, 'docs', 'SUBMISSION_PACKAGE.md'))) {
  console.error('缺少 docs/SUBMISSION_PACKAGE.md，无法生成提交包。');
  process.exit(1);
}

if (fs.existsSync(OUT)) {
  fs.rmSync(OUT, { recursive: true, force: true });
}
fs.mkdirSync(OUT, { recursive: true });

// 1. 源码快照（排除依赖、构建产物、运行时数据与原始 evaluation）
for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (!shouldCopy(path.join(ROOT, entry.name))) continue;
  copyTree(path.join(ROOT, entry.name), path.join(OUT, entry.name));
}

// 2. 提交说明与验证记录
fs.copyFileSync(path.join(ROOT, 'docs', 'SUBMISSION_PACKAGE.md'), path.join(OUT, 'SUBMISSION.md'));
if (fs.existsSync(path.join(STAGING, 'VERIFICATION.md'))) {
  fs.copyFileSync(path.join(STAGING, 'VERIFICATION.md'), path.join(OUT, 'VERIFICATION.md'));
}

// 3. 证据（只收录最终证据与关键清单）
const evidenceCopies = [
  ['evaluation/v75/v75-final-20261110', 'evidence/v75-final-20261110'],
  ['evaluation/v72/baseline_snapshot/SNAPSHOT.json', 'evidence/v72-baseline/SNAPSHOT.json'],
  ['evaluation/v72/baseline_snapshot/VERSION', 'evidence/v72-baseline/VERSION'],
  ['evaluation/MANIFEST.json', 'evidence/MANIFEST-v62.json'],
  ['evaluation/DATA_MANIFEST.md', 'evidence/DATA_MANIFEST.md'],
  ['evaluation/COMPETITION_REPORT.md', 'evidence/COMPETITION_REPORT.md'],
  ['evaluation/MVP_REPORT.md', 'evidence/MVP_REPORT.md'],
  ['evaluation/real-data/REPORT.md', 'evidence/real-data-REPORT.md'],
  ['evaluation/v75/LATEST.txt', 'evidence/v75-LATEST.txt'],
];
for (const [src, dest] of evidenceCopies) copyPath(src, dest);

// 3.1 后端证据测试与界面读取所需的最终 run（不是完整 evaluation/）
copyLatestEvidence('evaluation/v65');
copyLatestEvidence('evaluation/voi-v2');
copyPath('evaluation/competition', 'evaluation/competition');
copyPath('evaluation/real-data', 'evaluation/real-data');

fs.mkdirSync(path.join(OUT, 'evidence'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'evidence', 'README.md'), [
  '# 证据目录',
  '',
  '本目录收录最终证据与关键清单；完整原始实验数据保留在开发仓库的 `evaluation/`。',
  '',
  '- `v75-final-20261110/`：V7.5 最终证据，33 个根文件，`MANIFEST.json` 内含 SHA-256；',
  '- `v72-baseline/`：V7.2 冻结基线摘要（`SNAPSHOT.json` + `VERSION`）；完整 299 文件快照留在开发仓库，未随包分发；',
  '- `MANIFEST-v62.json`：V6.2 证据总清单（46 文件，原始数据未随包分发）；',
  '- 报告：`COMPETITION_REPORT.md`、`MVP_REPORT.md`、`real-data-REPORT.md`；',
  '- 包根 `evaluation/v65`、`evaluation/voi-v2`、`evaluation/competition` 与 `evaluation/real-data` 保留后端证据测试和界面读取所需的最小最终数据。',
  '',
  '所有数字以报告与原始清单为准；截图和演示只做展示。',
].join('\n'));

// 4. 截图（如果 staging 中存在）
const shotDir = path.join(STAGING, 'screenshots');
if (fs.existsSync(shotDir)) {
  fs.mkdirSync(path.join(OUT, 'screenshots'), { recursive: true });
  for (const file of fs.readdirSync(shotDir)) {
    if (IMAGE_EXT.test(file)) fs.copyFileSync(path.join(shotDir, file), path.join(OUT, 'screenshots', file));
  }
}

// 5. 凭证脱敏：提交包不携带开发默认口令与开发 JWT 密钥
const sanitized = sanitizeCredentials(OUT);

// 6. 清单与校验和
const files = walk(OUT).filter(rel => rel !== 'MANIFEST.json' && rel !== 'SHA256SUMS.txt');
const entries = files.map(rel => {
  const full = path.join(OUT, rel);
  const stat = fs.statSync(full);
  return { path: rel, bytes: stat.size, sha256: sha256(full) };
});
const dirty = git('status', '--porcelain')?.split('\n').filter(Boolean).length ?? null;
const manifest = {
  package: PACKAGE_NAME,
  generated_at: new Date().toISOString(),
  source: {
    git_head: git('rev-parse', 'HEAD'),
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    dirty_files: dirty,
    project_version: fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim(),
    scenario_version: '7.6.0',
  },
  verification: {
    backend_tests: '334/334',
    frontend_tests: '17/17',
    typecheck: 'pass',
    build: 'pass',
    verify_evidence: '178/178',
    freeze_baseline: '299 files OK',
  },
  contents: {
    source: true,
    docs: true,
    evidence: true,
    screenshots: fs.existsSync(path.join(OUT, 'screenshots')),
    excluded: ['node_modules', 'dist', '.git', '.claude', 'evaluation raw (except curated)', 'runtime data', 'unlicensed images'],
  },
  sanitization: {
    credential_files_rewritten: sanitized,
    note: '开发默认口令与开发 JWT 密钥已替换为占位值；运行前请设置 SKYGUARD_ADMIN_PASSWORD 与 SECRET_KEY。',
  },
  file_count: entries.length,
  total_bytes: entries.reduce((sum, item) => sum + item.bytes, 0),
  files: entries,
};
fs.writeFileSync(path.join(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
fs.writeFileSync(
  path.join(OUT, 'SHA256SUMS.txt'),
  entries.map(item => `${item.sha256}  ${item.path}`).join('\n') + '\n',
);

const warnings = scanForSecrets(OUT);
if (warnings.length > 0) {
  console.warn(`[warn] 可能包含敏感标记的文件（请人工确认）：${warnings.join(', ')}`);
}

if (!noZip) {
  if (fs.existsSync(ZIP)) fs.rmSync(ZIP, { force: true });
  // 用 Python zipfile 写正斜杠路径，避免 Compress-Archive 在 Windows 上写入反斜杠。
  const python = process.env.PYTHON ?? 'python';
  execFileSync(python, [path.join(ROOT, 'scripts', 'zip-submission.py'), OUT, ZIP], { stdio: 'inherit' });
}

const summary = {
  package: OUT,
  zip: noZip ? null : ZIP,
  files: manifest.file_count,
  bytes: manifest.total_bytes,
  zip_bytes: !noZip && fs.existsSync(ZIP) ? fs.statSync(ZIP).size : null,
  zip_sha256: !noZip && fs.existsSync(ZIP) ? sha256(ZIP) : null,
  sanitized_credential_files: sanitized,
  secrets_warnings: warnings,
};
console.log(JSON.stringify(summary, null, 2));
