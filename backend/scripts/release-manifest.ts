/**
 * 发布级证据清单：覆盖 evaluation/ 下所有冻结证据（含 v65/voi-v2/real-data 与各目录 manifest）。
 *
 *   tsx scripts/release-manifest.ts            # 生成 evaluation/RELEASE_MANIFEST.json
 *   tsx scripts/release-manifest.ts --verify   # 只读校验
 *
 * 不修改任何原始证据；文本按 LF 归一化后计算字节与 SHA-256，保证 Windows/Linux 一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(__dirname, '../..');
const EVAL = path.join(ROOT, 'evaluation');
const OUT = path.join(EVAL, 'RELEASE_MANIFEST.json');
const verifyOnly = process.argv.includes('--verify');
const TEXT = /\.(json|jsonl|md|tsv|txt|csv|log|ps1|sha256|sums)$/i;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'release') continue;
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function normalize(buffer: Buffer, relative: string): Buffer {
  if (!TEXT.test(relative)) return buffer;
  return Buffer.from(buffer.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

function digest(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

const entries = walk(EVAL)
  .filter(file => file !== OUT)
  .map(file => {
    const relative = path.relative(EVAL, file).replaceAll('\\', '/');
    const buffer = normalize(fs.readFileSync(file), relative);
    return { path: relative, bytes: buffer.length, sha256: digest(buffer), gzip_bytes: zlib.gzipSync(buffer).length };
  })
  .sort((a, b) => a.path.localeCompare(b.path));

if (verifyOnly) {
  if (!fs.existsSync(OUT)) {
    console.error('[release-manifest] 缺少 evaluation/RELEASE_MANIFEST.json');
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(OUT, 'utf8')) as {
    file_count: number;
    files: Array<{ path: string; bytes: number; sha256: string }>;
  };
  const expected = new Map(manifest.files.map(item => [item.path, item]));
  let failed = 0;
  for (const entry of entries) {
    const record = expected.get(entry.path);
    if (!record) {
      console.error(`[release-manifest] 未登记: ${entry.path}`);
      failed += 1;
      continue;
    }
    if (record.bytes !== entry.bytes || record.sha256 !== entry.sha256) {
      console.error(`[release-manifest] 不匹配: ${entry.path}`);
      failed += 1;
    }
    expected.delete(entry.path);
  }
  for (const missing of expected.keys()) {
    console.error(`[release-manifest] 文件缺失: ${missing}`);
    failed += 1;
  }
  if (manifest.file_count !== manifest.files.length) failed += 1;
  console.log(`[release-manifest] ${manifest.files.length - failed}/${manifest.files.length} OK`);
  process.exit(failed === 0 ? 0 : 1);
}

const payload = {
  version: 1,
  generated_at: new Date().toISOString(),
  git_head: execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(),
  note: '发布级证据清单：覆盖 evaluation/ 下全部冻结证据；文本按 LF 归一化后计算。',
  file_count: entries.length,
  total_bytes: entries.reduce((sum, item) => sum + item.bytes, 0),
  files: entries,
};
fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`[release-manifest] 写入 ${entries.length} 个文件，${payload.total_bytes} bytes`);
