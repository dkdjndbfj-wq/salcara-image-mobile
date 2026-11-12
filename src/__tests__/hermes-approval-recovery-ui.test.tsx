import React from 'react';
import { AppState } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

// Reuse the real Direct wire parser and persistent outbox, with a bounded
// in-memory transport. Only the final conversation renderer is a probe.
const mockMessages = new Set<(frame: unknown) => void>(), mockConnections = new Set<() => void>();
const mockSettings = new Map<string, string>(), mockSend = jest.fn();
let mockConnection: any = { status: 'connected', deviceId: 'pc', deviceName: 'Computer' };
let mockGeneration = 1, mockScope = 'approval-pairing', mockConversation: any, mockNewComposer: any;
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string) => { mockSettings.set(key, value); } }));
jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID(), CryptoDigestAlgorithm: { SHA256: 'SHA256' },
  digestStringAsync: async (_algorithm: string, value: string) => require('node:crypto').createHash('sha256').update(value).digest('hex') }));
jest.mock('../remote/direct-pairing', () => ({
  getDirectConnectionState: () => mockConnection, directDeliveryScope: () => mockScope, directConnectionGeneration: () => mockGeneration,
  subscribeDirectConnection: (listener: () => void) => { mockConnections.add(listener); return () => mockConnections.delete(listener); },
  subscribeDirectMessages: (listener: (frame: unknown) => void) => { mockMessages.add(listener); return () => mockMessages.delete(listener); },
  sendDirectPayload: (frame: unknown) => mockSend(frame),
}));
jest.mock('../remote/direct-workspace', () => ({ createDirectWorkspaceRuntime: () => ({ scope: 'approval-pairing' }) }));
jest.mock('../remote/DirectNewComposer', () => ({ DirectNewComposer: (props: any) => { mockNewComposer = props; return null; } }));
jest.mock('../remote/DirectConversation', () => ({ DirectConversation: (props: any) => { mockConversation = props; return null; } }));

const { cancelDirectRequests, requestDirect } = require('../remote/direct-api') as typeof import('../remote/direct-api');
const { resetQuestionOutboxForTests } = require('../remote/question-outbox') as typeof import('../remote/question-outbox');
const { DirectExperience } = require('../remote/DirectExperience') as typeof import('../remote/DirectExperience');
const session = { sessionKey: 'hermes:fixture', tool: 'hermes', client: 'Hermes', title: 'Original', cwd: 'C:/project',
  updatedAt: 1, status: 'waiting_approval', activeTurnId: 'turn-1', controllable: true, controlSurface: 'cli' };
const api = { name: 'API', model: 'model', protocol: 'chat', configured: true, pending: false, source: 'computer', accountId: 'api_00112233' };
const base = { deviceId: 'pc', sessionKey: session.sessionKey, tool: 'hermes' };
const approvalId = 'hermes:fixture:approval-1';
const request = { ...base, type: 'approval.request', approvalId, kind: 'tool', title: 'Confirm exactly once', ts: 2, seq: 2,
  approvalOptions: { version: 1, decisions: ['allow', 'deny'] } };
let hostHistory: any, approvalOutcome: 'uncertain' | 'reject' | 'success';
let negotiatedQuestions: boolean, initializeQuestions: boolean, statusReads: number, statusMode: 'success' | 'fail' | 'defer';
let finishStatus: (() => void) | undefined;
let failHistory: boolean;
const deliver = (frame: unknown) => mockMessages.forEach(listener => listener(frame));
const frames = (type: string) => mockSend.mock.calls.map(([frame]) => frame).filter(frame => frame.command.type === type);
const receipts = () => JSON.parse(mockSettings.get('remote_question_outbox_v1') ?? '[]') as import('../remote/question-outbox').QuestionReceipt[];

beforeEach(() => {
  cancelDirectRequests(); resetQuestionOutboxForTests(); jest.useFakeTimers(); jest.clearAllMocks(); mockSettings.clear();
  mockGeneration = 1; mockScope = 'approval-pairing'; mockConnection = { status: 'connected', deviceId: 'pc', deviceName: 'Computer' }; mockConversation = undefined; mockNewComposer = undefined;
  negotiatedQuestions = true; initializeQuestions = false; statusReads = 0; statusMode = 'success'; finishStatus = undefined; failHistory = false;
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  approvalOutcome = 'uncertain'; hostHistory = { session, events: [request] };
  mockSend.mockImplementation((frame: any) => {
    expect(frame.type).toBe('command'); expect(frame.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const command = frame.command; let result: unknown;
    switch (command.type) {
      case 'agents.status':
        statusReads++;
        result = { agents: [{ id: 'hermes', tool: 'hermes', name: 'Hermes', available: true, remoteSendSupported: true,
          capabilities: { list: true, read: true, send: true, interrupt: true, preciseInterrupt: true, approval: true,
            questions: negotiatedQuestions, startModelOverride: true }, api }] };
        if (statusReads > 1 && statusMode !== 'success') {
          const reply = result;
          finishStatus = () => deliver(statusMode === 'fail'
            ? { type: 'response', requestId: frame.requestId, error: 'Status unavailable', code: 'agent_unavailable' }
            : { type: 'response', requestId: frame.requestId, result: reply });
          if (statusMode === 'fail') void Promise.resolve().then(finishStatus);
          return;
        }
        break;
      case 'projects.list': result = { projects: [{ path: session.cwd, name: 'Project' }] }; break;
      case 'sessions.list': expect(command.tool).toBe('hermes'); result = { sessions: [session] }; break;
      case 'session.start':
        if (initializeQuestions) negotiatedQuestions = true;
        result = { sessionKey: session.sessionKey }; break;
      case 'session.open':
        expect(command.sessionKey).toBe(session.sessionKey);
        if (failHistory) {
          void Promise.resolve().then(() => deliver({ type: 'response', requestId: frame.requestId, error: 'History unavailable', code: 'agent_unavailable' }));
          return;
        }
        if (initializeQuestions) negotiatedQuestions = true;
        result = hostHistory; break;
      case 'approval.respond':
        expect(command).toMatchObject({ approvalId, sessionKey: session.sessionKey, controlSurface: 'cli', accountId: api.accountId });
        expect(command.operationId).toBe(frame.requestId);
        if (approvalOutcome !== 'success') {
          const code = approvalOutcome === 'uncertain' ? 'command_delivery_uncertain' : 'approval_rejected';
          void Promise.resolve().then(() => deliver({ type: 'response', requestId: frame.requestId, error: 'Native approval response', code }));
          return;
        }
        result = {}; break;
      default: throw new Error(`Unexpected command: ${command.type}`);
    }
    void Promise.resolve().then(() => deliver({ type: 'response', requestId: frame.requestId, result }));
  });
});
afterEach(() => { cancelDirectRequests(); jest.useRealTimers(); });
async function open() {
  const view = await render(<DirectExperience />);
  await fireEvent.press(await view.findByRole('button', { name: '打开对话 Original' }));
  await waitFor(() => expect(mockConversation.approvalReady).toBe(true));
  return view;
}

test.each(['text', 'enum'] as const)('Direct cold start refreshes explicitly advertised %s Questions after start/open', async inputType => {
  negotiatedQuestions = false; initializeQuestions = true; approvalOutcome = 'success';
  const nativeId = 'approval-1', answer = inputType === 'enum' ? 'raw, choice' : 'custom text';
  const question = { id: nativeId, question: 'Which value?', inputType, required: true, allowCustom: true,
    ...(inputType === 'enum' ? { options: [{ label: answer }] } : {}) };
  hostHistory = { session, events: [{ ...request, kind: 'question', title: 'Hermes 需要补充信息',
    questionMode: 'hermes', questions: [question], approvalOptions: { version: 1, decisions: ['allow'] } }] };
  const view = await render(<DirectExperience />);
  await fireEvent.press(await view.findByRole('button', { name: '在 project 中新建 Code 对话' }));
  await waitFor(() => expect(mockNewComposer.uncertain).toBe(false));
  expect(frames('session.open')).toHaveLength(0);
  await act(async () => { expect(await mockNewComposer.onSend('new task', {
    owner: JSON.stringify(['approval-pairing', 'pc', null, 'hermes', api.accountId, session.cwd, 'code']),
  })).toBe(true); });
  await waitFor(() => expect(mockConversation.profile.capabilities.questions).toBe(true));
  await waitFor(() => expect(mockConversation.approvalReady).toBe(true));
  const sequence = mockSend.mock.calls.map(([frame]) => frame.command.type);
  expect(sequence.indexOf('session.open')).toBeGreaterThan(sequence.indexOf('session.start'));
  expect(sequence.lastIndexOf('agents.status')).toBeGreaterThan(sequence.indexOf('session.open'));
  expect(mockConversation.timeline.items.find((item: any) => item.kind === 'approval')).toMatchObject({
    questionMode: 'hermes', questions: [question], approvalOptions: { version: 1, decisions: ['allow'] },
  });
  await act(async () => { mockConversation.onRespond(approvalId, 'allow', { [nativeId]: [answer] }); });
  await waitFor(() => expect(frames('approval.respond')).toHaveLength(1));
  expect(frames('approval.respond')[0].command).toMatchObject({ decision: 'allow', answers: { [nativeId]: [answer] } });
  expect(frames('approval.respond')[0].command).not.toHaveProperty('message');
  expect(frames('session.start')).toHaveLength(1);
  await view.unmount();
});

test('Direct post-open profile failure preserves the session and typed draft and does not keep polling', async () => {
  negotiatedQuestions = false; initializeQuestions = true; statusMode = 'defer';
  const view = await render(<DirectExperience />);
  await fireEvent.press(await view.findByRole('button', { name: '打开对话 Original' }));
  await waitFor(() => expect(finishStatus).toBeDefined());
  await act(async () => { mockConversation.onText('keep this draft'); statusMode = 'fail'; finishStatus!(); });
  await waitFor(() => expect(mockConversation.loading).toBe(false));
  expect(mockConversation.timeline.session.sessionKey).toBe(session.sessionKey);
  expect(mockConversation.timeline.error).toBeUndefined();
  expect(mockConversation.text).toBe('keep this draft');
  expect(mockConversation.profile.capabilities.questions).toBe(false);
  await act(async () => { mockConversation.onBack(); });
  await fireEvent.press(await view.findByRole('button', { name: '打开对话 Original' }));
  await waitFor(() => expect(mockConversation.loading).toBe(false));
  expect(mockConversation.text).toBe('keep this draft');
  expect(frames('agents.status')).toHaveLength(2);
  expect(frames('session.start')).toHaveLength(0);
  await view.unmount();
});

test.each(['scope', 'generation'] as const)('Direct discards a delayed post-open profile reply after %s changes', async changed => {
  negotiatedQuestions = false; initializeQuestions = true; statusMode = 'defer';
  const view = await render(<DirectExperience />);
  await fireEvent.press(await view.findByRole('button', { name: '打开对话 Original' }));
  await waitFor(() => expect(finishStatus).toBeDefined());
  await act(async () => {
    if (changed === 'scope') mockScope = 'different-pairing'; else mockGeneration++;
    finishStatus!();
  });
  expect(mockConversation.profile.capabilities.questions).toBe(false);
  expect(frames('approval.respond')).toHaveLength(0);
  await view.unmount();
});

test('Direct retains the typed native uncertainty code and exact operation identity', async () => {
  const operationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  await expect(requestDirect({ type: 'approval.respond', sessionKey: session.sessionKey, approvalId, decision: 'allow',
    controlSurface: 'cli', accountId: api.accountId, operationId }, { requestId: operationId }))
    .rejects.toMatchObject({ name: 'DirectApiError', code: 'remote', remoteCode: 'command_delivery_uncertain' });
  expect(frames('approval.respond')).toHaveLength(1);
  expect(frames('approval.respond')[0].requestId).toBe(operationId);
});

test('Direct ordinary approval remount and verification cannot submit another choice or UUID', async () => {
  let view = await open();
  await act(async () => { mockConversation.onRespond(approvalId, 'allow'); });
  await waitFor(() => expect(mockConversation.approvalPending).toBe(true));
  expect(mockConversation.error).toContain('审批结果待确认');
  expect(frames('approval.respond')).toHaveLength(1);
  const original = receipts()[0];
  expect(original).toMatchObject({ approvalId, decision: 'allow', attempted: true, requestId: frames('approval.respond')[0].requestId });
  expect(original.command).toMatchObject({ decision: 'allow', operationId: original.requestId });
  await view.unmount(); view = await open();
  await waitFor(() => expect(mockConversation.approvalPending).toBe(true));
  await act(async () => { mockConversation.onRespond(approvalId, 'deny'); });
  const beforeRead = mockSend.mock.calls.length;
  await act(async () => { mockConversation.onRefresh(); });
  await waitFor(() => expect(frames('session.open').length).toBeGreaterThan(2));
  const verification = mockSend.mock.calls.slice(beforeRead).map(([frame]) => frame.command.type);
  expect(verification).toEqual(expect.arrayContaining(['agents.status', 'session.open']));
  expect(verification.every(type => ['agents.status', 'session.open'].includes(type))).toBe(true);
  await act(async () => { jest.advanceTimersByTime(10_000); });
  expect(frames('approval.respond')).toHaveLength(1);
  expect(receipts()).toHaveLength(1);
  expect(receipts()[0]).toMatchObject({ requestId: original.requestId, decision: 'allow', attempted: true, command: original.command });
  await view.unmount();
});

test('Hermes unknown settlement closes an uncertain approval without inventing a decision or reviving replayed buttons', async () => {
  const view = await open();
  await act(async () => { mockConversation.onRespond(approvalId, 'allow'); });
  await waitFor(() => expect(mockConversation.approvalPending).toBe(true));
  await act(async () => { deliver({ type: 'event', event: 'approval.resolved', data: { ...base, type: 'approval.resolved',
    approvalId, decision: 'unknown', by: 'unknown', ts: 4, seq: 4 } }); });
  const item = () => mockConversation.timeline.items.find((row: any) => row.kind === 'approval' && row.id === approvalId);
  await waitFor(() => expect(item().state).toBe('resolved'));
  expect(item().by).toBeUndefined();
  await act(async () => { deliver({ type: 'event', event: 'approval.request', data: request }); });
  expect(item().state).toBe('resolved');
  await act(async () => { mockConversation.onRespond(approvalId, 'deny'); });
  expect(frames('approval.respond')).toHaveLength(1);
  // A newer authoritative read can retire the receipt, but still must not
  // manufacture an allow/deny or transmit another authorization.
  await act(async () => { jest.advanceTimersByTime(1); });
  hostHistory = { session: { ...session, status: 'idle', activeTurnId: undefined }, events: [{ ...base,
    type: 'approval.resolved', approvalId, decision: 'unknown', by: 'unknown', ts: 4, seq: 4 }] };
  await act(async () => { mockConversation.onRefresh(); });
  await waitFor(() => expect(mockConversation.approvalPending).toBe(false));
  expect(item().state).toBe('resolved'); expect(item().by).toBeUndefined();
  expect(receipts()).toHaveLength(0); expect(frames('approval.respond')).toHaveLength(1);
  await view.unmount();
});

test.each(['pending', 'resolved'] as const)('Direct definite rejection stays locked through failed read/remount until a newer %s head', async state => {
  approvalOutcome = 'reject'; let view = await open(); failHistory = true;
  await act(async () => { mockConversation.onRespond(approvalId, 'allow'); });
  await waitFor(() => expect(frames('approval.respond')).toHaveLength(1));
  await waitFor(() => expect(mockConversation.error).toContain('History unavailable'));
  expect(mockConversation.approvalPending).toBe(true);
  const rejected = receipts()[0];
  expect(rejected).toMatchObject({ attempted: true, blocked: 'approval_rejected', rejectedAt: expect.any(Number) });
  const firstId = frames('approval.respond')[0].requestId;
  await act(async () => { mockConversation.onRespond(approvalId, 'deny'); });
  expect(frames('approval.respond')).toHaveLength(1);
  await view.unmount(); jest.advanceTimersByTime(1); failHistory = false;
  if (state === 'resolved') hostHistory = { session: { ...session, status: 'idle' }, events: [{ ...base,
    type: 'approval.resolved', approvalId, decision: 'unknown', by: 'unknown', ts: Date.now(), seq: 4 }] };
  view = await open();
  await waitFor(() => expect(mockConversation.approvalPending).toBe(false));
  expect(receipts()).toHaveLength(0);
  approvalOutcome = 'success';
  await act(async () => { mockConversation.onRespond(approvalId, 'deny'); });
  if (state === 'pending') {
    await waitFor(() => expect(frames('approval.respond')).toHaveLength(2));
    expect(frames('approval.respond')[1].requestId).not.toBe(firstId);
    expect(frames('approval.respond')[1].command.decision).toBe('deny');
  } else {
    expect(frames('approval.respond')).toHaveLength(1);
    expect(mockConversation.timeline.items.find((item: any) => item.id === approvalId)).toMatchObject({ state: 'resolved', by: undefined });
  }
  await view.unmount();
});
