/**
 * SkyGuard 三场景验收运行器（进程内运行，无需先启动服务器）。
 *
 * 用途：
 *  - 可重复地跑完整演示闭环（A 常规 / B 出口火灾 / C 容量不足）；
 *  - 作为评审现场演示的"脚本化证据"，每一步都打印真实决策结果；
 *  - 任一场景最终状态与期望不符时以非零码退出，可直接进 CI。
 *
 * 运行：npm run demo:safety --prefix backend
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { loadSafetyScenario } from '../src/services/safety/scenario';
import { SafetyDecisionService } from '../src/services/safety/decision-service';
import { AuditLog } from '../src/services/safety/audit';

const ACTOR = { username: 'demo-operator', role: 'safety_operator' };

function line(char = '─', length = 78): string {
  return char.repeat(length);
}

async function main(): Promise<void> {
  const scenario = loadSafetyScenario(path.resolve(__dirname, '../../data/scenarios/venue-default.json'));
  const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyguard-demo-'));
  const service = new SafetyDecisionService({ scenario, auditLog: new AuditLog(auditDir) });

  console.log(line('═'));
  console.log('SkyGuard 安全决策闭环 · 三场景验收');
  console.log(`场景：${scenario.name} (${scenario.version})`);
  console.log(`通告：${scenario.notice}`);
  console.log(line('═'));

  let failures = 0;

  for (const demo of scenario.demo_scenarios) {
    console.log('');
    console.log(line());
    console.log(`▶ ${demo.label}  [${demo.id}]`);
    console.log(`  ${demo.description}`);
    console.log(line());

    const result = await service.runDemo(demo.id, ACTOR);
    for (const step of result.steps) {
      console.log(
        `  · 步骤 ${String(step.index + 1).padStart(2, ' ')} ${step.action.padEnd(16)} ${step.result}` +
          (step.detail ? `  ${JSON.stringify(step.detail)}` : ''),
      );
    }

    const status = result.status;
    const plan = status.plan ?? status.candidate_plan;
    console.log('');
    console.log(`  最终状态：${status.state.state}  ${status.state.headline}`);
    for (const reason of status.state.reasons) {
      console.log(`    - [${reason.severity}] ${reason.code}: ${reason.message}`);
    }
    if (plan) {
      console.log(
        `  方案：${plan.plan_id} · ${plan.status} · 已分配 ${plan.evacuated_persons}/${plan.total_persons} 人 · 未解决 ${plan.unresolved_persons} 人`,
      );
      const perExit = new Map<string, number>();
      for (const route of plan.routes) {
        perExit.set(route.exit_id, (perExit.get(route.exit_id) ?? 0) + route.persons);
      }
      console.log(
        `  出口分配：${[...perExit.entries()].map(([exitId, persons]) => `${exitId}=${persons}`).join('  ') || '无'}`,
      );
      if (plan.unresolved.length > 0) {
        console.log(
          `  未解决：${plan.unresolved.map(item => `${item.region_id}×${item.persons}（${item.reason}）`).join('；')}`,
        );
      }
    } else {
      console.log('  方案：无（系统拒绝发布任何未经验证的路线）');
    }
    if (status.validation) {
      console.log(
        `  独立校验：${status.validation.valid ? '通过' : '不通过'}` +
          (status.validation.violations.length > 0
            ? ` · ${status.validation.violations.map(item => item.code).join(', ')}`
            : ''),
      );
    }

    const matched = status.state.state === demo.expected_state;
    console.log(`  ${matched ? '✓' : '✗'} 期望 ${demo.expected_state} / 实际 ${status.state.state}`);
    if (!matched) failures += 1;
  }

  console.log('');
  console.log(line('═'));
  console.log(failures === 0 ? '✓ 三个场景全部符合预期' : `✗ ${failures} 个场景与预期不符`);
  console.log(line('═'));

  fs.rmSync(auditDir, { recursive: true, force: true });
  if (failures > 0) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
