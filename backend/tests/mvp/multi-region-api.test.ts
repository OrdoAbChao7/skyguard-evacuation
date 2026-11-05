import assert from 'node:assert/strict';
import test from 'node:test';
import { startTestServer } from '../helpers/api-fixtures';

test('多区域协同 API 返回风险传播、优先级与联合调查决策', async () => {
  const server = await startTestServer();
  try {
    await server.request('/api/v1/mvp/reset', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const response = await server.request('/api/v1/mvp/multi-region?region_id=R_EAST_STAND');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.available, true);
    assert.equal(response.body.target_region_id, 'R_EAST_STAND');
    assert.equal(response.body.propagated_risks.length, 8);
    assert.equal(response.body.priorities.length, 8);
    const uav = response.body.decision.evaluations.find((item: { action_id: string }) => item.action_id === 'A_UAV');
    assert.ok(uav.covered_regions.length > 1);
    assert.ok(uav.covered_regions.some((item: { region_id: string }) => item.region_id === 'R_NORTH_CONCOURSE' || item.region_id === 'R_SOUTH_CONCOURSE'));
  } finally {
    await server.close();
  }
});
