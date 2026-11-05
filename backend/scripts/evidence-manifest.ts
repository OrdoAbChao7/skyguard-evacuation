/**
 * 证据清单与完整性校验。
 *
 *   tsx scripts/evidence-manifest.ts            # 生成 evaluation/MANIFEST.json + DATA_MANIFEST.md
 *   tsx scripts/evidence-manifest.ts --verify   # 校验现有文件大小与 SHA-256
 *
 * 不删除/覆盖任何原始数据；只读取并记录。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(__dirname, '../..');
const EVAL = path.join(ROOT, 'evaluation');
const MANIFEST = path.join(EVAL, 'MANIFEST.json');
const verifyOnly = process.argv.includes('--verify');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function category(relative: string): 'raw' | 'summary' | 'report' {
  if (relative.endsWith('REPORT.md') || relative.endsWith('REPORT.md'.toLowerCase())) return 'report';
  if (/experiment.*\.json$/.test(relative) || relative.endsWith('performance.json')) return 'raw';
  return 'summary';
}

function generator(relative: string): string {
  if (relative.includes('v61/')) return 'backend/scripts/v61-benchmark.ts';
  if (relative.includes('v6/')) return 'backend/scripts/v6-benchmark.ts';
  if (relative.includes('competition/')) return 'backend/scripts/competition-benchmark.ts';
  if (relative.includes('mvp/')) return 'backend/scripts/mvp-experiments.ts 或 skyguard-benchmark.ts';
  return 'benchmark 脚本或人工报告（见文件头）';
}

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

const files = walk(EVAL)
  // release/ 下是测试日志与退出码，会随运行追加，不能作为被校验的原始证据。
  .filter(file => !path.relative(EVAL, file).startsWith(`release${path.sep}`))
  .filter(file => file !== MANIFEST && !file.endsWith('DATA_MANIFEST.md'))
  .map(file => {
    const relative = path.relative(EVAL, file).replaceAll('\\', '/');
    const buffer = fs.readFileSync(file);
    return {
      path: relative,
      bytes: buffer.length,
      gzip_bytes: zlib.gzipSync(buffer).length,
      sha256: sha256(buffer),
      category: category(relative),
      generator: generator(relative),
    };
  })
  .sort((a, b) => a.path.localeCompare(b.path));

const manifest = {
  version: 1,
  generated_at: new Date().toISOString(),
  git_head: execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(),
  node: process.version,
  platform: process.platform,
  note: '原始实验数据只读；重新生成会改变 generated_at 与耗时字段，统计量应保持一致。',
  file_count: files.length,
  total_bytes: files.reduce((sum, file) => sum + file.bytes, 0),
  total_gzip_bytes: files.reduce((sum, file) => sum + file.gzip_bytes, 0),
  files,
};

if (verifyOnly) {
  if (!fs.existsSync(MANIFEST)) {
    console.error('MANIFEST.json 不存在；先运行不带 --verify 的命令。');
    process.exit(1);
  }
  const previous = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as typeof manifest;
  const failures: string[] = [];
  for (const expected of previous.files) {
    const full = path.join(EVAL, expected.path);
    if (!fs.existsSync(full)) { failures.push(`missing: ${expected.path}`); continue; }
    const buffer = fs.readFileSync(full);
    if (buffer.length !== expected.bytes) failures.push(`size: ${expected.path}`);
    if (sha256(buffer) !== expected.sha256) failures.push(`sha256: ${expected.path}`);
  }
  console.log(`[manifest] verify ${previous.files.length - failures.length}/${previous.files.length} files OK`);
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
  process.exit(0);
}

fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
const lines = [
  '# 证据数据清单',
  '',
  `- 生成时间：${manifest.generated_at}`,
  `- Git：${manifest.git_head}`,
  `- 文件数：${manifest.file_count}`,
  `- 原始大小：${(manifest.total_bytes / 1024 / 1024).toFixed(2)} MiB`,
  `- gzip 估算：${(manifest.total_gzip_bytes / 1024 / 1024).toFixed(2)} MiB`,
  '',
  '> 原始数据只读；重新生成时统计量应可复算（`npm run verify:evidence --prefix backend`）。',
  '',
  '| 文件 | 层 | 大小 (KiB) | gzip (KiB) | SHA-256 | 生成脚本 |',
  '| --- | --- | --- | --- | --- | --- |',
  ...files.map(file => `| ${file.path} | ${file.category} | ${(file.bytes / 1024).toFixed(1)} | ${(file.gzip_bytes / 1024).toFixed(1)} | ${file.sha256.slice(0, 16)}… | ${file.generator} |`),
];
fs.writeFileSync(path.join(EVAL, 'DATA_MANIFEST.md'), `${lines.join('\n')}\n`);
console.log(`[manifest] ${files.length} files, ${(manifest.total_bytes / 1024 / 1024).toFixed(2)} MiB raw, ${(manifest.total_gzip_bytes / 1024 / 1024).toFixed(2)} MiB gzip`);
