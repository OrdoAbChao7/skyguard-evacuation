/** 安全相关运行时配置（全部来自环境变量，禁止在代码里硬编码生产值）。 */
export interface SecurityConfig {
  corsOrigins: string[] | '*' | false;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  readAuthRequired: boolean;
  cspEnabled: boolean;
  trustProxy: boolean;
  errorDetail: boolean;
}

export function securityConfig(env: NodeJS.ProcessEnv = process.env): SecurityConfig {
  const origins = env.CORS_ORIGINS?.trim();
  return {
    // 生产环境未显式配置 CORS 时不放行跨域（前端与 API 同源部署）。
    corsOrigins: !origins
      ? (env.NODE_ENV === 'production' ? false : '*')
      : origins === '*' ? '*' : origins.split(',').map(item => item.trim()).filter(Boolean),
    rateLimitWindowMs: Math.max(1000, Number(env.RATE_LIMIT_WINDOW_MS ?? 60_000)),
    rateLimitMax: Math.max(1, Number(env.RATE_LIMIT_MAX ?? 300)),
    readAuthRequired: env.READ_AUTH_REQUIRED === 'true',
    cspEnabled: env.CSP_ENABLED === 'true' || env.NODE_ENV === 'production',
    trustProxy: env.TRUST_PROXY === 'true',
    errorDetail: env.NODE_ENV !== 'production',
  };
}

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** 进程内固定窗口限流（单实例 MVP）；生产多实例需替换为共享存储。 */
export function rateLimit(config: SecurityConfig) {
  return (req: any, res: any, next: any): void => {
    if (req.path === '/health' || req.path === '/api/v1/auth/login' || req.path === '/api/v1/mvp/auth/staff-login') {
      next();
      return;
    }
    const now = Date.now();
    const key = `${req.ip ?? 'unknown'}:${req.method}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + config.rateLimitWindowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    res.setHeader('X-RateLimit-Limit', String(config.rateLimitMax));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, config.rateLimitMax - bucket.count)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > config.rateLimitMax) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后重试' } });
      return;
    }
    // 防止 Map 无界增长：超过 5000 个键时清理过期桶
    if (buckets.size > 5000) {
      for (const [bucketKey, value] of buckets) if (value.resetAt <= now) buckets.delete(bucketKey);
    }
    next();
  };
}

export function resetRateLimiterForTests(): void {
  buckets.clear();
}
