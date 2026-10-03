import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { ApiPicker, InlineApiPicker } from '../remote/ApiPicker';
import type { AgentProfile, RemoteApiOption } from '../remote/client';

let mockConnectionId = 'station-a';
const mockSetApi = jest.fn();
const mockToast = jest.fn();
let mockSubmit: () => void;
// Keep the controllable callback host for lifecycle tests; the real gradient
// action, loading gate and accessibility contract have their own UI suite.
jest.mock('../remote/ProgrammingUi', () => {
  const React = require('react'); const { Pressable, Text, View } = require('react-native');
  return { ...jest.requireActual('../remote/ProgrammingUi'),
    ProgrammingSheet: ({ visible, title, children, footer, onClose, dismissible = true }: { visible: boolean; title: string; children: unknown; footer: unknown; onClose: () => void; dismissible?: boolean }) => visible
      ? React.createElement(View, null,
        React.createElement(Pressable, { testID: 'api-picker-backdrop', disabled: !dismissible, onPress: () => { if (dismissible) onClose(); } }),
        React.createElement(Text, null, title), children, footer)
      : null,
    ProgrammingAction: ({ label, onPress, disabled, loading }: { label: string; onPress: () => void; disabled?: boolean; loading?: boolean }) => {
    mockSubmit = onPress;
    return React.createElement(Pressable, { accessibilityRole: 'button', accessibilityLabel: label,
      accessibilityState: { disabled: Boolean(disabled || loading), busy: Boolean(loading) }, disabled: Boolean(disabled || loading), onPress }, React.createElement(Text, null, label));
  } };
});
jest.mock('../remote/store', () => ({
  useRemote: () => ({ connectionId: mockConnectionId }),
  setAgentApi: (...args: unknown[]) => mockSetApi(...args),
}));
jest.mock('../components/Icon', () => ({ Icon: () => null }));
jest.mock('../components/ui', () => {
  const React = require('react');
  const { Pressable, View, Text } = require('react-native');
  return {
    Group: ({ children }: { children: unknown }) => React.createElement(View, null, children),
    Sheet: ({ visible, title, children, footer, onClose }: { visible: boolean; title: string; children: unknown; footer: unknown; onClose: () => void }) => visible
      ? React.createElement(View, null,
        React.createElement(Pressable, { testID: 'api-picker-backdrop', onPress: onClose }),
        React.createElement(Text, null, title), children, footer)
      : null,
    PrimaryButton: ({ label, onPress, disabled, loading }: { label: string; onPress: () => void; disabled?: boolean; loading?: boolean }) => {
      mockSubmit = onPress;
      return React.createElement(Pressable, {
        accessibilityRole: 'button', accessibilityLabel: label,
        accessibilityState: { disabled: Boolean(disabled || loading), busy: Boolean(loading) },
        disabled: Boolean(disabled || loading), onPress,
      }, React.createElement(Text, null, label));
    },
    showToast: (...args: unknown[]) => mockToast(...args), dismissKeyboardAndBlur: () => undefined,
  };
});

const agent: AgentProfile = {
  id: 'codex', name: 'Codex', tool: 'codex', available: true,
  remoteSendSupported: true, conversationApiSwitch: true,
  api: { name: '主力', model: 'gpt-fixture', protocol: 'responses', configured: true, pending: false, source: 'phone', accountId: 'opaque-primary' },
};
const apis: RemoteApiOption[] = [
  { id: 'opaque-primary', name: '主力', models: ['gpt-fixture'] },
  { id: 'opaque-backup', name: '备用', models: ['claude-fixture'] },
];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(overrides: Partial<React.ComponentProps<typeof ApiPicker>> = {}) {
  return { visible: true, deviceId: 'pc-a', agent, apis, sessionKey: 'codex:original', onClose: jest.fn(), onChanged: jest.fn(), ...overrides };
}
beforeEach(() => { jest.clearAllMocks(); mockSetApi.mockReset(); mockConnectionId = 'station-a'; });

test('API library is named, concise and never submits merely by opening or choosing a row', async () => {
  const props = fixture();
  const view = await render(<ApiPicker {...props} />);
  expect(view.getByText('更换 API')).toBeTruthy();
  expect(view.getAllByRole('radio').map((row) => row.props.accessibilityLabel)).toEqual(['跟随电脑', '主力', '备用']);
  expect(view.getByRole('radio', { name: '主力' }).props.accessibilityState.checked).toBe(true);
  expect(view.queryByText('gpt-fixture')).toBeNull();
  expect(view.queryByText('opaque-primary')).toBeNull();
  expect(view.queryByText('关闭')).toBeNull();
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  expect(view.getByRole('radio', { name: '备用' }).props.accessibilityState.checked).toBe(true);
  expect(mockSetApi).not.toHaveBeenCalled();
  expect(props.onChanged).not.toHaveBeenCalled();
});

test('outside dismissal cancels the unsaved choice and reopening restores the active API', async () => {
  const props = fixture();
  const view = await render(<ApiPicker {...props} />);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  await fireEvent.press(view.getByTestId('api-picker-backdrop'));
  expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(mockSetApi).not.toHaveBeenCalled();
  expect(props.onChanged).not.toHaveBeenCalled();
  await view.rerender(<ApiPicker {...props} visible={false} />);
  await view.rerender(<ApiPicker {...props} />);
  expect(view.getByRole('radio', { name: '主力' }).props.accessibilityState.checked).toBe(true);
  expect(view.getByRole('radio', { name: '备用' }).props.accessibilityState.checked).toBe(false);
});

test('confirmation sends only an opaque API handle and retains the original conversation', async () => {
  const props = fixture();
  const updated = { ...agent, api: { ...agent.api, accountId: 'opaque-backup', name: '备用' } };
  mockSetApi.mockResolvedValue(updated);
  const view = await render(<ApiPicker {...props} />);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  await fireEvent.press(view.getByLabelText('使用这个设置'));
  expect(mockSetApi).toHaveBeenCalledTimes(1);
  expect(mockSetApi).toHaveBeenCalledWith('pc-a', 'codex', 'opaque-backup', '', 'codex:original');
  expect(props.onChanged).toHaveBeenCalledWith(updated);
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

test('same-tick repeated confirmation and row changes cannot duplicate or mutate a pending submission', async () => {
  const request = deferred<AgentProfile>(); mockSetApi.mockReturnValue(request.promise);
  const view = await render(<ApiPicker {...fixture()} />);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  const submit = mockSubmit;
  await act(async () => { submit(); submit(); });
  await fireEvent.press(view.getByRole('radio', { name: '跟随电脑' }));
  expect(mockSetApi).toHaveBeenCalledTimes(1);
  expect(mockSetApi).toHaveBeenCalledWith('pc-a', 'codex', 'opaque-backup', '', 'codex:original');
  expect(view.getByRole('radio', { name: '备用' }).props.accessibilityState.checked).toBe(true);
  expect(view.getByLabelText('使用这个设置').props.accessibilityState.busy).toBe(true);
  await act(async () => { request.resolve(agent); });
});

test('an API removed from the current library cannot be submitted', async () => {
  const props = fixture();
  const view = await render(<ApiPicker {...props} />);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  await view.rerender(<ApiPicker {...props} apis={[apis[0]]} />);
  expect(view.queryByRole('radio', { name: '备用' })).toBeNull();
  expect(view.getByLabelText('使用这个设置').props.accessibilityState.disabled).toBe(true);
  await act(async () => { mockSubmit(); });
  expect(mockSetApi).not.toHaveBeenCalled();
  await fireEvent.press(view.getByRole('radio', { name: '主力' }));
  expect(view.getByLabelText('使用这个设置').props.accessibilityState.disabled).toBe(false);
});

test('a queued old UI press cannot dispatch against a different window scope or a reopened window', async () => {
  const props = fixture();
  const view = await render(<ApiPicker {...props} />);
  const oldSubmit = mockSubmit;
  await view.rerender(<ApiPicker {...props} deviceId="pc-b" sessionKey="codex:other" />);
  await act(async () => { oldSubmit(); });
  expect(mockSetApi).not.toHaveBeenCalled();
  const beforeReopen = mockSubmit;
  await view.rerender(<ApiPicker {...props} deviceId="pc-b" sessionKey="codex:other" visible={false} />);
  await view.rerender(<ApiPicker {...props} deviceId="pc-b" sessionKey="codex:other" />);
  await act(async () => { beforeReopen(); });
  expect(mockSetApi).not.toHaveBeenCalled();
});

test('queued UI presses recheck the latest Key catalog and task block before dispatch', async () => {
  const props = fixture();
  const view = await render(<ApiPicker {...props} />);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  const beforeRemoval = mockSubmit;
  await view.rerender(<ApiPicker {...props} apis={[apis[0]]} />);
  await act(async () => { beforeRemoval(); });
  expect(mockSetApi).not.toHaveBeenCalled();
  await view.rerender(<ApiPicker {...props} />);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  const beforeBlock = mockSubmit;
  await view.rerender(<ApiPicker {...props} blocked="当前任务进行中" />);
  await act(async () => { beforeBlock(); });
  expect(mockSetApi).not.toHaveBeenCalled();
});

test('pending dismissal is blocked and an external close/reopen keeps the mutation locked until its receipt', async () => {
  const oldRequest = deferred<AgentProfile>(), newRequest = deferred<AgentProfile>();
  mockSetApi.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
  const props = fixture();
  const view = await render(<ApiPicker {...props} />);
  await fireEvent.press(view.getByLabelText('使用这个设置'));
  await fireEvent.press(view.getByTestId('api-picker-backdrop'));
  expect(props.onClose).not.toHaveBeenCalled();
  await view.rerender(<ApiPicker {...props} visible={false} />);
  await view.rerender(<ApiPicker {...props} />);
  expect(view.getByLabelText('使用这个设置').props.accessibilityState.busy).toBe(true);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  await fireEvent.press(view.getByLabelText('使用这个设置'));
  expect(mockSetApi).toHaveBeenCalledTimes(1);
  await act(async () => { oldRequest.resolve(agent); });
  expect(props.onChanged).toHaveBeenCalledTimes(1);
  expect(props.onClose).not.toHaveBeenCalled();
  expect(view.getByLabelText('使用这个设置').props.accessibilityState.busy).toBe(false);
  await act(async () => { mockSubmit(); });
  expect(mockSetApi).toHaveBeenCalledTimes(2);
  await act(async () => { newRequest.resolve(agent); });
  expect(props.onChanged).toHaveBeenCalledTimes(2);
  expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(mockToast).not.toHaveBeenCalled();
});

test.each(['connection', 'device', 'session', 'agent'] as const)('a late receipt from a changed %s cannot interfere with the current window', async (changedScope) => {
  const oldRequest = deferred<AgentProfile>(), newRequest = deferred<AgentProfile>();
  mockSetApi.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
  const props = fixture();
  const view = await render(<ApiPicker {...props} />);
  await fireEvent.press(view.getByLabelText('使用这个设置'));
  if (changedScope === 'connection') mockConnectionId = 'station-b';
  const next = {
    ...props,
    ...(changedScope === 'device' ? { deviceId: 'pc-b' } : {}),
    ...(changedScope === 'session' ? { sessionKey: 'codex:other' } : {}),
    ...(changedScope === 'agent' ? { agent: { ...agent, id: 'claude' as const, tool: 'claude' as const } } : {}),
  };
  await view.rerender(<ApiPicker {...next} />);
  expect(view.getByLabelText('使用这个设置').props.accessibilityState.busy).toBe(true);
  await fireEvent.press(view.getByLabelText('使用这个设置'));
  expect(mockSetApi).toHaveBeenCalledTimes(1);
  await act(async () => { oldRequest.reject(new Error('旧连接回执')); });
  expect(props.onChanged).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
  expect(mockToast).not.toHaveBeenCalled();
  expect(view.getByLabelText('使用这个设置').props.accessibilityState.busy).toBe(false);
  await fireEvent.press(view.getByLabelText('使用这个设置'));
  expect(mockSetApi).toHaveBeenCalledTimes(2);
  expect(mockSetApi).toHaveBeenLastCalledWith(next.deviceId, next.agent.id, 'opaque-primary', '', next.sessionKey);
  await act(async () => { newRequest.resolve(agent); });
  expect(props.onChanged).toHaveBeenCalledTimes(1);
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

test('an unmounted picker ignores both late failure notifications and callbacks', async () => {
  const request = deferred<AgentProfile>(); mockSetApi.mockReturnValue(request.promise);
  const props = fixture();
  const view = await render(<ApiPicker {...props} />);
  await fireEvent.press(view.getByLabelText('使用这个设置'));
  await view.unmount();
  await act(async () => { request.reject(new Error('已离开会话')); });
  expect(props.onChanged).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
  expect(mockToast).not.toHaveBeenCalled();
});

test('an active failed switch leaves the selection intact and can be retried explicitly', async () => {
  const props = fixture();
  mockSetApi.mockRejectedValueOnce(new Error('电脑暂时离线')).mockResolvedValueOnce(agent);
  const view = await render(<ApiPicker {...props} />);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  await fireEvent.press(view.getByLabelText('使用这个设置'));
  expect(mockToast).toHaveBeenCalledWith('电脑暂时离线', 'alert');
  expect(props.onClose).not.toHaveBeenCalled();
  expect(view.getByRole('radio', { name: '备用' }).props.accessibilityState.checked).toBe(true);
  expect(view.getByLabelText('使用这个设置').props.accessibilityState.busy).toBe(false);
  await fireEvent.press(view.getByLabelText('使用这个设置'));
  expect(mockSetApi).toHaveBeenCalledTimes(2);
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

test('following the computer clears only the remote API override, not the session identity', async () => {
  mockSetApi.mockResolvedValue(agent);
  const view = await render(<ApiPicker {...fixture()} />);
  await fireEvent.press(view.getByRole('radio', { name: '跟随电脑' }));
  await fireEvent.press(view.getByLabelText('使用这个设置'));
  expect(mockSetApi).toHaveBeenCalledWith('pc-a', 'codex', '', '', 'codex:original');
});

test('inline Key list is content only: no new overlay, title or confirmation button', async () => {
  const view = await render(<InlineApiPicker {...fixture()} />);
  expect(view.getByTestId('remote-inline-api-picker')).toBeTruthy();
  expect(view.queryByTestId('api-picker-backdrop')).toBeNull();
  expect(view.queryByText('更换 API')).toBeNull();
  expect(view.queryByText('使用这个设置')).toBeNull();
  expect(view.queryByText('请先在电脑的 API 密钥库添加。')).toBeNull();
  expect(view.getByRole('radio', { name: '主力' }).props.accessibilityState.checked).toBe(true);
  expect(mockSetApi).not.toHaveBeenCalled();
});

test('horizontal shallow-arc swipes browse Key names without changing the actual API', async () => {
  const options = Array.from({ length: 8 }, (_, index) => ({ id: `opaque-${index}`, name: `API ${index}`, models: [] }));
  const view = await render(<InlineApiPicker {...fixture({ apis: options, agent: { ...agent, api: { ...agent.api, accountId: 'opaque-0' } } })} />);
  const strip = view.getByTestId('remote-api-key-strip');
  expect(strip.props.horizontal).toBe(true);
  const step = strip.props.snapToInterval;
  await fireEvent.scroll(strip, { nativeEvent: { contentOffset: { x: step * 5, y: 0 } } });
  expect(view.getAllByRole('radio')).toHaveLength(3);
  expect(view.getByRole('radio', { name: 'API 4' }).props.accessibilityState.checked).toBe(false);
  expect(mockSetApi).not.toHaveBeenCalled();
  await fireEvent.press(view.getByRole('radio', { name: 'API 4' }));
  expect(mockSetApi).toHaveBeenCalledWith('pc-a', 'codex', 'opaque-4', '', 'codex:original');
});

test('pressing the current inline Key is a no-op with no worker/API command or busy state', async () => {
  const busy = jest.fn();
  const props = fixture();
  const view = await render(<InlineApiPicker {...props} onBusyChange={busy} />);
  await fireEvent.press(view.getByRole('radio', { name: '主力' }));
  expect(mockSetApi).not.toHaveBeenCalled();
  expect(busy).not.toHaveBeenCalled();
  expect(view.queryByTestId('remote-api-switch-spinner')).toBeNull();
  await view.rerender(<InlineApiPicker {...props} agent={{ ...agent, api: { ...agent.api, source: 'computer' } }} onBusyChange={busy} />);
  await fireEvent.press(view.getByRole('radio', { name: '跟随电脑' }));
  expect(mockSetApi).not.toHaveBeenCalled();
});

test('inline named row immediately switches its opaque handle and shows the spinner only on that row', async () => {
  const request = deferred<AgentProfile>(); mockSetApi.mockReturnValue(request.promise);
  const props = fixture(), loading = jest.fn();
  const view = await render(<InlineApiPicker {...props} onLoadingChange={loading} />);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  expect(mockSetApi).toHaveBeenCalledTimes(1);
  expect(mockSetApi).toHaveBeenCalledWith('pc-a', 'codex', 'opaque-backup', '', 'codex:original');
  expect(view.getAllByTestId('remote-api-switch-spinner')).toHaveLength(1);
  expect(view.getByRole('radio', { name: '备用' }).props.accessibilityState.busy).toBe(true);
  expect(view.getAllByRole('radio').every((row) => row.props.accessibilityState.disabled)).toBe(true);
  expect(loading).toHaveBeenLastCalledWith(true, expect.any(String));
  await fireEvent.press(view.getByRole('radio', { name: '跟随电脑' }));
  expect(mockSetApi).toHaveBeenCalledTimes(1);
  await act(async () => { request.resolve(agent); });
  expect(props.onChanged).toHaveBeenCalledWith(agent);
  expect(props.onClose).not.toHaveBeenCalled();
  expect(view.getByTestId('remote-inline-api-picker')).toBeTruthy();
  expect(loading).toHaveBeenLastCalledWith(false, loading.mock.calls[0][1]);
});

test('inline collapse without a choice performs no API or model mutation', async () => {
  const props = fixture();
  const view = await render(<InlineApiPicker {...props} />);
  await view.rerender(<InlineApiPicker {...props} visible={false} />);
  expect(view.queryByTestId('remote-inline-api-picker')).toBeNull();
  expect(mockSetApi).not.toHaveBeenCalled();
  expect(props.onChanged).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
});

test('inline failed switches preserve actual API selection and allow an explicit retry', async () => {
  const props = fixture();
  mockSetApi.mockRejectedValueOnce(new Error('电脑暂时离线')).mockResolvedValueOnce(agent);
  const view = await render(<InlineApiPicker {...props} />);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  expect(mockToast).not.toHaveBeenCalled();
  expect(view.getByText('电脑暂时离线').props.accessibilityRole).toBe('alert');
  expect(view.getByRole('radio', { name: '主力' }).props.accessibilityState.checked).toBe(true);
  expect(view.getByRole('radio', { name: '备用' }).props.accessibilityState.disabled).toBe(false);
  expect(view.queryByTestId('remote-api-switch-spinner')).toBeNull();
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  expect(mockSetApi).toHaveBeenCalledTimes(2);
  expect(props.onClose).not.toHaveBeenCalled();
});

test('inline close/reopen cannot start a second switch and same-scope acknowledgement updates the catalog', async () => {
  const oldRequest = deferred<AgentProfile>(), newRequest = deferred<AgentProfile>();
  mockSetApi.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
  const props = fixture();
  const view = await render(<InlineApiPicker {...props} />);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  await view.rerender(<InlineApiPicker {...props} visible={false} />);
  await view.rerender(<InlineApiPicker {...props} />);
  await fireEvent.press(view.getByRole('radio', { name: '跟随电脑' }));
  expect(mockSetApi).toHaveBeenCalledTimes(1);
  expect(view.getByRole('radio', { name: '备用' }).props.accessibilityState.busy).toBe(true);
  await act(async () => { oldRequest.resolve(agent); });
  expect(props.onClose).not.toHaveBeenCalled();
  expect(props.onChanged).toHaveBeenCalledTimes(1);
  await fireEvent.press(view.getByRole('radio', { name: '跟随电脑' }));
  expect(mockSetApi).toHaveBeenCalledTimes(2);
  expect(view.getByRole('radio', { name: '跟随电脑' }).props.accessibilityState.busy).toBe(true);
  await act(async () => { newRequest.resolve(agent); });
  expect(props.onClose).not.toHaveBeenCalled();
  expect(props.onChanged).toHaveBeenCalledTimes(2);
});

test('inline scope changes and removed rows never authorize a stale selection', async () => {
  const request = deferred<AgentProfile>(); mockSetApi.mockReturnValue(request.promise);
  const props = fixture();
  const view = await render(<InlineApiPicker {...props} />);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  mockConnectionId = 'station-b';
  await view.rerender(<InlineApiPicker {...props} deviceId="pc-b" sessionKey="codex:other" apis={[apis[0]]} />);
  expect(view.queryByRole('radio', { name: '备用' })).toBeNull();
  expect(view.getByTestId('remote-api-switch-spinner')).toBeTruthy();
  await act(async () => { request.reject(new Error('旧电脑错误')); });
  expect(mockToast).not.toHaveBeenCalled();
  expect(props.onChanged).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
  expect(view.getByTestId('remote-inline-api-picker')).toBeTruthy();
});

test('inline API labels remain arbitrary names and ambiguous names are disambiguated without changing handles', async () => {
  mockSetApi.mockResolvedValue(agent);
  const names: RemoteApiOption[] = [
    { id: 'first', name: 'claude-opus-5-5', models: [] },
    { id: 'second', name: 'claude-opus-5-5', models: [] },
    { id: 'already-suffixed', name: 'claude-opus-5-5 · 2', models: [] },
    { id: 'empty', name: '   ', models: [] },
    { id: 'reserved', name: '跟随电脑', models: [] },
    { id: 'first', name: '重复 ID 不显示', models: [] },
  ];
  const view = await render(<InlineApiPicker {...fixture({ apis: names })} />);
  expect(Array.from({ length: 6 }, (_, index) => view.getByTestId(`remote-api-key-${index}`, { includeHiddenElements: true }).props.accessibilityLabel)).toEqual([
    '跟随电脑', 'claude-opus-5-5', 'claude-opus-5-5 · 3', 'claude-opus-5-5 · 2', '未命名 API', '跟随电脑 · 2',
  ]);
  const strip = view.getByTestId('remote-api-key-strip');
  await fireEvent.scroll(strip, { nativeEvent: { contentOffset: { x: strip.props.snapToInterval * 2, y: 0 } } });
  await fireEvent.press(view.getByRole('radio', { name: 'claude-opus-5-5 · 3' }));
  expect(mockSetApi).toHaveBeenCalledWith('pc-a', 'codex', 'second', '', 'codex:original');
});

test('inline computer-backed settings check follow-computer and blocked rows cannot mutate API', async () => {
  const props = fixture({ agent: { ...agent, api: { ...agent.api, source: 'computer' } }, blocked: '当前任务进行中' });
  const view = await render(<InlineApiPicker {...props} />);
  expect(view.getByRole('radio', { name: '跟随电脑' }).props.accessibilityState.checked).toBe(true);
  expect(view.getByText('当前任务进行中')).toBeTruthy();
  await fireEvent.press(view.getByTestId('remote-api-key-1'));
  expect(mockSetApi).not.toHaveBeenCalled();
});

test('StrictMode remount does not disable switching and the permanent Key arc remains available after a successful write', async () => {
  mockSetApi.mockResolvedValue(agent);
  const props = fixture();
  const view = await render(<React.StrictMode><InlineApiPicker {...props} /></React.StrictMode>);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  expect(mockSetApi).toHaveBeenCalledTimes(1);
  expect(props.onChanged).toHaveBeenCalledTimes(1);
  expect(props.onClose).not.toHaveBeenCalled();
  expect(view.getByTestId('remote-inline-api-picker')).toBeTruthy();
  await view.rerender(<React.StrictMode><InlineApiPicker {...props} apis={[...apis]} /></React.StrictMode>);
  expect(view.getByTestId('remote-inline-api-picker')).toBeTruthy();
  expect(mockSetApi).toHaveBeenCalledTimes(1);
  await fireEvent.press(view.getByRole('radio', { name: '跟随电脑' }));
  expect(mockSetApi).toHaveBeenCalledTimes(2);
});

test('changing the Key catalog during a write does not accept a receipt for a removed handle', async () => {
  const request = deferred<AgentProfile>(); mockSetApi.mockReturnValue(request.promise);
  const props = fixture();
  const view = await render(<InlineApiPicker {...props} />);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  await view.rerender(<InlineApiPicker {...props} apis={[apis[0]]} />);
  await act(async () => { request.resolve(agent); });
  expect(props.onChanged).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
  expect(mockToast).not.toHaveBeenCalled();
  expect(view.getByText('API 已移除，请重新选择')).toBeTruthy();
  expect(view.queryByTestId('remote-api-switch-spinner')).toBeNull();
  expect(view.getByTestId('remote-inline-api-picker')).toBeTruthy();
});

test('busy notifications survive scope changes and unmount, and settle only their own request ID', async () => {
  const oldRequest = deferred<AgentProfile>(), newRequest = deferred<AgentProfile>();
  mockSetApi.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
  const props = fixture(), busy = jest.fn();
  const view = await render(<InlineApiPicker {...props} onBusyChange={busy} />);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  const firstId = busy.mock.calls[0][1];
  expect(busy).toHaveBeenLastCalledWith(true, firstId);
  await view.rerender(<InlineApiPicker {...props} sessionKey="codex:other" onBusyChange={busy} />);
  expect(busy).toHaveBeenLastCalledWith(true, firstId);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  expect(mockSetApi).toHaveBeenCalledTimes(1);
  expect(busy).toHaveBeenCalledTimes(1);
  await act(async () => { oldRequest.resolve(agent); });
  expect(busy).toHaveBeenLastCalledWith(false, firstId);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  const secondId = busy.mock.calls.at(-1)?.[1];
  expect(secondId).not.toBe(firstId);
  expect(busy).toHaveBeenLastCalledWith(true, secondId);
  const notifications = busy.mock.calls.length;
  await view.unmount();
  expect(busy).toHaveBeenCalledTimes(notifications);
  await act(async () => { newRequest.resolve(agent); });
  expect(busy).toHaveBeenCalledTimes(notifications + 1);
  expect(busy).toHaveBeenLastCalledWith(false, secondId);
});

test.each(['resolved', 'rejected'] as const)('an immediately %s API request releases the outer model lock without a loading render or timer', async (outcome) => {
  if (outcome === 'resolved') mockSetApi.mockResolvedValue(agent);
  else mockSetApi.mockRejectedValue(new Error('即时失败'));
  const props = fixture(), busy = jest.fn();
  const view = await render(<InlineApiPicker {...props} onBusyChange={busy} />);
  busy.mockClear();
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  const signals = busy.mock.calls.map(([value]) => value);
  expect(signals[0]).toBe(true);
  expect(signals[signals.length - 1]).toBe(false);
  expect(signals.lastIndexOf(false)).toBeGreaterThan(signals.indexOf(true));
  expect(view.queryByTestId('remote-api-switch-spinner')).toBeNull();
  expect(view.getByRole('radio', { name: '备用' }).props.accessibilityState.disabled).toBe(false);
  expect(props.onClose).not.toHaveBeenCalled();
  expect(props.onChanged).toHaveBeenCalledTimes(outcome === 'resolved' ? 1 : 0);
});

test('a persistent parent request lock disables a freshly mounted arc and queued presses', async () => {
  const props = fixture(); const view = await render(<InlineApiPicker {...props} externalBusy />);
  expect(view.getAllByRole('radio').every(row => row.props.accessibilityState.disabled)).toBe(true);
  await fireEvent.press(view.getByRole('radio', { name: '备用' })); expect(mockSetApi).not.toHaveBeenCalled();
  await view.rerender(<InlineApiPicker {...props} externalBusy={false} />);
  const node = view.getByRole('radio', { name: '备用' });
  await view.rerender(<InlineApiPicker {...props} externalBusy />);
  await fireEvent.press(node); expect(mockSetApi).not.toHaveBeenCalled();
});

test.each([true, false])('unmounted success notifies its parent only while the owning conversation remains current (%s)', async isCurrent => {
  const request = deferred<AgentProfile>(); mockSetApi.mockReturnValue(request.promise);
  const props = fixture(), busy = jest.fn();
  const view = await render(<InlineApiPicker {...props} operationCurrent={() => isCurrent} onBusyChange={busy} />);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  const requestId = busy.mock.calls[0][1];
  await view.unmount(); expect(busy).toHaveBeenCalledTimes(1);
  await act(async () => request.resolve(agent));
  expect(props.onChanged).toHaveBeenCalledTimes(isCurrent ? 1 : 0);
  expect(props.onClose).not.toHaveBeenCalled(); expect(mockToast).not.toHaveBeenCalled();
  expect(busy).toHaveBeenLastCalledWith(false, requestId);
});

test('leaving and returning to the same scope does not inject the old receipt into a new generation', async () => {
  const request = deferred<AgentProfile>(); mockSetApi.mockReturnValue(request.promise);
  const props = fixture(); const view = await render(<InlineApiPicker {...props} operationCurrent={() => true} />);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  await view.rerender(<InlineApiPicker {...props} sessionKey="codex:other" operationCurrent={() => true} />);
  await view.rerender(<InlineApiPicker {...props} operationCurrent={() => true} />);
  await act(async () => request.resolve(agent));
  expect(props.onChanged).not.toHaveBeenCalled();
});
