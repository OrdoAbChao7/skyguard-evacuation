/**
 * Verify the V7.5.2 SHA-256 manifest.
 *
 * Usage: npx tsx scripts/simulation/v752/verify-manifest.ts
 *
 * The manifest is text: `<sha256>  <repo-relative-path>` per line, as
 * produced by the V7.5.2 evidence build.  Any mismatch or missing file exits 1.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const MANIFEST = path.join(ROOT, 'evaluation/realworld_hankou/v752/SHA256SUMS.txt');

function main(): void {
  if (!fs.existsSync(MANIFEST)) {
    throw new Error(`manifest not found: ${MANIFEST}`);
  }
  const lines = fs.readFileSync(MANIFEST, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));
  let failures = 0;
  for (const line of lines) {
    const match = /^([a-f0-9]{64})\s{1,2}(.+)$/.exec(line);
    if (!match) {
      console.error(`malformed manifest line: ${line}`);
      failures += 1;
      continue;
    }
    const [, expected, relativePath] = match;
    const filePath = path.join(ROOT, relativePath);
    if (!fs.existsSync(filePath)) {
      console.error(`MISSING  ${relativePath}`);
      failures += 1;
      continue;
    }
    const actual = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    if (actual !== expected) {
      console.error(`MISMATCH ${relativePath}: expected ${expected}, actual ${actual}`);
      failures += 1;
    }
  }
  if (failures > 0) {
    console.error(`\n${failures} manifest check(s) failed.`);
    process.exit(1);
  }
  console.log(`OK: ${lines.length} files verified against ${path.relative(ROOT, MANIFEST)}.`);
}

main();
