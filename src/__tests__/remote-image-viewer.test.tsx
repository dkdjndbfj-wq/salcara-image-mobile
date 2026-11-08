import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

const mockExport = jest.fn();
const mockFailure = jest.fn();
const mockToast = jest.fn();
const mockPreview = jest.fn();
jest.mock('../remote/image-export', () => ({
  exportRemoteImage: (...args: unknown[]) => mockExport(...args),
  imageExportFailure: (...args: unknown[]) => mockFailure(...args),
}));
jest.mock('../components/ui', () => ({ showToast: (...args: unknown[]) => mockToast(...args), Appear: () => null, MotionPressable: () => null }));
jest.mock('../components/Icon', () => ({ Icon: () => null }));
jest.mock('../remote/parts', () => ({ DiffView: () => null, mono: 'monospace' }));
jest.mock('../storage/database', () => ({ getSetting: async () => null, setSetting: async () => undefined }));
jest.mock('../components/ImagePreview', () => {
  const React = require('react');
  const { Pressable, Text, View } = require('react-native');
  return { ImagePreview: (props: any) => {
    mockPreview(props);
    return React.createElement(View, {},
      React.createElement(Text, {}, props.uri),
      React.createElement(Text, { testID: 'pending-action' }, props.pendingAction ?? 'idle'),
      React.createElement(Pressable, { accessibilityLabel: '保存图片', disabled: Boolean(props.pendingAction), onPress: props.onSave }),
      React.createElement(Pressable, { accessibilityLabel: '分享图片', disabled: Boolean(props.pendingAction), onPress: props.onShare }),
      React.createElement(Pressable, { accessibilityLabel: '关闭预览', onPress: props.onClose }));
  } };
});

import { ImageViewer } from '../remote/thread-extras';

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function preview() { return mockPreview.mock.calls[mockPreview.mock.calls.length - 1][0]; }

beforeEach(() => {
  jest.clearAllMocks(); mockExport.mockReset().mockResolvedValue(undefined);
  mockFailure.mockReset().mockImplementation((_error: unknown, action: string) => action === 'save' ? '保存失败，请稍后重试' : '分享失败，请稍后重试');
});

test('no image mounts no system image preview', async () => {
  await render(<ImageViewer uri={null} onClose={jest.fn()} />);
  expect(mockPreview).not.toHaveBeenCalled(); expect(mockExport).not.toHaveBeenCalled();
});

test('same-tick repeated clicks dispatch once and block the other action until completion', async () => {
  const pending = deferred(); mockExport.mockReturnValue(pending.promise);
  const view = await render(<ImageViewer uri="file:///cache/first.png" onClose={jest.fn()} />);
  const staleHandler = preview();
  await act(async () => { staleHandler.onSave(); staleHandler.onSave(); staleHandler.onShare(); });
  expect(mockExport).toHaveBeenCalledTimes(1);
  expect(mockExport).toHaveBeenCalledWith('file:///cache/first.png', 'save', expect.any(AbortSignal));
  expect(view.getByTestId('pending-action').props.children).toBe('save');
  await fireEvent.press(view.getByLabelText('分享图片'));
  expect(mockExport).toHaveBeenCalledTimes(1);
  await act(async () => { pending.resolve(); });
  expect(view.getByTestId('pending-action').props.children).toBe('idle');
  expect(mockToast).toHaveBeenCalledTimes(1); expect(mockToast).toHaveBeenCalledWith('已保存到相册', 'checkCircle');
});

test('successful sharing uses the selected local image without adding a false saved toast', async () => {
  const view = await render(<ImageViewer uri="file:///cache/photo.webp" onClose={jest.fn()} />);
  await fireEvent.press(view.getByLabelText('分享图片'));
  expect(mockExport).toHaveBeenCalledWith('file:///cache/photo.webp', 'share', expect.any(AbortSignal));
  expect(mockToast).not.toHaveBeenCalled();
  expect(view.getByTestId('pending-action').props.children).toBe('idle');
});

test('a failed operation reports safe feedback and can be retried', async () => {
  const error = new Error('https://hub.example/?lease=private');
  mockExport.mockRejectedValueOnce(error).mockResolvedValue(undefined);
  const view = await render(<ImageViewer uri="file:///cache/first.png" onClose={jest.fn()} />);
  await fireEvent.press(view.getByLabelText('保存图片'));
  expect(mockFailure).toHaveBeenCalledWith(error, 'save');
  expect(mockToast).toHaveBeenCalledWith('保存失败，请稍后重试', 'alert');
  expect(view.getByTestId('pending-action').props.children).toBe('idle');
  await fireEvent.press(view.getByLabelText('保存图片'));
  expect(mockExport).toHaveBeenCalledTimes(2); expect(mockToast).toHaveBeenLastCalledWith('已保存到相册', 'checkCircle');
});

test.each(['resolve', 'reject'] as const)('closing aborts synchronously and ignores a late %s result', async finish => {
  const pending = deferred(); mockExport.mockReturnValue(pending.promise); const close = jest.fn();
  const view = await render(<ImageViewer uri="file:///cache/first.png" onClose={close} />);
  await fireEvent.press(view.getByLabelText('保存图片'));
  const active = mockExport.mock.calls[0][2] as AbortSignal;
  const staleHandler = preview();
  await act(async () => { staleHandler.onClose(); expect(active.aborted).toBe(true); });
  expect(close).toHaveBeenCalledTimes(1);
  await act(async () => { finish === 'resolve' ? pending.resolve() : pending.reject(new Error('late failure')); });
  await act(async () => { staleHandler.onSave(); staleHandler.onShare(); });
  expect(mockExport).toHaveBeenCalledTimes(1); expect(mockToast).not.toHaveBeenCalled();
});

test('switching images cancels the old owner without clearing a newer pending action', async () => {
  const first = deferred(), second = deferred();
  mockExport.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const close = jest.fn(); const view = await render(<ImageViewer uri="file:///cache/first.png" onClose={close} />);
  await fireEvent.press(view.getByLabelText('保存图片'));
  const oldSignal = mockExport.mock.calls[0][2] as AbortSignal; const staleHandler = preview();
  await view.rerender(<ImageViewer uri="file:///cache/second.webp" onClose={close} />);
  expect(oldSignal.aborted).toBe(true);
  await fireEvent.press(view.getByLabelText('分享图片'));
  const nextSignal = mockExport.mock.calls[1][2] as AbortSignal;
  expect(nextSignal.aborted).toBe(false);
  await act(async () => { staleHandler.onSave(); staleHandler.onClose(); first.resolve(); });
  expect(mockExport).toHaveBeenCalledTimes(2);
  expect(close).not.toHaveBeenCalled();
  expect(view.getByTestId('pending-action').props.children).toBe('share'); expect(mockToast).not.toHaveBeenCalled();
  await act(async () => { second.resolve(); });
  expect(view.getByTestId('pending-action').props.children).toBe('idle'); expect(mockToast).not.toHaveBeenCalled();
});

test('unmount aborts the image action and a late failure has no toast', async () => {
  const pending = deferred(); mockExport.mockReturnValue(pending.promise);
  const view = await render(<ImageViewer uri="file:///cache/first.png" onClose={jest.fn()} />);
  await fireEvent.press(view.getByLabelText('分享图片'));
  const active = mockExport.mock.calls[0][2] as AbortSignal;
  await view.unmount(); expect(active.aborted).toBe(true);
  await act(async () => { pending.reject(new Error('late failure')); });
  expect(mockToast).not.toHaveBeenCalled();
});

test('closing before the lazy helper loads never starts an export', async () => {
  await render(<ImageViewer uri="file:///cache/first.png" onClose={jest.fn()} />);
  const handler = preview();
  await act(async () => { handler.onSave(); handler.onClose(); });
  expect(mockExport).not.toHaveBeenCalled(); expect(mockToast).not.toHaveBeenCalled();
});
