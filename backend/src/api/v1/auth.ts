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
const INSECURE_PLACEHOLDERS = [
  /replace[-_ ]?with/i,
  /change[-_ ]?me/i,
  /changeme/i,
  /your[-_ ]?.*(secret|password|key)/i,
  /example/i,
  /skyguard2026/i,
];

function looksLikePlaceholder(value: string): boolean {
  return INSECURE_PLACEHOLDERS.some(pattern => pattern.test(value));
}

export const SECRET = process.env.SECRET_KEY || process.env.JWT_SECRET || DEV_SECRET;
if (SECRET === DEV_SECRET) {
  console.warn('[auth] 未设置 SECRET_KEY/JWT_SECRET，正在使用开发默认密钥（勿用于生产）。');
}

/** 生产启动前的凭证门槛；返回空数组表示通过。 */
export function productionAuthConfigErrors(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const errors: string[] = [];
  const secret = env.SECRET_KEY?.trim() || env.JWT_SECRET?.trim() || '';
  if (!secret || secret === DEV_SECRET || secret.length < 16) {
    errors.push('生产环境必须设置长度至少 16 的 SECRET_KEY/JWT_SECRET');
  } else if (looksLikePlaceholder(secret)) {
    errors.push('SECRET_KEY/JWT_SECRET 仍是示例占位符；生产环境必须使用随机密钥');
  }
  const password = env.SKYGUARD_ADMIN_PASSWORD?.trim() || '';
  if (!password || password === 'skyguard2026' || password.length < 12) {
    errors.push('生产环境必须设置长度至少 12 且非默认值的 SKYGUARD_ADMIN_PASSWORD');
  } else if (looksLikePlaceholder(password)) {
    errors.push('SKYGUARD_ADMIN_PASSWORD 仍是示例占位符；生产环境必须使用强随机口令');
  }
  return errors;
}

/**
 * 生产环境旧管理员配置门槛：如果 data/admin_config.json 已存在，
 * 不允许继续使用默认口令，也不允许与环境变量中的新口令不一致（避免“改了 env 仍旧口令生效”）。
 */
export function productionAdminConfigErrors(
  env: NodeJS.ProcessEnv = process.env,
  adminConfigFile: string = ADMIN_CONFIG_FILE,
): string[] {
  if (env.NODE_ENV !== 'production') return [];
  if (!fs.existsSync(adminConfigFile)) return [];
  let config: { username?: string; hash?: string; salt?: string };
  try {
    config = JSON.parse(fs.readFileSync(adminConfigFile, 'utf8'));
  } catch {
    return ['生产环境 data/admin_config.json 无法解析；拒绝启动'];
  }
  if (!config?.hash || !config?.salt) {
    return ['生产环境 data/admin_config.json 缺少 hash/salt；拒绝启动'];
  }
  const errors: string[] = [];
  if (config.hash === hashPassword('skyguard2026', config.salt).hash) {
    errors.push('data/admin_config.json 仍是默认管理员口令 skyguard2026；拒绝启动');
  }
  const envPassword = env.SKYGUARD_ADMIN_PASSWORD?.trim();
  if (envPassword && config.hash !== hashPassword(envPassword, config.salt).hash) {
    errors.push('data/admin_config.json 与 SKYGUARD_ADMIN_PASSWORD 不一致；请迁移或删除后重新初始化');
  }
  const envUsername = env.SKYGUARD_ADMIN_USERNAME?.trim();
  if (envUsername && config.username && envUsername !== config.username) {
    errors.push('data/admin_config.json 与 SKYGUARD_ADMIN_USERNAME 不一致；请迁移或删除后重新初始化');
  }
  return errors;
}

const ADMIN_CONFIG_FILE = path.resolve(__dirname, '../../../../data/admin_config.json');
const DEFAULT_ADMIN = {
  username: process.env.SKYGUARD_ADMIN_USERNAME || 'admin',
  password: process.env.SKYGUARD_ADMIN_PASSWORD || 'skyguard2026',
};

export function hashPassword(password: string, salt?: string): { hash: string; salt: string } {
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
