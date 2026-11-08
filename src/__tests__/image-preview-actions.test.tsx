jest.mock('../remote/useManagedImage', () => ({ useManagedImage: (uri?: string) => ({ uri, active: Boolean(uri), foreground: true, loading: false }) }));
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('../components/Icon', () => ({ Icon: () => null }));
jest.mock('../components/ui', () => ({ ToastHost: () => null }));
jest.mock('../storage/database', () => ({ getSetting: async () => null, setSetting: async () => undefined }));
jest.mock('react-native-reanimated', () => {
  const React = require('react');
  const native = require('react-native');
  return { __esModule: true, default: { View: native.View, Image: native.Image },
    useSharedValue: (value: unknown) => React.useRef({ value }).current,
    useAnimatedStyle: (create: () => unknown) => create(), withSpring: (value: unknown) => value, cancelAnimation: jest.fn(),
    runOnJS: (callback: (...args: any[]) => void) => callback };
});
jest.mock('react-native-gesture-handler', () => {
  const { View } = require('react-native');
  const chain = () => { const value = { enabled: () => value, averageTouches: () => value, onBegin: () => value, onTouchesDown: () => value, onStart: () => value, onUpdate: () => value, onChange: () => value, onEnd: () => value, onFinalize: () => value, numberOfTaps: () => value }; return value; };
  return { GestureHandlerRootView: View, GestureDetector: View,
    Gesture: { Pinch: chain, Pan: chain, Tap: chain, Simultaneous: () => ({}) } };
});

import { ImagePreview } from '../components/ImagePreview';
import type { GeneratedImage } from '../domain';

async function imageAction(view:Awaited<ReturnType<typeof render>>,label:string){
 if(!view.queryByLabelText(label))await fireEvent.press(view.getByLabelText('图片更多操作'));
 await fireEvent.press(view.getByLabelText(label));
}

const images: GeneratedImage[] = [
  { id: 'first', uri: 'file:///documents/first.png', status: 'complete' },
  { id: 'failed', uri: null, remoteUrl: 'https://example.com/failed.png', status: 'error' },
  { id: 'pending', uri: null, status: 'pending' },
  { id: 'fourth', uri: 'file:///documents/fourth.png', status: 'complete' },
];

function capturedPress(view: Awaited<ReturnType<typeof render>>, label: string): () => void {
  // RNTL 14 exposes host nodes; capture the rendered Pressable callback before
  // it is replaced, rather than redispatching through the newer native props.
  let fiber = view.getByLabelText(label).unstable_fiber;
  while (fiber) {
    const handler = fiber.memoizedProps?.onPress;
    if (typeof handler === 'function') return handler;
    fiber = fiber.return;
  }
  throw new Error(`Missing press callback: ${label}`);
}

function capturedRequestClose(view: Awaited<ReturnType<typeof render>>, testId: string): () => void {
  let fiber = view.getByTestId(testId).unstable_fiber;
  while (fiber) {
    if (typeof fiber.memoizedProps?.onRequestClose === 'function') return fiber.memoizedProps.onRequestClose;
    fiber = fiber.return;
  }
  throw new Error(`Missing modal dismissal: ${testId}`);
}

test.each(['menu-first', 'preview-first'] as const)('one nested Escape closes only the menu with %s notification order', async order => {
  const close = jest.fn(), canvas = jest.fn();
  const view = await render(<ImagePreview uri="file:///documents/image.png" onClose={close} onOpenCanvas={canvas} />);
  await fireEvent.press(view.getByLabelText('图片更多操作'));
  const previewClose = capturedRequestClose(view, 'image-preview-stage'), menuClose = capturedRequestClose(view, 'image-preview-menu');
  await act(async () => { if (order === 'menu-first') { menuClose(); previewClose(); } else { previewClose(); menuClose(); } });
  expect(close).not.toHaveBeenCalled();
  expect(view.queryByTestId('image-preview-menu')).toBeNull();
  expect(view.getByLabelText('打开图片画布')).toBeTruthy();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1)); });
  await act(async () => { capturedRequestClose(view, 'image-preview-stage')(); });
  expect(close).toHaveBeenCalledTimes(1);
});

test('existing ordinary chat and Companion callbacks still receive the shown image', async () => {
  const save = jest.fn(), share = jest.fn();
  const view = await render(<ImagePreview uri="file:///documents/image.png" onClose={jest.fn()} onSave={save} onShare={share} />);
  await imageAction(view,'保存图片'); await imageAction(view,'分享图片');
  expect(save).toHaveBeenCalledWith('file:///documents/image.png');
  expect(share).toHaveBeenCalledWith('file:///documents/image.png');
  await fireEvent.press(view.getByLabelText('图片更多操作'));expect(view.getByLabelText('保存图片').props.accessibilityState.disabled).toBe(false);await fireEvent.press(view.getByLabelText('关闭图片操作'));
  expect(view.queryByLabelText('上一张图片')).toBeNull();
  expect(view.queryByLabelText('下一张图片')).toBeNull();
});

test('accessible navigation skips unavailable slots, keeps original page numbers, and actions follow the controlled URI', async () => {
  const save = jest.fn(), share = jest.fn(), select = jest.fn(), close = jest.fn();
  const view = await render(<ImagePreview uri={images[0].uri} images={images} onSelect={select} onClose={close} onSave={save} onShare={share} />);
  expect(view.getByLabelText('第 1 张，共 4 张')).toBeTruthy();
  expect(view.getByLabelText('上一张图片').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(view.getByLabelText('上一张图片'));
  expect(select).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('下一张图片'));
  await fireEvent.press(view.getByLabelText('下一张图片'));
  expect(select.mock.calls).toEqual([['file:///documents/fourth.png']]);
  expect(view.getByTestId('image-preview-image').props.source.uri).toBe('file:///documents/first.png');
  await view.rerender(<ImagePreview uri={images[3].uri} images={images} onSelect={select} onClose={close} onSave={save} onShare={share} />);
  expect(view.getByText('4 / 4')).toBeTruthy();
  expect(view.getByLabelText('下一张图片').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(view.getByLabelText('下一张图片'));
  expect(select).toHaveBeenCalledTimes(1);
  await imageAction(view,'保存图片');
  await imageAction(view,'分享图片');
  expect(save).toHaveBeenCalledWith('file:///documents/fourth.png');
  expect(share).toHaveBeenCalledWith('file:///documents/fourth.png');
  await fireEvent.press(view.getByLabelText('上一张图片'));
  expect(select.mock.calls[1]).toEqual(['file:///documents/first.png']);
});

test('a ten-slot preview retains the original last-page number when middle slots failed', async () => {
  const batch: GeneratedImage[] = Array.from({ length: 10 }, (_, index) => ({ id: `image-${index}`, uri: index === 0 || index === 9 ? `file:///documents/${index + 1}.png` : null, status: index === 0 || index === 9 ? 'complete' : 'error' }));
  const select = jest.fn();
  const view = await render(<ImagePreview uri={batch[9].uri} images={batch} onSelect={select} onClose={jest.fn()} />);
  expect(view.getByText('10 / 10')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('上一张图片'));
  expect(select).toHaveBeenCalledWith('file:///documents/1.png');
});

test('a current image outside the supplied batch stays single and cannot navigate unrelated results', async () => {
  const select = jest.fn();
  const view = await render(<ImagePreview uri="file:///documents/upload.png" images={images} onSelect={select} onClose={jest.fn()} />);
  expect(view.queryByLabelText('上一张图片')).toBeNull();
  expect(view.queryByLabelText('下一张图片')).toBeNull();
  expect(view.getByTestId('image-preview-image').props.source.uri).toBe('file:///documents/upload.png');
  expect(select).not.toHaveBeenCalled();
});

test('close immediately invalidates retained button callbacks before the owner hides the modal', async () => {
  const select = jest.fn(), save = jest.fn(), share = jest.fn(), close = jest.fn();
  const view = await render(<ImagePreview uri={images[0].uri} images={images} onSelect={select} onClose={close} onSave={save} onShare={share} />);
  const next = capturedPress(view, '下一张图片');
  await fireEvent.press(view.getByLabelText('图片更多操作'));
  const savePrevious = capturedPress(view, '保存图片');
  const sharePrevious = capturedPress(view, '分享图片');
  await fireEvent.press(view.getByLabelText('关闭图片操作'));
  await fireEvent.press(view.getByLabelText('关闭预览'));
  await act(async () => { next(); savePrevious(); sharePrevious(); });
  expect(close).toHaveBeenCalledTimes(1);
  expect(select).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  expect(share).not.toHaveBeenCalled();
});

test('callbacks retained from an earlier visit cannot operate after the same URI is reopened', async () => {
  const select = jest.fn(), save = jest.fn(), close = jest.fn();
  const props = { uri: images[0].uri, images, onSelect: select, onClose: close, onSave: save };
  const view = await render(<ImagePreview {...props} />);
  const oldNext = capturedPress(view, '下一张图片');
  await fireEvent.press(view.getByLabelText('图片更多操作'));
  const oldSave = capturedPress(view, '保存图片');
  await view.rerender(<ImagePreview {...props} uri={images[3].uri} />);
  await view.rerender(<ImagePreview {...props} />);
  await act(async () => { oldNext(); oldSave(); });
  expect(select).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  await imageAction(view,'保存图片');
  expect(save).toHaveBeenCalledWith(images[0].uri);
});

test.each(['save', 'share'] as const)('pending %s blocks both image actions while close and zoom remain available', async pendingAction => {
  const save = jest.fn(), share = jest.fn(), close = jest.fn();
  const view = await render(<ImagePreview uri="file:///documents/image.png" onClose={close} onSave={save} onShare={share} pendingAction={pendingAction} />);
  expect(view.getByText(pendingAction === 'save' ? '保存中…' : '分享中…')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('图片更多操作'));expect(view.getByLabelText('保存图片').props.accessibilityState.disabled).toBe(true);
  expect(view.getByLabelText('分享图片').props.accessibilityState.disabled).toBe(true);
  await imageAction(view,'保存图片'); await imageAction(view,'分享图片');
  expect(save).not.toHaveBeenCalled(); expect(share).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('关闭图片操作'));
  await imageAction(view,'放大图片'); await imageAction(view,'缩小图片');
  await fireEvent.press(view.getByLabelText('关闭预览')); expect(close).toHaveBeenCalledTimes(1);
});
