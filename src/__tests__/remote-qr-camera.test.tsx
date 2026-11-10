import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { QrPairing } from '../remote/RemoteScreen';
import type { RemoteState } from '../remote/store';

const mockQr = { type: 'salcara-remote-pair', version: 1, hubUrl: 'https://station.example/salcara-hub/v1', deviceId: 'pc-1', deviceName: 'My PC', ticket: 'a'.repeat(64), expiresAt: Date.now() + 120_000 };
const mockParse = jest.fn((..._args: unknown[]) => mockQr);
const mockPair = jest.fn(async (..._args: unknown[]) => undefined);
const mockDirectQr = { mode: 'direct', urls: ['wss://192.168.1.8:47832/direct/ws'], token: 'c'.repeat(32), deviceId: 'pc-1', fingerprint: 'a'.repeat(64), expiresAt: Date.now() + 120_000, deviceName: 'Direct PC' };
const mockIsDirect = jest.fn((raw: string) => raw === 'direct-json');
const mockParseDirect = jest.fn((..._args: unknown[]) => mockDirectQr);
const mockDirectState: { status: string; deviceId?: string; deviceName?: string; endpoint?: string } = { status: 'idle' };
const mockDirectStateListeners = new Set<() => void>();
const mockPairDirect = jest.fn(async (..._args: unknown[]) => {
  Object.assign(mockDirectState, { status: 'connected', deviceId: 'pc-1', deviceName: 'Direct PC', endpoint: mockDirectQr.urls[0] });
  mockDirectStateListeners.forEach(listener => listener());
  return mockDirectState;
});
let mockPermission = { granted: true, canAskAgain: true };
const mockRequest = jest.fn(async () => mockPermission);
jest.mock('expo-camera', () => ({
  useCameraPermissions: () => [mockPermission, mockRequest],
  CameraView: (props: unknown) => { const React = require('react'); const { View } = require('react-native'); return React.createElement(View, props); },
}));
jest.mock('../state/AppContext', () => ({ useApp: () => ({ providers: [] }) }));
jest.mock('../remote/ThreadView', () => ({ ThreadView: () => null }));
jest.mock('../remote/DirectExperience', () => ({ DirectExperience: () => null }));
jest.mock('../remote/NewConversationFlow', () => ({ NewConversationFlow: () => null }));
jest.mock('../remote/store', () => ({ parseScannedRemoteQr: (...args: unknown[]) => mockParse(...args), pairScannedRemoteQr: (...args: unknown[]) => mockPair(...args) }));
jest.mock('../remote/direct-pairing', () => ({ getDirectConnectionState: () => mockDirectState, subscribeDirectConnection: (listener: () => void) => { mockDirectStateListeners.add(listener); return () => mockDirectStateListeners.delete(listener); }, isDirectPairQr: (raw: string) => mockIsDirect(raw), parseDirectPairQr: (...args: unknown[]) => mockParseDirect(...args), pairDirectQr: (...args: unknown[]) => mockPairDirect(...args) }));
jest.mock('../components/ui', () => {
  const React = require('react'); const { View, Text, Pressable } = require('react-native');
  return {
    Group: ({ children }: { children: unknown }) => React.createElement(View, null, children),
    Appear: ({ children }: { children: unknown }) => React.createElement(View, null, children),
    PrimaryButton: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => React.createElement(Pressable, { onPress, disabled, accessibilityRole: 'button' }, React.createElement(Text, null, label)),
    Sheet: ({ visible, children }: { visible: boolean; children: unknown }) => visible ? React.createElement(View, null, children) : null,
    AppDialog: ({ visible, message, actions, children }: { visible: boolean; message: string; children?: React.ReactNode; actions: Array<{ label: string; onPress: () => void; disabled?: boolean }> }) => visible ? React.createElement(View, null, React.createElement(Text, null, message), children, ...actions.map((action) => React.createElement(Pressable, { key: action.label, onPress: action.onPress, disabled: action.disabled }, React.createElement(Text, null, action.label)))) : null,
    showToast: () => undefined, dismissKeyboardAndBlur: () => undefined,
  };
});
const remote = { selectedHubUrl: mockQr.hubUrl, connection: 'idle', connections: [] } as unknown as RemoteState;
jest.setTimeout(30_000);
beforeEach(() => { mockParse.mockClear(); mockPair.mockClear(); mockIsDirect.mockClear(); mockParseDirect.mockClear(); mockPairDirect.mockClear(); mockRequest.mockClear(); mockPermission = { granted: true, canAskAgain: true }; Object.assign(mockDirectState, { status: 'idle', deviceId: undefined, deviceName: undefined, endpoint: undefined }); mockDirectStateListeners.clear(); });

test('camera is QR-only, repeated scan is gated and no ticket exchange occurs before explicit confirmation', async () => {
  const view = await render(<QrPairing visible remote={remote} onChangeStation={() => undefined} />);
  await fireEvent.press(view.getByText('扫描二维码'));
  const camera = view.getByTestId('remote-qr-camera');
  expect(camera.props.barcodeScannerSettings).toEqual({ barcodeTypes: ['qr'] });
  await act(async () => {
    camera.props.onBarcodeScanned({ type: 'qr', data: 'fixture-json' });
    camera.props.onBarcodeScanned({ type: 'qr', data: 'fixture-json' });
  });
  expect(mockParse).toHaveBeenCalledTimes(1);
  expect(mockPair).not.toHaveBeenCalled();
  expect(view.getAllByText('station.example').length).toBeGreaterThan(0);
  expect(view.getByText(/My PC/)).toBeTruthy();
  await fireEvent.press(view.getByText('连接'));
  expect(mockPair).toHaveBeenCalledTimes(1);
  expect(mockPair).toHaveBeenCalledWith(mockQr, expect.any(Function));
});

test('denied camera permission never mounts a camera or sends a ticket', async () => {
  mockPermission = { granted: false, canAskAgain: true };
  const view = await render(<QrPairing visible remote={remote} onChangeStation={() => undefined} />);
  await fireEvent.press(view.getByText('扫描二维码'));
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(view.queryByTestId('remote-qr-camera')).toBeNull();
  expect(view.getByText('请允许相机权限，用来扫描电脑上的二维码')).toBeTruthy();
  expect(mockPair).not.toHaveBeenCalled();
});

test('Bot connection is available below QR pairing controls', async () => {
  const view = await render(<QrPairing visible remote={remote} />);
  expect(view.getByText('扫描二维码')).toBeTruthy();
  expect(view.getByText('首次绑定电脑时扫描一次，之后无需重复扫码')).toBeTruthy();
  expect(view.queryByText('绑定电脑中转站')).toBeNull();
  expect(view.getByText('Bot 连接')).toBeTruthy();
  expect(view.queryByLabelText('Bot 绑定 JSON')).toBeNull();
  await fireEvent.press(view.getByText('Bot 连接'));
  expect(view.getByLabelText('Bot 绑定 JSON')).toBeTruthy();
});

test('closing remote screen unmounts the camera and ignores non-QR codes', async () => {
  const view = await render(<QrPairing visible remote={remote} onChangeStation={() => undefined} />);
  await fireEvent.press(view.getByText('扫描二维码'));
  const camera = view.getByTestId('remote-qr-camera');
  await act(async () => { camera.props.onBarcodeScanned({ type: 'ean13', data: '12345' }); });
  expect(mockParse).not.toHaveBeenCalled();
  await view.rerender(<QrPairing visible={false} remote={remote} onChangeStation={() => undefined} />);
  expect(view.queryByTestId('remote-qr-camera')).toBeNull();
  expect(mockPair).not.toHaveBeenCalled();
});

test('direct QR has a separate explicit confirmation and opens the direct experience without Hub fallback', async () => {
  const onPaired = jest.fn();
  const view = await render(<QrPairing visible remote={remote} onChangeStation={() => undefined} onPaired={onPaired} />);
  await fireEvent.press(view.getByText('扫描二维码'));
  const camera = view.getByTestId('remote-qr-camera');
  await act(async () => { camera.props.onBarcodeScanned({ type: 'qr', data: 'direct-json' }); });
  expect(mockParseDirect).toHaveBeenCalledWith('direct-json');
  expect(mockParse).not.toHaveBeenCalled();
  expect(view.getByText('将通过局域网 / VPN 加密直连连接这台电脑。会话与消息只走此直连，不经过 Salcara Hub；不支持公网 NAT 穿透。')).toBeTruthy();
  await fireEvent.press(view.getByText('建立直连'));
  expect(mockPairDirect).toHaveBeenCalledWith(mockDirectQr);
  expect(mockPair).not.toHaveBeenCalled();
  expect(onPaired).toHaveBeenCalledWith(true);
  expect(view.queryByText(/尚未接入/)).toBeNull();
});
