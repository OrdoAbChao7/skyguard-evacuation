import path from 'path';
import dotenv from 'dotenv';
import { app } from './app';
import { getSafetyService } from './services/safety';
import { scenarioPath } from './services/safety/scenario';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

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
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});

export { app, server };
