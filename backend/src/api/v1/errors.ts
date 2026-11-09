/** API 错误响应的统一出口：生产 5xx 不回显内部错误，只保留 request_id。 */
import type { Request, Response } from 'express';
import { securityConfig } from '../../config/security';

export function requestIdOf(req: Request): string {
  return (req as Request & { requestId?: string }).requestId ?? 'unknown';
}

export function failFromError(
  req: Request,
  res: Response,
  status: number,
  code: string,
  error: unknown,
  detail?: unknown,
): void {
  const expose = securityConfig().errorDetail;
  const raw = error instanceof Error ? error.message : String(error ?? 'unknown');
  const message = status >= 500 && !expose ? '服务器内部错误' : raw;
  res.status(status).json({
    error: {
      code,
      message,
      request_id: requestIdOf(req),
      ...(detail === undefined ? {} : { detail }),
    },
  });
}
