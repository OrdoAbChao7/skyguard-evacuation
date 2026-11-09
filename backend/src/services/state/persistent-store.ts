/**
 * 单实例持久化状态存储（G08）。
 *
 * 设计目标：在不引入数据库的前提下，为 Agent Run、工单/预算预留、证据、
 * 审计事件提供一次原子提交的快照。
 *
 * 可靠性措施：
 *  - 写入临时文件 → fsync → 原文件转 backup → 临时文件原子改名；
 *  - 每次保存带 schema_version、revision 与 payload SHA-256；
 *  - 启动时依次尝试 primary / backup / temp，任一通过校验即可恢复；
 *  - 所有候选都损坏、版本超前或结构非法时 **fail closed**，不静默清空；
 *  - revision 必须连续递增，避免旧快照覆盖新状态；
 *  - 保存前读取磁盘当前 revision 做 CAS，并用独占锁文件串行化跨进程写入；
 *    发现其他实例已推进 revision 时拒绝覆盖（fail closed）。
 *
 * 仍是单实例业务方案：锁只防止“后写静默覆盖”，其他进程仍需重启才能读到新状态。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_STATE_BYTES = 32 * 1024 * 1024;
const LOCK_STALE_MS = 60_000;
const LOCK_RETRIES = 50;
const LOCK_RETRY_MS = 10;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class StateStoreError extends Error {
  readonly status = 500;
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'StateStoreError';
    this.code = code;
  }
}

export interface StateEnvelope<T> {
  schema_version: number;
  revision: number;
  saved_at: string;
  checksum_algorithm: 'sha256';
  checksum: string;
  payload: T;
}

export interface LoadedState<T> {
  payload: T;
  revision: number;
  saved_at: string;
  source: 'primary' | 'backup' | 'temp';
}

function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function readCandidate<T>(file: string, supportedVersion: number): StateEnvelope<T> {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    throw new StateStoreError('STATE_UNREADABLE', `无法读取 ${file}: ${(error as Error).message}`);
  }
  if (bytes.length > MAX_STATE_BYTES) {
    throw new StateStoreError('STATE_TOO_LARGE', `状态文件 ${file} 超过 ${MAX_STATE_BYTES} 字节上限`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new StateStoreError('STATE_INVALID_JSON', `${file} 不是有效 JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new StateStoreError('STATE_INVALID_SHAPE', `${file} 不是状态对象`);
  }
  const envelope = parsed as Partial<StateEnvelope<T>>;
  if (!Number.isInteger(envelope.schema_version)) {
    throw new StateStoreError('STATE_INVALID_SHAPE', `${file} 缺少 schema_version`);
  }
  if (envelope.schema_version! > supportedVersion) {
    throw new StateStoreError(
      'STATE_VERSION_UNSUPPORTED',
      `${file} 的 schema_version=${envelope.schema_version} 高于当前支持版本 ${supportedVersion}；拒绝启动`,
    );
  }
  if (envelope.schema_version! !== supportedVersion) {
    throw new StateStoreError(
      'STATE_VERSION_UNSUPPORTED',
      `${file} 的 schema_version=${envelope.schema_version} 不是当前支持版本 ${supportedVersion}`,
    );
  }
  if (!Number.isInteger(envelope.revision) || (envelope.revision as number) < 1) {
    throw new StateStoreError('STATE_INVALID_SHAPE', `${file} 的 revision 非法`);
  }
  if (envelope.checksum_algorithm !== 'sha256' || typeof envelope.checksum !== 'string') {
    throw new StateStoreError('STATE_INVALID_SHAPE', `${file} 缺少 sha256 校验`);
  }
  if (envelope.payload === undefined || envelope.payload === null) {
    throw new StateStoreError('STATE_INVALID_SHAPE', `${file} 缺少 payload`);
  }
  const expected = sha256Text(JSON.stringify(envelope.payload));
  const expectedEnvelope = sha256Text(JSON.stringify({
    schema_version: envelope.schema_version,
    revision: envelope.revision,
    saved_at: envelope.saved_at,
    payload: envelope.payload,
  }));
  if (expected !== envelope.checksum && expectedEnvelope !== envelope.checksum) {
    throw new StateStoreError('STATE_CHECKSUM_MISMATCH', `${file} 校验和不匹配（可能部分写入或损坏）`);
  }
  return envelope as StateEnvelope<T>;
}

export class PersistentStateStore<T> {
  private readonly primary: string;
  private readonly backup: string;
  private readonly temp: string;
  private lastRevision: number | null = null;

  constructor(
    file: string,
    private readonly supportedVersion = 1,
  ) {
    this.primary = file;
    this.backup = `${file}.bak`;
    this.temp = `${file}.tmp`;
  }

  get path(): string {
    return this.primary;
  }

  get revision(): number | null {
    return this.lastRevision;
  }

  load(): LoadedState<T> | null {
    const candidates: Array<{ source: LoadedState<T>['source']; file: string }> = [
      { source: 'primary', file: this.primary },
      { source: 'backup', file: this.backup },
      { source: 'temp', file: this.temp },
    ].filter(item => fs.existsSync(item.file)) as Array<{ source: LoadedState<T>['source']; file: string }>;
    if (candidates.length === 0) return null;

    const errors: string[] = [];
    const valid: Array<{ source: LoadedState<T>['source']; envelope: StateEnvelope<T> }> = [];
    for (const candidate of candidates) {
      try {
        const envelope = readCandidate<T>(candidate.file, this.supportedVersion);
        valid.push({ source: candidate.source, envelope });
      } catch (error) {
        // 未来版本的 schema 不能被旧代码静默降级恢复。
        if (error instanceof StateStoreError && error.code === 'STATE_VERSION_UNSUPPORTED') throw error;
        errors.push((error as Error).message);
      }
    }
    if (valid.length === 0) {
      throw new StateStoreError(
        'STATE_CORRUPT',
        `状态文件全部校验失败，拒绝以空状态启动：${errors.join(' | ')}`,
      );
    }
    // 崩溃恢复必须选择最新完整快照；primary/backup/temp 只作为同 revision 的优先级。
    const rank: Record<LoadedState<T>['source'], number> = { primary: 0, backup: 1, temp: 2 };
    valid.sort((a, b) =>
      b.envelope.revision - a.envelope.revision
      || rank[a.source] - rank[b.source]);
    const selected = valid[0];
    this.lastRevision = selected.envelope.revision;
    return {
      payload: selected.envelope.payload,
      revision: selected.envelope.revision,
      saved_at: selected.envelope.saved_at,
      source: selected.source,
    };
  }

  /** 跨进程写入锁：wx 独占创建；超时清理陈旧锁；失败 fail closed。 */
  private acquireLock(): () => void {
    const lock = `${this.primary}.lock`;
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
      try {
        const fd = fs.openSync(lock, 'wx');
        try {
          fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), 'utf8');
        } finally {
          fs.closeSync(fd);
        }
        return () => {
          try { fs.unlinkSync(lock); } catch { /* 锁已被清理 */ }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new StateStoreError('STATE_LOCK_FAILED', `无法创建状态锁 ${lock}: ${(error as Error).message}`);
        }
        try {
          const stat = fs.statSync(lock);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            fs.unlinkSync(lock);
            continue;
          }
        } catch {
          // 锁刚被释放或无法 stat，短暂等待后重试。
        }
        sleepSync(LOCK_RETRY_MS);
      }
    }
    throw new StateStoreError('STATE_LOCKED', `状态文件被其他进程锁定：${lock}`);
  }

  /** 读取磁盘上当前最高可用 revision（CAS 基线）；全部候选损坏时 fail closed。 */
  private diskRevision(): number | null {
    const candidates = [this.primary, this.backup, this.temp].filter(file => fs.existsSync(file));
    const errors: string[] = [];
    let maximum: number | null = null;
    for (const file of candidates) {
      try {
        const envelope = readCandidate<T>(file, this.supportedVersion);
        maximum = maximum === null ? envelope.revision : Math.max(maximum, envelope.revision);
      } catch (error) {
        if (error instanceof StateStoreError && error.code === 'STATE_VERSION_UNSUPPORTED') throw error;
        errors.push((error as Error).message);
      }
    }
    if (candidates.length > 0 && maximum === null) {
      throw new StateStoreError('STATE_CORRUPT', `状态文件全部校验失败，拒绝覆盖：${errors.join(' | ')}`);
    }
    return maximum;
  }

  save(payload: T, expectedRevision: number): number {
    if (this.lastRevision !== null && expectedRevision !== this.lastRevision) {
      throw new StateStoreError(
        'STATE_REVISION_CONFLICT',
        `状态 revision 冲突：期望 ${this.lastRevision}，收到 ${expectedRevision}`,
      );
    }
    const release = this.acquireLock();
    try {
      // CAS：磁盘上的状态可能已被其他进程推进，禁止静默覆盖。
      const onDisk = this.diskRevision();
      if (onDisk !== null && onDisk !== expectedRevision) {
        throw new StateStoreError(
          'STATE_REVISION_CONFLICT',
          `磁盘状态 revision=${onDisk}，调用方期望 ${expectedRevision}；拒绝覆盖其他写入方`,
        );
      }
      const revision = expectedRevision + 1;
      const savedAt = new Date().toISOString();
      const envelope: StateEnvelope<T> = {
        schema_version: this.supportedVersion,
        revision,
        saved_at: savedAt,
        checksum_algorithm: 'sha256',
        checksum: '',
        payload,
      };
      envelope.checksum = sha256Text(JSON.stringify({
        schema_version: envelope.schema_version,
        revision: envelope.revision,
        saved_at: envelope.saved_at,
        payload: envelope.payload,
      }));
      const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
      try {
        fs.mkdirSync(path.dirname(this.primary), { recursive: true });
        const fd = fs.openSync(this.temp, 'w');
        try {
          fs.writeFileSync(fd, serialized, 'utf8');
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        if (fs.existsSync(this.backup)) fs.unlinkSync(this.backup);
        if (fs.existsSync(this.primary)) fs.renameSync(this.primary, this.backup);
        fs.renameSync(this.temp, this.primary);
        try {
          const dirFd = fs.openSync(path.dirname(this.primary), 'r');
          try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
        } catch {
          // Windows 不支持目录 fsync；文件本身已 fsync。
        }
        this.lastRevision = revision;
        return revision;
      } catch (error) {
        if (error instanceof StateStoreError) throw error;
        throw new StateStoreError('STATE_WRITE_FAILED', `状态写入失败：${(error as Error).message}`);
      }
    } finally {
      release();
    }
  }
}
