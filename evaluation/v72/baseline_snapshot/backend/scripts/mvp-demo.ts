/**
 * SkyGuard MVP 端到端演示（进程内运行，可重复）。
 *
 *   npm run demo:mvp --prefix backend
 *
 * 三个场景：
 *   A 正常散场：回放数据、预测、风险评估，Agent 不发起无意义调查
 *   B 局部积聚 + 信息不确定：VoI 选调查 → 工单 → 审批 → 接单执行 → 反馈 → 重新评估
 *   C 不可信数据 / 出口容量不足：DEGRADED / REJECT，拒绝发布未验证路线
 *
 * 所有数据为合成演示数据；脚本不会修改期望状态来“让演示通过”。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditLog } from '../src/services/safety/audit';
import { SafetyDecisionService } from '../src/services/safety/decision-service';
import { loadSafetyScenario } from '../src/services/safety/scenario';
import { MvpService } from '../src/services/mvp';
import type { ReplayRow } from '../src/services/mvp/ingest';
import type { OpsActor, WorkOrder } from '../src/services/mvp/ops';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skyguard-mvp-demo-'));
process.env.DATA_ROOT = dataRoot;
process.env.SECRET_KEY = process.env.SECRET_KEY ?? 'skyguard-demo-only-secret';

const scenarioFile = path.resolve(__dirname, '../../data/scenarios/stadium-evacuation.json');
const scenario = loadSafetyScenario(scenarioFile);
const audit = new AuditLog(path.join(dataRoot, 'audit'));
const safety = new SafetyDecisionService({ scenario, auditLog: audit });
const mvp = new MvpService({ scenario, safety, audit });

const admin: OpsActor = { username: 'demo-admin', role: 'admin' };
let failures = 0;

function section(title: string): void {
  console.log('');
  console.log('─'.repeat(90));
  console.log(title);
  console.log('─'.repeat(90));
}

function check(condition: boolean, label: string, detail?: unknown): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail === undefined ? '' : `  (${JSON.stringify(detail)})`}`);
  }
}

function log(value: unknown): void {
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function rows(series: Record<string, number[]>, steps: number, startOffsetMinutes = 0): ReplayRow[] {
  const now = Date.now();
  const out: ReplayRow[] = [];
  for (let step = 0; step < steps; step += 1) {
    const timestamp = new Date(now - (steps - 1 - step) * 60_000).toISOString();
    for (const [regionId, counts] of Object.entries(series)) {
      const count = counts[Math.min(step, counts.length - 1)];
      out.push({ timestamp, region_id: regionId, count, confidence: 0.9 });
    }
  }
  return out;
}

function staffActor(staffId: string): OpsActor {
  const member = mvp.ops.getStaff(staffId);
  if (!member) throw new Error(`staff not found: ${staffId}`);
  return { username: member.name, role: 'staff', staff_id: member.id };
}

async function runOrderLoop(order: WorkOrder, observation: { count: number; confidence: number }, note: string): Promise<WorkOrder> {
  mvp.ops.approve(order.id, admin, '演示审批通过');
  if (mvp.ops.getWorkOrder(order.id)?.stale) {
    mvp.ops.revalidate(order.id, admin, '证据更新后重新确认上下文');
  }
  const assigned = mvp.ops.assignStaff(order.id, admin);
  const staffId = assigned.assigned_staff_id;
  if (!staffId) throw new Error(`工单 ${order.id} 未分配工作人员`);
  const actor = staffActor(staffId);
  mvp.ops.accept(order.id, actor);
  mvp.ops.start(order.id, actor);
  const completed = mvp.ops.complete(order.id, actor, { note, observation: { ...observation, valid: true } });
  return completed;
}

async function scenarioA(): Promise<void> {
  section('场景 A · 正常散场（回放 + 预测 + 风险评估）');
  mvp.resetAll(admin);

  const replay = rows({
    R_NORTH_STAND: [360, 345, 330, 315, 300, 290],
    R_SOUTH_STAND: [310, 300, 290, 280, 270, 260],
    R_WEST_STAND: [290, 280, 270, 260, 250, 240],
    R_EAST_STAND: [300, 320, 345, 370, 395, 420],
    R_NORTH_CONCOURSE: [120, 125, 130, 135, 140, 145],
    R_SOUTH_CONCOURSE: [110, 112, 114, 116, 118, 120],
    R_EAST_PLAZA: [60, 62, 64, 66, 68, 70],
    R_WEST_PLAZA: [55, 56, 57, 58, 59, 60],
  }, 6);
  mvp.replay.loadRows(replay, { name: 'stadium-evacuation-demo', provenance: '合成回放数据（固定序列）' });
  const stepped = mvp.stepReplay({ count: replay.length, actor: admin });
  log(`  回放写入：${stepped.ingested} 条观测`);

  const status = safety.getStatus();
  log(`  安全状态：${status.state.state} · ${status.state.headline}`);
  check(status.state.state === 'NORMAL', '正常散场应进入 NORMAL', status.state.state);

  const prediction = mvp.predict('R_EAST_STAND');
  console.log(`  东看台预测：当前 ${prediction.current_count} → 5 分钟后 ${prediction.predicted_count}（${prediction.trend.direction}，${prediction.trend.rate_per_minute} 人/分）`);
  check(prediction.sufficient, '预测数据充分');
  check(prediction.trend.direction === 'rising', '预测识别出上升趋势', prediction.trend);

  const run = await mvp.runAgent({ regionId: 'R_NORTH_STAND', trigger: 'normal_evacuation' });
  console.log(`  Agent：${run.status} · ${run.summary}`);
  console.log(`  工具调用：${run.trace.map(item => item.tool).join(' → ')}`);
  check(!run.investigation.required, '数据可信时不发起主动调查');
  check(run.trace.every(item => !item.tool.startsWith('request_')), '没有无意义的补充观察工具调用');
  check(run.work_orders.length === 0, '正常场景不生成工单', run.work_orders.map(order => order.id));
}

async function scenarioB(): Promise<void> {
  section('场景 B · 局部积聚 + 信息不确定（VoI → 审批 → 执行 → 反馈）');
  mvp.resetAll(admin);

  const baseline = rows({
    R_NORTH_STAND: [300, 305, 310],
    R_SOUTH_STAND: [280, 285, 290],
    R_WEST_STAND: [260, 265, 270],
    R_NORTH_CONCOURSE: [110, 115, 120],
    R_SOUTH_CONCOURSE: [105, 108, 112],
    R_EAST_PLAZA: [55, 60, 65],
    R_WEST_PLAZA: [50, 52, 55],
  }, 3);
  mvp.replay.loadRows(baseline, { name: 'stadium-evacuation-baseline', provenance: '合成回放数据（固定序列）' });
  mvp.stepReplay({ count: baseline.length, actor: admin });

  // 东看台：低置信度观测 → 信息缺口
  safety.ingestObservation({
    regionId: 'R_EAST_STAND',
    count: 900,
    confidence: 0.35,
    source: 'simulation',
    provider: 'camera-degraded',
    modelVersion: 'demo-degraded-v1',
    observedAt: new Date(),
    valid: true,
    evidence: { note: '摄像头降级，置信度不足' },
  }, admin);
  safety.recompute(admin, 'demo_b_degraded_observation');
  const degraded = safety.getStatus();
  log(`  写入低置信观测后状态：${degraded.state.state} · ${degraded.state.headline}`);
  check(degraded.state.state === 'DEGRADED', '低置信观测触发 DEGRADED', degraded.state.state);

  const run = await mvp.runAgent({ regionId: 'R_EAST_STAND', trigger: 'crowd_surge_alert' });
  console.log(`  Agent 状态：${run.status}`);
  console.log(`  调查轮次：${run.investigation.rounds.length}；停止原因：${run.investigation.stopped_reason}`);
  for (const round of run.investigation.rounds) {
    console.log(`    轮次 ${round.round}: 选择 ${round.selected_action_id ?? '无'}（${round.selected_kind ?? '—'}）→ ${round.outcome ?? '—'}${round.pending ? ' · 待人工证据' : ''}`);
    for (const evaluation of round.decision.evaluations) {
      console.log(`      ${evaluation.action_id.padEnd(10)} score=${evaluation.score === null ? '—' : evaluation.score.toFixed(4)}  IG=${evaluation.information_gain_bits.toFixed(4)}  ΔR=${evaluation.risk_reduction.toFixed(4)}  ${evaluation.available ? '' : `不可用(${evaluation.unavailable_reason})`}`);
    }
  }
  console.log(`  工单：${run.work_orders.map(order => `${order.id as string}:${order.type as string}`).join('、') || '无'}`);
  const types = new Set(run.work_orders.map(order => order.type));
  check(run.investigation.required, '检测到信息缺口并启动调查');
  check(run.investigation.rounds.length > 0, 'VoI 产生了调查排序');
  check(types.has('scene_verification'), '创建了现场核查工单');
  check(types.has('uav_observation'), '创建了无人机观察请求（待审批）');
  check(run.status === 'awaiting_evidence', '等待人工证据期间状态为 awaiting_evidence', run.status);

  const pending = mvp.ops.listWorkOrders().filter(order => order.status === 'PENDING_APPROVAL');
  check(pending.length >= 2, '至少两个待审批工单', pending.map(order => order.id));

  const staffOrder = pending.find(order => order.type === 'scene_verification')!;
  const uavOrder = pending.find(order => order.type === 'uav_observation')!;
  const completedStaff = await runOrderLoop(staffOrder, { count: 920, confidence: 0.95 }, '现场核查：东看台入口人流密集，通道仍可通行。');
  log(`  现场核查工单完成：${completedStaff.status} · 指派 ${completedStaff.assigned_staff_id}`);
  const completedUav = await runOrderLoop(uavOrder, { count: 940, confidence: 0.92 }, '无人机航拍：东看台外侧人流密集，建议分流至南侧。');
  log(`  无人机工单完成：${completedUav.status} · 指派 ${completedUav.assigned_staff_id}`);

  const afterEvidence = safety.getStatus();
  log(`  反馈写入后状态：${afterEvidence.state.state} · 观测来源 ${afterEvidence.observations.find(item => item.region_id === 'R_EAST_STAND')?.source}`);
  check(afterEvidence.state.state !== 'DEGRADED', '人工证据到达后脱离 DEGRADED', afterEvidence.state.state);

  const run2 = await mvp.runAgent({ regionId: 'R_EAST_STAND', trigger: 'staff_feedback' });
  console.log(`  第二次 Agent（反馈后）：${run2.status} · ${run2.summary}`);
  log(`    信念：${run2.belief_before.map(item => `${item.hypothesis_id}=${item.probability}`).join(' / ')} → ${run2.belief_after.map(item => `${item.hypothesis_id}=${item.probability}`).join(' / ')}`);
  log(`    熵：${run2.entropy_before_bits} → ${run2.entropy_after_bits} bit；风险：${run2.risk_before} → ${run2.risk_after}`);
  const controlOrder = run2.work_orders.find(order => order.type === 'crowd_control');
  check(Boolean(controlOrder), '反馈后生成人流疏导候选工单', run2.work_orders.map(order => order.type));

  if (controlOrder) {
    const completedControl = await runOrderLoop(
      controlOrder as unknown as WorkOrder,
      { count: 700, confidence: 0.95 },
      '疏导完成：东看台向南北环廊分流，密度下降。',
    );
    log(`  疏导工单完成：${completedControl.status}`);
  }

  const finalOrders = mvp.ops.listWorkOrders();
  check(finalOrders.every(order => ['COMPLETED', 'FAILED', 'REJECTED'].includes(order.status)), '全部工单到达终态', finalOrders.map(order => `${order.id}:${order.status}`));
  const history = completedStaff.history.map(item => item.status);
  check(history.includes('PENDING_APPROVAL') && history.includes('APPROVED') && history.includes('ASSIGNED') && history.includes('ACCEPTED') && history.includes('IN_PROGRESS') && history.includes('COMPLETED'), '工单状态按顺序完整流转', history);
  const finalStatus = safety.getStatus();
  log(`  场景 B 最终状态：${finalStatus.state.state} · ${finalStatus.state.headline}`);
  check(['NORMAL', 'REROUTE'].includes(finalStatus.state.state), '反馈驱动重新评估后处于可发布状态', finalStatus.state.state);
}

async function scenarioC(): Promise<void> {
  section('场景 C · 不可信数据 / 出口容量不足（DEGRADED / REJECT）');
  mvp.resetAll(admin);

  for (const region of scenario.regions) {
    safety.ingestObservation({
      regionId: region.id,
      count: 800,
      confidence: 0.9,
      source: 'simulation',
      provider: 'camera-offline',
      modelVersion: 'demo-offline-v1',
      observedAt: new Date(),
      valid: false,
      invalidReason: '摄像头离线（演示构造）',
    }, admin);
  }
  safety.recompute(admin, 'demo_c_untrusted');
  const degraded = safety.getStatus();
  log(`  全部观测不可信：${degraded.state.state} · 可发布=${degraded.state.publishable}`);
  check(degraded.state.state === 'DEGRADED', '不可信观测必须进入 DEGRADED', degraded.state.state);
  check(degraded.state.publishable === false, 'DEGRADED 下禁止发布路线');
  check(degraded.state.validated_route_display_allowed === false, 'DEGRADED 下禁止显示已验证路线');

  const highCounts: Record<string, number> = {
    R_NORTH_STAND: 1300,
    R_SOUTH_STAND: 1300,
    R_WEST_STAND: 1200,
    R_EAST_STAND: 1300,
    R_NORTH_CONCOURSE: 700,
    R_SOUTH_CONCOURSE: 700,
    R_EAST_PLAZA: 400,
    R_WEST_PLAZA: 400,
  };
  for (const [regionId, count] of Object.entries(highCounts)) {
    safety.ingestObservation({
      regionId,
      count,
      confidence: 0.95,
      source: 'simulation',
      provider: 'demo-capacity',
      modelVersion: 'demo-capacity-v1',
      observedAt: new Date(),
    }, admin);
  }
  const incident = safety.createIncident({
    type: 'corridor_closure',
    description: '东西主出口因设备故障临时关闭（演示）',
    severity: 'critical',
    affected: { region_ids: [], corridor_ids: [], exit_ids: ['E_EAST', 'E_WEST'] },
    source: 'operator',
    actor: admin.username,
  });
  safety.confirmIncident(incident.id, admin);
  safety.recompute(admin, 'demo_c_exit_closure');

  const rejected = safety.getStatus();
  log(`  关闭东西出口后：${rejected.state.state} · ${rejected.state.headline}`);
  for (const reason of rejected.state.reasons) console.log(`    - [${reason.severity}] ${reason.code}: ${reason.message}`);
  check(rejected.state.state === 'REJECT', '容量不足必须进入 REJECT', rejected.state.state);
  check(rejected.state.publishable === false, 'REJECT 下禁止发布');
  check(rejected.plan === null, 'REJECT 下不存在已发布方案');
  check(Boolean(rejected.candidate_plan && rejected.candidate_plan.unresolved_persons > 0), '候选方案显式给出未解决人数', rejected.candidate_plan?.unresolved_persons);

  const run = await mvp.runAgent({ regionId: 'R_EAST_STAND', trigger: 'exit_closure_capacity_shortage' });
  console.log(`  Agent：${run.status} · ${run.summary}`);
  check(run.status === 'needs_human', 'Agent 在 REJECT 下转人工', run.status);
  check(run.summary.includes('人工'), 'Agent 输出人工介入说明');
}

async function main(): Promise<void> {
  console.log('SkyGuard MVP 端到端演示');
  console.log(`场景：${scenario.name}（${scenario.scenario_id} v${scenario.version}）`);
  console.log(`数据根目录：${dataRoot}`);
  console.log('注意：所有数据均为合成演示数据，不得用于真实疏散指挥。');

  try {
    await scenarioA();
    await scenarioB();
    await scenarioC();
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }

  console.log('');
  console.log('═'.repeat(90));
  if (failures === 0) {
    console.log('✓ MVP 三个场景全部通过');
    console.log('═'.repeat(90));
  } else {
    console.error(`✗ 共有 ${failures} 项断言失败`);
    console.error('═'.repeat(90));
    process.exitCode = 1;
  }
}

void main().catch(error => {
  console.error('演示失败：', error);
  process.exitCode = 1;
});
