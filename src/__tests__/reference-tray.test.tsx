import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

jest.mock('@expo/vector-icons', () => {
  const ReactModule = require('react');
  const { Text } = require('react-native');
  return { Ionicons: ({ name }: { name: string }) => ReactModule.createElement(Text, null, name) };
});

jest.mock('react-native-draggable-flatlist', () => ({
  __esModule: true,
  default: ({ data, renderItem, onDragEnd }: { data: unknown[]; renderItem: (value: unknown) => React.ReactNode; onDragEnd: (value: { data: unknown[] }) => void }) => {
    const ReactModule = require('react');
    const { Pressable, Text, View } = require('react-native');
    return ReactModule.createElement(
      View,
      null,
      ...data.map((item: unknown, index: number) => ReactModule.createElement(View, { key: index }, renderItem({ item, drag: jest.fn(), isActive: false, getIndex: () => index }))),
      ReactModule.createElement(Pressable, { accessibilityLabel: '模拟拖动排序', onPress: () => onDragEnd({ data: [...data].reverse() }) }, ReactModule.createElement(Text, null, '排序')),
    );
  },
  ScaleDecorator: ({ children }: { children: React.ReactNode }) => children,
}));

import { ReferenceTray } from '../components/ReferenceTray';
import type { ReferenceImage } from '../domain';

const images: ReferenceImage[] = [
  { id: 'a', uri: 'file://a.png', name: 'a.png', mimeType: 'image/png', size: 100 },
  { id: 'b', uri: 'file://b.png', name: 'b.png', mimeType: 'image/png', size: 100 },
  { id: 'c', uri: 'file://c.png', name: 'c.png', mimeType: 'image/png', size: 100 },
  { id: 'd', uri: 'file://d.png', name: 'd.png', mimeType: 'image/png', size: 100 },
];

describe('ReferenceTray', () => {
  test('labels the first of four images as the main image', async () => {
    const screen = await render(<ReferenceTray images={images} onChange={jest.fn()} onEditMask={jest.fn()} hasMask={false} />);
    expect(screen.getByText('主图')).toBeTruthy();
    expect(screen.getByText('参考 3')).toBeTruthy();
  });

  test('passes the reordered image list back to the composer', async () => {
    const onChange = jest.fn();
    const screen = await render(<ReferenceTray images={images} onChange={onChange} onEditMask={jest.fn()} hasMask={false} />);
    await fireEvent.press(screen.getByLabelText('模拟拖动排序'));
    expect(onChange.mock.calls[0][0].map((image: ReferenceImage) => image.id)).toEqual(['d', 'c', 'b', 'a']);
  });

  test('highlights the mask state and can remove an image', async () => {
    const onChange = jest.fn();
    const onEditMask = jest.fn();
    const screen = await render(<ReferenceTray images={images} onChange={onChange} onEditMask={onEditMask} hasMask />);
    await fireEvent.press(screen.getByText('已加蒙版'));
    await fireEvent.press(screen.getAllByLabelText('移除图片')[0]);
    expect(onEditMask).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toHaveLength(3);
  });
});
