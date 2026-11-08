import React from 'react';
import { AppState, Share, type AppStateStatus } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { RemoteConnectionDiagnostics } from '../remote/RemoteConnectionDiagnostics';
import { diagnosticSummary, type ConnectionDiagnosticResult } from '../remote/connection-diagnostics';
import type { RemoteState } from '../remote/store';

const mockDiagnose = jest.fn(), mockCopy = jest.fn(), mockToast = jest.fn();
let mockScope = 'one';
jest.mock('../remote/store', () => ({ diagnoseRemoteConnection: (...args: unknown[]) => mockDiagnose(...args), remoteDeliveryScope: () => mockScope }));
jest.mock('expo-clipboard', () => ({ setStringAsync: (...args: unknown[]) => mockCopy(...args) }));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'fixture-nonce-12345678' }));
jest.mock('../components/ui', () => ({ showToast: (...args: unknown[]) => mockToast(...args) }));
jest.mock('../remote/ProgrammingUi', () => {
  const React = require('react'), { View, Pressable, Text } = require('react-native');
  return {
    ProgrammingCard: ({ children }: any) => <View>{children}</View>,
    ProgrammingSheet: ({ visible, children, onClose, subtitle }: any) => visible ? <View><Text>{subtitle}</Text><Pressable accessibilityLabel="关闭" onPress={onClose} />{children}</View> : null,
    ProgrammingAction: ({ label, onPress, disabled, loading }: any) => <Pressable accessibilityLabel={label} accessibilityState={{ disabled: disabled || loading }} disabled={disabled || loading} onPress={onPress}><Text>{label}</Text></Pressable>,
  };
});
const remote = { phase: 'ready', connection: 'open', connectionId: 'paired', selectedHubUrl: 'https://private.example', connections: [] } as unknown as RemoteState;
const device = { deviceId: 'private-pc', name: '电脑', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 };
const result: ConnectionDiagnosticResult = { checkedAt: 123456, hub: { status: 'ok', ms: 23, detail: '手机往返' }, computer: { status: 'ok', ms: 45, detail: '电脑往返' }, roundTrip: { status: 'ok', ms: 78, detail: '完整往返' } };
beforeEach(() => { jest.useFakeTimers(); jest.clearAllMocks(); mockScope = 'one'; mockDiagnose.mockResolvedValue(result); mockCopy.mockResolvedValue(undefined); });
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test('opening does not probe; manual refresh is single-flight/cooldown; export and clipboard receive only the allowlisted summary', async () => {
  const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
  const view = await render(<RemoteConnectionDiagnostics visible remote={remote} device={device} onClose={() => {}} />);
  expect(mockDiagnose).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('检测当前连接'));
  expect(mockDiagnose).toHaveBeenCalledTimes(1); expect(view.getByText('78 ms')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('稍后重新检测')); expect(mockDiagnose).toHaveBeenCalledTimes(1);
  await fireEvent.press(view.getByLabelText('复制摘要')); expect(mockCopy).toHaveBeenCalledWith(diagnosticSummary(result));
  await fireEvent.press(view.getByLabelText('导出摘要')); expect(share).toHaveBeenCalledWith({ title: 'Salcara 连接诊断', message: diagnosticSummary(result) });
  await act(async () => { await jest.advanceTimersByTimeAsync(5000); });
  await fireEvent.press(view.getByLabelText('检测当前连接')); expect(mockDiagnose).toHaveBeenCalledTimes(2);
});

test.each(['hide', 'reopen', 'device', 'station', 'credential', 'background', 'unmount'] as const)('late result is discarded and request aborted after %s', async change => {
  let finish!: (value: ConnectionDiagnosticResult) => void;
  mockDiagnose.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  let background!: (state: AppStateStatus) => void;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_name, callback) => { background = callback; return { remove: jest.fn() }; });
  const props = { visible: true, remote, device, onClose: jest.fn() };
  const view = await render(<RemoteConnectionDiagnostics {...props} />);
  await fireEvent.press(view.getByLabelText('检测当前连接'));
  const signal = mockDiagnose.mock.calls[0][1] as AbortSignal;
  if (change === 'hide' || change === 'reopen') { await view.rerender(<RemoteConnectionDiagnostics {...props} visible={false} />); if (change === 'reopen') await view.rerender(<RemoteConnectionDiagnostics {...props} />); }
  else if (change === 'device') await view.rerender(<RemoteConnectionDiagnostics {...props} device={{ ...device, deviceId: 'other' }} />);
  else if (change === 'station') await view.rerender(<RemoteConnectionDiagnostics {...props} remote={{ ...remote, selectedHubUrl: 'https://other.example' }} />);
  else if (change === 'credential') { mockScope = 'two'; await view.rerender(<RemoteConnectionDiagnostics {...props} />); }
  else if (change === 'background') await act(async () => { background('background'); });
  else await view.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => { finish(result); });
  if (change !== 'unmount') expect(view.queryByText('78 ms')).toBeNull();
});

test('a selected Bot binding owns the name, status and diagnostic target even while the previous computer prop lingers', async () => {
  const profile = { id: 'bot-b', hubUrl: 'https://private.example', deviceId: 'pc-b', deviceName: '电脑 B', alias: '工作电脑', botGroupId: 'group-b', pairedAt: 1 };
  const selected = { ...remote, connectionId: profile.id, connections: [profile], devices: [] };
  const view = await render(<RemoteConnectionDiagnostics visible remote={selected} device={device} onClose={() => {}} />);
  expect(view.getByText('工作电脑 · Bot')).toBeTruthy();expect(view.getByText('电脑离线')).toBeTruthy();
  expect(view.getByText('手机 ↔ Bot')).toBeTruthy();expect(view.getByText('Bot ↔ 电脑')).toBeTruthy();
  expect(view.queryByText('手机 ↔ 中转站')).toBeNull();expect(mockDiagnose).not.toHaveBeenCalled();
  await view.rerender(<RemoteConnectionDiagnostics visible remote={selected} device={{ ...device, deviceId: profile.deviceId, name: '旧站点的电脑' }} onClose={() => {}} />);
  expect(view.getByText('电脑离线')).toBeTruthy();expect(view.queryByText('已连接')).toBeNull();
  await fireEvent.press(view.getByLabelText('检测当前连接'));
  expect(mockDiagnose).toHaveBeenCalledWith('pc-b', expect.any(AbortSignal));
});

test('changing the selected connection retires the previous diagnosis even if its device prop has not caught up', async () => {
  let finish!: (value: ConnectionDiagnosticResult) => void;
  mockDiagnose.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const relay = { id: 'relay-a', hubUrl: remote.selectedHubUrl!, deviceId: device.deviceId, deviceName: '电脑 A', pairedAt: 1 };
  const bot = { ...relay, id: 'bot-b', deviceId: 'pc-b', deviceName: '电脑 B', botGroupId: 'group-b' };
  const props = { visible: true, remote: { ...remote, connectionId: relay.id, connections: [relay, bot] }, device, onClose: jest.fn() };
  const view = await render(<RemoteConnectionDiagnostics {...props} />);
  await fireEvent.press(view.getByLabelText('检测当前连接'));
  const signal = mockDiagnose.mock.calls[0][1] as AbortSignal;
  await view.rerender(<RemoteConnectionDiagnostics {...props} remote={{ ...props.remote, connectionId: bot.id }} />);
  expect(signal.aborted).toBe(true);expect(view.getByText('电脑 B · Bot')).toBeTruthy();
  await act(async () => { finish(result); });expect(view.queryByText('78 ms')).toBeNull();
  await fireEvent.press(view.getByLabelText('检测当前连接'));
  expect(mockDiagnose).toHaveBeenLastCalledWith('pc-b', expect.any(AbortSignal));
});
