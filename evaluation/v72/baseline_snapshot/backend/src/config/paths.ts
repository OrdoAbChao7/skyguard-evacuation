import path from 'path';

/** 数据根目录：优先 DATA_ROOT，否则仓库根目录下的 data/。 */
const DEFAULT_DATA_ROOT = path.resolve(__dirname, '../../../data');

export function getDataRoot(): string {
  const configured = process.env.DATA_ROOT;
  return configured && configured !== 'undefined'
    ? path.resolve(configured)
    : DEFAULT_DATA_ROOT;
}

export function resolveDataPath(...segments: string[]): string {
  const root = getDataRoot();
  const resolved = path.resolve(root, ...segments);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('data path escapes DATA_ROOT');
  }
  return resolved;
}
