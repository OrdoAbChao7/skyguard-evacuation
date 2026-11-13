import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dominates,
  paretoFront,
  selectConstrained,
  selectKnee,
  type ObjectiveVector,
  type ParetoCandidate,
} from '../../src/services/safety/planning/multi-objective';

const candidate = (id: string, vector: Partial<ObjectiveVector>): ParetoCandidate<string> => ({
  id,
  payload: id,
  vector: {
    unresolved: 0, makespan: 10, queuePersonMinutes: 20000, switchPersons: 1000, emergencyDelay: 1,
    ...vector,
  },
});

test('支配关系与 Pareto 前沿正确', () => {
  const a = candidate('a', { makespan: 9, queuePersonMinutes: 19000 });
  const b = candidate('b', { makespan: 11, queuePersonMinutes: 22000 });
  const c = candidate('c', { makespan: 10, queuePersonMinutes: 18000, switchPersons: 1200 });
  assert.equal(dominates(a.vector, b.vector), true);
  assert.equal(dominates(b.vector, a.vector), false);
  const front = paretoFront([a, b, c]);
  assert.deepEqual(front.map(item => item.id).sort(), ['a', 'c']);
});

test('膝点选择随优先级改变', () => {
  const efficiency = candidate('eff', { makespan: 8, queuePersonMinutes: 15000, switchPersons: 3000, emergencyDelay: 2 });
  const stability = candidate('stab', { makespan: 12, queuePersonMinutes: 26000, switchPersons: 500, emergencyDelay: 1 });
  const front = paretoFront([efficiency, stability]);
  assert.equal(selectKnee(front, 'efficiency')?.id, 'eff');
  assert.equal(selectKnee(front, 'stability')?.id, 'stab');
});

test('约束选择在无可行解时返回 null，不静默放宽', () => {
  const a = candidate('a', { unresolved: 5, makespan: 12 });
  const b = candidate('b', { unresolved: 0, makespan: 15 });
  const selected = selectConstrained([a, b], { maxUnresolved: 0, maxMakespan: 12 });
  assert.equal(selected, null);
  const feasible = selectConstrained([a, b], { maxMakespan: 16 });
  assert.equal(feasible?.id, 'b');
});

test('安全优先级下零未疏散候选胜出', () => {
  const unsafe = candidate('unsafe', { unresolved: 10, makespan: 7, queuePersonMinutes: 12000 });
  const safe = candidate('safe', { unresolved: 0, makespan: 12, queuePersonMinutes: 26000 });
  assert.equal(selectKnee([unsafe, safe], 'safety')?.id, 'safe');
});
