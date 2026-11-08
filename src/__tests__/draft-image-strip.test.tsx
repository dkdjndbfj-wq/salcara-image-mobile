import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { DraftImageStrip } from '../remote/DraftImageStrip';

jest.mock('../components/Icon', () => ({ Icon: () => null }));
jest.mock('../remote/ManagedImage', () => ({ ManagedImage: () => null }));
jest.mock('../remote/thread-extras', () => {
  const React = require('react'), { Pressable, Text, View } = require('react-native');
  return { ImageViewer: ({ uri, onClose }: { uri: string | null; onClose: () => void }) => uri ? <View testID="draft-preview"><Text>{uri}</Text><Pressable accessibilityLabel="关闭草稿图片预览" onPress={onClose} /></View> : null };
});
const images = [{ uri: 'file://first.png' }, { uri: 'file://second.png' }];
function pressHandler(view: Awaited<ReturnType<typeof render>>, label: string): () => void {
  let fiber = view.getByLabelText(label).unstable_fiber;
  while (fiber) { if (typeof fiber.memoizedProps?.onPress === 'function') return fiber.memoizedProps.onPress; fiber = fiber.return; }
  throw new Error(`Missing press handler: ${label}`);
}

test('preview and remove are separate actions, keeping the rest of the draft intact', async () => {
  const remove = jest.fn(), view = await render(<DraftImageStrip scopeKey="one" images={images} onRemove={remove} />);
  await fireEvent.press(view.getByLabelText('预览待发送图片 2'));
  expect(view.getByTestId('draft-preview')).toHaveTextContent('file://second.png'); expect(remove).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('关闭草稿图片预览'));
  expect(view.queryByTestId('draft-preview')).toBeNull(); expect(remove).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('移除待发送图片 1'));
  expect(remove).toHaveBeenCalledTimes(1); expect(remove).toHaveBeenCalledWith(0); expect(view.queryByTestId('draft-preview')).toBeNull();
});

test('scope changes close the preview immediately and invalidate retained callbacks even after switching back', async () => {
  const remove = jest.fn(), props = { images, onRemove: remove };
  const view = await render(<DraftImageStrip {...props} scopeKey="one" />);
  const oldPreview = pressHandler(view, '预览待发送图片 1');
  const oldRemove = pressHandler(view, '移除待发送图片 1');
  await fireEvent.press(view.getByLabelText('预览待发送图片 1'));
  await view.rerender(<DraftImageStrip {...props} scopeKey="two" />); expect(view.queryByTestId('draft-preview')).toBeNull();
  await view.rerender(<DraftImageStrip {...props} scopeKey="one" />);
  await act(async () => { oldPreview(); oldRemove(); });
  expect(view.queryByTestId('draft-preview')).toBeNull(); expect(remove).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('预览待发送图片 2')); expect(view.getByTestId('draft-preview')).toHaveTextContent('file://second.png');
});

test('hidden surfaces and removed attachments close preview without mutating images', async () => {
  const remove = jest.fn(), props = { scopeKey: 'same', onRemove: remove };
  const view = await render(<DraftImageStrip {...props} images={images} />);
  await fireEvent.press(view.getByLabelText('预览待发送图片 1'));
  await view.rerender(<DraftImageStrip {...props} images={images.slice(1)} />); expect(view.queryByTestId('draft-preview')).toBeNull();
  await fireEvent.press(view.getByLabelText('预览待发送图片 1'));
  await view.rerender(<DraftImageStrip {...props} images={images.slice(1)} visible={false} />); expect(view.queryByTestId('draft-image-strip')).toBeNull();
  await view.rerender(<DraftImageStrip {...props} images={images.slice(1)} />); expect(view.queryByTestId('draft-preview')).toBeNull();
  expect(remove).not.toHaveBeenCalled();
});

test('disabled controls reject retained callbacks, and empty state mounts no viewer', async () => {
  const remove = jest.fn(), props = { scopeKey: 'locked', images, onRemove: remove };
  const view = await render(<DraftImageStrip {...props} />);
  const open = pressHandler(view, '预览待发送图片 1'), drop = pressHandler(view, '移除待发送图片 1');
  await view.rerender(<DraftImageStrip {...props} disabled />);
  await act(async () => { open(); drop(); });
  expect(remove).not.toHaveBeenCalled(); expect(view.queryByTestId('draft-preview')).toBeNull(); expect(view.getByLabelText('移除待发送图片 1')).toBeDisabled();
  await view.rerender(<DraftImageStrip {...props} images={[]} />); expect(view.queryByTestId('draft-image-strip')).toBeNull();
});
