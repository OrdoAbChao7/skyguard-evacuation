import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { apiRouter } from './api/v1/router';
import { verifyToken } from './api/v1/auth';
import { rateLimit, securityConfig } from './config/security';
import { mcpHttpHandler } from './mcp/server';

export function createApp(): Express {
  const app = express();
  const security = securityConfig();

  if (security.trustProxy) app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: security.cspEnabled ? {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    } : false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));
  app.use(cors({ origin: security.corsOrigins }));
  app.use(morgan(process.env.LOG_FORMAT ?? 'dev'));
  app.use((req, res, next) => {
    const requestId = req.header('x-request-id') ?? randomUUID().slice(0, 8);
    (req as express.Request & { requestId?: string }).requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    next();
  });
  app.use(express.json({ limit: '20mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use(express.static(path.resolve(__dirname, '../../frontend/dist')));
  app.use('/api', rateLimit(security));
  // 同一进程、同一 MvpService 单例：HTTP MCP 与网页读写同一份业务状态。
  app.use('/mcp', rateLimit(security), mcpHttpHandler());

  if (security.readAuthRequired) {
    app.use('/api/v1', (req, res, next) => {
      if (req.method !== 'GET') return next();
      if (req.path.startsWith('/auth/') || req.path === '/mvp/auth/staff-login') return next();
      return verifyToken(req, res, next);
    });
  }

  app.use('/api/v1', apiRouter);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'SkyGuard', version: '0.1.0' });
  });

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.resolve(__dirname, '../../frontend/dist/index.html'));
  });

  app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 500
      ? err.status
      : 500;
    const requestId = (req as express.Request & { requestId?: string }).requestId ?? 'unknown';
    if (status >= 500) console.error(`[error ${requestId}]`, err);
    res.status(status).json({
      error: {
        code: status === 400 ? 'BAD_REQUEST' : status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL_ERROR',
        message: status === 400 ? '请求格式错误' : status === 413 ? '上传文件过大' : '服务器内部错误',
        request_id: requestId,
      },
      ...(security.errorDetail ? { detail: err?.message } : {}),
    });
  });

  return app;
}

export const app = createApp();
