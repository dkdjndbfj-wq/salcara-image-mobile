import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import * as Clipboard from 'expo-clipboard';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => {}) }));

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
  remoteImageUrl: null,
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

  test('offers a download-only retry when generation already returned a URL', async () => {
    const onRetry = jest.fn();
    const screen = await renderMessage(
      { ...base, status: 'error', error: '图片下载失败', remoteImageUrl: 'https://cdn.example/result.png' },
      { onRetry },
    );
    await fireEvent.press(screen.getByText('重新下载'));
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

  test('renders and copies a successful text answer without showing an image failure', async () => {
    const screen = await renderMessage({ ...base, mode: 'chat', status: 'complete', text: '足球场的两侧是蓝色看台。', size: '' });
    expect(screen.getByText('足球场的两侧是蓝色看台。')).toBeTruthy();
    expect(screen.queryByText('请求失败')).toBeNull();
    expect(screen.queryByText('生成失败')).toBeNull();
    expect(screen.queryByText('保存')).toBeNull();
    await fireEvent.press(screen.getByText('复制回答'));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('足球场的两侧是蓝色看台。');
    expect(screen.getByText('已复制')).toBeTruthy();
  });

  test('shows document names beside the user prompt', async () => {
    const screen = await renderMessage({ ...base, role: 'user', status: 'complete', documents: [{ id: 'pdf', uri: 'file:///scheme.pdf', name: '足球场设计方案.pdf', mimeType: 'application/pdf', size: 128 }] });
    expect(screen.getByText('足球场设计方案.pdf')).toBeTruthy();
    expect(screen.getByText('奥特曼打怪兽')).toBeTruthy();
  });

  test('explains the analysis stage and expands the prompt used for image generation', async () => {
    const pending = await renderMessage({ ...base, documents: [] }, { requestStage: '正在解析附件并整理生图需求' });
    expect(pending.getByText('正在解析附件并整理生图需求')).toBeTruthy();
    await pending.unmount();
    const result = await renderMessage({ ...base, status: 'complete', imageUri: 'file:///result.png', preparedPrompt: '保留 PDF 中的场地尺寸与配色。' });
    expect(result.queryByText('保留 PDF 中的场地尺寸与配色。')).toBeNull();
    await fireEvent.press(result.getByText('查看文件解析后的提示词'));
    expect(result.getByText('保留 PDF 中的场地尺寸与配色。')).toBeTruthy();
    await fireEvent.press(result.getByText('收起文件解析结果'));
    expect(result.queryByText('保留 PDF 中的场地尺寸与配色。')).toBeNull();
  });
});
