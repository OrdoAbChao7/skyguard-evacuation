import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import { apiRouter } from './api/v1/router';

export function createApp(): Express {
  const app = express();

  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));
  app.use(cors());
  app.use(morgan('dev'));
  app.use(express.json({ limit: '20mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use(express.static(path.resolve(__dirname, '../../frontend/dist')));
  app.use('/api/v1', apiRouter);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'SkyGuard', version: '0.1.0' });
  });

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.resolve(__dirname, '../../frontend/dist/index.html'));
  });

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Unhandled error:', err);
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 500
      ? err.status
      : 500;
    res.status(status).json({
      error: status === 400 ? '请求格式错误' : '服务器内部错误',
      detail: err.message,
    });
  });

  return app;
}

export const app = createApp();
