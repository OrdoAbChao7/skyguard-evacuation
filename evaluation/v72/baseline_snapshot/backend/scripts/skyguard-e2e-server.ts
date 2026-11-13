import express from 'express';
import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 隔离 HTTP 集成测试：真实安全路由和 JWT 校验，不挂载生产服务。
const root = process.env.SKYGUARD_E2E_ROOT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'skyguard-http-e2e-'));
fs.mkdirSync(path.join(root, 'scenarios'), { recursive: true });
fs.copyFileSync(path.resolve(__dirname, '../../data/scenarios/stadium-evacuation.json'), path.join(root, 'scenarios/stadium-evacuation.json'));
process.env.DATA_ROOT = root;
process.env.SECRET_KEY = 'skyguard-isolated-e2e-secret';

async function main() {
  const { createSafetyRouter } = await import('../src/api/v1/safety');
  const app = express();
  app.use(express.json());
  app.post('/test/login', (req, res) => {
    if (!['e2e-operator','e2e-viewer'].includes(req.body?.username) || req.body?.password !== 'e2e-only-password') return res.sendStatus(401);
    const role = req.body.username === 'e2e-operator' ? 'safety_operator' : 'viewer';
    return res.json({ access_token: jwt.sign({ username:req.body.username, role }, process.env.SECRET_KEY!, { expiresIn:'1h' }) });
  });
  app.use('/api/v1/safety', createSafetyRouter());
  const server = app.listen(18110, '127.0.0.1', () => console.log(`isolated safety server ready; DATA_ROOT=${root}`));
  const cleanup = () => server.close(() => { fs.rmSync(root, { recursive:true, force:true }); process.exit(0); });
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
}
void main();
