import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { DirectComputerManagement, type DirectComputerManagementProps } from '../remote/DirectComputerManagement';
import { apiCreationConfirmed, buildComputerApiCommand, parseManagementStatus, type ComputerManagementCommand } from '../remote/direct-computer-management';

jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID() }));
jest.mock('react-native/Libraries/Components/Pressable/Pressable', () => ({ __esModule: true, default: (props: any) => require('react').createElement(require('react-native').View, { accessible: true, ...props }, props.children) }));
jest.mock('../remote/ProgrammingUi', () => {
  const React = require('react'), { View, Text, TextInput, Pressable } = require('react-native');
  return {
    ProgrammingSheet: ({ visible, title, children, onClose }: any) => visible ? React.createElement(View, null,
      React.createElement(Text, null, title), React.createElement(Pressable, { accessibilityRole: 'button', accessibilityLabel: '关闭', onPress: onClose }, React.createElement(Text, null, '关闭')), children) : null,
    ProgrammingCard: ({ children }: any) => React.createElement(View, null, children),
    ProgrammingPanel: ({ visible, title, children, footer }: any) => visible ? React.createElement(View, null, React.createElement(Text, null, title), children, footer) : null,
    ProgrammingSection: ({ title }: any) => React.createElement(Text, null, title),
    ProgrammingField: ({ label, ...props }: any) => React.createElement(TextInput, { ...props, accessibilityLabel: label }),
  };
});
const tool = { id: 'codex', name: 'Codex CLI', role: '运行 Codex 任务', installed: false, installable: true };
const snapshot = (extra: Record<string, unknown> = {}) => ({ supported: true, items: [tool], job: null, discoveryPending: false, busy: false, ...extra });
const pending = <T,>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const command = jest.fn(), changed = jest.fn(), closed = jest.fn();
const props = (extra: Partial<DirectComputerManagementProps> = {}): DirectComputerManagementProps => ({ visible: true, online: true, scope: 'pair-a:pc-a:g1', command, onChanged: changed, onClose: closed, ...extra });
const writes = () => command.mock.calls.filter(([payload]) => payload.type !== 'computer.management.status');
const pressHandler = (view: Awaited<ReturnType<typeof render>>, label: string) => view.getByRole('button', { name: label }).props.onPress;
async function opened(extra: Partial<DirectComputerManagementProps> = {}) {
  const view = await render(<DirectComputerManagement {...props(extra)} />);
  if (extra.online !== false && extra.visible !== false) await waitFor(() => expect(view.getByRole('button', { name: '添加 API' })).not.toBeDisabled());
  return view;
}
async function fill(view: Awaited<ReturnType<typeof render>>) {
  await fireEvent.press(view.getByRole('button', { name: '添加 API' }));
  await fireEvent.changeText(view.getByLabelText('API 名称'), '测试 API');
  await fireEvent.changeText(view.getByLabelText('API 地址'), 'https://provider.example/v1');
  await fireEvent.changeText(view.getByLabelText('API Key'), 'synthetic-secret-123');
}
beforeEach(() => { jest.clearAllMocks(); command.mockReset().mockImplementation(async (payload: ComputerManagementCommand) => payload.type === 'computer.management.status' ? snapshot() : { ok: true, accountId: 'api_0011223344556677', name: '测试 API' }); });

test('opening or cancelling an install never mutates the computer', async () => {
  const view = await opened();
  await fireEvent.press(view.getByRole('button', { name: '安装 Codex CLI' }));
  expect(view.getByText(/将运行官方安装程序/)).toBeTruthy();
  const staleConfirm = pressHandler(view, '确认安装');
  await fireEvent.press(view.getByRole('button', { name: '取消安装' }));
  // The callback from a dismissed confirmation must not remain executable.
  await act(async () => staleConfirm());
  expect(writes()).toHaveLength(0); await view.unmount();
});

test('saving clears the key immediately, serializes duplicate clicks, and clears the request after completion', async () => {
  const deferred = pending<unknown>(); let sent: any;
  command.mockImplementation((payload: ComputerManagementCommand) => {
    if (payload.type === 'computer.management.status') return Promise.resolve(snapshot());
    sent = payload; return deferred.promise;
  });
  const view = await opened(); await fill(view);
  const submit = pressHandler(view, '保存到电脑');
  await act(async () => { submit(); submit(); });
  expect(writes()).toHaveLength(1); expect(sent).toMatchObject({ type: 'computer.api.create', controlSurface: 'cli', key: 'synthetic-secret-123' });
  expect(sent.requestId).toMatch(/^[a-f0-9-]{36}$/); expect(view.getByLabelText('API Key').props.value).toBe('');
  await act(async () => deferred.resolve({ ok: true, accountId: 'api_0011223344556677', name: '测试 API' }));
  expect(sent.key).toBe(''); expect(changed).toHaveBeenCalledTimes(1); expect(view.getByText(/API 已保存到电脑/)).toBeTruthy(); await view.unmount();
});

test('an uncertain API result shows no reflected secret and never retries the write', async () => {
  command.mockImplementation(async payload => { if (payload.type === 'computer.management.status') return snapshot(); throw new Error('synthetic-secret-123 echoed by server'); });
  const view = await opened(); await fill(view); await fireEvent.press(view.getByRole('button', { name: '保存到电脑' }));
  expect(view.getByText(/保存结果未确认/)).toBeTruthy(); expect(JSON.stringify(view.toJSON())).not.toContain('synthetic-secret-123');
  expect(view.getByRole('button', { name: '保存到电脑' })).toBeDisabled();
  await fireEvent.press(view.getByRole('button', { name: '刷新电脑配置' }));
  expect(writes()).toHaveLength(1);
  await fireEvent.press(view.getByRole('button', { name: '返回 API 列表核对' })); expect(closed).toHaveBeenCalledTimes(1); await view.unmount();
});

test.each([{ online: false }, { scope: 'pair-b:pc-b:g2' }, { visible: false }])('identity/lifecycle change clears draft and ignores the old response: %j', async changedProps => {
  const deferred = pending<unknown>();
  command.mockImplementation(payload => payload.type === 'computer.management.status' ? Promise.resolve(snapshot()) : deferred.promise);
  const view = await opened(); await fill(view); await fireEvent.press(view.getByRole('button', { name: '保存到电脑' }));
  await view.rerender(<DirectComputerManagement {...props(changedProps)} />);
  await act(async () => deferred.resolve({ ok: true, accountId: 'api_0011223344556677', name: '测试 API' }));
  expect(changed).not.toHaveBeenCalled(); expect(JSON.stringify(view.toJSON())).not.toContain('synthetic-secret-123');
  expect(view.queryByText(/API 已保存到电脑/)).toBeNull(); await view.unmount();
});

test('draft secret is cleared on disconnect before a request exists', async () => {
  const view = await opened(); await fill(view);
  await view.rerender(<DirectComputerManagement {...props({ online: false })} />);
  await view.rerender(<DirectComputerManagement {...props()} />);
  await waitFor(() => expect(view.getByRole('button', { name: '添加 API' })).not.toBeDisabled());
  await fireEvent.press(view.getByRole('button', { name: '添加 API' }));
  expect(view.getByLabelText('API Key').props.value).toBe(''); expect(writes()).toHaveLength(0); await view.unmount();
});

test('installer uses an explicit confirmation and one stable request ID', async () => {
  const deferred = pending<unknown>();
  command.mockImplementation(payload => payload.type === 'computer.management.status' ? Promise.resolve(snapshot()) : deferred.promise);
  const view = await opened(); await fireEvent.press(view.getByRole('button', { name: '安装 Codex CLI' }));
  const confirm = pressHandler(view, '确认安装');
  await act(async () => { confirm(); confirm(); });
  expect(writes()).toHaveLength(1); expect(writes()[0][0]).toMatchObject({ type: 'computer.agent.install', controlSurface: 'cli', confirmed: true, tool: 'codex', requestId: expect.any(String) });
  await act(async () => deferred.resolve({ ok: true, job: { id: 'job-123', tool: 'codex', state: 'done' } }));
  expect(view.getByText('未检测到')).toBeTruthy(); expect(view.getByText(/安装程序已结束，等待检测/)).toBeTruthy(); await view.unmount();
});

test('another installer blocks installation without revealing its job', async () => {
  command.mockResolvedValue(snapshot({ busy: true })); const view = await opened();
  expect(view.getByRole('button', { name: '安装 Codex CLI' })).toBeDisabled();
  expect(view.getByText('电脑正在安装其他工具，请等待完成。')).toBeTruthy(); await view.unmount();
});

test('an uncertain installation stays blocked until a successful status check', async () => {
  command.mockImplementation(async payload => { if (payload.type === 'computer.management.status') return snapshot(); throw new Error('private installer output'); });
  const view = await opened(); await fireEvent.press(view.getByRole('button', { name: '安装 Codex CLI' }));
  await fireEvent.press(view.getByRole('button', { name: '确认安装' }));
  expect(view.getByRole('button', { name: '安装 Codex CLI' })).toBeDisabled();
  expect(JSON.stringify(view.toJSON())).not.toContain('private installer output');
  await fireEvent.press(view.getByRole('button', { name: '刷新电脑配置' }));
  expect(view.getByRole('button', { name: '安装 Codex CLI' })).not.toBeDisabled(); expect(writes()).toHaveLength(1); await view.unmount();
});

test('polls a running installation only while this sheet is visible and connected', async () => {
  jest.useFakeTimers(); command.mockResolvedValue(snapshot({ busy: true, job: { id: 'job-123', tool: 'codex', state: 'running' } }));
  const view = await opened(); const before = command.mock.calls.length;
  await act(async () => { jest.advanceTimersByTime(2500); }); expect(command.mock.calls.length).toBe(before + 1);
  await view.rerender(<DirectComputerManagement {...props({ visible: false })} />);
  await act(async () => { jest.advanceTimersByTime(10000); }); expect(command.mock.calls.length).toBe(before + 1);
  await view.unmount(); jest.useRealTimers();
});

test('parsers discard installer logs/errors and validation never echoes a secret', () => {
  expect(parseManagementStatus(snapshot({ job: { id: 'job-123', tool: 'codex', state: 'failed', error: 'secret', log: 'secret' } }))?.job).toEqual({ id: 'job-123', tool: 'codex', state: 'failed' });
  expect(parseManagementStatus(snapshot({ items: [tool, tool] }))).toBeUndefined();
  expect(() => buildComputerApiCommand({ name: 'API', baseUrl: 'https://example.com', key: 'bad\nsecret', wire: 'auto', authMode: 'bearer', models: '' }, '01234567-0123-4123-8123-0123456789ab')).toThrow('请填写有效的 API Key');
  expect(() => buildComputerApiCommand({ name: 'API', baseUrl: 'https://user:secret@example.com', key: 'secret', wire: 'auto', authMode: 'bearer', models: '' }, '01234567-0123-4123-8123-0123456789ab')).toThrow('API 地址格式无效');
  expect(apiCreationConfirmed({ ok: true, accountId: 'api_00112233', name: '😀'.repeat(80) })).toBe(true);
  expect(() => buildComputerApiCommand({ name: 'API', baseUrl: 'https://example.com', key: 'secret', wire: 'auto', authMode: 'bearer', models: Array.from({ length: 101 }, (_, i) => `model-${i}`).join('\n') }, '01234567-0123-4123-8123-0123456789ab')).toThrow('模型目录最多 100 项');
});
