/**
 * 人员名册、身份校验与推荐评分。
 *
 * 全部为纯函数：运行时状态由调用方以 Map 注入，便于持久化与测试。
 */
import type { SafetyScenario, StaffMember } from '../../safety/types';
import type { RecommendStaffResult, StaffRecommendation } from './model';
import { STAFF_STATUSES, travelSecondsBetween } from './model';

export type StaffView = StaffMember & { runtime_status: string };

export function listStaff(
  scenario: SafetyScenario,
  staffStatus: Map<string, StaffMember['status']>,
): StaffView[] {
  return scenario.staff.map(member => ({
    ...member,
    runtime_status: staffStatus.get(member.id) ?? member.status,
  }));
}

export function getStaff(
  scenario: SafetyScenario,
  staffStatus: Map<string, StaffMember['status']>,
  staffId: string,
): StaffView | undefined {
  const member = scenario.staff.find(item => item.id === staffId);
  if (!member) return undefined;
  return { ...member, runtime_status: staffStatus.get(member.id) ?? member.status };
}

/** 演示用身份校验：真实部署必须替换为正式身份系统。 */
export function authenticateStaff(
  scenario: SafetyScenario,
  staffId: string,
  accessCode: string,
): StaffMember | null {
  const member = scenario.staff.find(item => item.id === staffId);
  if (!member || !member.access_code) return null;
  return member.access_code === accessCode ? member : null;
}

export function recommendStaff(
  scenario: SafetyScenario,
  staffStatus: Map<string, StaffMember['status']>,
  input: {
    region_id: string;
    required_skills?: string[];
    preferred_roles?: string[];
  },
): RecommendStaffResult {
  const regionId = input.region_id;
  const requiredSkills = input.required_skills ?? [];
  const preferredRoles = new Set(input.preferred_roles ?? []);
  const regionExists = scenario.regions.some(region => region.id === regionId);
  if (!regionExists) throw new Error(`unknown region: ${regionId}`);

  const candidates: StaffRecommendation[] = [];
  for (const member of scenario.staff) {
    const runtimeStatus = staffStatus.get(member.id) ?? member.status;
    const reasons: string[] = [];
    const missingSkills = requiredSkills.filter(skill => !member.skills.includes(skill));

    if (runtimeStatus !== STAFF_STATUSES.available) {
      reasons.push(`当前状态为 ${runtimeStatus}，不可派单`);
    }
    if (missingSkills.length > 0) {
      reasons.push(`缺少技能：${missingSkills.join('、')}`);
    }

    const travel = travelSecondsBetween(scenario, member.region_id, regionId);
    if (travel === null) reasons.push('按现有通道不可达（需人工确认）');

    const available = runtimeStatus === STAFF_STATUSES.available;
    const skillOk = missingSkills.length === 0;
    const reachable = travel !== null;
    let score: number | null = null;
    if (available && skillOk && reachable) {
      const travelMinutes = travel / 60;
      const roleBonus = preferredRoles.has(member.role) ? 12 : 0;
      const skillBonus = requiredSkills.length > 0 ? 10 : 4;
      score = Number((100 - travelMinutes * 2 + roleBonus + skillBonus).toFixed(2));
      reasons.push(`状态可用`);
      reasons.push(requiredSkills.length > 0 ? `技能匹配：${requiredSkills.join('、')}` : '无强制技能要求');
      reasons.push(`预计到达 ${travelMinutes.toFixed(1)} 分钟`);
      if (roleBonus > 0) reasons.push(`岗位匹配：${member.role}`);
    }

    candidates.push({
      staff_id: member.id,
      name: member.name,
      role: member.role,
      region_id: member.region_id,
      status: runtimeStatus,
      skills: member.skills,
      travel_seconds: travel,
      travel_minutes: travel === null ? null : Number((travel / 60).toFixed(2)),
      score,
      reasons,
      source: member.source,
      verified: member.verified,
    });
  }

  const ranked = candidates
    .filter(item => item.score !== null)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const recommended = ranked[0] ?? null;

  return {
    region_id: regionId,
    required_skills: requiredSkills,
    candidates: candidates.sort((a, b) => {
      if (a.score === null && b.score === null) return a.staff_id.localeCompare(b.staff_id);
      if (a.score === null) return 1;
      if (b.score === null) return -1;
      return b.score - a.score;
    }),
    recommended,
    shortage: recommended === null,
    reason: recommended
      ? `推荐 ${recommended.name}（${recommended.staff_id}）：${recommended.reasons.join('；')}`
      : '没有同时满足状态、技能与可达性要求的可用人员，需人工协调或调整任务。',
  };
}
