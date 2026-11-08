import React from 'react';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { ApiChoiceMenu, ApiPicker, InlineApiPicker } from '../remote/ApiPicker';
import type { AgentProfile, RemoteApiOption } from '../remote/client';

const mockRowPress = new Map<string, () => void>();
jest.mock('react-native', () => {
  const React = require('react'); const native = jest.requireActual('react-native');
  return Object.create(Object.getPrototypeOf(native), { ...Object.getOwnPropertyDescriptors(native), Pressable: { configurable: true, enumerable: true, value: React.forwardRef((props: any, ref: any) => {
    if (props.accessibilityRole === 'radio' || props.accessibilityRole === 'button') mockRowPress.set(props.accessibilityLabel, props.onPress);
    return React.createElement(native.Pressable, { ...props, ref });
  }) } });
});

let mockConnectionId = 'station-a';
const mockSetApi = jest.fn();
const mockToast = jest.fn();
const mockApiTargets = jest.fn((): Array<{ id: string; hubUrl: string; deviceId: string; computerId: string; deviceName: string; pairedAt: number }> => []);
jest.mock('../remote/store', () => ({
  useRemote: () => ({ connectionId: mockConnectionId }),
  setAgentApi: (...args: unknown[]) => mockSetApi(...args),
  apiStationChoices: () => mockApiTargets(),
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
beforeEach(() => { jest.clearAllMocks(); mockRowPress.clear(); mockSetApi.mockReset(); mockApiTargets.mockReset().mockReturnValue([]); mockConnectionId = 'station-a'; });

test('unsupported official accounts stay disabled and offer an explicit same-computer station choice', async () => {
  const account: RemoteApiOption = { id: 'official', name: 'Fixture Account', models: [], sourceType: 'official_account',
    remoteEligibility: { supported: false, reason: 'unsupported', apiRemote: true, accountRemote: false } };
  mockApiTargets.mockReturnValue([{ id: 'supported-b', hubUrl: 'https://b.example/salcara-hub/v1', deviceId: 'pc-b', computerId: 'same', deviceName: 'Fixture', pairedAt: 1 }]);
  const props = fixture({ apis: [...apis, account] });
  mockSetApi.mockResolvedValue(agent);
  const view = await render(<ApiPicker {...props} />);
  expect(view.getByRole('radio', { name: 'Fixture Account' }).props.accessibilityState.disabled).toBe(true);
  expect(view.getByText('本站暂不支持账号远程')).toBeTruthy();
  await fireEvent.press(view.getByRole('radio', { name: 'Fixture Account' }));
  expect(mockSetApi).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('为 Fixture Account 选择支持的中转站'));
  await fireEvent.press(view.getByText('b.example'));
  expect(mockSetApi).toHaveBeenCalledWith('pc-a', 'codex', 'official', '', 'codex:original', 'supported-b');
});

test('opening, outside dismissal and choosing the current API never write', async () => {
  const props = fixture();
  const view = await render(<ApiPicker {...props} />);
  expect(view.getAllByRole('radio').map(row => row.props.accessibilityLabel)).toEqual(['默认 API', '主力', '备用']);
  expect(view.queryByText('使用这个设置')).toBeNull();
  expect(view.queryByText('gpt-fixture')).toBeNull();
  expect(view.queryByText('opaque-primary')).toBeNull();
  await fireEvent.press(view.getByTestId('agent-api-menu-backdrop'));
  expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(mockSetApi).not.toHaveBeenCalled();
  await view.rerender(<ApiPicker {...props} visible={false} />);
  await view.rerender(<ApiPicker {...props} />);
  await fireEvent.press(view.getByRole('radio', { name: '主力' }));
  expect(props.onClose).toHaveBeenCalledTimes(2);
  expect(mockSetApi).not.toHaveBeenCalled();
});

test('a long API menu stays bounded with a fixed default choice and selects every saved handle without search', async () => {
  const options = Array.from({ length: 24 }, (_, index) => ({ id: `saved-${index}`, name: `API ${index}`, models: [] }));
  const select = jest.fn(), close = jest.fn();
  const view = await render(<ApiChoiceMenu visible apis={options} current="saved-0" onSelect={select} onClose={close} />);
  type MenuNode = NonNullable<ReturnType<typeof view.toJSON>>;
  const descendants = (node: MenuNode): MenuNode[] => [node, ...node.children.flatMap(child => typeof child === 'string' ? [] : descendants(child))];
  const nodes = descendants(view.toJSON()!);
  expect(nodes.some(node => node.type.includes('TextInput'))).toBe(false);
  expect(view.getAllByRole('radio')).toHaveLength(options.length + 1);
  const menuStyle = StyleSheet.flatten(view.getByTestId('agent-api-menu').props.style);
  expect(menuStyle.maxHeight).toBeGreaterThan(0);
  expect(menuStyle.maxHeight).toBeLessThanOrEqual(320);
  const list = nodes.find(node => node.type.includes('ScrollView') && descendants(node).some(child => child.props.accessibilityLabel === 'API 0'));
  expect(list).toBeDefined();
  expect(list!.props.horizontal).not.toBe(true);
  expect(descendants(list!).some(node => node.props.accessibilityLabel === '默认 API')).toBe(false);
  expect(within(view.getByTestId('agent-api-menu-default')).getByRole('radio', { name: '默认 API' })).toBeTruthy();
  await fireEvent.press(view.getByRole('radio', { name: '默认 API' }));
  for (const option of options) await fireEvent.press(view.getByRole('radio', { name: option.name }));
  expect(select.mock.calls.map(([id]) => id)).toEqual(['', ...options.map(option => option.id)]);
  expect(close).not.toHaveBeenCalled();
});

test('a choice sends only its handle and closes after the receipt', async () => {
  const props = fixture();
  const updated = { ...agent, api: { ...agent.api, accountId: 'opaque-backup', name: '备用' } };
  mockSetApi.mockResolvedValue(updated);
  const view = await render(<ApiPicker {...props} />);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  expect(mockSetApi).toHaveBeenCalledTimes(1);
  expect(mockSetApi).toHaveBeenCalledWith('pc-a', 'codex', 'opaque-backup', '', 'codex:original');
  expect(props.onChanged).toHaveBeenCalledWith(updated, 'opaque-backup');
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

test('duplicate presses and dismissal cannot mutate an in-flight choice', async () => {
  const request = deferred<AgentProfile>(); mockSetApi.mockReturnValue(request.promise);
  const props = fixture(); const busy = jest.fn();
  const view = await render(<ApiPicker {...props} onBusyChange={busy} />);
  const press = mockRowPress.get('备用')!;
  await act(async () => { press(); press(); });
  await fireEvent.press(view.getByRole('radio', { name: '默认 API' }));
  await fireEvent.press(view.getByTestId('agent-api-menu-backdrop'));
  expect(props.onClose).not.toHaveBeenCalled();
  expect(mockSetApi).toHaveBeenCalledTimes(1);
  expect(view.getByRole('radio', { name: '主力' }).props.accessibilityState.checked).toBe(true);
  expect(view.getByRole('radio', { name: '备用' }).props.accessibilityState.busy).toBe(true);
  await act(async () => request.resolve(agent));
  expect(busy.mock.calls.map(call => call[0])).toEqual([true, false]);
  expect(busy.mock.calls[0][1]).toBe(busy.mock.calls[1][1]);
});

test.each(['removed', 'blocked', 'unsupported', 'pending', 'device', 'closed'] as const)('queued selection rechecks %s before dispatch', async condition => {
  const props = fixture(); const view = await render(<ApiPicker {...props} />);
  const press = mockRowPress.get('备用')!;
  const next = condition === 'removed' ? { apis: [apis[0]] }
    : condition === 'blocked' ? { blocked: '当前任务进行中' }
    : condition === 'unsupported' ? { apis: [apis[0], { ...apis[1], sourceType: 'official_account' as const }] }
    : condition === 'pending' ? { agent: { ...agent, api: { ...agent.api, pending: true } } }
    : condition === 'device' ? { deviceId: 'pc-b' } : { visible: false };
  await view.rerender(<ApiPicker {...props} {...next} />);
  await act(async () => press());
  expect(mockSetApi).not.toHaveBeenCalled();
});

test.each(['connection', 'device', 'session', 'agent'] as const)('late %s receipts cannot change the new selection scope', async condition => {
  const request = deferred<AgentProfile>(); mockSetApi.mockReturnValue(request.promise);
  const props = fixture(); const view = await render(<ApiPicker {...props} />);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  if (condition === 'connection') mockConnectionId = 'station-b';
  const next = condition === 'device' ? { deviceId: 'pc-b' }
    : condition === 'session' ? { sessionKey: 'codex:new' }
    : condition === 'agent' ? { agent: { ...agent, id: 'claude' } } : {};
  await view.rerender(<ApiPicker {...props} {...next} />);
  await act(async () => request.resolve(agent));
  expect(props.onChanged).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
});

test('external hide and reopen keeps the pending write locked until its receipt', async () => {
  const request = deferred<AgentProfile>(); mockSetApi.mockReturnValue(request.promise);
  const props = fixture(); const view = await render(<ApiPicker {...props} />);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  await view.rerender(<ApiPicker {...props} visible={false} />);
  await view.rerender(<ApiPicker {...props} />);
  await fireEvent.press(view.getByRole('radio', { name: '默认 API' }));
  expect(mockSetApi).toHaveBeenCalledTimes(1);
  await act(async () => request.resolve(agent));
  expect(props.onChanged).toHaveBeenCalledTimes(1);
  expect(props.onClose).not.toHaveBeenCalled();
});

test('a failed popup switch reports its target safely and closes without changing the actual selection', async () => {
  mockSetApi.mockRejectedValueOnce(new Error('private.example sk-secret'));
  const onFailed = jest.fn(), close = jest.fn(), props = fixture({ onFailed, onClose: close });
  const view = await render(<ApiPicker {...props} />);
  expect(view.getByRole('radio', { name: '主力' }).props.accessibilityState.checked).toBe(true);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  expect(onFailed).toHaveBeenCalledTimes(1);
  expect(onFailed).toHaveBeenCalledWith('opaque-backup');
  expect(props.onChanged).not.toHaveBeenCalled();
  expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(onFailed.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]);
  expect(mockToast).toHaveBeenCalledWith('暂未确认切换结果，请稍后重新选择', 'alert');
  expect(JSON.stringify(mockToast.mock.calls)).not.toMatch(/private\.example|sk-secret/);
  expect(view.queryByText(/private\.example|sk-secret/)).toBeNull();
  expect(view.queryByTestId('agent-api-menu')).toBeNull();
  expect(mockSetApi).toHaveBeenCalledTimes(1);
});

test('a closed failure exposes no recovery buttons and retained choices cannot replay the write', async () => {
  const props = fixture();
  const view = await render(<ApiPicker {...props} />);
  expect(view.queryByRole('button', { name: '核对 API 状态' })).toBeNull();
  expect(view.queryByRole('button', { name: '重试切换 API' })).toBeNull();
  const backup = mockRowPress.get('备用')!, follow = mockRowPress.get('默认 API')!;
  mockSetApi.mockRejectedValueOnce(new Error('connection lost'));
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  await view.rerender(<ApiPicker {...props} />);
  await act(async () => { backup(); backup(); follow(); });
  expect(view.queryByTestId('agent-api-menu')).toBeNull();
  expect(view.queryByRole('button', { name: '核对 API 状态' })).toBeNull();
  expect(view.queryByRole('button', { name: '重试切换 API' })).toBeNull();
  expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(mockSetApi).toHaveBeenCalledTimes(1);
});

test('retry requires reopening and a fresh choice while duplicate or retained choices remain inert', async () => {
  const request = deferred<AgentProfile>();
  mockSetApi.mockRejectedValueOnce(new Error('timeout')).mockReturnValueOnce(request.promise);
  const props = fixture(), view = await render(<ApiPicker {...props} />);
  const oldChoice = mockRowPress.get('备用')!;
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  await view.rerender(<ApiPicker {...props} visible={false} />);
  await view.rerender(<ApiPicker {...props} />);
  expect(view.getByRole('radio', { name: '主力' }).props.accessibilityState.checked).toBe(true);
  expect(view.queryByRole('alert')).toBeNull();
  expect(view.queryByRole('button', { name: '重试切换 API' })).toBeNull();
  expect(mockSetApi).toHaveBeenCalledTimes(1);
  await act(async () => oldChoice());
  expect(mockSetApi).toHaveBeenCalledTimes(1);
  const freshChoice = mockRowPress.get('备用')!;
  await act(async () => { freshChoice(); freshChoice(); });
  expect(mockSetApi).toHaveBeenCalledTimes(2);
  expect(mockSetApi).toHaveBeenLastCalledWith('pc-a', 'codex', 'opaque-backup', '', 'codex:original');
  expect(view.getByRole('radio', { name: '备用' }).props.accessibilityState.busy).toBe(true);
  await act(async () => request.resolve(agent));
  await act(async () => { oldChoice(); freshChoice(); });
  expect(mockSetApi).toHaveBeenCalledTimes(2);
  expect(props.onClose).toHaveBeenCalledTimes(2);
});

test('a failed station switch returns to API choices and requires selecting the station again', async () => {
  const account: RemoteApiOption = { id: 'official', name: '官方账号', models: [], sourceType: 'official_account',
    remoteEligibility: { supported: false, reason: 'unsupported', apiRemote: true, accountRemote: false } };
  mockApiTargets.mockReturnValue([{ id: 'supported-b', hubUrl: 'https://b.example/salcara-hub/v1', deviceId: 'pc-b', computerId: 'same', deviceName: 'Fixture', pairedAt: 1 }]);
  mockSetApi.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(agent);
  const props = fixture({ apis: [...apis, account] }), view = await render(<ApiPicker {...props} />);
  await fireEvent.press(view.getByLabelText('为 官方账号 选择支持的中转站'));
  const oldStation = mockRowPress.get('b.example')!;
  await fireEvent.press(view.getByText('b.example'));
  expect(mockSetApi).toHaveBeenLastCalledWith('pc-a', 'codex', 'official', '', 'codex:original', 'supported-b');
  expect(props.onClose).toHaveBeenCalledTimes(1);
  await view.rerender(<ApiPicker {...props} visible={false} />);
  mockApiTargets.mockReturnValue([{ id: 'supported-c', hubUrl: 'https://c.example/salcara-hub/v1', deviceId: 'pc-c', computerId: 'same', deviceName: 'Fixture', pairedAt: 1 }]);
  await view.rerender(<ApiPicker {...props} />);
  expect(view.getByRole('radio', { name: '官方账号' }).props.accessibilityState.disabled).toBe(true);
  expect(view.queryByText('b.example')).toBeNull();
  expect(view.queryByText('c.example')).toBeNull();
  await act(async () => oldStation());
  expect(mockSetApi).toHaveBeenCalledTimes(1);
  await fireEvent.press(view.getByLabelText('为 官方账号 选择支持的中转站'));
  await fireEvent.press(view.getByText('c.example'));
  expect(mockSetApi).toHaveBeenCalledTimes(2);
  expect(mockSetApi).toHaveBeenLastCalledWith('pc-a', 'codex', 'official', '', 'codex:original', 'supported-c');
});

test('reopening after failure can choose a different target instead of replaying the failed API', async () => {
  const props = fixture();
  mockSetApi.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(agent);
  const view = await render(<ApiPicker {...props} />);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  await view.rerender(<ApiPicker {...props} visible={false} />);
  await view.rerender(<ApiPicker {...props} />);
  await fireEvent.press(view.getByRole('radio', { name: '默认 API' }));
  expect(mockSetApi).toHaveBeenCalledTimes(2);
  expect(mockSetApi).toHaveBeenLastCalledWith('pc-a', 'codex', '', '', 'codex:original');
  expect(props.onChanged).toHaveBeenCalledWith(agent, '');
});

test('reopening for another device does not revive a choice captured before the failed request', async () => {
  const props = fixture();
  mockSetApi.mockRejectedValueOnce(new Error('timeout'));
  const view = await render(<ApiPicker {...props} />);
  const oldChoice = mockRowPress.get('备用')!;
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  await view.rerender(<ApiPicker {...props} visible={false} />);
  await view.rerender(<ApiPicker {...props} deviceId="another-computer" />);
  await act(async () => oldChoice());
  expect(mockSetApi).toHaveBeenCalledTimes(1);
  expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(props.onChanged).not.toHaveBeenCalled();
});

test('following the computer clears only the override and preserves the conversation', async () => {
  mockSetApi.mockResolvedValue(agent);
  const view = await render(<ApiPicker {...fixture()} />);
  await fireEvent.press(view.getByRole('radio', { name: '默认 API' }));
  expect(mockSetApi).toHaveBeenCalledWith('pc-a', 'codex', '', '', 'codex:original');
});

test('an unmounted picker ignores late failure and never emits a raw diagnostic', async () => {
  const request = deferred<AgentProfile>(); mockSetApi.mockReturnValue(request.promise);
  const props = fixture(); const view = await render(<ApiPicker {...props} />);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  await view.unmount();
  await act(async () => request.reject(new Error('private sk-secret')));
  expect(props.onChanged).not.toHaveBeenCalled(); expect(props.onClose).not.toHaveBeenCalled();
  expect(mockToast).not.toHaveBeenCalled();
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

test('horizontal tabs browse Key names without changing the actual API', async () => {
  const options = Array.from({ length: 8 }, (_, index) => ({ id: `opaque-${index}`, name: `API ${index}`, models: [] }));
  const view = await render(<InlineApiPicker {...fixture({ apis: options, agent: { ...agent, api: { ...agent.api, accountId: 'opaque-0' } } })} />);
  const strip = view.getByTestId('remote-api-key-strip');
  expect(strip.props.horizontal).toBe(true);
  const step = strip.props.snapToInterval;
  await fireEvent.scroll(strip, { nativeEvent: { contentOffset: { x: step * 5, y: 0 } } });
  expect(view.getAllByRole('radio')).toHaveLength(9);
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
  await fireEvent.press(view.getByRole('radio', { name: '主力' }));
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
  await fireEvent.press(view.getByRole('radio', { name: '默认 API' }));
  expect(mockSetApi).toHaveBeenCalledTimes(1);
  await act(async () => { request.resolve(agent); });
  expect(props.onChanged).toHaveBeenCalledWith(agent, 'opaque-backup');
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
  expect(view.getByText('电脑已断开连接，请连接后重试').props.accessibilityRole).toBe('alert');
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
  await fireEvent.press(view.getByRole('radio', { name: '默认 API' }));
  expect(mockSetApi).toHaveBeenCalledTimes(1);
  expect(view.getByRole('radio', { name: '备用' }).props.accessibilityState.busy).toBe(true);
  await act(async () => { oldRequest.resolve(agent); });
  expect(props.onClose).not.toHaveBeenCalled();
  expect(props.onChanged).toHaveBeenCalledTimes(1);
  await fireEvent.press(view.getByRole('radio', { name: '默认 API' }));
  expect(mockSetApi).toHaveBeenCalledTimes(2);
  expect(view.getByRole('radio', { name: '默认 API' }).props.accessibilityState.busy).toBe(true);
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
    { id: 'reserved', name: '默认 API', models: [] },
    { id: 'first', name: '重复 ID 不显示', models: [] },
  ];
  const view = await render(<InlineApiPicker {...fixture({ apis: names })} />);
  expect(Array.from({ length: 6 }, (_, index) => view.getByTestId(`remote-api-key-${index}`, { includeHiddenElements: true }).props.accessibilityLabel)).toEqual([
    '默认 API', 'claude-opus-5-5', 'claude-opus-5-5 · 3', 'claude-opus-5-5 · 2', '未命名 API', '默认 API · 2',
  ]);
  const strip = view.getByTestId('remote-api-key-strip');
  await fireEvent.scroll(strip, { nativeEvent: { contentOffset: { x: strip.props.snapToInterval * 2, y: 0 } } });
  await fireEvent.press(view.getByRole('radio', { name: 'claude-opus-5-5 · 3' }));
  expect(mockSetApi).toHaveBeenCalledWith('pc-a', 'codex', 'second', '', 'codex:original');
});

test('inline computer-backed settings use the actual default API name and blocked rows cannot mutate API', async () => {
  const props = fixture({ agent: { ...agent, api: { ...agent.api, source: 'computer' } }, blocked: '当前任务进行中' });
  const view = await render(<InlineApiPicker {...props} />);
  expect(view.getByRole('radio', { name: '主力' }).props.accessibilityState.checked).toBe(true);
  expect(view.getByText('当前任务进行中')).toBeTruthy();
  await fireEvent.press(view.getByTestId('remote-api-key-1'));
  expect(mockSetApi).not.toHaveBeenCalled();
});

test('StrictMode remount does not disable switching and the API tabs remains available after a successful write', async () => {
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
  await fireEvent.press(view.getByRole('radio', { name: '默认 API' }));
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

test('a persistent parent request lock disables a freshly mounted tabs and queued presses', async () => {
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
