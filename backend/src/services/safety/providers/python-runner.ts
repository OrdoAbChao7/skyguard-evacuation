/**
 * Python 感知脚本的统一调用入口。
 *
 * 录制视频与实时流共用同一个 crowd_service.py；把进程调用集中在这里，
 * 便于统一超时、缓冲和 Python 可执行文件配置。
 */
import { execFile } from 'node:child_process';

export const PYTHON_BIN = process.env.SKYGUARD_PYTHON || 'python';

export interface PythonRunResult {
  stdout: string;
  stderr: string;
}

export function runPython(args: string[], timeoutMs = 120000): Promise<PythonRunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON_BIN,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}
