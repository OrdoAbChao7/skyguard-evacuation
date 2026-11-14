/**
 * 实验脚本共享工具：随机数、描述统计、区间估计、证据哈希与外部命令探测。
 *
 * 这些函数原先在 48 个 benchmark 脚本中逐份复制，行为必须与历史实验一致；
 * 参数（尤其 bootstrap 的迭代次数与种子）由调用方显式传入，不使用隐藏默认值。
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { regionDensity, regionRiskRatio } from '../../src/services/safety/planning/route-stability';
import type { SafetyScenario } from '../../src/services/safety/types';

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rng: () => number): number {
  const u = Math.max(1e-9, rng());
  const v = Math.max(1e-9, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function sampleIndex(probabilities: number[], rng: () => number): number {
  const total = probabilities.reduce((sum, value) => sum + value, 0);
  let threshold = rng() * total;
  for (let index = 0; index < probabilities.length; index += 1) {
    threshold -= probabilities[index];
    if (threshold <= 0) return index;
  }
  return probabilities.length - 1;
}

export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function std(values: number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Number(sorted[index].toFixed(3));
}

export function normalCdf(value: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(value));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const cdf = 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * value * value) * poly;
  return value >= 0 ? cdf : 1 - cdf;
}

export function pairedPValue(differences: number[]): number {
  if (differences.length < 2) return 1;
  const deviation = std(differences);
  if (deviation === 0) return mean(differences) === 0 ? 1 : 0;
  const z = Math.abs(mean(differences)) / (deviation / Math.sqrt(differences.length));
  return Math.max(0, Math.min(1, 2 * (1 - normalCdf(z))));
}

export function holm(pValues: Record<string, number>): Record<string, { raw: number; adjusted: number; rejected_0_05: boolean }> {
  const entries = Object.entries(pValues).sort((a, b) => a[1] - b[1]);
  const total = entries.length;
  const result: Record<string, { raw: number; adjusted: number; rejected_0_05: boolean }> = {};
  let previous = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const [key, value] = entries[index];
    const next = Math.min(1, Math.max(previous, (total - index) * value));
    previous = next;
    result[key] = { raw: Number(value.toFixed(6)), adjusted: Number(next.toFixed(6)), rejected_0_05: next < 0.05 };
  }
  return result;
}

export function dz(differences: number[]): number {
  return std(differences) === 0 ? 0 : Number((mean(differences) / std(differences)).toFixed(4));
}

export function bootstrap(values: number[], iterations: number, seed: number): { lower: number; upper: number } {
  const rng = mulberry32(seed);
  const stats: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let sum = 0;
    for (let index = 0; index < values.length; index += 1) sum += values[Math.floor(rng() * values.length)];
    stats.push(sum / values.length);
  }
  stats.sort((a, b) => a - b);
  return {
    lower: Number(stats[Math.floor(iterations * 0.025)].toFixed(4)),
    upper: Number(stats[Math.floor(iterations * 0.975)].toFixed(4)),
  };
}

export function clusterBootstrap(groups: number[][], iterations: number, seed: number): { lower: number; upper: number } {
  const rng = mulberry32(seed);
  const stats: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let sum = 0;
    let count = 0;
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const group = groups[Math.floor(rng() * groups.length)];
      for (let index = 0; index < group.length; index += 1) {
        sum += group[Math.floor(rng() * group.length)];
        count += 1;
      }
    }
    stats.push(sum / count);
  }
  stats.sort((a, b) => a - b);
  return {
    lower: Number(stats[Math.floor(iterations * 0.025)].toFixed(4)),
    upper: Number(stats[Math.floor(iterations * 0.975)].toFixed(4)),
  };
}

export function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function sha256File(filePath: string): string {
  return sha256(fs.readFileSync(filePath));
}

export function commandAvailable(command: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function which(command: string): { available: boolean; path: string | null } {
  try {
    const output = execFileSync(process.platform === 'win32' ? 'where' : 'which', [command], { encoding: 'utf8' }).trim();
    return { available: true, path: output.split(/\r?\n/)[0] ?? null };
  } catch {
    return { available: false, path: null };
  }
}

export function pythonProbe(moduleName: string): { available: boolean; version: string | null; error: string | null } {
  try {
    const output = execFileSync('python', ['-c', `import ${moduleName}; print(getattr(${moduleName}, '__version__', 'unknown'))`], { encoding: 'utf8' }).trim();
    return { available: true, version: output || 'unknown', error: null };
  } catch (error) {
    return { available: false, version: null, error: (error as Error).message.slice(0, 300) };
  }
}

export function cloneScenario(scenario: SafetyScenario): SafetyScenario {
  return JSON.parse(JSON.stringify(scenario)) as SafetyScenario;
}

export function initialDensity(scenario: SafetyScenario, demand: Map<string, number>): { density: number; risk: number } {
  let density = 0;
  let risk = 0;
  for (const [regionId, persons] of demand) {
    density = Math.max(density, regionDensity(scenario, regionId, persons));
    risk = Math.max(risk, regionRiskRatio(scenario, regionId, persons));
  }
  return { density, risk };
}
