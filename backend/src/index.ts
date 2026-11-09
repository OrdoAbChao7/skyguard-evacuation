import './config/env';
import { app } from './app';
import { getSafetyService } from './services/safety';
import { getMvpService } from './services/mvp';
import { scenarioPath } from './services/safety/scenario';
import { productionAuthConfigErrors, productionAdminConfigErrors } from './api/v1/auth';

const authErrors = [...productionAuthConfigErrors(), ...productionAdminConfigErrors()];
if (authErrors.length > 0) {
  for (const error of authErrors) console.error(`[FATAL] ${error}`);
  process.exit(1);
}

// 统一状态在启动阶段完成校验；损坏或版本不兼容时 fail closed。
try {
  getMvpService();
} catch (error) {
  console.error('[FATAL] 统一状态初始化失败，拒绝启动：', (error as Error).message);
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || '8010', 10);
const server = app.listen(PORT, () => {
  const status = getSafetyService().getStatus();
  console.log('');
  console.log('  SkyGuard — 应急疏散辅助决策原型');
  console.log(`  大屏:   http://localhost:${PORT}/`);
  console.log(`  API:    http://localhost:${PORT}/api/v1/safety/status`);
  console.log(`  Health: http://localhost:${PORT}/health`);
  console.log(`  场景:   ${status.scenario.name} (v${status.scenario.version})`);
  console.log(`  文件:   ${scenarioPath()}`);
  console.log('  研究原型，不得用于真实疏散指挥。');
  console.log('');
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message);
  console.error(err.stack);
  // 未捕获异常后内存可能不一致：fail closed，交由编排器重启。
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
  process.exit(1);
});

export { app, server };
