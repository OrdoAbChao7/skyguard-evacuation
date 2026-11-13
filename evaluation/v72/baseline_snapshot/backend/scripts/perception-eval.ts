/**
 * 人群计数/定位评测 CLI（不附带数据集与模型）。
 *
 *   npx tsx scripts/perception-eval.ts --gt gt.json --pred pred.json --radius 8 --out result.json
 *
 * 输入 JSON：
 * { "provenance": "...", "samples": [{ "image": "...", "ground_truth_points": [...],
 *   "predicted_points": [...], "ground_truth_count": 10, "predicted_count": 9 }] }
 */
import fs from 'node:fs';
import path from 'node:path';
import { evaluateDataset, type DatasetSample } from '../src/services/perception/metrics';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const gtPath = arg('gt');
const predPath = arg('pred');
const radius = Number(arg('radius') ?? 8);
const outPath = arg('out');

if (!gtPath || !predPath) {
  console.error('用法：tsx scripts/perception-eval.ts --gt gt.json --pred pred.json [--radius 8] [--out result.json]');
  process.exit(1);
}

const groundTruth = JSON.parse(fs.readFileSync(path.resolve(gtPath), 'utf8')) as { provenance?: string; samples: Array<{ image: string; points: Array<{ x: number; y: number }>; count?: number }> };
const predictions = JSON.parse(fs.readFileSync(path.resolve(predPath), 'utf8')) as { samples: Array<{ image: string; points: Array<{ x: number; y: number }>; count?: number }> };
const predictedByImage = new Map(predictions.samples.map(sample => [sample.image, sample]));

const samples: DatasetSample[] = groundTruth.samples.map(sample => {
  const predicted = predictedByImage.get(sample.image) ?? { points: [], count: 0 };
  return {
    image: sample.image,
    ground_truth_points: sample.points,
    predicted_points: predicted.points,
    ground_truth_count: sample.count,
    predicted_count: predicted.count,
  };
});

const result = evaluateDataset(samples, Number.isFinite(radius) ? radius : 8, groundTruth.provenance ?? 'unspecified');
const json = JSON.stringify(result, null, 2);
if (outPath) {
  fs.writeFileSync(path.resolve(outPath), `${json}\n`);
  console.log(`[perception] 写入 ${outPath}`);
} else {
  console.log(json);
}
