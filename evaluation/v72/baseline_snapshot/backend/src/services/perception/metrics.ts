/**
 * 人群计数/定位评测工具（无模型依赖）。
 *
 * 用于接入公开数据集或现场标注后的统一评测：
 *  - 计数：MAE / RMSE / NAE；
 *  - 定位：按半径匹配的 precision / recall / F1。
 *
 * 本仓库不附带数据集与权重；没有真实标注时不得声称精度。
 */
export interface Point {
  x: number;
  y: number;
}

export interface CountPair {
  region_id: string;
  ground_truth: number;
  predicted: number;
}

export interface LocalizationResult {
  true_positives: number;
  false_positives: number;
  false_negatives: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface CountMetrics {
  n: number;
  mae: number;
  rmse: number;
  nae: number;
}

/** 贪心最近邻匹配：每个 GT 点最多匹配一个预测点，半径内匹配。 */
export function matchPoints(groundTruth: Point[], predictions: Point[], radius: number): LocalizationResult {
  // 最大基数二分匹配（Kuhn），避免贪心在学生/预测密度不均时漏配。
  const adjacency: number[][] = groundTruth.map(gt =>
    predictions
      .map((prediction, index) => ({ index, distance: Math.hypot(prediction.x - gt.x, prediction.y - gt.y) }))
      .filter(item => item.distance <= radius)
      .sort((a, b) => a.distance - b.distance)
      .map(item => item.index),
  );
  const matchedPrediction = new Array<number>(predictions.length).fill(-1);
  const tryAssign = (gtIndex: number, visited: boolean[]): boolean => {
    for (const predictionIndex of adjacency[gtIndex]) {
      if (visited[predictionIndex]) continue;
      visited[predictionIndex] = true;
      if (matchedPrediction[predictionIndex] === -1 || tryAssign(matchedPrediction[predictionIndex], visited)) {
        matchedPrediction[predictionIndex] = gtIndex;
        return true;
      }
    }
    return false;
  };
  let truePositives = 0;
  for (let gtIndex = 0; gtIndex < groundTruth.length; gtIndex += 1) {
    if (tryAssign(gtIndex, new Array<boolean>(predictions.length).fill(false))) truePositives += 1;
  }
  const falsePositives = predictions.length - truePositives;
  const falseNegatives = groundTruth.length - truePositives;
  const precision = predictions.length === 0 ? (groundTruth.length === 0 ? 1 : 0) : truePositives / predictions.length;
  const recall = groundTruth.length === 0 ? 1 : truePositives / groundTruth.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    true_positives: truePositives,
    false_positives: falsePositives,
    false_negatives: falseNegatives,
    precision: Number(precision.toFixed(4)),
    recall: Number(recall.toFixed(4)),
    f1: Number(f1.toFixed(4)),
  };
}

export function countMetrics(pairs: CountPair[]): CountMetrics {
  if (pairs.length === 0) return { n: 0, mae: 0, rmse: 0, nae: 0 };
  const absolute = pairs.map(pair => Math.abs(pair.predicted - pair.ground_truth));
  const mean = absolute.reduce((sum, value) => sum + value, 0) / pairs.length;
  const rmse = Math.sqrt(absolute.reduce((sum, value) => sum + value ** 2, 0) / pairs.length);
  const gtSum = pairs.reduce((sum, pair) => sum + pair.ground_truth, 0);
  const nae = gtSum === 0
    ? 0
    : pairs.reduce((sum, pair) => sum + Math.abs(pair.predicted - pair.ground_truth), 0) / gtSum;
  return {
    n: pairs.length,
    mae: Number(mean.toFixed(4)),
    rmse: Number(rmse.toFixed(4)),
    nae: Number(nae.toFixed(4)),
  };
}

export interface DatasetSample {
  image: string;
  ground_truth_points: Point[];
  predicted_points: Point[];
  ground_truth_count?: number;
  predicted_count?: number;
}

export interface DatasetEvaluation {
  images: number;
  count_metrics: CountMetrics;
  localization: LocalizationResult;
  radius: number;
  provenance: string;
}

export function evaluateDataset(samples: DatasetSample[], radius: number, provenance: string): DatasetEvaluation {
  const countPairs: CountPair[] = samples.map(sample => ({
    region_id: sample.image,
    ground_truth: sample.ground_truth_count ?? sample.ground_truth_points.length,
    predicted: sample.predicted_count ?? sample.predicted_points.length,
  }));
  const totals = samples.reduce((acc, sample) => {
    const result = matchPoints(sample.ground_truth_points, sample.predicted_points, radius);
    acc.tp += result.true_positives;
    acc.fp += result.false_positives;
    acc.fn += result.false_negatives;
    return acc;
  }, { tp: 0, fp: 0, fn: 0 });
  const precision = totals.tp + totals.fp === 0 ? 0 : totals.tp / (totals.tp + totals.fp);
  const recall = totals.tp + totals.fn === 0 ? 0 : totals.tp / (totals.tp + totals.fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    images: samples.length,
    count_metrics: countMetrics(countPairs),
    localization: {
      true_positives: totals.tp,
      false_positives: totals.fp,
      false_negatives: totals.fn,
      precision: Number(precision.toFixed(4)),
      recall: Number(recall.toFixed(4)),
      f1: Number(f1.toFixed(4)),
    },
    radius,
    provenance,
  };
}
