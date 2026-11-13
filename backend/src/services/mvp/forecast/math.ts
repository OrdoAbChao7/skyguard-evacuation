import type { SeriesPoint } from './types';

export const mean = (values: number[]): number => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);

export function std(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
}

export function clamp(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, value));
}

export function sorted(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

export function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const ordered = sorted(values);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.floor(ordered.length * q)))];
}

export function conformalQuantile(errors: number[], level: number): number | null {
  if (errors.length === 0) return null;
  const ordered = sorted(errors);
  const rank = Math.ceil((ordered.length + 1) * level);
  const index = Math.min(ordered.length - 1, Math.max(0, rank - 1));
  return ordered[index];
}

export function linearFit(points: SeriesPoint[]): { slope: number; intercept: number } {
  if (points.length < 2) {
    const value = points[0]?.y ?? 0;
    return { slope: 0, intercept: value };
  }
  const meanX = mean(points.map(point => point.x));
  const meanY = mean(points.map(point => point.y));
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    numerator += (point.x - meanX) * (point.y - meanY);
    denominator += (point.x - meanX) ** 2;
  }
  const slope = denominator === 0 ? 0 : numerator / denominator;
  return { slope, intercept: meanY - slope * meanX };
}

export function residualStdPoints(points: SeriesPoint[]): number {
  if (points.length < 3) return Math.max(1, std(points.map(point => point.y)));
  const { slope, intercept } = linearFit(points);
  const residuals = points.map(point => point.y - (intercept + slope * point.x));
  return Math.sqrt(residuals.reduce((sum, value) => sum + value ** 2, 0) / Math.max(1, points.length - 2));
}

export function regularize(points: SeriesPoint[]): SeriesPoint[] {
  if (points.length < 2) return points;
  const byX = new Map<number, number>();
  for (const point of points) {
    byX.set(Math.round(point.x), (byX.get(Math.round(point.x)) ?? 0) + point.y);
  }
  const first = Math.round(points[0].x);
  const last = Math.round(points[points.length - 1].x);
  const grid: SeriesPoint[] = [];
  let cursor = first;
  let lastKnown: number | null = null;
  const nextKnownX = (x: number): number | null => {
    for (let candidate = x + 1; candidate <= last; candidate += 1) {
      if (byX.has(candidate)) return candidate;
    }
    return null;
  };
  while (cursor <= last) {
    if (byX.has(cursor)) {
      lastKnown = byX.get(cursor)!;
      grid.push({ x: cursor - first, y: lastKnown });
    } else if (lastKnown !== null) {
      const nextX = nextKnownX(cursor);
      const nextY = nextX === null ? lastKnown : byX.get(nextX)!;
      const ratio = nextX === null ? 0 : (cursor - (cursor - 1)) / (nextX - (cursor - 1));
      grid.push({ x: cursor - first, y: lastKnown + (nextY - lastKnown) * ratio });
    }
    cursor += 1;
  }
  return grid;
}
