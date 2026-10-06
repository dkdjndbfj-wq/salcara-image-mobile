import React from 'react';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import { Animated, AppState } from 'react-native';
import { MODEL_HOLD_STEP_MS } from '../remote/ModelPopover';
import { ThreadView } from '../remote/ThreadView';
import { HubError } from '../remote/client';
import type { AgentProfile, SessionInfo, ModelCatalog, Effort } from '../remote/client';
import type { RemoteState, TimelineItem } from '../remote/store';
import type { ThreadPrefs } from '../remote/thread-prefs';
import type { PendingDelivery } from '../remote/delivery';
import type { RemoteImage } from '../remote/attachments';

let mockRemote: RemoteState;
const mockQuestionStorage = new Map<string, string>();
let mockDeliveryScope = 'paired|fixture-credential';
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockQuestionStorage.get(key) ?? null,
  setSetting: async (key: string, value: string) => { mockQuestionStorage.set(key, value); } }));
const desktopCapabilities = { list: true, read: true, send: true, interrupt: false, approval: false, attachments: false, modelOverride: false };
const mockOpen = jest.fn(async (..._args: unknown[]) => undefined);
const mockLoadEarlier = jest.fn(async (..._args: unknown[]) => undefined);
const mockStart = jest.fn(async (..._args: unknown[]) => 'codex:new');
const mockSend = jest.fn(async (..._args: unknown[]) => undefined);
const mockSetApi = jest.fn();
const mockRespond = jest.fn(async (..._args: unknown[]): Promise<void> => undefined);
const mockSendSubmit: { current: () => void } = { current: () => undefined };
const mockDialogActions = new Map<string, () => void>();
const mockCancelPending = jest.fn(async (..._args: unknown[]) => undefined);
const mockOpenDesktop = jest.fn(async (..._args: unknown[]) => undefined);
const mockPickImages = jest.fn(async (): Promise<RemoteImage[]> => []);
const mockLoadAgents = jest.fn(async (..._args: unknown[]) => undefined);
const mockSaveDraft = jest.fn(async (..._args: unknown[]) => undefined);
const mockSavePrefs = jest.fn(async (..._args: unknown[]) => undefined);
const mockLoadPrefs = jest.fn(async (_key: string): Promise<ThreadPrefs> => ({}));
const mockPending = jest.fn(async (): Promise<PendingDelivery | undefined> => undefined);
const mockToast = jest.fn();
const mockListModels = jest.fn(async (..._args: unknown[]): Promise<ModelCatalog> => ({ models: ['gpt-fixture'], api: '主力' }));
// Only effort-specific fixtures claim capabilities. Relay ID-only fixtures stay unknown.
const reportedCatalog = (models = ['gpt-fixture'], efforts: Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh']): ModelCatalog => ({
  models, api: '主力', modelCapabilities: Object.fromEntries(models.map(id => [id,
    { source: 'codex-model-list', reasoningKnown: true, reasoningEfforts: efforts } ])),
});
const useReportedModels = () => mockListModels.mockResolvedValue(reportedCatalog());
/** Thinking effort is changed by press-and-slide on the composer chip; tests drive it with the accessibility actions. */
const scrubEffort = async (view: { getByTestId: (id: string) => unknown }, steps: number) => {
  for (let index = 0; index < Math.abs(steps); index += 1) {
    await fireEvent(view.getByTestId('remote-effort-chip') as never, 'accessibilityAction', { nativeEvent: { actionName: steps > 0 ? 'increment' : 'decrement' } });
  }
};
const mockCaptureModelBackdrop = jest.fn(async (..._args: unknown[]): Promise<string | undefined> => undefined);
jest.mock('expo-crypto', () => ({ randomUUID: () => '0199aaa1-1234-4678-9abc-000000000001' }));
jest.mock('react-native/Libraries/AppState/AppState', () => ({ __esModule: true, default: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) } }));
// Preserve the Pressable's JS callbacks in the synthetic host, so queued-event
// tests can capture the actual handler before a scope/visibility change.
jest.mock('react-native', () => {
  const React = require('react'); const actual = jest.requireActual('react-native'); const replacement = Object.create(actual);
  Object.defineProperty(replacement, 'Pressable', { enumerable: true, value: ({ children, style, ...props }: Record<string, any>) =>
    React.createElement(actual.View, { ...props, accessible: props.accessible ?? true, accessibilityState: { ...props.accessibilityState, ...(props.disabled !== undefined ? { disabled: props.disabled } : {}) }, style: typeof style === 'function' ? style({ pressed: false }) : style }, typeof children === 'function' ? children({ pressed: false }) : children) });
  return replacement;
});

// Supply geometry only: the native test host's default measureInWindow never calls back.
jest.mock('react-native/Libraries/Components/View/View', () => {
  const React = require('react');
  const ActualView = jest.requireActual('react-native/Libraries/Components/View/View').default;
  return { __esModule: true, default: React.forwardRef((props: Record<string, unknown>, ref: unknown) => {
    React.useImperativeHandle(ref, () => ({
      measureInWindow: (callback: (x: number, y: number) => void) => callback(16, 600),
      setNativeProps: jest.fn(),
    }));
    return React.createElement(ActualView, props);
  }) };
});
jest.mock('../components/Icon', () => ({ Icon: () => null }));
jest.mock('../components/MessageContent', () => {
  const React = require('react'); const { Text } = require('react-native');
  return { MessageContent: ({ text }: { text: string }) => React.createElement(Text, null, text) };
});
jest.mock('../components/ui', () => {
  const React = require('react'); const { View, Text, Pressable } = require('react-native');
  const pass = ({ children }: { children: unknown }) => React.createElement(View, null, children);
  const button = ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => {
    if (label === '发送') mockSendSubmit.current = onPress;
    return React.createElement(Pressable, { accessibilityRole: 'button', accessibilityLabel: label, accessibilityState: { disabled }, disabled, onPress }, React.createElement(Text, null, label));
  };
  return {
    PrimaryButton: button, IconButton: button, Group: pass, Appear: pass,
    MotionPressable: ({ children, wrapperStyle: _wrapperStyle, scaleTo: _scaleTo, ...props }: Record<string, unknown>) => React.createElement(Pressable, props, children),
    Sheet: ({ visible, title, children, headerRight, footer }: { visible: boolean; title: string; children: unknown; headerRight: unknown; footer: unknown }) => visible
      ? React.createElement(View, null, React.createElement(Text, null, title), headerRight, children, footer) : null,
    AppDialog: ({ visible, title, actions }: { visible: boolean; title: string; actions?: Array<{ label: string; onPress: () => void }> }) => {
      if (!visible) return null;
      actions?.forEach(action => mockDialogActions.set(action.label, action.onPress));
      return React.createElement(View, null, React.createElement(Text, null, title), actions?.map((action) => React.createElement(Pressable, { key: action.label, accessibilityRole: 'button', accessibilityLabel: action.label, onPress: action.onPress }, React.createElement(Text, null, action.label))));
    },
    useReducedMotion: () => true,
    showToast: (...args: unknown[]) => mockToast(...args),
  };
});
jest.mock('../remote/useLiveSync', () => ({ useLiveSync: () => undefined }));
jest.mock('../remote/attachments', () => ({ MAX_REMOTE_IMAGES: 4, pickRemoteImages: () => mockPickImages() }));
jest.mock('../remote/model-backdrop', () => ({ captureModelBackdrop: (...args: unknown[]) => mockCaptureModelBackdrop(...args) }));
jest.mock('../remote/drafts', () => ({ loadRemoteDraft: async () => '原草稿', saveRemoteDraft: (...args: unknown[]) => mockSaveDraft(...args) }));
jest.mock('../remote/thread-prefs', () => ({ loadThreadPrefs: (key: string) => mockLoadPrefs(key), saveThreadPrefs: (...args: unknown[]) => mockSavePrefs(...args) }));
jest.mock('../remote/store', () => ({
  useRemote: () => mockRemote,
  hydrateCachedThread: async () => undefined, hydrateCachedSessions: async () => undefined,
  EMPTY_TIMELINE: { items: [], loading: false }, timelineKey: (device: string, key: string) => `${device}|${key}`,
  cachedModels: () => ({ models: ['gpt-fixture'], api: '主力' }), listModels: (...args: unknown[]) => mockListModels(...args),
  getPendingRemoteMessage: () => mockPending(), openSession: (...args: unknown[]) => mockOpen(...args),
  loadEarlierHistory: (...args: unknown[]) => mockLoadEarlier(...args),
  startSession: (...args: unknown[]) => mockStart(...args), sendToSession: (...args: unknown[]) => mockSend(...args),
  loadAgentProfiles: (...args: unknown[]) => mockLoadAgents(...args), setAgentApi: (...args: unknown[]) => mockSetApi(...args),
  respondApproval: (...args: unknown[]) => mockRespond(...args),
  canOpenOnDesktop: () => true, hubSupportsWait: () => false,
  cancelPendingRemoteMessage: (...args: unknown[]) => mockCancelPending(...args), openOnDesktop: (...args: unknown[]) => mockOpenDesktop(...args), interruptSession: jest.fn(),
  syncSessionEvents: jest.fn(), remoteDeliveryScope: () => mockDeliveryScope, listProjects: async () => [],
}));

const originalAgent: AgentProfile = {
  id: 'codex', name: 'Codex', tool: 'codex', available: true, remoteSendSupported: true, conversationApiSwitch: true,
  api: { name: '主力', model: 'gpt-fixture', protocol: 'responses', configured: true, pending: false, source: 'computer', accountId: 'api_original' },
};
const originalSession: SessionInfo = {
  sessionKey: 'codex:original', tool: 'codex', client: 'Codex App', title: '原会话', cwd: 'C:\\fixture', updatedAt: 1,
  status: 'idle', controllable: true, controlSurface: 'cli', model: 'gpt-fixture',
};

function setItems(items: TimelineItem[], session = originalSession) {
  mockRemote.timelines['pc|codex:original'] = { items, loading: false, session };
}
function viewThread(onCreated = jest.fn(), visible = true) {
  return <ThreadView visible={visible} deviceId="pc" sessionKey="codex:original" agent={originalAgent} onClose={jest.fn()} onCreated={onCreated} />;
}
async function openModels(view: Awaited<ReturnType<typeof render>>) {
  if (!view.queryByTestId('remote-model-popover')) await fireEvent.press(view.getByLabelText(/模型：/));
}
async function closeModels(view: Awaited<ReturnType<typeof render>>) {
  if (view.queryByTestId('remote-model-popover')) await fireEvent.press(view.getByTestId('remote-model-backdrop', { includeHiddenElements: true }));
}

test('native hook approval offers only this request allow/deny and keeps the original desktop surface', async () => {
  setItems([{ kind: 'approval', id: '11111111-2222-4333-8444-555555555555', approval: 'command', title: 'Bash', detail: 'git status',
    state: 'pending', ts: Date.now(), expiresAt: Date.now() + 60000, approvalTransport: 'codex-hook-v1' }], { ...originalSession, controlSurface: 'desktop', status: 'waiting_approval' });
  const view = await render(viewThread());
  expect(view.queryByText('本对话都允许')).toBeNull();
  await fireEvent.press(view.getByText('允许'));
  expect(mockRespond).toHaveBeenCalledWith(expect.objectContaining({ controlSurface: 'desktop', sessionKey: originalSession.sessionKey }), 'allow', undefined, undefined);
});
beforeEach(() => {
  mockQuestionStorage.clear();
  mockDialogActions.clear();
  mockDeliveryScope = 'paired|fixture-credential';
  mockOpen.mockReset().mockResolvedValue(undefined);
  jest.clearAllMocks(); jest.useFakeTimers();
  jest.replaceProperty(AppState, 'currentState', 'active');
  // Geometry refs are synthetic; keep native animation plumbing out of the host mock.
  const animation: typeof Animated.spring = (value, config) => {
    if (value instanceof Animated.Value && typeof config.toValue === 'number') value.setValue(config.toValue);
    return { start: (callback) => callback?.({ finished: true }), stop: () => undefined, reset: () => undefined };
  };
  jest.spyOn(Animated, 'spring').mockImplementation(animation);
  jest.spyOn(Animated, 'timing').mockImplementation(animation);
  mockSend.mockResolvedValue(undefined);
  mockRespond.mockReset().mockResolvedValue(undefined);
  mockPickImages.mockReset().mockResolvedValue([]);
  mockLoadPrefs.mockReset().mockResolvedValue({});
  mockPending.mockReset().mockResolvedValue(undefined);
  mockCaptureModelBackdrop.mockReset().mockResolvedValue(undefined);
  mockListModels.mockReset().mockImplementation(async () => {
    const api = mockRemote.agents.pc.list[0].api;
    return { models: api.accountId === 'api_backup' ? ['deepseek-chat'] : ['gpt-fixture'], api: api.name };
  });
  mockRemote = {
    phase: 'ready', serviceId: null, connections: [], connectionId: 'paired', selectedHubUrl: 'https://fixture.test', probes: {}, connection: 'open',
    devices: [{ deviceId: 'pc', name: '测试电脑', os: 'windows', online: true, lastSeen: 1, tools: [], projects: [] }], devicesLoaded: true,
    sessions: { pc: { list: [originalSession], loading: false, loaded: true } },
    agents: { pc: { list: [originalAgent], apis: [{ id: 'api_backup', name: '备用', models: ['deepseek-chat'] }], loading: false, loaded: true } },
    timelines: {}, approvals: {}, signingIn: null, focus: null,
  };
  setItems([{ kind: 'message', id: 'old-reply', role: 'assistant', text: '原来的回复', final: true, ts: 1 }]);
  mockSetApi.mockImplementation(async () => {
    const changed: AgentProfile = { ...originalAgent, api: { ...originalAgent.api, name: '备用', model: '', source: 'phone', accountId: 'api_backup' } };
    mockRemote.agents.pc.list = [changed];
    return changed;
  });
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test('opening a listed computer conversation reads its original history without starting or sending a task', async () => {
  let release!: () => void;
  const read = new Promise<void>((resolve) => { release = resolve; });
  mockRemote.timelines = { 'pc|codex:original': { items: [], loading: true, session: originalSession } };
  mockOpen.mockImplementationOnce(async () => {
    await read;
    setItems([
      { kind: 'message', id: 'computer-user', role: 'user', text: '电脑上之前发过的任务', final: true, ts: 1 },
      { kind: 'message', id: 'computer-reply', role: 'assistant', text: '电脑上之前的回答与结果', final: true, ts: 2 },
    ]);
  });
  const view = await render(viewThread());
  expect(mockOpen).toHaveBeenCalledWith('pc', 'codex:original', expect.objectContaining({ signal: expect.any(Object) }));
  expect(view.getByText('正在从电脑读取对话…')).toBeTruthy();
  await act(async () => { release(); await read; });
  await view.rerender(viewThread());
  expect(view.getByText('电脑上之前发过的任务')).toBeTruthy();
  expect(view.getByText('电脑上之前的回答与结果')).toBeTruthy();
  expect(view.queryByText('正在从电脑读取对话…')).toBeNull();
  expect(mockStart).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
  expect(mockSetApi).not.toHaveBeenCalled();
});

test('tapping outside the model popup preserves the current choice and draft without refreshing or sending', async () => {
  useReportedModels();
  mockLoadPrefs.mockResolvedValue({ model: 'gpt-fixture', effort: 'minimal', apiIdentity: 'computer:api_original' });
  const view = await render(viewThread());
  await openModels(view);
  expect(view.getByTestId('remote-model-popover')).toBeTruthy();
  mockListModels.mockClear(); mockSavePrefs.mockClear();
  await fireEvent.press(view.getByTestId('remote-model-backdrop', { includeHiddenElements: true }));
  expect(view.queryByTestId('remote-model-popover')).toBeNull();
  expect(view.getByLabelText(`模型：${'gpt-fixture'}`)).toBeTruthy();
  expect(view.getByLabelText('Minimal')).toBeTruthy();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
  expect(mockListModels).not.toHaveBeenCalled(); expect(mockSavePrefs).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
});

test('a short model press begins at Low and atomically replaces a previous XHigh override before sending', async () => {
  useReportedModels();
  mockLoadPrefs.mockResolvedValue({ model: 'gpt-fixture', effort: 'xhigh', apiIdentity: 'computer:api_original' });
  const view = await render(viewThread());
  await fireEvent.press(view.getByLabelText('模型：gpt-fixture'));
  mockSavePrefs.mockClear();
  await fireEvent(view.getByRole('radio', { name: 'gpt-fixture' }), 'pressIn');
  expect(view.getByTestId('remote-model-effort-preview').props.children).toBe('Low');
  expect(mockSavePrefs).not.toHaveBeenCalled();
  await fireEvent(view.getByTestId('remote-model-orbit'), 'touchEnd');
  await fireEvent.press(view.getByRole('radio', { name: 'gpt-fixture' }));
  expect(view.queryByTestId('remote-model-popover')).toBeNull();
  expect(view.getByLabelText('Low')).toBeTruthy();
  expect(mockSavePrefs).toHaveBeenLastCalledWith('paired|pc|codex:original', {
    model: 'gpt-fixture', effort: 'low', apiIdentity: 'computer:api_original',
  });
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: 'gpt-fixture', effort: 'low' }));
});

test('an ID-only relay model remains selectable but cannot invent reasoning controls or a parameter', async () => {
  mockLoadPrefs.mockResolvedValue({ model: 'gpt-fixture', effort: 'xhigh', apiIdentity: 'computer:api_original' });
  const view = await render(viewThread());
  expect(view.queryByLabelText('XHigh')).toBeNull();
  expect(view.queryByLabelText('Default')).toBeNull();
  await openModels(view);
  await fireEvent(view.getByRole('radio', { name: 'gpt-fixture' }), 'pressIn');
  await act(async () => { jest.advanceTimersByTime(MODEL_HOLD_STEP_MS * 8); });
  expect(view.queryByTestId('remote-model-effort-preview')).toBeNull();
  await fireEvent(view.getByTestId('remote-model-orbit'), 'touchEnd');
  await fireEvent.press(view.getByRole('radio', { name: 'gpt-fixture' }));
  expect(mockSavePrefs).toHaveBeenLastCalledWith('paired|pc|codex:original', { model: 'gpt-fixture', effort: undefined, apiIdentity: 'computer:api_original' });
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: 'gpt-fixture', effort: undefined }));
});

test.each([undefined, 'phone:api_other'])('a preference from a missing or different API identity cannot inherit XHigh: %s', async (apiIdentity) => {
  useReportedModels();
  mockLoadPrefs.mockResolvedValue({ model: 'gpt-fixture', effort: 'xhigh', apiIdentity });
  const view = await render(viewThread());
  expect(view.queryByLabelText('XHigh')).toBeNull();
  expect(view.getByLabelText('Default')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ effort: undefined }));
});

test('a refreshed same-Key group cannot retain XHigh when the new catalog only reports IDs', async () => {
  useReportedModels();
  mockLoadPrefs.mockResolvedValue({ model: 'gpt-fixture', effort: 'xhigh', apiIdentity: 'computer:api_original' });
  const view = await render(viewThread());
  expect(view.getByLabelText('XHigh')).toBeTruthy();
  await openModels(view);
  mockListModels.mockResolvedValue({ models: ['gpt-fixture'] });
  await fireEvent.press(view.getByLabelText('刷新模型列表'));
  await closeModels(view);
  expect(view.queryByLabelText('XHigh')).toBeNull();
  expect(view.queryByLabelText('Default')).toBeNull();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: 'gpt-fixture', effort: undefined }));
});

test('switching API drops XHigh even when both Keys list the same model ID', async () => {
  mockLoadPrefs.mockResolvedValue({ model: 'gpt-fixture', effort: 'xhigh', apiIdentity: 'computer:api_original' });
  mockListModels.mockImplementation(async () => mockRemote.agents.pc.list[0].api.accountId === 'api_backup' ? { models: ['gpt-fixture'] } : reportedCatalog());
  const view = await render(viewThread());
  expect(view.getByLabelText('XHigh')).toBeTruthy();
  await openModels(view);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  await closeModels(view);
  expect(view.queryByLabelText('XHigh')).toBeNull();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: 'gpt-fixture', effort: undefined }));
});

test('a runtime effort rejection clears the old override and rechecks metadata without losing the draft', async () => {
  useReportedModels();
  mockRemote.agents.pc.list = [{ ...originalAgent, api: { ...originalAgent.api, source: 'tool', configured: false } }];
  mockLoadPrefs.mockResolvedValue({ model: 'gpt-fixture', effort: 'xhigh', apiIdentity: 'tool:api_original' });
  const view = await render(viewThread());
  expect(view.getByLabelText('XHigh')).toBeTruthy();
  mockListModels.mockResolvedValue({ models: ['gpt-fixture'] });
  mockSend.mockRejectedValueOnce(new Error('这个模型不支持该推理档位，请刷新后重选'));
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockListModels).toHaveBeenCalledTimes(2);
  expect(view.queryByLabelText('XHigh')).toBeNull();
  expect(view.queryByText(/正在检查|模型档位/)).toBeNull();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenLastCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: 'gpt-fixture', effort: undefined }));
});

test('an explicitly text-only model disables adding images while unknown relay metadata stays compatible', async () => {
  mockListModels.mockResolvedValue({ models: ['gpt-fixture'], modelCapabilities: {
    'gpt-fixture': { source: 'codex-model-list', reasoningKnown: false, inputModalities: ['text'] },
  } });
  const view = await render(viewThread());
  expect(view.getByLabelText('添加图片').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(view.getByLabelText('添加图片'));
  expect(mockPickImages).not.toHaveBeenCalled();
  mockListModels.mockResolvedValue({ models: ['gpt-fixture'] });
  await openModels(view); await closeModels(view);
  expect(view.getByLabelText('添加图片').props.accessibilityState.disabled).toBe(false);
});

test('choosing a text-only model keeps the attached image and draft but refuses sending until it is removed', async () => {
  const capabilities = {
    'gpt-fixture': { source: 'codex-model-list' as const, reasoningKnown: false, inputModalities: ['text', 'image'] as Array<'text' | 'image'> },
    'text-only': { source: 'codex-model-list' as const, reasoningKnown: false, inputModalities: ['text'] as Array<'text' | 'image'> },
  };
  mockListModels.mockResolvedValue({ models: ['gpt-fixture', 'text-only'], modelCapabilities: capabilities });
  const view = await render(viewThread());
  mockPickImages.mockResolvedValueOnce([{ uri: 'fixture://kept-image', base64: 'fixture', mime: 'image/jpeg', width: 100, height: 100 }]);
  await fireEvent.press(view.getByLabelText('添加图片'));
  await fireEvent.press(view.getByLabelText('从相册选择'));
  await openModels(view);
  await fireEvent.press(view.getByRole('radio', { name: 'text-only' }));
  expect(view.getByLabelText('添加图片').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).not.toHaveBeenCalled();
  expect(view.getByLabelText('移除图片')).toBeTruthy();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
  await fireEvent.press(view.getByLabelText('移除图片'));
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: 'text-only', images: [] }));
});

test('late image picker results are ignored after current model metadata becomes explicitly text-only', async () => {
  let release!: (images: RemoteImage[]) => void;
  mockPickImages.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const view = await render(viewThread());
  await fireEvent.press(view.getByLabelText('添加图片'));
  await fireEvent.press(view.getByLabelText('从相册选择'));
  mockListModels.mockResolvedValue({ models: ['gpt-fixture'], modelCapabilities: {
    'gpt-fixture': { source: 'codex-model-list', reasoningKnown: false, inputModalities: ['text'] },
  } });
  await openModels(view); await closeModels(view);
  await act(async () => { release([{ uri: 'fixture://late-image', base64: 'fixture', mime: 'image/jpeg', width: 100, height: 100 }]); });
  expect(view.queryByLabelText('移除图片')).toBeNull();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
});

test('holding a shortened namespaced model commits XHigh exactly once with the untouched full ID', async () => {
  const id = 'anthropic/claude-opus-5-5-fast[1m]:thinking';
  const catalog = [id, 'anthropic/claude-sonnet-5-5-preview'];
  mockListModels.mockResolvedValue(reportedCatalog(catalog));
  const view = await render(viewThread());
  await openModels(view);
  expect(view.getByText('Claude')).toBeTruthy();
  await fireEvent(view.getByRole('radio', { name: 'opus-5-5-fast[1m]:thinking' }), 'pressIn');
  expect(view.getByTestId('remote-model-effort-preview').props.children).toBe('Low');
  for (const strength of ['Medium', 'High', 'XHigh']) {
    await act(async () => { jest.advanceTimersByTime(MODEL_HOLD_STEP_MS); });
    expect(view.getByTestId('remote-model-effort-preview').props.children).toBe(strength);
  }
  expect(mockSavePrefs).not.toHaveBeenCalled();
  await fireEvent(view.getByTestId('remote-model-orbit'), 'touchEnd');
  await fireEvent.press(view.getByRole('radio', { name: 'opus-5-5-fast[1m]:thinking' }));
  expect(mockSavePrefs).toHaveBeenCalledTimes(1);
  expect(mockSavePrefs).toHaveBeenLastCalledWith('paired|pc|codex:original', { model: id, effort: 'xhigh', apiIdentity: 'computer:api_original' });
  expect(view.getByLabelText('模型：opus-5-5-fast[1m]:thinking')).toBeTruthy();
  expect(view.getByLabelText('XHigh')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: id, effort: 'xhigh' }));
});

test('closing the upper backdrop discards an in-progress High preview and restores the original preferences and draft', async () => {
  useReportedModels();
  mockLoadPrefs.mockResolvedValue({ model: 'gpt-fixture', effort: 'minimal', apiIdentity: 'computer:api_original' });
  const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '还没提交的任务');
  await openModels(view);
  mockSavePrefs.mockClear();
  await fireEvent(view.getByRole('radio', { name: 'gpt-fixture' }), 'pressIn');
  await act(async () => { jest.advanceTimersByTime(MODEL_HOLD_STEP_MS * 2); });
  expect(view.getByTestId('remote-model-effort-preview').props.children).toBe('High');
  await fireEvent.press(view.getByTestId('remote-model-backdrop', { includeHiddenElements: true }));
  await act(async () => { jest.advanceTimersByTime(MODEL_HOLD_STEP_MS * 4); });
  expect(view.queryByTestId('remote-model-popover')).toBeNull();
  expect(view.getByLabelText('模型：gpt-fixture')).toBeTruthy();
  expect(view.getByLabelText('Minimal')).toBeTruthy();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('还没提交的任务');
  expect(mockSavePrefs).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
});

test('touching the same-page Key strip cancels a held model preview without committing or dropping the draft', async () => {
  useReportedModels();
  mockLoadPrefs.mockResolvedValue({ model: 'gpt-fixture', effort: 'high', apiIdentity: 'computer:api_original' });
  const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '等我选好 Key 再发送');
  await openModels(view);
  mockSavePrefs.mockClear();
  await fireEvent(view.getByRole('radio', { name: 'gpt-fixture' }), 'pressIn');
  expect(view.getByTestId('remote-model-effort-preview').props.children).toBe('Low');
  await fireEvent(view.getByTestId('remote-api-header'), 'touchStart');
  await act(async () => { jest.advanceTimersByTime(MODEL_HOLD_STEP_MS * 4); });
  expect(view.getByTestId('remote-model-popover')).toBeTruthy();
  expect(view.getByTestId('remote-inline-api-picker')).toBeTruthy();
  expect(view.getByRole('radio', { name: '备用' })).toBeTruthy();
  expect(view.queryByText('更换 API')).toBeNull();
  expect(view.queryByLabelText('使用这个设置')).toBeNull();
  expect(view.getByTestId('remote-model-effort-preview').props.children).toBe('High');
  await closeModels(view);
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('等我选好 Key 再发送');
  expect(view.getByLabelText('High')).toBeTruthy();
  expect(mockSaveDraft).toHaveBeenLastCalledWith('paired|pc|codex:original', '等我选好 Key 再发送');
  expect(mockSavePrefs).not.toHaveBeenCalled(); expect(mockSetApi).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
});

test.each(['close', 'Key', 'scope'] as const)('a late local backdrop after %s cannot restore the old API pixels or alter picker visibility', async (change) => {
  let finishCapture!: (pixels: string | undefined) => void;
  mockCaptureModelBackdrop.mockImplementationOnce(() => new Promise((resolve) => { finishCapture = resolve; }));
  const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '截屏期间保留的草稿');
  await openModels(view);
  expect(mockCaptureModelBackdrop).toHaveBeenCalledTimes(1);
  if (change === 'close') await fireEvent.press(view.getByTestId('remote-model-backdrop', { includeHiddenElements: true }));
  else if (change === 'Key') await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  else {
    mockRemote.agents.pc.list = [{ ...originalAgent, api: { ...originalAgent.api, accountId: 'api_backup', name: '备用', source: 'phone', model: '' } }];
    await view.rerender(viewThread());
  }
  await act(async () => { finishCapture('data:image/jpeg;base64,old-private-pixels'); });
  if (change === 'close') expect(view.queryByTestId('remote-model-popover')).toBeNull();
  else expect(view.getByTestId('remote-model-popover')).toBeTruthy();
  expect(view.queryByTestId('remote-model-blur')).toBeNull();
  if (change === 'Key') expect(view.getByRole('radio', { name: '备用' }).props.accessibilityState.checked).toBe(true);
  await closeModels(view);
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('截屏期间保留的草稿');
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
});

test('reopening model selection uses the current capture and never accepts pixels from a previously closed picker', async () => {
  let finishOld!: (pixels: string | undefined) => void;
  mockCaptureModelBackdrop.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
    .mockResolvedValueOnce('data:image/jpeg;base64,current-private-pixels');
  const view = await render(viewThread());
  await openModels(view);
  await fireEvent.press(view.getByTestId('remote-model-backdrop', { includeHiddenElements: true }));
  await openModels(view);
  expect(view.getByTestId('remote-model-blur').props.source).toEqual({ uri: 'data:image/jpeg;base64,current-private-pixels' });
  await act(async () => { finishOld('data:image/jpeg;base64,old-private-pixels'); });
  expect(view.getByTestId('remote-model-blur').props.source).toEqual({ uri: 'data:image/jpeg;base64,current-private-pixels' });
  expect(mockCaptureModelBackdrop).toHaveBeenCalledTimes(2);
  await fireEvent.press(view.getByTestId('remote-model-backdrop', { includeHiddenElements: true }));
  expect(view.queryByTestId('remote-model-blur')).toBeNull();
  expect(mockSaveDraft.mock.calls.flat()).not.toContain('data:image/jpeg;base64,current-private-pixels');
  expect(mockSavePrefs.mock.calls.flat()).not.toContain('data:image/jpeg;base64,current-private-pixels');
});

test.each([
  { name: 'mixed providers', catalog: ['deepseek-chat', 'claude-opus-5-5', 'gpt-5.5'], id: 'deepseek-chat', label: 'deepseek-chat' },
  { name: 'custom deployment path', catalog: ['custom/deploy/claude-opus-5-5', 'claude-sonnet-5-5'], id: 'custom/deploy/claude-opus-5-5', label: 'custom/deploy/claude-opus-5-5' },
  { name: 'prefix collision', catalog: ['claude-opus-5-5', 'anthropic/claude-opus-5-5'], id: 'anthropic/claude-opus-5-5', label: 'anthropic/claude-opus-5-5' },
  { name: 'dated and preview suffixes', catalog: ['claude-opus-5-5-20260930-preview-thinking-200k', 'claude-sonnet-5-5-latest'], id: 'claude-opus-5-5-20260930-preview-thinking-200k', label: 'opus-5-5-20260930-preview-thinking-200k' },
])('model presentation never rewrites the outgoing ID: $name', async ({ catalog, id, label }) => {
  mockListModels.mockResolvedValue({ models: catalog, api: '主力' });
  const view = await render(viewThread());
  await openModels(view);
  const node = view.getByRole('radio', { name: label });
  expect(node.props.accessibilityHint).toBe(id);
  await fireEvent(node, 'pressIn');
  await fireEvent(view.getByTestId('remote-model-orbit'), 'touchEnd');
  await fireEvent.press(view.getByRole('radio', { name: label }));
  expect(mockSavePrefs).toHaveBeenLastCalledWith('paired|pc|codex:original', { model: id, effort: undefined, apiIdentity: 'computer:api_original' });
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: id, effort: undefined }));
});

test('a short model choice in a new conversation starts Low and copies the untouched ID to the created thread', async () => {
  const id = 'anthropic/claude-sonnet-5-5-preview';
  mockRemote.devices[0].projects = [{ path: 'C:\\fixture', name: 'fixture' }];
  mockListModels.mockResolvedValue(reportedCatalog([id]));
  const created = jest.fn();
  const view = await render(<ThreadView visible deviceId="pc" sessionKey={null} agent={originalAgent} onClose={jest.fn()} onCreated={created} />);
  await openModels(view);
  await fireEvent(view.getByRole('radio', { name: 'sonnet-5-5-preview' }), 'pressIn');
  await fireEvent(view.getByTestId('remote-model-orbit'), 'touchEnd');
  await fireEvent.press(view.getByRole('radio', { name: 'sonnet-5-5-preview' }));
  expect(mockSavePrefs).toHaveBeenLastCalledWith('paired|pc|new:codex', { model: id, effort: 'low', apiIdentity: 'computer:api_original' });
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockStart).toHaveBeenCalledWith('pc', expect.objectContaining({ tool: 'codex', cwd: 'C:\\fixture', prompt: '原草稿', model: id, effort: 'low' }));
  expect(mockSavePrefs).toHaveBeenLastCalledWith('paired|pc|codex:new', { model: id, effort: 'low', apiIdentity: 'computer:api_original' });
  expect(created).toHaveBeenCalledWith('codex:new'); expect(mockSend).not.toHaveBeenCalled();
});

test('Claude model holding cannot invent a Codex effort override', async () => {
  const id = 'claude-opus-5-5-fast';
  const agent: AgentProfile = { ...originalAgent, id: 'claude-desktop', name: 'Claude Desktop', tool: 'claude', api: { ...originalAgent.api, model: id, protocol: 'anthropic' } };
  const session: SessionInfo = { ...originalSession, sessionKey: 'claude:original', tool: 'claude', client: 'Claude Desktop', model: id };
  mockRemote.agents.pc.list = [agent];
  mockRemote.sessions.pc.list = [session];
  mockRemote.timelines['pc|claude:original'] = { items: [{ kind: 'message', id: 'claude-reply', role: 'assistant', text: '原来的 Claude 回复', final: true, ts: 1 }], loading: false, session };
  mockListModels.mockResolvedValue({ models: [id], api: '主力' });
  mockLoadPrefs.mockResolvedValue({ model: id, effort: 'xhigh', apiIdentity: 'computer:api_original' });
  const view = await render(<ThreadView visible deviceId="pc" sessionKey="claude:original" agent={agent} onClose={jest.fn()} onCreated={jest.fn()} />);
  await openModels(view);
  await fireEvent(view.getByRole('radio', { name: 'opus-5-5-fast' }), 'pressIn');
  await act(async () => { jest.advanceTimersByTime(MODEL_HOLD_STEP_MS * 4); });
  expect(view.queryByTestId('remote-model-effort-preview')).toBeNull();
  await fireEvent(view.getByTestId('remote-model-orbit'), 'touchEnd');
  await fireEvent.press(view.getByRole('radio', { name: 'opus-5-5-fast' }));
  expect(mockSavePrefs).toHaveBeenLastCalledWith('paired|pc|claude:original', { model: id, effort: undefined, apiIdentity: 'computer:api_original' });
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'claude:original', '原草稿', expect.objectContaining({ model: id, effort: undefined }));
});

test('XHigh is selected, saved for this thread and restored for the next send', async () => {
  useReportedModels();
  const view = await render(viewThread());
  expect(view.getByLabelText('Default')).toBeTruthy();
  // Default → Minimal → Low → Medium → High → XHigh
  await scrubEffort(view, 5);
  expect(view.queryByText('推理')).toBeNull();
  expect(view.queryByText('思考程度')).toBeNull();
  expect(view.getByLabelText('XHigh')).toBeTruthy();
  expect(mockSavePrefs).toHaveBeenLastCalledWith('paired|pc|codex:original', { model: 'gpt-fixture', effort: 'xhigh', apiIdentity: 'computer:api_original' });
  mockLoadPrefs.mockResolvedValue({ model: 'gpt-fixture', effort: 'xhigh', apiIdentity: 'computer:api_original' });
  await view.rerender(viewThread(jest.fn(), false));
  await view.rerender(viewThread());
  expect(view.getByLabelText('XHigh')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ effort: 'xhigh' }));
});

test('a new thread sends XHigh and copies the choice to the created thread preferences', async () => {
  useReportedModels();
  mockRemote.devices[0].projects = [{ path: 'C:\\fixture', name: 'fixture' }];
  const created = jest.fn();
  const view = await render(<ThreadView visible deviceId="pc" sessionKey={null} agent={originalAgent} onClose={jest.fn()} onCreated={created} />);
  await scrubEffort(view, 5);
  expect(mockSavePrefs).toHaveBeenLastCalledWith('paired|pc|new:codex', expect.objectContaining({ effort: 'xhigh' }));
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockStart).toHaveBeenCalledWith('pc', expect.objectContaining({ cwd: 'C:\\fixture', prompt: '原草稿', effort: 'xhigh' }));
  expect(created).toHaveBeenCalledWith('codex:new');
  expect(mockSavePrefs).toHaveBeenLastCalledWith('paired|pc|codex:new', expect.objectContaining({ effort: 'xhigh' }));
  expect(mockSend).not.toHaveBeenCalled();
});

test('a matching API Minimal preference has the correct English label and remains Minimal when sent', async () => {
  useReportedModels();
  mockLoadPrefs.mockResolvedValue({ effort: 'minimal', apiIdentity: 'computer:api_original' });
  const view = await render(viewThread());
  expect(view.getByLabelText('Minimal')).toBeTruthy();
  expect(view.queryByLabelText('推理')).toBeNull();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ effort: 'minimal' }));
});

test('Default clears the saved override and sends no Medium assumption', async () => {
  useReportedModels();
  mockLoadPrefs.mockResolvedValue({ effort: 'high', apiIdentity: 'computer:api_original' });
  const view = await render(viewThread());
  expect(view.getByLabelText('High')).toBeTruthy();
  await scrubEffort(view, -4);
  expect(mockSavePrefs).toHaveBeenLastCalledWith('paired|pc|codex:original', expect.objectContaining({ effort: undefined }));
  expect(view.getByLabelText('Default')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ effort: undefined }));
});

test.each(['matching', 'other-thread', 'expired'] as const)('desktop Live hides effort only for the active covered thread: %s', async (lease) => {
  useReportedModels();
  mockLoadPrefs.mockResolvedValue({ model: 'gpt-fixture', effort: 'xhigh', apiIdentity: 'computer:api_original' });
  mockRemote.agents.pc.list = [{ ...originalAgent, desktopLive: { expiresAt: Date.now() + (lease === 'expired' ? -1 : 60_000),
    sessionKeys: [lease === 'other-thread' ? 'codex:other' : 'codex:original'], capabilities: desktopCapabilities } }];
  const view = await render(viewThread());
  if (lease === 'matching') {
    for (const label of ['Default', 'Minimal', 'Low', 'Medium', 'High', 'XHigh']) expect(view.queryByLabelText(label)).toBeNull();
    expect(view.getByLabelText('模型：跟随电脑')).toBeTruthy();
    await fireEvent.press(view.getByLabelText('发送'));
    expect(mockSend).not.toHaveBeenCalled();
    expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
    expect(view.getByTestId('remote-model-popover')).toBeTruthy();
    await fireEvent.press(view.getByLabelText('使用电脑设置'));
    expect(mockSavePrefs).toHaveBeenLastCalledWith('paired|pc|codex:original', { apiIdentity: 'computer:api_original' });
    expect(view.queryByTestId('remote-model-popover')).toBeNull();
  } else expect(view.getByLabelText('XHigh')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({
    model: lease === 'matching' ? undefined : 'gpt-fixture', effort: lease === 'matching' ? undefined : 'xhigh',
  }));
});

test('ThreadView model API entry switches the original session without dropping its draft or history', async () => {
  const created = jest.fn(); const view = await render(viewThread(created));
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.placeholder).toBe('随心输入');
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '尚未发送的任务');
  await openModels(view);
  expect(view.getByTestId('remote-api-header')).toBeTruthy();
  expect(view.getByRole('radio', { name: '跟随电脑' })).toBeTruthy();
  expect(view.getByRole('radio', { name: '备用' })).toBeTruthy();
  expect(view.queryByText('API：主力')).toBeNull();
  expect(view.queryByText('更换 API')).toBeNull();
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  expect(mockSetApi).toHaveBeenCalledWith('pc', 'codex', 'api_backup', '', 'codex:original');
  expect(view.getByTestId('remote-model-popover')).toBeTruthy();
  expect(view.getByRole('radio', { name: '备用' }).props.accessibilityState.checked).toBe(true);
  expect(view.getByRole('radio', { name: 'deepseek-chat' }).props.accessibilityState.disabled).toBe(false);
  await closeModels(view);
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('尚未发送的任务');
  expect(view.getByText('原来的回复')).toBeTruthy();
  expect(mockOpen).toHaveBeenCalledTimes(1); expect(mockOpen).toHaveBeenCalledWith('pc', 'codex:original', expect.objectContaining({ signal: expect.any(Object) }));
  expect(created).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled(); expect(mockSend).not.toHaveBeenCalled();
  await act(async () => { jest.advanceTimersByTime(450); });
  expect(mockSaveDraft).toHaveBeenLastCalledWith('paired|pc|codex:original', '尚未发送的任务');
  expect(mockSavePrefs).toHaveBeenLastCalledWith('paired|pc|codex:original', expect.objectContaining({ model: undefined, apiIdentity: 'phone:api_backup' }));
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  expect(view.getByLabelText('模型：选择模型')).toBeTruthy();
  expect(mockToast).not.toHaveBeenCalled();
});

test('an in-flight Key switch disables model selection and duplicate API writes, then keeps the same picker and draft', async () => {
  let finishSwitch!: (profile: AgentProfile) => void;
  mockSetApi.mockImplementationOnce(() => new Promise((resolve) => { finishSwitch = resolve; }));
  const created = jest.fn(), view = await render(viewThread(created));
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '等 Key 切好以后发送');
  await openModels(view);
  mockSavePrefs.mockClear();
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  expect(view.getByTestId('remote-api-switch-spinner')).toBeTruthy();
  expect(view.getByRole('radio', { name: 'gpt-fixture' }).props.accessibilityState.disabled).toBe(true);
  expect(view.getByRole('radio', { name: '备用' }).props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(view.getByRole('radio', { name: 'gpt-fixture' }));
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  expect(mockSavePrefs).not.toHaveBeenCalled(); expect(mockSetApi).toHaveBeenCalledTimes(1);
  const changed: AgentProfile = { ...originalAgent, api: { ...originalAgent.api, name: '备用', model: '', source: 'phone', accountId: 'api_backup' } };
  await act(async () => { mockRemote.agents.pc.list = [changed]; finishSwitch(changed); });
  expect(view.getByTestId('remote-model-popover')).toBeTruthy();
  expect(view.getByTestId('remote-inline-api-picker')).toBeTruthy();
  expect(view.queryByTestId('remote-api-switch-spinner')).toBeNull();
  expect(view.getByRole('radio', { name: 'deepseek-chat' }).props.accessibilityState.disabled).toBe(false);
  expect(view.getByRole('radio', { name: '备用' }).props.accessibilityState.checked).toBe(true);
  await closeModels(view);
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('等 Key 切好以后发送');
  expect(view.getByText('原来的回复')).toBeTruthy();
  expect(mockOpen).toHaveBeenCalledTimes(1);
  expect(mockSetApi).toHaveBeenCalledWith('pc', 'codex', 'api_backup', '', 'codex:original');
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled(); expect(created).not.toHaveBeenCalled();
});

test('the top Key arc browses without switching and never strips a named API as if it were a model', async () => {
  const id = 'claude-opus-5-5', named = { id: 'api_named', name: 'claude-opus-5-5', models: [id] };
  mockRemote.agents.pc.apis = [named, { id: 'api_named_two', name: 'anthropic/claude-sonnet-5-5-preview', models: [id] }, { id: 'api_named_three', name: 'gpt-5.5-fast', models: [id] }];
  mockRemote.agents.pc.list = [{ ...originalAgent, api: { ...originalAgent.api, model: id, source: 'phone', accountId: named.id } }];
  mockListModels.mockResolvedValue({ models: [id, 'claude-sonnet-5-5'], api: named.name });
  mockLoadPrefs.mockResolvedValue({ model: id, effort: 'high', apiIdentity: 'phone:api_named' });
  const view = await render(viewThread());
  await openModels(view);
  expect(view.getByRole('radio', { name: named.name })).toBeTruthy();
  expect(view.getByRole('radio', { name: 'opus-5-5' })).toBeTruthy();
  expect(view.getByText('Claude')).toBeTruthy();
  mockSavePrefs.mockClear();
  await fireEvent(view.getByTestId('remote-api-key-strip'), 'scroll', { nativeEvent: { contentOffset: { x: 256, y: 0 } } });
  expect(view.getByRole('radio', { name: 'anthropic/claude-sonnet-5-5-preview' })).toBeTruthy();
  expect(view.getByRole('radio', { name: 'gpt-5.5-fast' })).toBeTruthy();
  expect(mockSetApi).not.toHaveBeenCalled(); expect(mockSavePrefs).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
  await closeModels(view);
  expect(view.getByLabelText('模型：opus-5-5')).toBeTruthy();
  expect(view.queryByLabelText('High')).toBeNull();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
});

test('a provider error in the timeline offers the conversation API picker', async () => {
  setItems([{ kind: 'turn', id: 'failure', status: 'failed', error: 'invalid_api_key', ts: 2 }], { ...originalSession, status: 'failed' });
  const view = await render(viewThread());
  await fireEvent.press(view.getByLabelText('API 出错，更换 API'));
  expect(view.getByTestId('remote-inline-api-picker')).toBeTruthy();
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  expect(view.getByTestId('remote-model-popover')).toBeTruthy();
  await closeModels(view);
  expect(view.queryByLabelText('API 出错，更换 API')).toBeNull();
  expect(mockSetApi).toHaveBeenCalledWith('pc', 'codex', 'api_backup', '', 'codex:original');
});

test('a failed send preserves text and offers changing API, but a network failure does not', async () => {
  mockSend.mockRejectedValueOnce(new Error('insufficient_quota'));
  const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '保留这个任务');
  await fireEvent.press(view.getByLabelText('发送'));
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('保留这个任务');
  await fireEvent.press(view.getByLabelText('API 出错，更换 API'));
  expect(view.getByTestId('remote-inline-api-picker')).toBeTruthy();
  expect(mockStart).not.toHaveBeenCalled();
  await view.unmount();
  mockSend.mockRejectedValueOnce(new Error('电脑不在线'));
  const networkView = await render(viewThread());
  await fireEvent.press(networkView.getByLabelText('发送'));
  expect(networkView.queryByLabelText('API 出错，更换 API')).toBeNull();
});

test('Codex subagent details navigate to the actual child session and expose its result', async () => {
  setItems([
    { kind: 'tool', id: 'spawn', tool: 'subagent', title: '启动子智能体', detail: '检查代码', status: 'done', childSessionKeys: ['codex:real-child'], ts: 1 },
    { kind: 'tool', id: 'spawn:child:real-child', parentId: 'spawn', tool: 'subagent', title: '子智能体', output: '全部测试通过', status: 'done', childSessionKeys: ['codex:real-child'], ts: 2 },
  ]);
  const created = jest.fn(); const view = await render(viewThread(created));
  expect(view.queryByLabelText('启动子智能体：子任务详情')).toBeNull();
  await fireEvent.press(view.getByLabelText('展开处理摘要'));
  await fireEvent.press(view.getByLabelText('启动子智能体：子任务详情'));
  await fireEvent.press(view.getByLabelText('打开子智能体对话 1'));
  expect(created).toHaveBeenCalledWith('codex:real-child');
  expect(mockStart).not.toHaveBeenCalled();
  await fireEvent.press(view.getByText('子智能体'));
  expect(view.getByText('全部测试通过')).toBeTruthy();
});

test('an expired first question cannot hide the next live form and answers retain their exact labels', async () => {
  setItems([
    { kind: 'approval', id: 'expired', approval: 'question', title: '旧问题', state: 'pending', expiresAt: Date.now() - 1, ts: 1, questions: [{ id: 'old', question: '旧选项', options: [{ label: '旧答案' }] }] },
    { kind: 'approval', id: 'live', approval: 'question', title: '新问题', state: 'pending', expiresAt: Date.now() + 60_000, ts: 2,
      questions: [{ id: 'choice', question: '选方案', required: true, options: [{ label: ' A ' }, { label: 'B' }] }, { id: 'extra', question: '补充', required: true, allowCustom: true }] },
  ]);
  const view = await render(viewThread());
  expect(view.queryByRole('radio', { name: '旧答案' })).toBeNull();
  await fireEvent.press(view.getByRole('radio', { name: ' A ' }));
  await fireEvent.press(view.getByLabelText('下一题'));
  await fireEvent.changeText(view.getByLabelText('补充：回答'), '我的要求');
  await fireEvent.press(view.getByLabelText('提交回答'));
  expect(mockRespond).toHaveBeenCalledWith({ approvalId: 'live', deviceId: 'pc', sessionKey: 'codex:original' }, 'allow', undefined, { choice: [' A '], extra: ['我的要求'] }, expect.objectContaining({ requestId: expect.any(String), retrying: false }));
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
});

test('expiry while the view stays open advances to the next actionable question', async () => {
  setItems([
    { kind: 'approval', id: 'short', approval: 'question', title: '先问', state: 'pending', expiresAt: Date.now() + 100, ts: 1, questions: [{ id: 'one', question: '先选', options: [{ label: '即将过期' }] }] },
    { kind: 'approval', id: 'next', approval: 'question', title: '后问', state: 'pending', expiresAt: Date.now() + 60_000, ts: 2, questions: [{ id: 'two', question: '再选', options: [{ label: '有效回答' }], required: true }] },
  ]);
  const view = await render(viewThread());
  expect(view.getByRole('radio', { name: '即将过期' })).toBeTruthy();
  await act(async () => { jest.advanceTimersByTime(1100); });
  expect(view.queryByRole('radio', { name: '即将过期' })).toBeNull();
  await fireEvent.press(view.getByRole('radio', { name: '有效回答' }));
  await fireEvent.press(view.getByLabelText('提交回答'));
  expect(mockRespond).toHaveBeenCalledWith({ approvalId: 'next', deviceId: 'pc', sessionKey: 'codex:original' }, 'allow', undefined, { two: ['有效回答'] }, expect.objectContaining({ retrying: false }));
});

test('reopening after a question expires while hidden selects the next question without changing session', async () => {
  setItems([
    { kind: 'approval', id: 'hidden-expiry', approval: 'question', title: '旧问题', state: 'pending', expiresAt: Date.now() + 100, ts: 1, questions: [{ id: 'one', question: '先选', options: [{ label: '关闭期间过期' }] }] },
    { kind: 'approval', id: 'after-reopen', approval: 'question', title: '新问题', state: 'pending', expiresAt: Date.now() + 60_000, ts: 2, questions: [{ id: 'two', question: '再选', options: [{ label: '重新打开的回答' }], required: true }] },
  ]);
  const created = jest.fn(); const view = await render(viewThread(created));
  expect(view.getByRole('radio', { name: '关闭期间过期' })).toBeTruthy();
  await view.rerender(viewThread(created, false));
  await act(async () => { jest.advanceTimersByTime(1100); });
  await view.rerender(viewThread(created));
  expect(view.queryByRole('radio', { name: '关闭期间过期' })).toBeNull();
  await fireEvent.press(view.getByRole('radio', { name: '重新打开的回答' }));
  await fireEvent.press(view.getByLabelText('提交回答'));
  expect(mockRespond).toHaveBeenCalledWith({ approvalId: 'after-reopen', deviceId: 'pc', sessionKey: 'codex:original' }, 'allow', undefined, { two: ['重新打开的回答'] }, expect.objectContaining({ retrying: false }));
  expect(created).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
});

test('a late preference read cannot restore the previous API model after switching', async () => {
  let release!: (prefs: ThreadPrefs) => void;
  mockLoadPrefs.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '使用新 API 模型');
  await openModels(view);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  await act(async () => { release({ model: 'gpt-fixture', apiIdentity: 'computer:api_original' }); });
  await openModels(view);
  expect(view.queryByRole('radio', { name: 'gpt-fixture' })).toBeNull();
  await fireEvent.press(view.getByRole('radio', { name: 'deepseek-chat' }));
  expect(view.getByLabelText(`模型：${'deepseek-chat'}`)).toBeTruthy();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('使用新 API 模型');
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '使用新 API 模型', expect.objectContaining({ model: 'deepseek-chat' }));
  expect(mockStart).not.toHaveBeenCalled();
});

test('reopening with empty preferences requires a new API model, never the old session default', async () => {
  const created = jest.fn(); const view = await render(viewThread(created));
  await openModels(view);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  expect(mockRemote.timelines['pc|codex:original'].session?.model).toBe('gpt-fixture');
  await view.rerender(viewThread(created, false));
  await view.rerender(viewThread(created));
  expect(mockLoadPrefs).toHaveBeenCalledTimes(2);
  await openModels(view);
  expect(view.queryByRole('radio', { name: '默认' })).toBeNull();
  expect(view.queryByRole('radio', { name: 'gpt-fixture' })).toBeNull();
  await fireEvent.press(view.getByRole('radio', { name: 'deepseek-chat' }));
  expect(view.getByLabelText(`模型：${'deepseek-chat'}`)).toBeTruthy();
  expect(view.getByText('原来的回复')).toBeTruthy();
  expect(created).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '用新的默认模型');
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '用新的默认模型', expect.objectContaining({ model: 'deepseek-chat' }));
});

test('a pending receipt blocks changing model, effort or API without clearing the draft', async () => {
  useReportedModels();
  mockPending.mockResolvedValue({ scope: 'fixture', deviceId: 'pc', sessionKey: 'codex:original', surface: 'cli', text: '待确认任务',
    requestId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', createdAt: Date.now(), firstAttemptAt: Date.now(), lastObservedAt: Date.now(), attempted: true, safeRetry: true });
  setItems([{ kind: 'turn', id: 'pending-error', status: 'failed', error: 'invalid_api_key', ts: 2 }], { ...originalSession, status: 'failed' });
  const view = await render(viewThread());
  await openModels(view);
  await fireEvent.press(view.getByRole('radio', { name: 'gpt-fixture' }));
  expect(mockSavePrefs).not.toHaveBeenCalled();
  expect(view.getByText('先核对待确认消息，再换 API')).toBeTruthy();
  expect(view.getByRole('radio', { name: '备用' }).props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  await closeModels(view);
  await scrubEffort(view, 4);
  expect(mockSavePrefs).not.toHaveBeenCalled();
  expect(view.getAllByText('Default').length).toBeGreaterThan(0);
  await fireEvent.press(view.getByLabelText('API 出错，更换 API'));
  expect(view.getByText('先核对待确认消息，再换 API')).toBeTruthy();
  expect(mockSetApi).not.toHaveBeenCalled(); expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
});

test('a shared model is retained only after the new Key catalog confirms it', async () => {
  mockListModels.mockImplementation(async () => ({ models: ['gpt-fixture', 'deepseek-chat'] }));
  const view = await render(viewThread());
  await openModels(view);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  expect(view.getByTestId('remote-model-popover')).toBeTruthy();
  await closeModels(view);
  expect(view.getByLabelText(`模型：${'gpt-fixture'}`)).toBeTruthy();
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(false);
  expect(mockSavePrefs).toHaveBeenLastCalledWith('paired|pc|codex:original', expect.objectContaining({ model: 'gpt-fixture', apiIdentity: 'phone:api_backup' }));
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: 'gpt-fixture' }));
  expect(mockStart).not.toHaveBeenCalled();
});

test('an empty new catalog cannot use an obsolete configured default or lose the draft', async () => {
  mockListModels.mockImplementation(async () => ({ models: mockRemote.agents.pc.list[0].api.accountId === 'api_backup' ? [] : ['gpt-fixture'] }));
  mockSetApi.mockImplementation(async () => {
    const changed: AgentProfile = { ...originalAgent, api: { ...originalAgent.api, name: '备用', model: 'retired-model', source: 'phone', accountId: 'api_backup' } };
    mockRemote.agents.pc.list = [changed]; return changed;
  });
  const view = await render(viewThread());
  await openModels(view);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  expect(view.getByTestId('remote-model-popover')).toBeTruthy();
  expect(view.getByText('暂无可用模型')).toBeTruthy();
  await closeModels(view);
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  expect(view.getByLabelText('模型：选择模型')).toBeTruthy();
  expect(view.queryByText('暂无可用模型')).toBeNull();
  expect(mockToast).not.toHaveBeenCalled();
  await openModels(view);
  expect(view.getByText('暂无可用模型')).toBeTruthy();
  expect(view.queryByRole('radio', { name: '默认' })).toBeNull();
  expect(view.queryByRole('radio', { name: 'retired-model' })).toBeNull();
  expect(view.queryByRole('radio', { name: 'gpt-fixture' })).toBeNull();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
  expect(view.getByText('原来的回复')).toBeTruthy();
});

test('a saved default absent from a nonempty catalog requires a real model choice', async () => {
  mockListModels.mockResolvedValue({ models: ['deepseek-chat'] });
  mockLoadPrefs.mockResolvedValue({ model: 'gpt-fixture', apiIdentity: 'computer:api_original' });
  const view = await render(viewThread());
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  await openModels(view);
  expect(view.queryByRole('radio', { name: '默认' })).toBeNull();
  expect(view.queryByRole('radio', { name: 'gpt-fixture' })).toBeNull();
  await fireEvent.press(view.getByRole('radio', { name: 'deepseek-chat' }));
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: 'deepseek-chat' }));
});

test('a failed refresh revokes the earlier catalog and a successful retry restores the same draft', async () => {
  const view = await render(viewThread());
  await openModels(view);
  mockListModels.mockRejectedValueOnce(new Error('fixture network failure'));
  await fireEvent.press(view.getByLabelText('刷新模型列表'));
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  expect(view.getByText('加载失败')).toBeTruthy();
  expect(mockToast).not.toHaveBeenCalled();
  expect(view.queryByRole('radio', { name: 'gpt-fixture' })).toBeNull();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('刷新模型列表'));
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(false);
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: 'gpt-fixture' }));
});

test('a late old API catalog cannot replace the new Key model selection', async () => {
  const release: Array<(value: { models: string[] }) => void> = [];
  mockListModels.mockImplementation(async () => mockRemote.agents.pc.list[0].api.accountId === 'api_backup'
    ? { models: ['deepseek-chat'] } : new Promise((resolve) => { release.push(resolve); }));
  const view = await render(viewThread());
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  await openModels(view);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  await openModels(view);
  await fireEvent.press(view.getByRole('radio', { name: 'deepseek-chat' }));
  await act(async () => { release.forEach((finish) => finish({ models: ['gpt-fixture'] })); });
  expect(view.getByLabelText(`模型：${'deepseek-chat'}`)).toBeTruthy();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: 'deepseek-chat' }));
});

test('the original tool login does not require a vault catalog or override its resumed model', async () => {
  mockRemote.agents.pc.list = [{ ...originalAgent, api: { ...originalAgent.api, source: 'tool', configured: false, model: '' } }];
  const view = await render(viewThread());
  expect(mockListModels).toHaveBeenCalledWith('pc', 'codex', true);
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(false);
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: undefined }));
});

test('a native desktop lease keeps its own send route without requiring the background API catalog', async () => {
  mockRemote.agents.pc.list = [{ ...originalAgent, desktopLive: { expiresAt: Date.now() + 60_000, sessionKeys: ['codex:original'], capabilities: desktopCapabilities } }];
  const view = await render(viewThread());
  expect(mockListModels).not.toHaveBeenCalled();
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(false);
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledTimes(1);
});

test('a retained receipt can still retry its frozen payload when the catalog is unavailable', async () => {
  mockListModels.mockRejectedValue(new Error('catalog unavailable'));
  mockPending.mockResolvedValue({ scope: 'fixture', deviceId: 'pc', sessionKey: 'codex:original', surface: 'cli', text: '待确认任务',
    requestId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', createdAt: Date.now(), firstAttemptAt: Date.now(), lastObservedAt: Date.now(), attempted: true, safeRetry: true,
    sendOptions: { model: 'gpt-frozen', effort: 'high' } });
  const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '待确认任务');
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(false);
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '待确认任务', expect.anything());
  expect(mockSetApi).not.toHaveBeenCalled();
});

test('a backend model rejection revokes stale UI validation and restores the unsent task', async () => {
  mockSend.mockRejectedValueOnce(new Error('这个 API 不支持该模型，请刷新后重选模型'));
  const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '不能丢失的任务');
  await fireEvent.press(view.getByLabelText('发送'));
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('不能丢失的任务');
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  expect(view.getByLabelText('模型：选择模型')).toBeTruthy();
  expect(view.queryByText('请选择模型')).toBeNull();
  mockListModels.mockResolvedValue({ models: ['deepseek-chat'] });
  await openModels(view);
  expect(view.queryByRole('radio', { name: 'gpt-fixture' })).toBeNull();
  await fireEvent.press(view.getByRole('radio', { name: 'deepseek-chat' }));
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenLastCalledWith('pc', 'codex:original', '不能丢失的任务', expect.objectContaining({ model: 'deepseek-chat' }));
  expect(mockStart).not.toHaveBeenCalled();
});

test('following the original tool again does not keep a phone-picked model override', async () => {
  mockRemote.agents.pc.list = [{ ...originalAgent, api: { ...originalAgent.api, source: 'phone' } }];
  mockLoadPrefs.mockResolvedValue({ model: 'gpt-fixture', apiIdentity: 'phone:api_original' });
  const view = await render(viewThread());
  mockSetApi.mockImplementation(async () => {
    const changed: AgentProfile = { ...originalAgent, api: { ...originalAgent.api, model: '', source: 'tool', configured: false } };
    mockRemote.agents.pc.list = [changed]; return changed;
  });
  await openModels(view);
  await fireEvent.press(view.getByRole('radio', { name: '跟随电脑' }));
  expect(view.getByTestId('remote-model-popover')).toBeTruthy();
  expect(mockSetApi).toHaveBeenCalledWith('pc', 'codex', '', '', 'codex:original');
  await closeModels(view);
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: undefined }));
});

test('a pending but unapplied computer card does not impose its model on the tool login', async () => {
  mockRemote.agents.pc.list = [{ ...originalAgent, api: { ...originalAgent.api, source: 'computer', configured: false, pending: true, model: 'not-applied-model' } }];
  const view = await render(viewThread());
  expect(mockListModels).toHaveBeenCalledWith('pc', 'codex', true);
  expect(view.getByLabelText(`模型：${'gpt-fixture'}`)).toBeTruthy();
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(false);
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: undefined }));
});

test('a new API effort cannot be selected until its exact model metadata arrives', async () => {
  let release!: (value: ModelCatalog) => void;
  mockListModels.mockImplementation(async () => mockRemote.agents.pc.list[0].api.accountId === 'api_backup'
    ? new Promise((resolve) => { release = resolve; }) : reportedCatalog());
  const view = await render(viewThread());
  await openModels(view);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  await closeModels(view);
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  expect(view.queryByLabelText('Default')).toBeNull();
  expect(view.queryByLabelText('High')).toBeNull();
  expect(mockSavePrefs).toHaveBeenLastCalledWith('paired|pc|codex:original', { apiIdentity: 'phone:api_backup' });
  await act(async () => { release(reportedCatalog(['gpt-fixture', 'deepseek-chat'])); });
  await scrubEffort(view, 4);
  expect(mockSavePrefs).toHaveBeenLastCalledWith('paired|pc|codex:original', expect.objectContaining({ model: 'gpt-fixture', effort: 'high', apiIdentity: 'phone:api_backup' }));
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: 'gpt-fixture', effort: 'high' }));
});

test('conversation entry forces a fresh catalog once, not on typing, elapsed time or each turn', async () => {
  const view = await render(viewThread());
  expect(mockListModels).toHaveBeenCalledTimes(1);
  expect(mockListModels).toHaveBeenLastCalledWith('pc', 'codex', true);
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '第一次任务');
  await fireEvent.press(view.getByLabelText('发送'));
  await act(async () => { jest.advanceTimersByTime(10 * 60_000); });
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '第二次任务');
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockListModels).toHaveBeenCalledTimes(1);
  await openModels(view);
  expect(mockListModels).toHaveBeenLastCalledWith('pc', 'codex', false);
});

test.each(['valid', 'empty', 'failed'] as const)('automatic catalog checks stay out of the conversation UI: %s', async (outcome) => {
  mockListModels.mockImplementation(async () => {
    if (outcome === 'failed') throw new Error('internal catalog check details');
    return { models: outcome === 'empty' ? [] : ['gpt-fixture'] };
  });
  const view = await render(viewThread());
  expect(mockListModels).toHaveBeenCalledWith('pc', 'codex', true);
  expect(mockToast).not.toHaveBeenCalled();
  expect(view.queryByText(/正在检查|模型列表读取|internal catalog/)).toBeNull();
  expect(view.queryByText('加载失败')).toBeNull();
  expect(view.queryByText('暂无可用模型')).toBeNull();
  expect(view.queryByLabelText('更换对话 API')).toBeNull();
  expect(view.queryByLabelText('选择当前 API 的模型')).toBeNull();
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(outcome !== 'valid');
  expect(view.getByText('原来的回复')).toBeTruthy();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
  if (outcome !== 'valid') {
    await openModels(view);
    expect(view.getByText(outcome === 'failed' ? '加载失败' : '暂无可用模型')).toBeTruthy();
    expect(mockToast).not.toHaveBeenCalled();
  }
});

test('a pending background catalog check does not open a popup or add a progress banner', async () => {
  let release!: (value: { models: string[] }) => void;
  mockListModels.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const view = await render(viewThread());
  expect(view.queryByText(/正在检查|检查成功|模型目录/)).toBeNull();
  expect(view.queryByLabelText('更换对话 API')).toBeNull();
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  expect(mockToast).not.toHaveBeenCalled();
  await act(async () => { release({ models: ['gpt-fixture'] }); });
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(false);
  expect(view.getByLabelText(`模型：${'gpt-fixture'}`)).toBeTruthy();
  expect(mockToast).not.toHaveBeenCalled();
});

test('reopening the same conversation detects a new group even when API handle and Key are unchanged', async () => {
  let group = ['gpt-fixture'];
  mockListModels.mockImplementation(async () => ({ models: group, api: '主力' }));
  mockLoadPrefs.mockResolvedValue({ model: 'gpt-fixture', apiIdentity: 'computer:api_original' });
  const created = jest.fn(), view = await render(viewThread(created));
  const identity = mockRemote.agents.pc.list[0].api;
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(false);
  await view.rerender(viewThread(created, false));
  group = ['claude-sonnet-new'];
  await view.rerender(viewThread(created));
  expect(mockRemote.agents.pc.list[0].api).toBe(identity);
  expect(mockListModels).toHaveBeenCalledTimes(2);
  expect(mockListModels).toHaveBeenLastCalledWith('pc', 'codex', true);
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  expect(view.getByLabelText('模型：选择模型')).toBeTruthy();
  expect(mockToast).not.toHaveBeenCalled();
  expect(view.getByText('原来的回复')).toBeTruthy();
  await openModels(view);
  expect(view.queryByRole('radio', { name: 'gpt-fixture' })).toBeNull();
  await fireEvent.press(view.getByRole('radio', { name: 'claude-sonnet-new' }));
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: 'claude-sonnet-new' }));
  expect(mockSetApi).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled(); expect(created).not.toHaveBeenCalled();
});

test('same-Key entry failure cannot authorize the old cached model or lose the conversation', async () => {
  const view = await render(viewThread());
  await view.rerender(viewThread(undefined, false));
  mockListModels.mockRejectedValueOnce(new Error('fixture permission changed'));
  await view.rerender(viewThread());
  expect(mockListModels).toHaveBeenLastCalledWith('pc', 'codex', true);
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
  expect(view.getByText('原来的回复')).toBeTruthy();
});

test('a late catalog from the previous entry cannot restore an old group after reopening', async () => {
  let release!: (value: { models: string[] }) => void;
  mockListModels.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const view = await render(viewThread());
  await view.rerender(viewThread(undefined, false));
  mockListModels.mockResolvedValue({ models: ['deepseek-chat'] });
  await view.rerender(viewThread());
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  await openModels(view);
  await fireEvent.press(view.getByRole('radio', { name: 'deepseek-chat' }));
  await act(async () => { release({ models: ['gpt-fixture'] }); });
  expect(view.getByLabelText(`模型：${'deepseek-chat'}`)).toBeTruthy();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: 'deepseek-chat' }));
});

test('a new conversation checks its unchanged Key group before starting any task', async () => {
  mockRemote.devices[0].projects = [{ name: '项目', path: 'C:\\fixture' }];
  mockListModels.mockResolvedValue({ models: ['claude-sonnet-new'] });
  const created = jest.fn();
  const view = await render(<ThreadView visible deviceId="pc" sessionKey={null} agent={originalAgent} onClose={jest.fn()} onCreated={created} />);
  expect(mockListModels).toHaveBeenLastCalledWith('pc', 'codex', true);
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  expect(mockStart).not.toHaveBeenCalled();
  await openModels(view);
  await fireEvent.press(view.getByRole('radio', { name: 'claude-sonnet-new' }));
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockStart).toHaveBeenCalledWith('pc', expect.objectContaining({ tool: 'codex', cwd: 'C:\\fixture', prompt: '原草稿', model: 'claude-sonnet-new' }));
  expect(created).toHaveBeenCalledWith('codex:new');
  expect(mockSetApi).not.toHaveBeenCalled(); expect(mockSend).not.toHaveBeenCalled();
});

const compactQuestion = (id = 'compact'): TimelineItem => ({ kind: 'approval', id, approval: 'question', title: '选一下', state: 'pending', ts: 2,
  questions: [{ id: 'choice', question: '选方案', required: true, options: [{ label: 'A' }, { label: 'B' }] }] });
const oldReply: TimelineItem = { kind: 'message', id: 'old', role: 'assistant', text: '原来的回复', final: true, ts: 1 };

test.each(['allow', 'deny'] as const)('submitting %s restores the draft and attachments immediately, with delivery progress only in the main conversation', async (decision) => {
  const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '未发送的新任务');
  mockPickImages.mockResolvedValueOnce([{ uri: 'fixture://draft-image', base64: 'fixture', mime: 'image/jpeg', width: 100, height: 100 }]);
  await fireEvent.press(view.getByLabelText('添加图片'));
  await fireEvent.press(view.getByLabelText('从相册选择'));
  expect(view.getByLabelText('移除图片')).toBeTruthy();
  setItems([oldReply, compactQuestion()]);
  await view.rerender(viewThread());
  expect(view.queryByLabelText('给电脑上的 Agent 发消息')).toBeNull();
  expect(view.queryByLabelText('移除图片')).toBeNull();
  expect(view.getByTestId('remote-question-dialog')).toBeTruthy();
  expect(within(view.getByTestId('remote-conversation')).queryByLabelText('回答 Agent 的问题')).toBeNull();
  expect(view.getByText('原来的回复')).toBeTruthy();
  if (decision === 'allow') {
    await fireEvent.press(view.getByRole('radio', { name: 'B' }));
    await fireEvent.press(view.getByLabelText('提交回答'));
  } else await fireEvent.press(view.getByLabelText('取消回答'));
  expect(mockRespond).toHaveBeenCalledWith({ approvalId: 'compact', deviceId: 'pc', sessionKey: 'codex:original' }, decision, undefined, decision === 'allow' ? { choice: ['B'] } : undefined, expect.objectContaining({ requestId: expect.any(String), retrying: false }));
  // Locally dismiss the card; do not claim approval.resolved before the real receipt.
  expect(view.queryByTestId('remote-question-dialog')).toBeNull();
  expect(within(view.getByTestId('remote-conversation')).getByTestId('remote-answer-delivery')).toBeTruthy();
  expect(mockRemote.timelines['pc|codex:original'].items.at(-1)).toMatchObject({ state: 'pending' });
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('未发送的新任务');
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.placeholder).toBe('随心输入');
  expect(view.getByLabelText('移除图片')).toBeTruthy();
  expect(view.queryByLabelText('提交回答')).toBeNull();
  setItems([oldReply, { ...compactQuestion(), state: decision } as TimelineItem]);
  await view.rerender(viewThread());
  expect(view.queryByTestId('remote-question-dialog')).toBeNull();
  expect(view.queryByTestId('remote-answer-delivery')).toBeNull();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('未发送的新任务');
  expect(view.getByLabelText('移除图片')).toBeTruthy();
  expect(view.getByText('原来的回复')).toBeTruthy();
  expect(mockStart).not.toHaveBeenCalled(); expect(mockSend).not.toHaveBeenCalled();
});

test('definitive question rejection restores the answer for correction without losing the draft', async () => {
  setItems([oldReply, compactQuestion()]); mockRespond.mockRejectedValueOnce(new Error('fixture disconnected'));
  const view = await render(viewThread());
  await fireEvent.press(view.getByRole('radio', { name: 'A' }));
  await fireEvent.press(view.getByLabelText('提交回答'));
  expect(view.getByRole('radio', { name: 'A' }).props.accessibilityState.checked).toBe(true);
  expect(view.queryByLabelText('给电脑上的 Agent 发消息')).toBeNull();
  mockRemote.devices[0].online = false;
  await view.rerender(viewThread());
  expect(view.getByLabelText('提交回答').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(view.getByLabelText('提交回答')); await fireEvent.press(view.getByLabelText('取消回答'));
  expect(mockRespond).toHaveBeenCalledTimes(1);
  mockRemote.devices[0].online = true;
  await view.rerender(viewThread());
  expect(view.getByRole('radio', { name: 'A' }).props.accessibilityState.checked).toBe(true);
  await fireEvent.press(view.getByLabelText('提交回答'));
  expect(mockRespond).toHaveBeenCalledTimes(2);
  expect(mockRespond).toHaveBeenLastCalledWith({ approvalId: 'compact', deviceId: 'pc', sessionKey: 'codex:original' }, 'allow', undefined, { choice: ['A'] }, expect.objectContaining({ retrying: false }));
});

test('a lost question acknowledgement leaves the input usable and retries the frozen answer from main-conversation progress', async () => {
  setItems([oldReply, compactQuestion()]);
  mockRespond.mockRejectedValueOnce(new HubError('fixture disconnected'));
  const view = await render(viewThread());
  await fireEvent.press(view.getByRole('radio', { name: 'A' }));
  await fireEvent.press(view.getByLabelText('提交回答'));
  expect(view.queryByRole('radio', { name: 'A' })).toBeNull();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
  expect(view.getByTestId('remote-answer-delivery')).toBeTruthy();
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '等待时先写下一步');
  const send = view.getByLabelText(/^(发送|排队发送)$/);
  expect(send.props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(send); expect(mockSend).not.toHaveBeenCalled();
  expect(mockToast).not.toHaveBeenCalled();
  await act(async () => { jest.advanceTimersByTime(2000); });
  expect(mockRespond).toHaveBeenCalledTimes(2);
  expect(mockRespond.mock.calls[1].slice(0, 4)).toEqual(mockRespond.mock.calls[0].slice(0, 4));
  expect(mockRespond.mock.calls[1][4]).toMatchObject({ requestId: (mockRespond.mock.calls[0][4] as { requestId: string }).requestId, retrying: true });
  // Even a successful transport cannot claim delivery before a resolved event.
  expect(view.getByTestId('remote-answer-delivery')).toBeTruthy();
  setItems([oldReply, { ...compactQuestion(), state: 'allow' } as TimelineItem]);
  await view.rerender(viewThread());
  expect(view.queryByTestId('remote-question-dialog')).toBeNull();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('等待时先写下一步');
});

test('rapid duplicate presses submit once and a late old-session failure cannot unlock the new question', async () => {
  let rejectOld!: (reason: Error) => void, finishNew!: () => void;
  mockRespond.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectOld = reject; }))
    .mockImplementationOnce(() => new Promise<void>((resolve) => { finishNew = resolve; }));
  setItems([oldReply, compactQuestion('old-question')]);
  const view = await render(viewThread());
  await fireEvent.press(view.getByRole('radio', { name: 'A' }));
  const submit = view.getByLabelText('提交回答').props.onPress as () => void;
  await act(async () => { submit(); submit(); });
  expect(mockRespond).toHaveBeenCalledTimes(1);
  const otherSession = { ...originalSession, sessionKey: 'codex:other', title: '另一会话' };
  mockRemote.sessions.pc.list.push(otherSession);
  mockRemote.timelines['pc|codex:other'] = { items: [compactQuestion('new-question')], loading: false, session: otherSession };
  const other = <ThreadView visible deviceId="pc" sessionKey="codex:other" agent={originalAgent} onClose={jest.fn()} onCreated={jest.fn()} />;
  await view.rerender(other);
  expect(view.getByLabelText('提交回答').props.accessibilityState.disabled).toBe(false);
  await fireEvent.press(view.getByRole('radio', { name: 'B' }));
  await fireEvent.press(view.getByLabelText('提交回答'));
  expect(mockRespond).toHaveBeenCalledTimes(2);
  await act(async () => { rejectOld(new Error('obsolete request error')); });
  expect(mockToast).not.toHaveBeenCalled();
  expect(view.getByTestId('remote-answer-delivery')).toBeTruthy();
  expect(view.queryByLabelText('提交回答')).toBeNull();
  await act(async () => { finishNew(); });
  expect(view.getByTestId('remote-answer-delivery')).toBeTruthy();
  expect(view.queryByLabelText('提交回答')).toBeNull();
  expect(mockRespond).toHaveBeenLastCalledWith({ approvalId: 'new-question', deviceId: 'pc', sessionKey: 'codex:other' }, 'allow', undefined, { choice: ['B'] }, expect.objectContaining({ retrying: false }));
});

test('three subagents share one collapsed summary and update independently without leaking into the main replies', async () => {
  const tasks = ['a', 'b', 'c'].flatMap<TimelineItem>((id, index) => [
    { kind: 'tool', id, tool: 'subagent', title: `检查 ${id}`, detail: `任务 ${id} 的要求`, childSessionKeys: [`codex:child-${id}`], status: 'done', ts: index * 2 + 2 },
    { kind: 'tool', id: `${id}:state`, tool: 'subagent', title: `子智能体 ${id}`, parentId: id, childSessionKeys: [`codex:child-${id}`], status: id === 'a' ? 'done' : id === 'b' ? 'running' : 'failed', output: `${id} 的进度`, ts: index * 2 + 3 },
  ]);
  setItems([oldReply, ...tasks]);
  const created = jest.fn(), view = await render(viewThread(created));
  expect(view.getAllByLabelText('展开处理摘要')).toHaveLength(1);
  expect(view.getByText('3 个子智能体 · 进行中')).toBeTruthy();
  expect(view.queryByText('检查 a')).toBeNull(); expect(view.queryByText('a 的进度')).toBeNull();
  expect(view.getByText('原来的回复')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('展开处理摘要'));
  expect(view.getByText('检查 a')).toBeTruthy(); expect(view.getByText('检查 b')).toBeTruthy(); expect(view.getByText('检查 c')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('检查 a：子任务详情'));
  expect(view.getByText('任务 a 的要求')).toBeTruthy(); expect(view.queryByText('任务 b 的要求')).toBeNull();
  await fireEvent.press(view.getByText('子智能体 a'));
  expect(view.getByText('a 的进度')).toBeTruthy();
  setItems([oldReply, ...tasks.map((item) => item.id === 'b:state' ? { ...item, status: 'done', output: 'b 已完成' } as TimelineItem : item)]);
  await view.rerender(viewThread(created));
  expect(view.getByLabelText('收起处理摘要')).toBeTruthy(); expect(view.getByText('a 的进度')).toBeTruthy();
  expect(view.getByText('3 个子智能体 · 有失败')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('打开子智能体对话 1'));
  expect(created).toHaveBeenCalledWith('codex:child-a');
  await fireEvent.press(view.getByLabelText('收起处理摘要'));
  expect(view.queryByText('检查 a')).toBeNull(); expect(view.queryByText('a 的进度')).toBeNull();
  expect(mockStart).not.toHaveBeenCalled();
});

test('child edits and plans stay inside the task details and pending child questions are not marked answered', async () => {
  setItems([
    oldReply,
    { kind: 'tool', id: 'task', tool: 'subagent', title: '子任务', status: 'done', childSessionKeys: ['codex:child'], ts: 2 },
    { kind: 'tool', id: 'child-edit', tool: 'file_change', title: '修改 child.ts', diff: '--- a/child.ts\n+++ b/child.ts\n-old\n+new', status: 'done', parentId: 'task', ts: 3 },
    { kind: 'tool', id: 'child-plan', tool: 'plan', title: '计划', output: '✓ 子任务分析\n○ 子任务验证', status: 'running', parentId: 'task', ts: 4 },
    { ...compactQuestion('child-question'), title: '子任务提问', parentId: 'task' } as TimelineItem,
  ]);
  const view = await render(viewThread());
  expect(view.queryByText('child.ts')).toBeNull(); expect(view.queryByText('子任务分析')).toBeNull();
  await fireEvent.press(view.getByLabelText('展开处理摘要'));
  expect(view.queryByText('child.ts')).toBeNull();
  await fireEvent.press(view.getByLabelText('子任务：子任务详情'));
  expect(view.getByText('child.ts')).toBeTruthy(); expect(view.getByText('子任务分析')).toBeTruthy(); expect(view.getByText('子任务验证')).toBeTruthy();
  expect(view.getByText('等待回答：子任务提问')).toBeTruthy();
  expect(view.queryByText('已回答：子任务提问')).toBeNull();
  expect(view.getByTestId('remote-question-dialog')).toBeTruthy();
  expect(within(view.getByTestId('remote-conversation')).queryByLabelText('提交回答')).toBeNull();
});

test('restored answers wait for a fresh snapshot and then reuse the journaled UUID', async () => {
  const receipt = { scope: 'paired|fixture-credential', deviceId: 'pc', sessionKey: 'codex:original', approvalId: 'restored',
    decision: 'allow', answers: { choice: ['B'] }, requestId: '0199aaa1-1234-4678-9abc-000000000007', createdAt: Date.now() - 1000, lastObservedAt: Date.now() - 1000, attempted: true };
  mockQuestionStorage.set('remote_question_outbox_v1', JSON.stringify([receipt]));
  setItems([oldReply, compactQuestion('restored')]); mockRemote.timelines['pc|codex:original'].snapshotAt = Date.now() - 5000;
  let read!: () => void; const opening = new Promise<undefined>(resolve => { read = () => resolve(undefined); }); mockOpen.mockReturnValue(opening);
  let acknowledge!: () => void; const response = new Promise<void>(resolve => { acknowledge = resolve; }); mockRespond.mockReturnValue(response);
  const view = await render(viewThread()); expect(mockRespond).not.toHaveBeenCalled();
  await act(async () => { read(); await opening; });
  expect(mockRespond).toHaveBeenCalledWith({ approvalId: 'restored', deviceId: 'pc', sessionKey: 'codex:original' }, 'allow', undefined,
    { choice: ['B'] }, expect.objectContaining({ requestId: receipt.requestId, retrying: true }));
  expect(view.getByTestId('remote-answer-delivery')).toBeTruthy();
  setItems([oldReply, { ...compactQuestion('restored'), state: 'allow' } as TimelineItem]); mockRemote.timelines['pc|codex:original'].snapshotAt = Date.now();
  await view.rerender(viewThread()); await act(async () => { acknowledge(); await response; });
  expect(mockSend).not.toHaveBeenCalled(); expect(mockRespond).toHaveBeenCalledTimes(1);
});

test.each(['hide', 'unmount', 'withdraw'])('a queued question submit after %s cannot create a receipt or send', async mode => {
  setItems([oldReply, compactQuestion('stale-question')]);
  const view = await render(viewThread()); await fireEvent.press(view.getByText('B'));
  const submit = view.getByLabelText('提交回答').props.onPress as () => void;
  if (mode === 'hide') await view.rerender(viewThread(jest.fn(), false));
  else if (mode === 'unmount') await view.unmount();
  else { setItems([oldReply]); await view.rerender(viewThread()); }
  await act(async () => { submit(); });
  expect(mockRespond).not.toHaveBeenCalled(); expect(JSON.parse(mockQuestionStorage.get('remote_question_outbox_v1') ?? '[]')).toEqual([]);
});

test('a queued old send callback after closing cannot dispatch', async () => {
  const view = await render(viewThread()); const send = mockSendSubmit.current;
  await view.rerender(viewThread(jest.fn(), false)); await act(async () => { await send(); });
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
});

test('a late new-thread acknowledgement cannot clear or navigate a newly selected conversation', async () => {
  let finish!: (key: string) => void; mockStart.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  mockRemote.devices[0].projects = [{ path: 'C:\\fixture', name: 'fixture' }]; const created = jest.fn();
  const view = await render(<ThreadView visible deviceId="pc" sessionKey={null} agent={originalAgent} onClose={jest.fn()} onCreated={created} />);
  await act(async () => { fireEvent.press(view.getByLabelText('发送')); }); expect(mockStart).toHaveBeenCalledTimes(1);
  await view.rerender(viewThread()); await fireEvent.changeText(view.getByPlaceholderText('随心输入'), '新会话草稿');
  await act(async () => { finish('codex:created-earlier'); });
  expect(created).not.toHaveBeenCalled(); expect(view.getByPlaceholderText('随心输入').props.value).toBe('新会话草稿');
  expect(mockToast).not.toHaveBeenCalled();
});

test('renewed pairing credentials cancel the old answer spinner even for the same connection and thread', async () => {
  setItems([oldReply, compactQuestion('credential-question')]); mockRespond.mockReturnValue(new Promise(() => undefined));
  const view = await render(viewThread()); await fireEvent.press(view.getByText('B')); await fireEvent.press(view.getByLabelText('提交回答'));
  expect(view.getByTestId('remote-answer-delivery')).toBeTruthy();
  mockDeliveryScope = 'paired|new-fixture-credential'; await view.rerender(viewThread());
  expect(view.queryByTestId('remote-answer-delivery')).toBeNull(); expect(view.getByLabelText('提交回答').props.accessibilityState.disabled).toBe(false);
  expect(mockRespond).toHaveBeenCalledTimes(1); expect(mockOpen).toHaveBeenCalledTimes(2);
});

test('local form expiry cannot reconcile away its UUID tombstone or replay after clock rollback', async () => {
  const now = Date.now(), approval = { ...compactQuestion('local-expiry'), expiresAt: now + 500 };
  const receipt = { scope: mockDeliveryScope, deviceId: 'pc', sessionKey: 'codex:original', approvalId: approval.id,
    decision: 'allow', answers: { choice: ['B'] }, requestId: '0199aaa1-1234-4678-9abc-000000000007', createdAt: now - 1000, lastObservedAt: now - 1000, expiresAt: approval.expiresAt, attempted: true };
  mockQuestionStorage.set('remote_question_outbox_v1', JSON.stringify([receipt])); mockRemote.devices[0].online = false;
  setItems([oldReply, approval]); mockRemote.timelines['pc|codex:original'].snapshotAt = now; mockRemote.timelines['pc|codex:original'].snapshotStartedAt = now;
  const view = await render(viewThread()); await act(async () => { jest.advanceTimersByTime(600); });
  expect(JSON.parse(mockQuestionStorage.get('remote_question_outbox_v1')!)[0]).toMatchObject({ requestId: receipt.requestId, blocked: 'question_expired' });
  jest.setSystemTime(now + 100); await view.rerender(viewThread(jest.fn(), false)); await view.rerender(viewThread());
  expect(mockRespond).not.toHaveBeenCalled(); expect(JSON.parse(mockQuestionStorage.get('remote_question_outbox_v1')!)[0].requestId).toBe(receipt.requestId);
});

test('a blocked receipt for the second question cannot disable the first question', async () => {
  const now = Date.now(); setItems([oldReply, compactQuestion('first-question'), compactQuestion('second-question')]);
  mockRemote.timelines['pc|codex:original'].snapshotAt = now; mockRemote.timelines['pc|codex:original'].snapshotStartedAt = now;
  mockQuestionStorage.set('remote_question_outbox_v1', JSON.stringify([{ scope: mockDeliveryScope, deviceId: 'pc', sessionKey: 'codex:original', approvalId: 'second-question', decision: 'allow',
    answers: { choice: ['B'] }, requestId: '0199aaa1-1234-4678-9abc-000000000007', createdAt: now - 1000, lastObservedAt: now - 1000, attempted: true, blocked: 'command_delivery_uncertain' }]));
  const view = await render(viewThread()); expect(view.queryByText('请在电脑核对回答')).toBeNull();
  await fireEvent.press(view.getByText('B')); expect(view.getByLabelText('提交回答').props.accessibilityState.disabled).toBe(false);
  await fireEvent.press(view.getByLabelText('提交回答')); expect(mockRespond.mock.calls[0][0]).toMatchObject({ approvalId: 'first-question' });
});

test('queued old menu actions cannot cancel or open anything through renewed pairing credentials', async () => {
  mockPending.mockResolvedValue({ scope: mockDeliveryScope, deviceId: 'pc', sessionKey: 'codex:original', surface: 'cli', text: '待确认任务',
    requestId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', createdAt: Date.now(), attempted: true, safeRetry: true });
  const view = await render(viewThread()); await fireEvent.press(view.getByLabelText('更多'));
  const cancel = mockDialogActions.get('已核对，停止重发')!, open = mockDialogActions.get('在电脑的 Codex 里打开')!;
  expect(typeof cancel).toBe('function'); expect(typeof open).toBe('function');
  mockDeliveryScope = 'paired|renewed'; await view.rerender(viewThread());
  await act(async () => { cancel(); open(); });
  expect(mockCancelPending).not.toHaveBeenCalled(); expect(mockOpenDesktop).not.toHaveBeenCalled();
});

test('an expired native lease cannot silently turn the same screen into a background sender', async () => {
  mockRemote.agents.pc.list = [{ ...originalAgent, desktopLive: { expiresAt: Date.now() + 60000, sessionKeys: ['codex:original'], capabilities: desktopCapabilities } }];
  const view = await render(viewThread()); expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(false);
  mockRemote.agents.pc.list[0].desktopLive!.expiresAt = Date.now() - 1;
  await view.rerender(viewThread()); await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).not.toHaveBeenCalled(); expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  expect(view.getByLabelText('添加图片').props.accessibilityState.disabled).toBe(true);
});

test('earlier-history action reads the same thread without moving the scroll to the live tail', async () => {
  mockRemote.timelines['pc|codex:original'].nextCursor = 'older';
  const view = await render(viewThread()); await fireEvent.press(view.getByLabelText('加载更早记录'));
  expect(mockLoadEarlier).toHaveBeenCalledWith('pc', 'codex:original', expect.any(Object)); expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
});

test('backgrounding cancels the first history read and foreground retries without resetting the draft', async () => {
  let release!: () => void;
  const pending = new Promise<undefined>(resolve => { release = () => resolve(undefined); });
  mockOpen.mockImplementationOnce(() => pending);
  const view = await render(viewThread());
  await fireEvent.changeText(view.getByPlaceholderText('随心输入'), '未发送的文字');
  const signal = (mockOpen.mock.calls[0][2] as { signal: AbortSignal }).signal;
  const listeners = (AppState.addEventListener as jest.Mock).mock.calls.map((call) => call[1] as (state: string) => void);
  await act(async () => { jest.replaceProperty(AppState, 'currentState', 'background'); listeners.forEach(change => change('background')); });
  expect(signal.aborted).toBe(true);
  await act(async () => { release(); await pending; });
  await act(async () => { jest.replaceProperty(AppState, 'currentState', 'active'); listeners.forEach(change => change('active')); });
  expect(mockOpen).toHaveBeenCalledTimes(2);
  expect((mockOpen.mock.calls[1][2] as { signal: AbortSignal }).signal.aborted).toBe(false);
  expect(view.getByPlaceholderText('随心输入').props.value).toBe('未发送的文字');
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
});

test('an initially backgrounded thread defers its first history read until foreground', async () => {
  jest.replaceProperty(AppState, 'currentState', 'background');
  const view = await render(viewThread());
  expect(mockOpen).not.toHaveBeenCalled();
  const listeners = (AppState.addEventListener as jest.Mock).mock.calls.map((call) => call[1] as (state: string) => void);
  await act(async () => { jest.replaceProperty(AppState, 'currentState', 'active'); listeners.forEach(change => change('active')); });
  expect(mockOpen).toHaveBeenCalledTimes(1);
  await view.unmount();
});

test('backgrounding cancels an earlier-history read as well as the initial snapshot', async () => {
  mockRemote.timelines['pc|codex:original'].nextCursor = 'older';
  mockLoadEarlier.mockImplementationOnce(() => new Promise(() => undefined));
  const view = await render(viewThread()); await fireEvent.press(view.getByLabelText('加载更早记录'));
  const signal = mockLoadEarlier.mock.calls[0][2] as AbortSignal;
  const listeners = (AppState.addEventListener as jest.Mock).mock.calls.map((call) => call[1] as (state: string) => void);
  await act(async () => { jest.replaceProperty(AppState, 'currentState', 'background'); listeners.forEach(change => change('background')); });
  expect(signal.aborted).toBe(true);
  await view.unmount();
});

test('native Claude readonly history shows its original replies without composer, models, stop or approval actions', async () => {
  const key = 'claude-desktop:local_0199aaa1-1234-4678-9abc-000000000001';
  mockRemote.timelines[`pc|${key}`] = { items: [oldReply], loading: false, session: { ...originalSession, sessionKey: key, tool: 'claude', client: 'Claude Desktop', controlSurface: 'read-only', controllable: false, sessionScope: 'desktop-chat' } };
  const view = await render(<ThreadView visible deviceId="pc" sessionKey={key} agent={originalAgent} onClose={jest.fn()} onCreated={jest.fn()} />);
  expect(view.getByText('原来的回复')).toBeTruthy(); expect(view.getByTestId('remote-readonly-footer')).toBeTruthy();
  expect(view.queryByLabelText('发送')).toBeNull(); expect(view.queryByLabelText('给电脑上的 Agent 发消息')).toBeNull();
  expect(view.queryByLabelText('停止')).toBeNull(); expect(mockListModels).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled(); expect(mockRespond).not.toHaveBeenCalled();
});
