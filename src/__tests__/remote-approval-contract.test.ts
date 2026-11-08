import { approvalDecisions, normalizeApprovalOptions } from '../remote/approvals';
import { applyEvent } from '../remote/store';
import type { HubEvent } from '../remote/client';

test('legacy requests offer once-only actions without assuming Codex session grants', () => {
  expect(approvalDecisions({})).toEqual(['allow', 'deny']);
});

test.each([null, 7, [], { version: 2, decisions: ['allow'] }, { version: 1, decisions: 'allow' }, { version: 1, decisions: Array(17).fill('allow') }])('malformed or future descriptor %p cannot add grants', raw => {
  expect(normalizeApprovalOptions(raw)).toEqual({ version: 0, decisions: [] });
});

test('adapter decisions are bounded and preserved without exposing unknown action identifiers', () => {
  const options = normalizeApprovalOptions({ version: 1, decisions: ['allow_session', 'allow', 'allow', 'arbitraryAction', 'deny'] });
  expect(options).toEqual({ version: 1, decisions: ['allow', 'allow_session', 'deny'] });
  expect(approvalDecisions({ approvalOptions: options })).toEqual(['allow', 'allow_session', 'deny']);
  expect(approvalDecisions({ approvalOptions: options, approval: 'question' })).toEqual(['allow', 'deny']);
  expect(approvalDecisions({ approvalOptions: options, approvalTransport: 'codex-hook-v1' })).toEqual(['allow', 'deny']);
  expect(approvalDecisions({ approvalOptions: { version: 1, decisions: [] } })).toEqual([]);
});

test('request projection retains turn and parent association and copies action choices', () => {
  const event: HubEvent = { type: 'approval.request', tool: 'claude', deviceId: 'pc', sessionKey: 'claude:s', ts: 1,
    approvalId: 'request', kind: 'tool', title: 'Synthetic tool', turnId: 'turn', parentId: 'child', approvalOptions: { version: 1, decisions: ['allow', 'deny'] } };
  const result = applyEvent({ items: [], loading: false }, event);
  event.approvalOptions!.decisions.push('allow_session');
  expect(result.items[0]).toMatchObject({ turnId: 'turn', parentId: 'child', approvalOptions: { version: 1, decisions: ['allow', 'deny'] } });
});

test('a delayed older worker-status snapshot cannot restore waiting after a newer idle snapshot', () => {
  const current: Extract<HubEvent, { type: 'session.updated' }> = { type: 'session.updated', deviceId: 'pc', sessionKey: 'claude:s', tool: 'claude', seq: 10, ts: 1001,
    session: { sessionKey: 'claude:s', tool: 'claude', client: 'Claude Code', controllable: true, title: 'Synthetic', cwd: 'C:\\fixture', status: 'idle', updatedAt: 1001 } };
  const timeline = applyEvent({ items: [], loading: false }, current);
  // Transport arrival order is newer, but the native snapshot was committed
  // earlier. A monotonic native timestamp, not the Hub sequence, owns status.
  const delayed: HubEvent = { ...current, seq: 11, ts: 1000,
    session: { ...current.session, status: 'waiting_approval', updatedAt: 1000 } };
  expect(applyEvent(timeline, delayed).session).toEqual(current.session);
});
