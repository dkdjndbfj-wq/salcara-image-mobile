import { foregroundTaskNotice } from '../remote/notification-policy';
import type { HubEvent } from '../remote/client';

const base = { deviceId: 'pc', sessionKey: 'codex:task', tool: 'codex' as const, ts: Date.now() };

test('only terminal results and actionable user requests create a foreground notice', () => {
  const notice = (event: HubEvent) => foregroundTaskNotice(event, '重构首页', false, 'Codex');
  expect(notice({ ...base, type: 'turn', status: 'completed' })?.icon).toBe('checkCircle');
  expect(notice({ ...base, type: 'turn', status: 'failed' })?.icon).toBe('alert');
  expect(notice({ ...base, type: 'message', id: 'reply', role: 'assistant', text: '完成', final: true })?.icon).toBe('chat');
  expect(notice({ ...base, type: 'message', id: 'commentary', role: 'assistant', text: '处理中', final: true, messagePhase: 'commentary' })).toBeNull();
  expect(notice({ ...base, type: 'message', id: 'child-reply', role: 'assistant', text: '子任务完成', final: true, parentId: 'subtask' })).toBeNull();
  expect(notice({ ...base, type: 'turn', status: 'started' })).toBeNull();
  expect(notice({ ...base, type: 'message', id: 'draft', role: 'assistant', text: '正在处理', final: false })).toBeNull();
  expect(notice({ ...base, type: 'approval.request', approvalId: 'ask', kind: 'command', title: '确认修改' })?.text).toContain('需要批准');
  expect(notice({ ...base, type: 'approval.request', approvalId: 'question', kind: 'question', title: '需要你选择' })?.text).toContain('需要你回答');
  expect(notice({ ...base, type: 'notice', level: 'error', text: '重试中', progress: true })).toBeNull();
});

test('the thread already on screen stays silent', () => {
  expect(foregroundTaskNotice({ ...base, type: 'turn', status: 'completed' }, '重构首页', true, 'Codex')).toBeNull();
  expect(foregroundTaskNotice({ ...base, type: 'message', id: 'reply', role: 'assistant', text: '完成', final: true }, '重构首页', true, 'Codex')).toBeNull();
});
