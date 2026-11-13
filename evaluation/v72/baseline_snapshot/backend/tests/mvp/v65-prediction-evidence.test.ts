import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const EVAL = path.resolve(__dirname, '../../../evaluation/v65');
const LATEST = path.join(EVAL, 'LATEST.txt');

interface Row {
  seed: number;
  origin: number;
  mechanism: string;
  method: string;
  abs_error: number;
  squared_error: number;
  actual: number;
  covered90: boolean;
  covered95: boolean;
  width: number;
  reliability_failed: boolean;
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

test('V6.5 预测证据独立清单与指标可复算', () => {
  assert.equal(fs.existsSync(LATEST), true, '缺少 evaluation/v65/LATEST.txt');
  const runId = fs.readFileSync(LATEST, 'utf8').trim();
  const dir = path.join(EVAL, runId);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'MANIFEST.json'), 'utf8')) as {
    file_count: number;
    files: Array<{ path: string; bytes: number; sha256: string }>;
  };
  assert.equal(manifest.file_count, manifest.files.length);
  for (const file of manifest.files) {
    const full = path.join(dir, file.path);
    assert.equal(fs.existsSync(full), true, `清单文件缺失: ${file.path}`);
    const bytes = fs.readFileSync(full);
    assert.equal(bytes.length, file.bytes, `大小不一致: ${file.path}`);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), file.sha256, `哈希不一致: ${file.path}`);
  }

  const result = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')) as {
    summary: Record<string, Record<string, { aggregate: {
      n: number; mae: number; rmse: number; nae: number;
      coverage90: number; coverage95: number; mean_width: number; failure_rate: number;
    } }>>;
    paired: Record<string, { adaptive_minus_baseline_abs_error: { mean: number }; n_pairs: number }>;
    raw: Row[];
  };
  const rows = JSON.parse(fs.readFileSync(path.join(dir, 'rows.json'), 'utf8')) as Row[];

  for (const [mechanism, methods] of Object.entries(result.summary)) {
    for (const [method, summary] of Object.entries(methods)) {
      const subset = rows.filter(row => row.mechanism === mechanism && row.method === method);
      const aggregate = summary.aggregate;
      assert.equal(aggregate.n, subset.length, `${mechanism}/${method} n 不一致`);
      assert.ok(Math.abs(aggregate.mae - mean(subset.map(row => row.abs_error))) <= 5e-4, `${mechanism}/${method} MAE`);
      assert.ok(Math.abs(aggregate.rmse - Math.sqrt(mean(subset.map(row => row.squared_error)))) <= 5e-4, `${mechanism}/${method} RMSE`);
      assert.ok(Math.abs(aggregate.nae - subset.reduce((sum, row) => sum + row.abs_error, 0) / Math.max(1, subset.reduce((sum, row) => sum + row.actual, 0))) <= 5e-4, `${mechanism}/${method} NAE`);
      assert.ok(Math.abs(aggregate.coverage90 - subset.filter(row => row.covered90).length / subset.length) <= 5e-4, `${mechanism}/${method} c90`);
      assert.ok(Math.abs(aggregate.coverage95 - subset.filter(row => row.covered95).length / subset.length) <= 5e-4, `${mechanism}/${method} c95`);
      assert.ok(Math.abs(aggregate.mean_width - mean(subset.map(row => row.width))) <= 5e-4, `${mechanism}/${method} width`);
      assert.ok(Math.abs(aggregate.failure_rate - subset.filter(row => row.reliability_failed).length / subset.length) <= 5e-4, `${mechanism}/${method} failure`);
    }
  }

  const adaptive = rows.filter(row => row.method === 'adaptive');
  const baselines = new Map(rows.filter(row => row.method !== 'adaptive').map(row =>
    [`${row.mechanism}|${row.method}|${row.seed}|${row.origin}`, row]));
  const baseline = 'persistence';
  const pairedDiffs: number[] = [];
  for (const row of adaptive) {
    const key = `${row.mechanism}|${baseline}|${row.seed}|${row.origin}`;
    const other = baselines.get(key);
    if (other) pairedDiffs.push(row.abs_error - other.abs_error);
  }
  assert.equal(result.paired[baseline].n_pairs, pairedDiffs.length);
  assert.ok(Math.abs(result.paired[baseline].adaptive_minus_baseline_abs_error.mean - mean(pairedDiffs)) <= 5e-4);
});
