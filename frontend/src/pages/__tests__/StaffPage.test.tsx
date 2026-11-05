import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StaffPage from '../StaffPage';

const mocks = vi.hoisted(() => ({
  workOrders: vi.fn(),
  staffLogin: vi.fn(),
  accept: vi.fn(),
  start: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
}));

vi.mock('../../services/mvpApi', () => ({ default: mocks }));

const order = {
  id: 'WO-STAFF-1',
  type: 'scene_verification',
  title: '东看台现场核查',
  description: '核查东看台人流',
  priority: 'high',
  region_id: 'R_EAST_STAND',
  status: 'ASSIGNED',
  created_by: { username: 'skyguard-agent', role: 'agent', kind: 'agent' },
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  approval: null,
  assigned_staff_id: 'STF-02',
  feedback: null,
  context_version: { observation: 1, constraint: 1, scenario: '1.0.0' },
  stale: false,
  stale_reason: null,
  history: [],
};

describe('工作人员移动端', () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => (mock as ReturnType<typeof vi.fn>).mockReset());
    mocks.workOrders.mockResolvedValue([order]);
    mocks.accept.mockResolvedValue({ ...order, status: 'ACCEPTED' });
    localStorage.clear();
  });

  it('未登录时显示登录表单', () => {
    render(<StaffPage />);
    expect(screen.getByText('SkyGuard 工作人员任务')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '登录' })).toBeDisabled();
  });

  it('登录后只展示指派给本人的工单并可接单', async () => {
    localStorage.setItem('staff_token', 'token');
    localStorage.setItem('staff_id', 'STF-02');
    localStorage.setItem('staff_name', '李巡（演示）');
    render(<StaffPage />);
    await waitFor(() => expect(screen.getByText('东看台现场核查')).toBeInTheDocument());
    expect(screen.getByText(/李巡/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '接单' }));
    await waitFor(() => expect(mocks.accept).toHaveBeenCalledWith('WO-STAFF-1'));
  });
});
