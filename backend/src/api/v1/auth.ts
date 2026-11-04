/**
 * SkyGuard 最小认证。
 *
 * - 账号密码来自环境变量 `SKYGUARD_ADMIN_USERNAME` / `SKYGUARD_ADMIN_PASSWORD`，
 *   首次启动时写入 `data/admin_config.json`（PBKDF2 哈希 + salt）。
 * - JWT 签名密钥来自 `SECRET_KEY` / `JWT_SECRET`；未配置时使用仅限本机开发的
 *   固定值并打印警告。生产部署必须显式配置。
 * - 角色：admin（可执行全部安全写操作）。`safety_operator` 角色由外部签发时同样被接受。
 */
import { Router, Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const authRouter = Router();

const DEV_SECRET = 'skyguard-local-dev-secret-change-me';
export const SECRET = process.env.SECRET_KEY || process.env.JWT_SECRET || DEV_SECRET;
if (SECRET === DEV_SECRET) {
  console.warn('[auth] 未设置 SECRET_KEY/JWT_SECRET，正在使用开发默认密钥（勿用于生产）。');
}

const ADMIN_CONFIG_FILE = path.resolve(__dirname, '../../../../data/admin_config.json');
const DEFAULT_ADMIN = {
  username: process.env.SKYGUARD_ADMIN_USERNAME || 'admin',
  password: process.env.SKYGUARD_ADMIN_PASSWORD || 'skyguard2026',
};

function hashPassword(password: string, salt?: string): { hash: string; salt: string } {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.pbkdf2Sync(password, s, 100000, 64, 'sha512').toString('hex');
  return { hash: h, salt: s };
}

function getAdminCredentials(): { username: string; hash: string; salt: string } {
  try {
    if (fs.existsSync(ADMIN_CONFIG_FILE)) {
      const config = JSON.parse(fs.readFileSync(ADMIN_CONFIG_FILE, 'utf-8'));
      if (config.hash && config.salt) return config;
    }
  } catch { /* fall through to init */ }

  const { hash, salt } = hashPassword(DEFAULT_ADMIN.password);
  const config = { username: DEFAULT_ADMIN.username, hash, salt };
  try {
    fs.mkdirSync(path.dirname(ADMIN_CONFIG_FILE), { recursive: true });
    fs.writeFileSync(ADMIN_CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch { /* non-fatal */ }
  return config;
}

function verifyPassword(password: string): boolean {
  const config = getAdminCredentials();
  const { hash } = hashPassword(password, config.salt);
  return hash === config.hash;
}

export function verifyToken(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: '未提供认证令牌' });
    return;
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, SECRET) as Record<string, unknown>;
    (req as Request & { user?: Record<string, unknown> }).user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Token 无效或已过期，请重新登录' });
  }
}

authRouter.post('/login', (req: Request, res: Response) => {
  const { username, password } = req.body ?? {};
  const config = getAdminCredentials();
  if (username === config.username && verifyPassword(password)) {
    const token = jwt.sign({ username, role: 'admin' }, SECRET, { expiresIn: '24h' });
    res.json({ access_token: token, token_type: 'bearer', username: config.username, role: 'admin' });
  } else {
    res.status(401).json({ error: '用户名或密码错误' });
  }
});

authRouter.post('/refresh', (req: Request, res: Response) => {
  const { token } = req.body ?? {};
  try {
    const decoded = jwt.verify(token, SECRET) as { username?: string; role?: string };
    const newToken = jwt.sign(
      { username: decoded.username, role: decoded.role },
      SECRET,
      { expiresIn: '24h' },
    );
    res.json({ access_token: newToken, token_type: 'bearer' });
  } catch {
    res.status(401).json({ error: 'Token 无效或已过期' });
  }
});

export { authRouter, getAdminCredentials };
