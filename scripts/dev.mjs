#!/usr/bin/env node
/** 同时启动后端与前端开发服务器（无额外依赖）。 */
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = [
  spawn(npm, ['run', 'dev', '--prefix', 'backend'], { stdio: 'inherit', shell: process.platform === 'win32' }),
  spawn(npm, ['run', 'dev', '--prefix', 'frontend'], { stdio: 'inherit', shell: process.platform === 'win32' }),
];

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try { child.kill('SIGINT'); } catch { /* ignore */ }
  }
  setTimeout(() => process.exit(code), 200);
}

for (const child of children) {
  child.on('exit', code => {
    if (!shuttingDown) shutdown(code ?? 0);
  });
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
