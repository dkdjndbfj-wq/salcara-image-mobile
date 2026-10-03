import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { QrPairing } from '../remote/RemoteScreen';
import type { RemoteState } from '../remote/store';

const mockQr = { type: 'salcara-remote-pair', version: 1, hubUrl: 'https://station.example/salcara-hub/v1', deviceId: 'pc-1', deviceName: 'My PC', ticket: 'a'.repeat(64), expiresAt: Date.now() + 120_000 };
const mockParse = jest.fn((..._args: unknown[]) => mockQr);
const mockPair = jest.fn(async (..._args: unknown[]) => undefined);
let mockPermission = { granted: true, canAskAgain: true };
const mockRequest = jest.fn(async () => mockPermission);
jest.mock('expo-camera', () => ({
  useCameraPermissions: () => [mockPermission, mockRequest],
  CameraView: (props: unknown) => { const React = require('react'); const { View } = require('react-native'); return React.createElement(View, props); },
}));
jest.mock('../state/AppContext', () => ({ useApp: () => ({ providers: [] }) }));
jest.mock('../remote/ThreadView', () => ({ ThreadView: () => null }));
jest.mock('../remote/store', () => ({ parseRemoteQr: (...args: unknown[]) => mockParse(...args), pairRemoteQr: (...args: unknown[]) => mockPair(...args) }));
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
const remote = { selectedHubUrl: mockQr.hubUrl, connection: 'idle' } as RemoteState;
jest.setTimeout(30_000);
beforeEach(() => { mockParse.mockClear(); mockPair.mockClear(); mockRequest.mockClear(); mockPermission = { granted: true, canAskAgain: true }; });

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
  expect(mockPair).toHaveBeenCalledWith(mockQr);
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
