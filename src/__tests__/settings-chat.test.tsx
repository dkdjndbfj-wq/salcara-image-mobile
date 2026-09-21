import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import type { ProviderProfile } from '../domain';

const mockUpdate = jest.fn();
let mockMode: 'image' | 'chat' = 'chat';
let mockGenerating = false;
let mockActive: ProviderProfile;
let mockProviders: ProviderProfile[];
jest.mock('../state/AppContext', () => ({ useApp: () => ({ activeProvider: mockActive, providers: mockProviders, composerMode: mockMode, generating: mockGenerating, updateActiveProviderSettings: mockUpdate }) }));
jest.mock('@expo/vector-icons', () => {
  const ReactModule = require('react');
  const { Text } = require('react-native');
  return { Ionicons: ({ name }: { name: string }) => ReactModule.createElement(Text, null, name) };
});
// The settings behavior is under test here; native Modal/ScrollView layout is
// must be checked on Android rather than React's asynchronous test renderer.
jest.mock('../components/ui', () => {
  const original = jest.requireActual('../components/ui');
  const ReactModule = require('react');
  const { View, Text } = require('react-native');
  return {
    ...original,
    Sheet: ({ visible, title, children }: { visible: boolean; title: string; children: React.ReactNode }) => visible
      ? ReactModule.createElement(View, null, ReactModule.createElement(Text, null, title), children) : null,
    AppDialog: ({ visible, title, message }: { visible: boolean; title: string; message: string }) => visible
      ? ReactModule.createElement(View, null, ReactModule.createElement(Text, null, title), ReactModule.createElement(Text, null, message)) : null,
  };
});

import { SettingsSheet } from '../components/SettingsSheet';

beforeEach(() => {
  mockUpdate.mockReset().mockResolvedValue(undefined);
  mockMode = 'chat';
  mockGenerating = false;
  mockActive = {
    id: 'image', name: '生图服务', baseUrl: 'https://example.com/v1', model: 'gpt-image-2', quality: 'high',
    aspectRatio: '16:9', resolutionTier: '2K', chatModel: 'original-chat', chatApi: 'chat-completions', createdAt: 1, updatedAt: 1,
  };
  mockProviders = [mockActive, { ...mockActive, id: 'chat', name: '对话服务', model: null, chatModel: 'vision-model', chatApi: 'responses' }];
});

test('chooses an independent chat provider and keeps the image configuration intact', async () => {
  const onClose = jest.fn();
  const screen = await render(<SettingsSheet visible onClose={onClose} />);
  expect(screen.getByText('对话设置')).toBeTruthy();
  expect(screen.queryByText('画质')).toBeNull();
  await fireEvent.press(screen.getByText('对话服务'));
  expect(screen.queryByPlaceholderText('填写对话／视觉模型 ID')).toBeNull();
  expect(screen.getByText(/当前会话保持不变，内容发给 对话服务/)).toBeTruthy();
  await fireEvent.press(screen.getByText('应用设置'));
  expect(mockUpdate).toHaveBeenCalledWith({ analysisProviderId: 'chat' });
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('returning to current provider exposes its model and persists selected API', async () => {
  mockActive.analysisProviderId = 'chat';
  const screen = await render(<SettingsSheet visible onClose={jest.fn()} />);
  await fireEvent.press(screen.getByText('使用当前服务商'));
  expect(screen.getByDisplayValue('original-chat')).toBeTruthy();
  await fireEvent.changeText(screen.getByPlaceholderText('填写对话／视觉模型 ID'), 'custom-vision');
  await fireEvent.press(screen.getByText('Responses'));
  await fireEvent.press(screen.getByText('应用设置'));
  expect(mockUpdate).toHaveBeenCalledWith({ chatModel: 'custom-vision', chatApi: 'responses', analysisProviderId: null });
});

test('image mode retains image options while selecting the document analysis provider', async () => {
  mockMode = 'image';
  const screen = await render(<SettingsSheet visible onClose={jest.fn()} />);
  expect(screen.getByText('画质')).toBeTruthy();
  expect(screen.getByText('比例')).toBeTruthy();
  expect(screen.queryByText('Responses')).toBeNull();
  await fireEvent.press(screen.getByText('对话服务'));
  await fireEvent.press(screen.getByText('应用设置'));
  expect(mockUpdate).toHaveBeenCalledWith({ model: 'gpt-image-2', quality: 'high', aspectRatio: '16:9', resolutionTier: '2K', analysisProviderId: 'chat' });
});

test('settings cannot be applied while a request is in progress', async () => {
  mockGenerating = true;
  const screen = await render(<SettingsSheet visible onClose={jest.fn()} />);
  await fireEvent.press(screen.getByText('应用设置'));
  expect(mockUpdate).not.toHaveBeenCalled();
});
