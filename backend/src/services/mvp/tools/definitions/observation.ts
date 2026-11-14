import { z } from 'zod';
import type { InvestigationOutcome } from '../../../safety/types';
import { cameraHealthFor } from '../../ingest';
import {
  ALL_ROLES,
  OPERATOR_ROLES,
  EmptyInput,
  ok,
  regionOf,
  latestAssessment,
  classifyTrustedObservation,
  summarizeStatus,
  agentActor,
  investigationResourceRequest,
  type ToolContext,
  type ToolDefinition,
} from '../core';

export function observationTools(ctx: ToolContext): ToolDefinition[] {
  return [
    {
      name: 'get_crowd_status',
      title: '读取人流态势',
      description: '返回指定区域或全部区域的当前人数、密度、置信度、时效、可信度与安全状态摘要。',
      inputSchema: z.object({ region_id: z.string().min(1).optional() }),
      roles: ALL_ROLES,
      source: 'safety-observation-store',
      timeout_ms: 3000,
      async handler(args, _actor) {
        const status = ctx.safety.getStatus();
        const regions = status.regions
          .filter(region => !args.region_id || region.id === args.region_id)
          .map(region => {
            const observation = ctx.safety.getObservationStore().latest(region.id);
            const assessment = latestAssessment(ctx, region.id);
            const risk = status.risks.find(item => item.regionId === region.id);
            return {
              region_id: region.id,
              region_name: region.name,
              area_m2: region.area_m2,
              observation: observation
                ? {
                  count: observation.estimated_count,
                  density: observation.estimated_density,
                  confidence: observation.confidence,
                  source: observation.source,
                  provider: observation.provider,
                  observed_at: observation.observed_at,
                  valid: observation.valid,
                  age_seconds: assessment ? Math.round(assessment.ageSeconds) : null,
                  trusted: assessment?.trusted ?? false,
                  untrusted_reasons: assessment?.untrustedReasons ?? [],
                }
                : null,
              risk: risk
                ? { level: risk.level, count: risk.count, density: risk.density, trusted: risk.trusted }
                : null,
            };
          });
        if (args.region_id && regions.length === 0) throw new Error(`unknown region: ${args.region_id}`);
        return ok({ state: status.state, regions, summary: summarizeStatus(status) }, 'safety-observation-store');
      },
    },
    {
      name: 'get_region_trend',
      title: '读取区域人流趋势',
      description: '返回区域时间序列、变化速率与预测趋势（预测由 ema-linear-v1 给出）。',
      inputSchema: z.object({
        region_id: z.string().min(1),
        window_minutes: z.number().int().positive().max(60).optional(),
      }),
      roles: ALL_ROLES,
      source: 'safety-observation-store+prediction',
      timeout_ms: 3000,
      async handler(args, _actor) {
        const windowMinutes = args.window_minutes ?? Math.max(5, Math.round(ctx.scenario.config.trend_window_seconds / 60));
        const now = ctx.now();
        const points = ctx.safety.getObservationStore().window(
          args.region_id,
          new Date(now.getTime() - windowMinutes * 60_000),
          now,
        );
        const prediction = ctx.prediction.predict(args.region_id, { windowMinutes, now });
        return ok({
          region_id: args.region_id,
          window_minutes: windowMinutes,
          points: points.map(item => ({
            observed_at: item.observed_at,
            count: item.estimated_count,
            density: item.estimated_density,
            confidence: item.confidence,
            source: item.source,
            valid: item.valid,
          })),
          prediction,
        }, prediction.sufficient ? 'safety-observation-store+prediction' : 'safety-observation-store', prediction.sufficient ? 0.8 : 0.4);
      },
    },
    {
      name: 'get_camera_status',
      title: '读取摄像头状态',
      description: '返回固定摄像头在线/降级/离线状态、最近观测时效与判定原因。',
      inputSchema: z.object({ region_id: z.string().min(1).optional() }),
      roles: ALL_ROLES,
      source: 'camera-health',
      timeout_ms: 3000,
      async handler(args, _actor) {
        return ok({ cameras: ctx.cameras(args.region_id) }, 'camera-health');
      },
    },
    {
      name: 'request_supplemental_observation',
      title: '请求补充观察',
      description: '查询其他摄像头或请求现场工作人员核查。摄像头查询直接返回证据；人员核查会创建待审批工单。',
      inputSchema: z.object({
        region_id: z.string().min(1),
        channel: z.enum(['camera', 'staff']),
        note: z.string().max(500).optional(),
      }),
      roles: OPERATOR_ROLES,
      source: 'camera-health+ops',
      timeout_ms: 5000,
      async handler(args, actor) {
        const region = regionOf(ctx, args.region_id);
        if (args.channel === 'camera') {
          const camera = cameraHealthFor(ctx.scenario, ctx.safety.getObservationStore(), args.region_id, ctx.now());
          const classified = classifyTrustedObservation(ctx, args.region_id);
          const outcome: InvestigationOutcome = camera.state !== 'online'
            ? (camera.state === 'offline' ? 'unavailable' : 'inconclusive')
            : classified?.outcome ?? 'unavailable';
          return ok({
            channel: 'camera',
            region_id: region.id,
            outcome,
            camera,
            evidence: classified && camera.state === 'online'
              ? {
                observation_id: classified.observation.id,
                count: classified.observation.estimated_count,
                density: classified.observation.estimated_density,
                confidence: classified.observation.confidence,
                observed_at: classified.observation.observed_at,
                trusted: classified.trusted,
                reason: classified.reason,
              }
              : null,
          }, 'camera-health', camera.confidence);
        }

        const recommendation = ctx.ops.recommendStaff({
          region_id: args.region_id,
          required_skills: ['crowd_check'],
        });
        const order = ctx.ops.createWorkOrder(agentActor(actor), {
          type: 'scene_verification',
          title: `${region.name}现场核查`,
          description: args.note ?? `请求工作人员核查 ${region.name} 的人流与通道状态，并回报现场情况。`,
          priority: 'high',
          region_id: args.region_id,
          required_skills: ['crowd_check'],
          evidence: [],
          recommendation: recommendation.recommended
            ? {
              staff_id: recommendation.recommended.staff_id,
              reasons: recommendation.recommended.reasons,
              score: recommendation.recommended.score,
            }
            : { staff_id: null, reasons: [recommendation.reason], score: null },
          submit: true,
          resource_request: investigationResourceRequest(
            ctx,
            'staff_check',
            recommendation.recommended?.staff_id,
          ),
        });
        return ok({
          channel: 'staff',
          region_id: region.id,
          outcome: 'inconclusive',
          pending: true,
          work_order: order,
          recommendation: {
            recommended: recommendation.recommended,
            shortage: recommendation.shortage,
            reason: recommendation.reason,
          },
        }, 'ops-work-order', null);
      },
    },
    {
      name: 'request_uav_observation',
      title: '申请无人机补充观察',
      description: '创建无人机观察请求（待审批）。无人机不会自动起飞，必须人工审批与持证操作员执行。',
      inputSchema: z.object({
        region_id: z.string().min(1),
        reason: z.string().min(1).max(500),
      }),
      roles: OPERATOR_ROLES,
      source: 'venue-uav+ops',
      timeout_ms: 5000,
      async handler(args, actor) {
        const region = regionOf(ctx, args.region_id);
        const units = ctx.scenario.venue?.uav_units ?? [];
        const availableUnits = units.filter(unit => unit.status === 'available');
        const recommendation = ctx.ops.recommendStaff({
          region_id: args.region_id,
          required_skills: ['uav_operation'],
          preferred_roles: ['uav_operator'],
        });
        const order = ctx.ops.createWorkOrder(agentActor(actor), {
          type: 'uav_observation',
          title: `${region.name}无人机补充观察`,
          description: `${args.reason}\n注：无人机起飞需现场负责人审批与持证操作员执行，系统不会自动起飞。`,
          priority: 'high',
          region_id: args.region_id,
          required_skills: ['uav_operation'],
          evidence: [],
          recommendation: recommendation.recommended
            ? {
              staff_id: recommendation.recommended.staff_id,
              reasons: recommendation.recommended.reasons,
              score: recommendation.recommended.score,
            }
            : { staff_id: null, reasons: [recommendation.reason], score: null },
          submit: true,
          resource_request: investigationResourceRequest(
            ctx,
            'uav_request',
            recommendation.recommended?.staff_id,
          ),
        });
        return ok({
          outcome: 'inconclusive',
          pending: true,
          requested: true,
          available_units: availableUnits,
          all_units: units,
          work_order: order,
          recommendation: {
            recommended: recommendation.recommended,
            shortage: recommendation.shortage,
          },
        }, 'venue-uav+ops', null);
      },
    },
    {
      name: 'get_venue_information',
      title: '读取场馆信息',
      description: '返回场馆名称、类型、区域、出口与无人机资源概况。',
      inputSchema: EmptyInput,
      roles: ALL_ROLES,
      source: 'scenario',
      timeout_ms: 2000,
      async handler(_args, _actor) {
        return ok({
          scenario_id: ctx.scenario.scenario_id,
          name: ctx.scenario.venue?.name ?? ctx.scenario.name,
          kind: ctx.scenario.venue?.kind ?? 'unknown',
          description: ctx.scenario.venue?.description ?? ctx.scenario.description,
          notice: ctx.scenario.notice,
          regions: ctx.scenario.regions.map(region => ({ id: region.id, name: region.name, area_m2: region.area_m2 })),
          exits: ctx.scenario.exits.map(exit => ({ id: exit.id, name: exit.name, region_id: exit.region_id, capacity_per_min: exit.capacity_per_min })),
          uav_units: ctx.scenario.venue?.uav_units ?? [],
        }, 'scenario', null);
      },
    },
    {
      name: 'get_venue_rules',
      title: '读取场馆管理规则',
      description: '返回与安全、审批、无人机、人员调度相关的场馆规则。',
      inputSchema: z.object({ category: z.string().min(1).optional() }),
      roles: ALL_ROLES,
      source: 'scenario-venue-rules',
      timeout_ms: 2000,
      async handler(args, _actor) {
        const rules = (ctx.scenario.venue?.rules ?? []).filter(rule => !args.category || rule.category === args.category);
        return ok({ rules, mandatory_count: rules.filter(rule => rule.mandatory).length }, 'scenario-venue-rules');
      },
    },
    {
      name: 'predict_crowd_trend',
      title: '预测短时人流',
      description: '调用 ema-linear-v1 预测区域短时人数、趋势方向与误差区间，并说明数据充分性。',
      inputSchema: z.object({
        region_id: z.string().min(1),
        horizon_minutes: z.number().int().positive().max(30).optional(),
      }),
      roles: ALL_ROLES,
      source: 'prediction:ema-linear-v1',
      timeout_ms: 3000,
      async handler(args, _actor) {
        const result = ctx.prediction.predict(args.region_id, { horizonMinutes: args.horizon_minutes, now: ctx.now() });
        return ok(result, 'prediction:ema-linear-v1', result.sufficient ? 0.8 : 0.4);
      },
    },
    {
      name: 'evaluate_region_risk',
      title: '评估区域风险',
      description: '结合安全域风险评估与短时预测，返回区域风险等级、趋势与可信度。',
      inputSchema: z.object({ region_id: z.string().min(1) }),
      roles: ALL_ROLES,
      source: 'safety-risk+prediction',
      timeout_ms: 3000,
      async handler(args, _actor) {
        const status = ctx.safety.getStatus();
        const risk = status.risks.find(item => item.regionId === args.region_id);
        if (!risk) throw new Error(`unknown region: ${args.region_id}`);
        const prediction = ctx.prediction.predict(args.region_id, { now: ctx.now() });
        return ok({
          region_id: args.region_id,
          risk,
          state: status.state.state,
          prediction: {
            predicted_count: prediction.predicted_count,
            trend: prediction.trend,
            sufficient: prediction.sufficient,
            uncertainty_note: prediction.uncertainty_note,
          },
        }, 'safety-risk+prediction', risk.trusted ? 0.8 : 0.4);
      },
    },
  ];
}
