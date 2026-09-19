import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

jest.mock('@expo/vector-icons', () => {
  const ReactModule = require('react');
  const { Text } = require('react-native');
  return { Ionicons: ({ name }: { name: string }) => ReactModule.createElement(Text, null, name) };
});

import { MessageBubble } from '../components/MessageBubble';
import type { ChatMessage } from '../domain';

const noop = jest.fn();
const base: ChatMessage = {
  id: 'message-1',
  conversationId: 'conversation-1',
  role: 'assistant',
  prompt: '奥特曼打怪兽',
  mode: 'generate',
  status: 'pending',
  providerId: 'provider-1',
  model: 'gpt-image-2.5',
  quality: 'high',
  size: '1024x1024',
  transparent: false,
  imageUri: null,
  references: [],
  maskUri: null,
  error: null,
  elapsedMs: null,
  createdAt: 1,
};

function renderMessage(message: ChatMessage, overrides: Partial<React.ComponentProps<typeof MessageBubble>> = {}) {
  return render(
    <MessageBubble
      message={message}
      elapsedSeconds={65}
      onCancel={noop}
      onRetry={noop}
      onSave={noop}
      onShare={noop}
      onReuse={noop}
      onPreview={noop}
      {...overrides}
    />,
  );
}

describe('MessageBubble', () => {
  beforeEach(() => jest.clearAllMocks());

  test('shows elapsed time and cancels a pending request', async () => {
    const onCancel = jest.fn();
    const screen = await renderMessage(base, { onCancel });
    expect(screen.getByText('已等待 1分05秒 · 最长 10 分钟')).toBeTruthy();
    await fireEvent.press(screen.getByText('取消'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('offers only a manual retry after an error', async () => {
    const onRetry = jest.fn();
    const screen = await renderMessage({ ...base, status: 'error', error: '余额不足' }, { onRetry });
    expect(screen.getByText('余额不足')).toBeTruthy();
    await fireEvent.press(screen.getByText('手动重试'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test('exposes save, share and reference reuse actions for a result', async () => {
    const onSave = jest.fn();
    const onShare = jest.fn();
    const onReuse = jest.fn();
    const screen = await renderMessage({ ...base, status: 'complete', imageUri: 'file://result.png', elapsedMs: 9200 }, { onSave, onShare, onReuse });
    await fireEvent.press(screen.getByText('保存'));
    await fireEvent.press(screen.getByText('分享'));
    await fireEvent.press(screen.getByText('作为参考图'));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onShare).toHaveBeenCalledTimes(1);
    expect(onReuse).toHaveBeenCalledTimes(1);
  });
});
