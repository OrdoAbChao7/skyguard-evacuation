/**
 * 场景 overlay 解析。
 *
 * overlay 文件只声明 `extends` 与 `overrides`：
 *  - `extends` 指向同目录的基础场景（或绝对路径）；
 *  - `overrides` 对基础场景做深度合并；
 *  - `staff` 数组按 id 合并，避免复制整份人员名册。
 *
 * 基础场景仍是完整、可独立校验的输入；overlay 不改变安全校验逻辑。
 */
import fs from 'node:fs';
import path from 'node:path';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return clone(patch);
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    result[key] = isPlainObject(value) && isPlainObject(result[key])
      ? deepMerge(result[key], value)
      : clone(value);
  }
  return result;
}

function mergeStaff(base: unknown, patch: unknown, filePath: string): unknown {
  if (!Array.isArray(base) || !Array.isArray(patch)) {
    throw new Error(`scenario overlay ${filePath}: staff must be an array in both base and overlay`);
  }
  const baseIds = new Set(base.map(item => (isPlainObject(item) ? String(item.id) : '')));
  const patches = new Map<string, Record<string, unknown>>();
  for (const item of patch) {
    if (!isPlainObject(item) || typeof item.id !== 'string') {
      throw new Error(`scenario overlay ${filePath}: each staff override must have an id`);
    }
    if (!baseIds.has(item.id)) {
      throw new Error(`scenario overlay ${filePath}: unknown staff id ${item.id}`);
    }
    patches.set(item.id, item);
  }
  return base.map(item => {
    if (!isPlainObject(item)) return item;
    const override = patches.get(String(item.id));
    return override ? deepMerge(item, override) : item;
  });
}

/** 读取场景 JSON；若含 extends 则先解析基础场景并合并 overrides。 */
export function readScenarioJson(filePath: string, stack: string[] = []): unknown {
  const resolved = path.resolve(filePath);
  if (stack.includes(resolved)) {
    throw new Error(`scenario overlay cycle: ${[...stack, resolved].join(' -> ')}`);
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`Safety scenario not found: ${resolved}`);
  }
  const raw = JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown;
  if (!isPlainObject(raw) || typeof raw.extends !== 'string') return raw;

  for (const key of Object.keys(raw)) {
    if (key !== 'extends' && key !== 'overrides') {
      throw new Error(`scenario overlay ${resolved}: unsupported top-level key ${key}`);
    }
  }
  if (raw.overrides !== undefined && !isPlainObject(raw.overrides)) {
    throw new Error(`scenario overlay ${resolved}: overrides must be an object`);
  }

  const basePath = path.isAbsolute(raw.extends)
    ? raw.extends
    : path.join(path.dirname(resolved), raw.extends);
  const base = readScenarioJson(basePath, [...stack, resolved]);
  if (raw.overrides === undefined) return base;
  if (!isPlainObject(base)) {
    throw new Error(`scenario overlay ${resolved}: base scenario must be an object`);
  }

  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(raw.overrides)) {
    merged[key] = key === 'staff'
      ? mergeStaff(base[key], value, resolved)
      : deepMerge(base[key], value);
  }
  return merged;
}
