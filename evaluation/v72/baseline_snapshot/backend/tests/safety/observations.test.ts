import assert from 'node:assert/strict';
import test from 'node:test';
import { loadSafetyScenario } from '../../src/services/safety/scenario';
import { ObservationStore, buildObservation } from '../../src/services/safety/observations';

const scenario = loadSafetyScenario('stadium-evacuation.json');
const region = scenario.regions[0];

function observation(at: string, count = 120) {
  return buildObservation({
    region,
    count,
    confidence: 0.9,
    source: 'simulation',
    provider: 'test-harness',
    modelVersion: 'test/1.0.0',
    observedAt: new Date(at),
    receivedAt: new Date('2026-11-09T10:10:00.000Z'),
  });
}

test('相同来源与内容的重复上报被忽略，不增加观测版本', () => {
  const store = new ObservationStore();
  assert.equal(store.ingest(observation('2026-11-09T10:00:00.000Z')).accepted, true);
  const duplicate = store.ingest(observation('2026-11-09T10:00:00.000Z'));
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(store.getVersion(), 1);
  assert.equal(store.window(region.id, new Date('2026-11-09T09:00:00.000Z'), new Date('2026-11-09T11:00:00.000Z')).length, 1);
});

test('乱序到达的旧观测不会覆盖较新的最新观测', () => {
  const store = new ObservationStore();
  store.ingest(observation('2026-11-09T10:05:00.000Z', 150));
  store.ingest(observation('2026-11-09T10:00:00.000Z', 100));
  assert.equal(store.latest(region.id)?.observed_at, '2026-11-09T10:05:00.000Z');
  const window = store.window(region.id, new Date('2026-11-09T09:00:00.000Z'), new Date('2026-11-09T11:00:00.000Z'));
  assert.deepEqual(window.map(item => item.observed_at), [
    '2026-11-09T10:00:00.000Z',
    '2026-11-09T10:05:00.000Z',
  ]);
  assert.equal(store.getVersion(), 2);
});

test('不同人数或不同时间是独立观测', () => {
  const store = new ObservationStore();
  store.ingest(observation('2026-11-09T10:00:00.000Z', 100));
  store.ingest(observation('2026-11-09T10:00:00.000Z', 101));
  store.ingest(observation('2026-11-09T10:01:00.000Z', 100));
  assert.equal(store.getVersion(), 3);
});
