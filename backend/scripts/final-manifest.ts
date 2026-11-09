/** evaluation/final 实验证据清单（逐文件 SHA-256，文本按 LF 归一化）。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(__dirname, '../..');
const EVAL = path.join(ROOT, 'evaluation/final');
const OUT = path.join(EVAL, 'MANIFEST.json');
const verifyOnly = process.argv.includes('--verify');
const TEXT = /\.(json|jsonl|md|tsv|txt|csv|log)$/i;

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function normalized(file: string, relative: string): Buffer {
  const buffer = fs.readFileSync(file);
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
    const buffer = normalized(file, relative);
    return { path: relative, bytes: buffer.length, sha256: digest(buffer), gzip_bytes: zlib.gzipSync(buffer).length };
  })
  .sort((a, b) => a.path.localeCompare(b.path));

if (verifyOnly) {
  if (!fs.existsSync(OUT)) {
    console.error('[final-manifest] 缺少 evaluation/final/MANIFEST.json');
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
    if (!record || record.bytes !== entry.bytes || record.sha256 !== entry.sha256) {
      console.error(`[final-manifest] 不匹配: ${entry.path}`);
      failed += 1;
    }
    expected.delete(entry.path);
  }
  for (const missing of expected.keys()) {
    console.error(`[final-manifest] 文件缺失: ${missing}`);
    failed += 1;
  }
  if (manifest.file_count !== manifest.files.length) failed += 1;
  console.log(`[final-manifest] ${manifest.files.length - failed}/${manifest.files.length} OK`);
  process.exit(failed === 0 ? 0 : 1);
}

fs.mkdirSync(EVAL, { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify({
  version: 1,
  generated_at: new Date().toISOString(),
  git_head: execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(),
  note: '研发总攻阶段新增实验证据；不覆盖 V6.1/V6.2/V6.4/V6.5 冻结目录。',
  file_count: entries.length,
  total_bytes: entries.reduce((sum, item) => sum + item.bytes, 0),
  files: entries,
}, null, 2)}\n`);
console.log(`[final-manifest] 写入 ${entries.length} 个文件`);
