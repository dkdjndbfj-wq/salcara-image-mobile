import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import type { ProviderProfile } from '../domain';

const mockUpsert = jest.fn(); const mockSaveKey = jest.fn(); const mockActivate = jest.fn(); const mockReload = jest.fn();
const mockFetchModels = jest.fn(); const mockRemove = jest.fn();
let mockProviders: ProviderProfile[] = [];
jest.mock('expo-crypto', () => ({ randomUUID: () => 'new-provider-id' }));
jest.mock('../state/AppContext', () => ({ useApp: () => ({ providers: mockProviders, activeProvider: mockProviders[0] ?? null, reloadProviders: mockReload, activateProvider: mockActivate, removeProvider: mockRemove, generating: false }) }));
jest.mock('../storage/database', () => ({ upsertProvider: (...args: unknown[]) => mockUpsert(...args) }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: jest.fn().mockResolvedValue('existing-key'), saveProviderKey: (...args: unknown[]) => mockSaveKey(...args) }));
jest.mock('../api/chat-api', () => ({ fetchChatModels: (...args: unknown[]) => mockFetchModels(...args) }));
jest.mock('@expo/vector-icons', () => {
  const ReactModule = require('react'); const { Text } = require('react-native');
  return { Ionicons: ({ name }: { name: string }) => ReactModule.createElement(Text, null, name) };
});
jest.mock('../components/ui', () => {
  const original = jest.requireActual('../components/ui'); const ReactModule = require('react'); const { View, Text } = require('react-native');
  return { ...original,
    Sheet: ({ visible, children, footer }: { visible: boolean; children: React.ReactNode; footer: React.ReactNode }) => visible ? ReactModule.createElement(View, null, children, footer) : null,
    AppDialog: ({ visible, title, message }: { visible: boolean; title: string; message: string }) => visible ? ReactModule.createElement(View, null, ReactModule.createElement(Text, null, title), ReactModule.createElement(Text, null, message)) : null,
  };
});

import { ProviderManager } from '../components/ProviderManager';

beforeEach(() => {
  mockProviders = []; mockUpsert.mockReset().mockResolvedValue(undefined); mockSaveKey.mockReset().mockResolvedValue(undefined);
  mockActivate.mockReset().mockResolvedValue(undefined); mockReload.mockReset().mockResolvedValue(undefined);
  mockFetchModels.mockReset().mockResolvedValue(['chat-model', 'gpt-image-2']);
});

test('adds a provider in two steps, protects the key, and leaves image parameters to the composer', async () => {
  const onClose = jest.fn(); const screen = await render(<ProviderManager visible onClose={onClose} />);
  await fireEvent.press(screen.getByText('添加服务商'));
  await fireEvent.press(screen.getByText('图片'));
  await fireEvent.changeText(screen.getByLabelText('名称'), '测试图片');
  await fireEvent.changeText(screen.getByLabelText('API 地址'), 'https://example.com');
  await fireEvent.changeText(screen.getByLabelText('API 密钥'), 'test-secret');
  expect(screen.getByLabelText('API 密钥').props.secureTextEntry).toBe(true);
  await fireEvent.press(screen.getByLabelText('显示密钥'));
  expect(screen.getByLabelText('API 密钥').props.secureTextEntry).toBe(false);
  await fireEvent.press(screen.getByText('下一步 · 选择模型'));
  await waitFor(() => expect(screen.getByText('已连接 · 2 个可用模型')).toBeTruthy());
  expect(screen.queryByText('画质')).toBeNull(); expect(screen.queryByText('比例')).toBeNull();
  await fireEvent.press(screen.getByText('点此选择模型'));
  expect(screen.queryByText('chat-model')).toBeNull();
  await fireEvent.press(screen.getByText('gpt-image-2'));
  await fireEvent.press(screen.getByText('保存服务商'));
  expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({ name: '测试图片', baseUrl: 'https://example.com/v1', model: 'gpt-image-2', chatModel: null, quality: null, aspectRatio: null, resolutionTier: null }));
  expect(JSON.stringify(mockUpsert.mock.calls)).not.toContain('test-secret');
  expect(mockSaveKey).toHaveBeenCalledWith(expect.any(String), 'test-secret');
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('editing an existing provider preserves its routing and does not switch conversations', async () => {
  mockProviders = [{ id: 'saved', name: '已有服务', baseUrl: 'https://example.com/v1', model: null, chatModel: 'chat-model', imageProviderId: 'images', quality: null, aspectRatio: null, resolutionTier: null, createdAt: 1, updatedAt: 1 }];
  const screen = await render(<ProviderManager visible onClose={jest.fn()} focusProviderId="saved" />);
  await fireEvent.changeText(screen.getByLabelText('名称'), '新的名称');
  await fireEvent.press(screen.getByText('下一步 · 选择模型'));
  await waitFor(() => expect(screen.getByText('已连接 · 2 个可用模型')).toBeTruthy());
  await fireEvent.press(screen.getByText('保存服务商'));
  expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'saved', name: '新的名称', imageProviderId: 'images', createdAt: 1 }));
  expect(mockSaveKey).not.toHaveBeenCalled(); expect(mockActivate).not.toHaveBeenCalled();
});

test('connection failures keep manual model entry available', async () => {
  mockFetchModels.mockRejectedValue(new Error('模型列表暂不可用'));
  const screen = await render(<ProviderManager visible onClose={jest.fn()} />);
  await fireEvent.press(screen.getByText('添加服务商'));
  await fireEvent.changeText(screen.getByLabelText('名称'), '手动连接');
  await fireEvent.changeText(screen.getByLabelText('API 地址'), 'https://example.com');
  await fireEvent.changeText(screen.getByLabelText('API 密钥'), 'test-secret');
  await fireEvent.press(screen.getByText('下一步 · 选择模型'));
  await waitFor(() => expect(screen.getByText('模型列表暂不可用')).toBeTruthy());
  await fireEvent.press(screen.getByText('点此选择模型'));
  await fireEvent.press(screen.getByText('手动添加'));
  await fireEvent.changeText(screen.getByLabelText('自定义模型 ID'), 'my-private-model');
  await fireEvent.press(screen.getByText('使用这个模型'));
  await fireEvent.press(screen.getByText('保存服务商'));
  expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({ chatModel: 'my-private-model' }));
});
