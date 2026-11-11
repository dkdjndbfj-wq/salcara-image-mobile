import type { HubEvent } from '../remote/client';
import { createTaskNotificationPolicy, taskNoticeKind } from '../remote/notification-policy';

type Turn = Extract<HubEvent, { type: 'turn' }>;
type Message = Extract<HubEvent, { type: 'message' }>;
type Approval = Extract<HubEvent, { type: 'approval.request' }>;
const now = 4_000_000;
const scope = 'station-a:credential-a';
const base = { deviceId: 'pc', sessionKey: 'hermes:task', tool: 'hermes', turnId: 'turn-a', ts: now };
const turn = (status: Turn['status'], extra: Partial<Turn> = {}): Turn => ({ ...base, type: 'turn', status, ...extra });
const reply = (extra: Partial<Message> = {}): Message => ({ ...base, type: 'message', id: 'reply-a', role: 'assistant', text: '完成', final: true, ...extra });
const approval = (extra: Partial<Approval> = {}): Approval => ({ ...base, type: 'approval.request', approvalId: 'approval-a', kind: 'command', title: '确认执行', ...extra });
const resolved = (approvalId = 'approval-a', extra: Partial<Extract<HubEvent, { type: 'approval.resolved' }>> = {}): HubEvent =>
  ({ ...base, type: 'approval.resolved', approvalId, decision: 'allow', by: 'phone', ...extra });

test.each(['reply-first', 'complete-first'] as const)('a normal result pair creates one notification: %s', order => {
  const policy = createTaskNotificationPolicy();
  const events = order === 'reply-first' ? [reply(), turn('completed')] : [turn('completed'), reply()];
  expect(policy.observe(events[0], scope, now)).toMatchObject({ scope, urgent: false, upgrade: false });
  expect(policy.observe(events[1], scope, now + 1)).toBeNull();
});

test.each([reply(), turn('completed')])('a later same-turn failure upgrades an earlier $type result', ordinary => {
  const policy = createTaskNotificationPolicy();
  const first = policy.observe(ordinary, scope, now)!;
  const failed = policy.observe(turn('failed', { ts: now + 9000 }), scope, now + 9000)!;
  expect(failed).toMatchObject({ id: first.id, scope, kind: 'failed', urgent: true, upgrade: true });
  expect(policy.observe(turn('completed', { ts: now + 10_000 }), scope, now + 10_000)).toBeNull();
  expect(policy.observe(reply({ id: 'late-reply', ts: now + 11_000 }), scope, now + 11_000)).toBeNull();
  expect(policy.observe(turn('failed', { ts: now + 12_000 }), scope, now + 12_000)).toBeNull();
});

test('a second turn failing within eight seconds is not rate-limited away', () => {
  const policy = createTaskNotificationPolicy();
  const first = policy.observe(turn('completed'), scope, now)!;
  const second = policy.observe(turn('failed', { turnId: 'turn-b', ts: now + 1000 }), scope, now + 1000)!;
  expect(second).toMatchObject({ kind: 'failed', urgent: true, upgrade: false });
  expect(second.id).not.toBe(first.id);
});

test('two different failed turns within eight seconds both remain actionable', () => {
  const policy = createTaskNotificationPolicy();
  expect(policy.observe(turn('failed'), scope, now)?.urgent).toBe(true);
  expect(policy.observe(turn('failed', { turnId: 'turn-b', ts: now + 1 }), scope, now + 1)?.urgent).toBe(true);
});

test('different conversations are not accidentally deduplicated by a shared turn id', () => {
  const policy = createTaskNotificationPolicy();
  const first = policy.observe(turn('completed'), scope, now)!;
  const second = policy.observe(turn('completed', { sessionKey: 'hermes:other' }), scope, now)!;
  expect(second).not.toBeNull();
  expect(second.id).not.toBe(first.id);
});

test('the same device/session/turn ids on two saved connections are isolated', () => {
  const policy = createTaskNotificationPolicy();
  const first = policy.observe(turn('completed'), scope, now)!;
  const second = policy.observe(turn('failed'), 'station-b:credential-b', now + 1)!;
  expect(second).toMatchObject({ scope: 'station-b:credential-b', kind: 'failed', urgent: true, upgrade: false });
  expect(second.id).not.toBe(first.id);
});

test.each(['command', 'question'] as const)('%s requests have independent urgent identities inside an existing turn', kind => {
  const policy = createTaskNotificationPolicy();
  const result = policy.observe(reply(), scope, now)!;
  const request = policy.observe(approval({ kind }), scope, now + 1)!;
  expect(request).toMatchObject({ kind: kind === 'question' ? 'question' : 'approval', urgent: true, upgrade: false });
  expect(request.id).not.toBe(result.id);
  expect(policy.observe(approval({ kind }), scope, now + 2)).toBeNull();
  const other = policy.observe(approval({ kind, approvalId: 'approval-b' }), scope, now + 3)!;
  expect(other.id).not.toBe(request.id);
});

test('a resolved request is not revived by a replayed request event', () => {
  const policy = createTaskNotificationPolicy();
  expect(policy.observe(approval(), scope, now)).not.toBeNull();
  expect(policy.observe(resolved(), scope, now + 1)).toBeNull();
  expect(policy.observe(approval(), scope, now + 2)).toBeNull();
});

test('a resolution observed before its old request still suppresses the stale replay', () => {
  const policy = createTaskNotificationPolicy();
  expect(policy.observe(resolved(), scope, now)).toBeNull();
  expect(policy.observe(approval({ ts: now - 1000 }), scope, now + 1)).toBeNull();
  expect(policy.observe(approval({ approvalId: 'approval-b' }), scope, now + 2)).not.toBeNull();
});

test.each(['command', 'question'] as const)('expired %s requests do not generate a notification', kind => {
  const request = approval({ kind, expiresAt: now });
  expect(taskNoticeKind(request, now)).toBeNull();
  expect(createTaskNotificationPolicy().observe(request, scope, now)).toBeNull();
});

test('an old but still valid question is not discarded by the normal freshness window', () => {
  const request = approval({ kind: 'question', ts: now - 20 * 60_000, expiresAt: now + 60_000 });
  expect(taskNoticeKind(request, now)).toBe('question');
  expect(createTaskNotificationPolicy().observe(request, scope, now)).toMatchObject({
    kind: 'question', urgent: true, stale: true, expiresAt: now + 60_000,
  });
});

test.each(['completed', 'failed'] as const)('an older %s result remains available for an offline digest', status => {
  expect(createTaskNotificationPolicy().observe(turn(status, { ts: now - 20 * 60_000 }), scope, now))
    .toMatchObject({ kind: status, urgent: status === 'failed', stale: true });
});

test('without turnId, a started event establishes the identity for reply, completion and failure', () => {
  const policy = createTaskNotificationPolicy();
  expect(policy.observe(turn('started', { turnId: undefined, seq: 10 }), scope, now)).toBeNull();
  const first = policy.observe(reply({ turnId: undefined, seq: 11 }), scope, now + 1)!;
  expect(policy.observe(turn('completed', { turnId: undefined, seq: 12 }), scope, now + 2)).toBeNull();
  expect(policy.observe(turn('failed', { turnId: undefined, seq: 13 }), scope, now + 3))
    .toMatchObject({ id: first.id, kind: 'failed', upgrade: true });
  expect(policy.observe(turn('started', { turnId: undefined, seq: 14, ts: now + 4 }), scope, now + 4)).toBeNull();
  const next = policy.observe(turn('failed', { turnId: undefined, seq: 15, ts: now + 5 }), scope, now + 5)!;
  expect(next).toMatchObject({ kind: 'failed', urgent: true, upgrade: false });
  expect(next.id).not.toBe(first.id);
});

test('replaying the same started event does not reset a delivered legacy turn', () => {
  const policy = createTaskNotificationPolicy();
  const started = turn('started', { turnId: undefined, seq: 1 });
  policy.observe(started, scope, now);
  expect(policy.observe(reply({ turnId: undefined, seq: 2 }), scope, now + 1)).not.toBeNull();
  policy.observe(started, scope, now + 2);
  expect(policy.observe(turn('completed', { turnId: undefined, seq: 3 }), scope, now + 3)).toBeNull();
});

test.each(['reply-first', 'complete-first'] as const)('without turnId or started, complementary legacy events merge: %s', order => {
  const policy = createTaskNotificationPolicy();
  const message = reply({ turnId: undefined, seq: 1 });
  const complete = turn('completed', { turnId: undefined, seq: 2 });
  const events = order === 'reply-first' ? [message, complete] : [complete, message];
  expect(policy.observe(events[0], scope, now)).not.toBeNull();
  expect(policy.observe(events[1], scope, now + 1000)).toBeNull();
});

test.each(['reply', 'completed', 'failed'] as const)('a new same-kind legacy %s event is not mistaken for the previous task', kind => {
  const policy = createTaskNotificationPolicy();
  const firstEvent = kind === 'reply' ? reply({ turnId: undefined, seq: 1 }) : turn(kind, { turnId: undefined, seq: 1 });
  const nextEvent = kind === 'reply' ? reply({ turnId: undefined, id: 'reply-b', seq: 2, ts: now + 1 }) : turn(kind, { turnId: undefined, seq: 2, ts: now + 1 });
  const first = policy.observe(firstEvent, scope, now)!;
  expect(policy.observe(firstEvent, scope, now + 1)).toBeNull();
  const next = policy.observe(nextEvent, scope, now + 2)!;
  expect(next).not.toBeNull();
  expect(next.id).not.toBe(first.id);
});

test('the legacy pairing window is bounded rather than merging later independent work forever', () => {
  const policy = createTaskNotificationPolicy({ legacyWindowMs: 1000 });
  const first = policy.observe(reply({ turnId: undefined, seq: 1 }), scope, now)!;
  const next = policy.observe(turn('completed', { turnId: undefined, seq: 2, ts: now + 1001 }), scope, now + 1001)!;
  expect(next).not.toBeNull();
  expect(next.id).not.toBe(first.id);
});

test('distinct legacy messages sharing a timestamp do not collapse without a sequence cursor', () => {
  const policy = createTaskNotificationPolicy();
  const first = policy.observe(reply({ turnId: undefined, id: 'reply-a', ts: now }), scope, now)!;
  const next = policy.observe(reply({ turnId: undefined, id: 'reply-b', ts: now }), scope, now + 1)!;
  expect(next).not.toBeNull();
  expect(next.id).not.toBe(first.id);
});

test.each([
  reply({ final: false }), reply({ messagePhase: 'commentary' }), reply({ parentId: 'parent' }),
  turn('completed', { parentId: 'parent' }), turn('started'), turn('interrupted'),
  { ...base, type: 'reasoning', id: 'reasoning', text: '分析', final: true } as HubEvent,
  { ...base, type: 'tool', id: 'tool', kind: 'command', title: '执行命令', status: 'done' } as HubEvent,
  { ...base, type: 'notice', level: 'error', text: '重试中', progress: true } as HubEvent,
])('process and child-task noise stay silent: $type', event => {
  expect(createTaskNotificationPolicy().observe(event, scope, now)).toBeNull();
});

test('clearing one scope preserves the other saved connection dedup state', () => {
  const policy = createTaskNotificationPolicy();
  policy.observe(turn('completed'), scope, now);
  policy.observe(turn('completed'), 'other', now);
  policy.clearScope(scope);
  expect(policy.observe(turn('completed'), scope, now + 1)).not.toBeNull();
  expect(policy.observe(turn('completed'), 'other', now + 1)).toBeNull();
});

test('clearing the policy retires all connection history', () => {
  const policy = createTaskNotificationPolicy();
  policy.observe(turn('failed'), scope, now);
  policy.observe(approval(), 'other', now);
  policy.clear();
  expect(policy.observe(turn('failed'), scope, now + 1)).toMatchObject({ upgrade: false });
  expect(policy.observe(approval(), 'other', now + 1)).not.toBeNull();
});

test('expired dedup records do not permanently suppress later recovery', () => {
  const policy = createTaskNotificationPolicy({ retentionMs: 1000 });
  expect(policy.observe(turn('failed'), scope, now)).not.toBeNull();
  expect(policy.observe(turn('failed'), scope, now + 500)).toBeNull();
  expect(policy.observe(turn('failed'), scope, now + 2000)).not.toBeNull();
});
