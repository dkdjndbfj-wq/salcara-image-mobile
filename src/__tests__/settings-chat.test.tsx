import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import type { ComposerMode, ProviderProfile } from '../domain';

const mockUpdate = jest.fn();
const mockGetKey = jest.fn();
const mockFetchModels = jest.fn();
let mockMode: ComposerMode = 'auto';
let mockGenerating = false;
let mockActive: ProviderProfile;
let mockProviders: ProviderProfile[];
jest.mock('../state/AppContext', () => ({ useApp: () => ({ activeProvider: mockActive, providers: mockProviders, composerMode: mockMode, generating: mockGenerating, updateProviderSettings: mockUpdate }) }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: (...args: unknown[]) => mockGetKey(...args) }));
jest.mock('../api/chat-api', () => ({ fetchChatModels: (...args: unknown[]) => mockFetchModels(...args) }));
jest.mock('@expo/vector-icons', () => {
  const ReactModule = require('react'); const { Text } = require('react-native');
  return { Ionicons: ({ name }: { name: string }) => ReactModule.createElement(Text, null, name) };
});
jest.mock('../components/ui', () => {
  const original = jest.requireActual('../components/ui');
  const ReactModule = require('react'); const { View, Text } = require('react-native');
  return {
    ...original,
    Sheet: ({ visible, title, children, footer }: { visible: boolean; title: string; children: React.ReactNode; footer: React.ReactNode }) => visible
      ? ReactModule.createElement(View, null, ReactModule.createElement(Text, null, title), children, footer) : null,
    AppDialog: ({ visible, title, message }: { visible: boolean; title: string; message: string }) => visible
      ? ReactModule.createElement(View, null, ReactModule.createElement(Text, null, title), ReactModule.createElement(Text, null, message)) : null,
  };
});

import { SettingsSheet } from '../components/SettingsSheet';

beforeEach(() => {
  mockUpdate.mockReset().mockResolvedValue(undefined);
  mockGetKey.mockReset().mockResolvedValue('test-key');
  mockFetchModels.mockReset().mockResolvedValue(['original-chat', 'vision-model', 'vision-pro', 'gpt-image-2', 'gpt-image-2.5']);
  mockMode = 'auto'; mockGenerating = false;
  mockActive = { id: 'main', name: '主服务', baseUrl: 'https://example.com/v1', model: 'gpt-image-2', quality: 'high', aspectRatio: '16:9', resolutionTier: '2K', chatModel: 'original-chat', chatApi: 'chat-completions', createdAt: 1, updatedAt: 1 };
  mockProviders = [mockActive,
    { ...mockActive, id: 'chat', name: '独立对话', model: null, chatModel: 'vision-model', chatApi: 'responses' },
    { ...mockActive, id: 'image', name: '独立图片', model: 'gpt-image-2.5', chatModel: null },
  ];
});

test('searches and changes an independent conversation model without switching the conversation', async () => {
  const onClose = jest.fn();
  const screen = await render(<SettingsSheet visible onClose={onClose} />);
  await fireEvent.press(screen.getByLabelText('选择对话服务商'));
  await fireEvent.press(screen.getByText('独立对话'));
  await waitFor(() => expect(mockFetchModels).toHaveBeenCalledWith('https://example.com/v1', 'test-key', 'responses'));
  await fireEvent.press(screen.getByLabelText('选择对话模型'));
  await fireEvent.changeText(screen.getByLabelText('搜索模型'), 'vision-pro');
  expect(screen.queryByText('original-chat')).toBeNull();
  await fireEvent.press(screen.getByText('vision-pro'));
  await fireEvent.press(screen.getByText('应用'));
  expect(mockUpdate).toHaveBeenCalledWith('chat', { chatModel: 'vision-pro' });
  expect(mockUpdate).toHaveBeenCalledWith('main', { analysisProviderId: 'chat', imageProviderId: null });
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('auto mode changes the independent image provider and its parameters from the same sheet', async () => {
  const screen = await render(<SettingsSheet visible onClose={jest.fn()} />);
  await fireEvent.press(screen.getByText('图片创作'));
  await fireEvent.press(screen.getByLabelText('选择图片服务商'));
  await fireEvent.press(screen.getByText('独立图片'));
  await fireEvent.press(screen.getByText('max'));
  await fireEvent.press(screen.getByText('9:16'));
  await fireEvent.press(screen.getByText('4K'));
  await fireEvent.press(screen.getByText('应用'));
  expect(mockUpdate).toHaveBeenCalledWith('image', { model: 'gpt-image-2.5', quality: 'max', aspectRatio: '9:16', resolutionTier: '4K' });
  expect(mockUpdate).toHaveBeenCalledWith('main', { analysisProviderId: null, imageProviderId: 'image' });
});

test('merges chat, image and routing changes when both capabilities share the same provider', async () => {
  const screen = await render(<SettingsSheet visible onClose={jest.fn()} />);
  await waitFor(() => expect(mockFetchModels).toHaveBeenCalled());
  await fireEvent.press(screen.getByLabelText('选择对话模型'));
  await fireEvent.press(screen.getByText('vision-pro'));
  await fireEvent.press(screen.getByText('图片创作'));
  await fireEvent.press(screen.getByText('1:1'));
  await fireEvent.press(screen.getByText('应用'));
  expect(mockUpdate).toHaveBeenCalledTimes(1);
  expect(mockUpdate).toHaveBeenCalledWith('main', { chatModel: 'vision-pro', model: 'gpt-image-2', quality: 'high', aspectRatio: '1:1', resolutionTier: '2K', analysisProviderId: null, imageProviderId: null });
});

test('starts with persisted image mapping and requires parameters before first image use', async () => {
  mockMode = 'image'; mockActive.imageProviderId = 'image';
  mockProviders[2].quality = null;
  const screen = await render(<SettingsSheet visible onClose={jest.fn()} />);
  expect(screen.getByText('独立图片')).toBeTruthy();
  await fireEvent.press(screen.getByText('应用'));
  expect(screen.getByText('请选择画质、比例和清晰度')).toBeTruthy();
  expect(mockUpdate).not.toHaveBeenCalled();
});

test('settings cannot be applied during a request', async () => {
  mockGenerating = true;
  const screen = await render(<SettingsSheet visible onClose={jest.fn()} />);
  await fireEvent.press(screen.getByText('应用'));
  expect(mockUpdate).not.toHaveBeenCalled();
});
