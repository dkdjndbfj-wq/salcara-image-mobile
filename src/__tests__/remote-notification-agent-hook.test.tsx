import { act, renderHook } from '@testing-library/react-native';
import { AppState } from 'react-native';
import type { HubEvent, SessionInfo } from '../remote/client';
import type { PendingApproval } from '../remote/store';
import { useRemoteLink } from '../remote/useRemoteLink';

const mockToast = jest.fn();
const mockSetFocus = jest.fn();
const mockVisibleThread = jest.fn((_deviceId: string, _sessionKey: string) => false);
const mockEvents = new Set<(event: HubEvent) => void>();
const mockApprovals = new Set<(approval: PendingApproval) => void>();
let mockScope = 'notification-scope-a';
let mockSessions: SessionInfo[] = [];
let mockPending: Record<string, PendingApproval> = {};
let mockEnabled = true;
// Notification subscriptions run without enabling pairing or network synchronization.
const mockApp = { providers: [], ready: false, space: 'assistant' };

jest.mock('react-native', () => {
  // Preserve React Native's lazy exports; spreading them eagerly loads native-only modules.
  const native = Object.create(jest.requireActual('react-native'));
  Object.defineProperties(native, {
    AppState: { value: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) } },
    Linking: { value: { getInitialURL: jest.fn(async () => null), addEventListener: jest.fn(() => ({ remove: jest.fn() })) } },
  });
  return native;
});
jest.mock('../components/ui', () => ({ showToast: (...args: unknown[]) => mockToast(...args) }));
jest.mock('../state/AppContext', () => ({ useApp: () => mockApp }));
jest.mock('../remote/notifications', () => ({
  isVisibleThread: (deviceId: string, sessionKey: string) => mockVisibleThread(deviceId, sessionKey),
  startRemoteNotifications: jest.fn(() => jest.fn()),
  admitForegroundNotification: () => true,
}));
jest.mock('../remote/notification-preferences', () => ({ remoteNotificationsEnabled: () => mockEnabled }));
jest.mock('../remote/push', () => ({ startRemotePush: jest.fn(() => jest.fn()) }));
jest.mock('../remote/store', () => ({
  bootRemote: jest.fn(async () => undefined),
  getRemoteState: () => ({ phase: 'ready', signingIn: null, sessions: { pc: { list: mockSessions } }, approvals: mockPending }),
  onRemoteEvent: (listener: (event: HubEvent) => void) => {
    mockEvents.add(listener); return () => { mockEvents.delete(listener); };
  },
  onApprovalAlert: (listener: (approval: PendingApproval) => void) => {
    mockApprovals.add(listener); return () => { mockApprovals.delete(listener); };
  },
  onRemoteChange: jest.fn(() => jest.fn()),
  remoteDeliveryScope: () => mockScope,
  setRemoteFocus: (...args: unknown[]) => mockSetFocus(...args),
  setRemoteForeground: jest.fn(), pushTarget: () => null,
  loadSessions: jest.fn(async () => undefined), syncSessionEvents: jest.fn(async () => undefined),
}));

const agents = [
  ['deepseek-harness', 'DeepSeek Harness'],
  ['hermes', 'Hermes Agent'],
] as const;
type NoticeKind = 'completed' | 'failed' | 'reply';
const outcomes: ReadonlyArray<readonly [NoticeKind, string, string]> = [
  ['completed', '已完成', 'checkCircle'], ['failed', '失败', 'alert'], ['reply', '有新回复', 'chat'],
];
function session(tool: string, client = tool): SessionInfo {
  return { sessionKey: `${tool}:task`, tool, client, title: '修复项目', cwd: 'C:/Demo',
    updatedAt: Date.now(), status: 'idle', controllable: true, controlSurface: 'cli' };
}
function event(tool: string, kind: NoticeKind = 'completed'): HubEvent {
  const base = { deviceId: 'pc', sessionKey: `${tool}:task`, tool, ts: Date.now(), turnId: 'turn-1' };
  return kind === 'reply' ? { ...base, type: 'message', id: 'reply-1', role: 'assistant', text: '已完成', final: true }
    : { ...base, type: 'turn', status: kind };
}
async function emit(value: HubEvent) {
  expect(mockEvents.size).toBe(1);
  await act(async () => { mockEvents.forEach(listener => listener(value)); });
  await act(async () => { jest.advanceTimersByTime(1100); });
}

beforeEach(() => {
  jest.useFakeTimers(); mockPending = {}; mockEnabled = true;
  jest.clearAllMocks(); mockEvents.clear(); mockApprovals.clear(); mockSessions = [];
  mockScope = 'notification-scope-a'; mockApp.space = 'assistant';
  mockVisibleThread.mockReturnValue(false); AppState.currentState = 'active';
});
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

test.each(agents.flatMap(([tool, label]) => outcomes.map(([kind, verb, icon]) => ({ tool, label, kind, verb, icon }))))(
  '$tool $kind uses its real Agent name and opens the exact task', async ({ tool, label, kind, verb, icon }) => {
    mockSessions = [session(tool)];
    const open = jest.fn(), hook = await renderHook(() => useRemoteLink(open));
    await emit(event(tool, kind));
    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledWith(`${label} ${verb} · 修复项目`, icon, expect.any(Function));
    await act(async () => { mockToast.mock.calls[0][2](); });
    expect(mockSetFocus).toHaveBeenCalledWith({ deviceId: 'pc', sessionKey: `${tool}:task` });
    expect(open).toHaveBeenCalledTimes(1);
    await hook.unmount();
    expect(mockEvents.size).toBe(0); expect(mockApprovals.size).toBe(0);
  },
);

test.each(agents)('%s uses the event identity before its session directory arrives', async (tool, label) => {
  const hook = await renderHook(() => useRemoteLink(jest.fn()));
  await emit(event(tool));
  expect(mockToast).toHaveBeenCalledWith(`${label} 已完成 · 远程任务`, 'checkCircle', expect.any(Function));
  await hook.unmount();
});

test.each(agents)('%s is not relabeled by an unrelated Claude Desktop client string', async (tool, label) => {
  mockSessions = [session(tool, 'Claude Desktop')];
  const hook = await renderHook(() => useRemoteLink(jest.fn()));
  await emit(event(tool));
  expect(mockToast).toHaveBeenCalledWith(`${label} 已完成 · 修复项目`, 'checkCircle', expect.any(Function));
  await hook.unmount();
});

test('a real Claude Desktop session retains its distinct label', async () => {
  mockSessions = [session('claude', 'Claude Desktop')];
  const hook = await renderHook(() => useRemoteLink(jest.fn()));
  await emit(event('claude'));
  expect(mockToast).toHaveBeenCalledWith('Claude Desktop 已完成 · 修复项目', 'checkCircle', expect.any(Function));
  await hook.unmount();
});

test.each(agents)('%s approval prompts use its display name and preserve navigation scope', async (tool, label) => {
  const open = jest.fn(), hook = await renderHook(() => useRemoteLink(open));
  const approval: PendingApproval = { approvalId: 'approval-1', deviceId: 'pc', sessionKey: `${tool}:task`, tool, title: '执行测试', ts: Date.now() };
  mockPending = { approval };
  await emit({ ...approval, type: 'approval.request', kind: 'command' });
  expect(mockToast).toHaveBeenCalledWith(`${label} 需要批准 · 远程任务`, 'code', expect.any(Function));
  mockScope = 'notification-scope-b';
  await act(async () => { mockToast.mock.calls[0][2](); });
  expect(mockSetFocus).toHaveBeenCalledWith({ home: true });
  expect(mockSetFocus).not.toHaveBeenCalledWith(expect.objectContaining({ sessionKey: `${tool}:task` }));
  expect(open).toHaveBeenCalledTimes(1);
  await hook.unmount();
});

test('renamed task notices still suppress the visible thread and background toasts', async () => {
  const hook = await renderHook(() => useRemoteLink(jest.fn()));
  mockVisibleThread.mockReturnValue(true);
  await emit(event('hermes'));
  mockVisibleThread.mockReturnValue(false); AppState.currentState = 'background';
  await emit(event('deepseek-harness'));
  expect(mockToast).not.toHaveBeenCalled();
  await hook.unmount();
});

test('a reply cannot suppress a failure and a different failure within eight seconds stays visible', async () => {
  const hook = await renderHook(() => useRemoteLink(jest.fn()));
  await emit(event('hermes', 'reply'));
  await emit({ ...event('hermes', 'failed'), ts: Date.now() });
  expect(mockToast.mock.calls.at(-1)?.[0]).toContain('失败');
  await emit({ ...event('hermes', 'failed'), turnId: 'turn-2', ts: Date.now() });
  expect(mockToast.mock.calls.at(-1)?.[0]).toBe('2 项任务失败');
  await hook.unmount();
});

test('simultaneous normal results are batched and open the task list', async () => {
  const hook = await renderHook(() => useRemoteLink(jest.fn()));
  await act(async () => {
    for (let i = 0; i < 6; i++) mockEvents.forEach(listener => listener({ ...event('hermes'), turnId: `turn-${i}` }));
    jest.advanceTimersByTime(1100);
  });
  expect(mockToast).toHaveBeenCalledTimes(1);
  expect(mockToast.mock.calls[0][0]).toBe('6 项任务有更新');
  mockToast.mock.calls[0][2]();
  expect(mockSetFocus).toHaveBeenLastCalledWith({ home: true });
  await hook.unmount();
});

test('a question in another programming thread remains actionable; resolved queued requests do not appear', async () => {
  mockApp.space = 'remote';
  const hook = await renderHook(() => useRemoteLink(jest.fn()));
  const request = { ...event('hermes'), type: 'approval.request', kind: 'question', approvalId: 'q1', title: 'choose' } as HubEvent;
  mockPending = { q1: { deviceId: 'pc', sessionKey: 'hermes:task', approvalId: 'q1', title: 'choose', tool: 'hermes', ts: Date.now() } };
  await emit(request);
  expect(mockToast.mock.calls.at(-1)?.[0]).toContain('需要你回答');
  mockToast.mockClear();
  await act(async () => {
    const next = { ...request, approvalId: 'q2' } as HubEvent;
    mockPending.q2 = { ...mockPending.q1, approvalId: 'q2' };
    mockEvents.forEach(listener => listener(next));
    delete mockPending.q2;
    mockEvents.forEach(listener => listener({ ...event('hermes'), type: 'approval.resolved', approvalId: 'q2', decision: 'allow', by: 'phone' }));
    jest.advanceTimersByTime(200);
  });
  expect(mockToast).not.toHaveBeenCalled();
  await hook.unmount();
});

test('queued notices recheck visibility, notification preference and connection before delivery', async () => {
  const hook = await renderHook(() => useRemoteLink(jest.fn()));
  await act(async () => { mockEvents.forEach(listener => listener(event('hermes'))); mockEnabled = false; jest.advanceTimersByTime(1100); });
  expect(mockToast).not.toHaveBeenCalled();
  mockEnabled = true;
  await act(async () => { mockEvents.forEach(listener => listener({ ...event('hermes'), turnId: 'second' })); mockScope = 'changed'; jest.advanceTimersByTime(1100); });
  expect(mockToast).not.toHaveBeenCalled();
  await hook.unmount();
});
