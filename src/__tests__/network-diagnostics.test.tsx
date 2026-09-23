import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

jest.setTimeout(15_000);

const mockFetch = jest.fn();
const mockGetKey = jest.fn();
jest.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => mockFetch(...args) }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: (...args: unknown[]) => mockGetKey(...args) }));
jest.mock('@expo/vector-icons', () => {
  const ReactModule = require('react');
  const { Text } = require('react-native');
  return { Ionicons: ({ name }: { name: string }) => ReactModule.createElement(Text, null, name) };
});

import { NetworkDiagnostics } from '../components/NetworkDiagnostics';

beforeEach(() => { mockFetch.mockReset(); mockGetKey.mockReset(); mockGetKey.mockResolvedValue('private-key'); });

test('diagnoses API and image host separately without sending the API key to the CDN', async () => {
  mockFetch.mockResolvedValue({ ok: true, status: 200, body: { cancel: async () => undefined } });
  const screen = await render(<NetworkDiagnostics visible onClose={jest.fn()} providerId="provider" baseUrl="https://api.example" imageUrl="https://cdn.example/result.png?secret=signature" />);
  expect(mockFetch).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByText('检测当前网络'));
  await waitFor(() => expect(screen.getByText('模型接口可连接')).toBeTruthy());
  expect(screen.getByText('API 服务器 · api.example')).toBeTruthy();
  expect(screen.getByText('图片服务器 · cdn.example')).toBeTruthy();
  expect(mockFetch).toHaveBeenCalledWith('https://api.example/v1/models', expect.objectContaining({
    method: 'GET', headers: { Authorization: 'Bearer private-key' }, redirect: 'error', credentials: 'omit',
  }));
  expect(mockFetch).toHaveBeenCalledWith('https://cdn.example/result.png?secret=signature', expect.objectContaining({
    method: 'HEAD', headers: undefined, credentials: 'omit',
  }));
  expect(JSON.stringify(screen.toJSON())).not.toContain('secret=signature');
  expect(JSON.stringify(screen.toJSON())).not.toContain('private-key');
});

test('explains reachable-but-unauthorized responses instead of calling them network failures', async () => {
  mockFetch.mockResolvedValue({ ok: false, status: 401 });
  const screen = await render(<NetworkDiagnostics visible onClose={jest.fn()} providerId="provider" baseUrl="https://api.example" />);
  await fireEvent.press(screen.getByText('检测当前网络'));
  await waitFor(() => expect(screen.getAllByText(/服务器可连接，但拒绝访问/).length).toBeGreaterThanOrEqual(1));
});

test('uses native Claude authentication only for the configured API host', async () => {
  mockGetKey.mockResolvedValue('  claude-private-key  ');
  mockFetch.mockResolvedValue({ ok: true, status: 200 });
  const screen = await render(<NetworkDiagnostics visible onClose={jest.fn()} providerId="claude-provider" baseUrl="https://claude.example/v1" api="anthropic" imageUrl="https://cdn.example/image.png" />);
  await fireEvent.press(screen.getByText('检测当前网络'));
  await waitFor(() => expect(screen.getByText('模型接口可连接')).toBeTruthy());
  expect(mockFetch).toHaveBeenCalledWith('https://claude.example/v1/models', expect.objectContaining({
    method: 'GET',
    headers: { 'x-api-key': 'claude-private-key', 'anthropic-version': '2023-06-01' },
    redirect: 'error', credentials: 'omit',
  }));
  expect(mockFetch).toHaveBeenCalledWith('https://cdn.example/image.png', expect.objectContaining({
    method: 'HEAD', headers: undefined, credentials: 'omit',
  }));
  expect(JSON.stringify(screen.toJSON())).not.toContain('claude-private-key');
});

test('can diagnose a separate image provider in automatic mode', async () => {
  mockFetch.mockResolvedValue({ ok: true, status: 200, body: { cancel: async () => undefined } });
  const screen = await render(<NetworkDiagnostics
    visible
    onClose={jest.fn()}
    providerId="chat-provider"
    baseUrl="https://chat.example/v1"
    api="responses"
    secondaryProviderId="image-provider"
    secondaryBaseUrl="https://image.example/v1"
    secondaryApi="chat-completions"
  />);
  await fireEvent.press(screen.getByText('检测当前网络'));
  await waitFor(() => expect(screen.getByText('图片 API 服务器 · image.example')).toBeTruthy());
  expect(mockGetKey).toHaveBeenCalledWith('chat-provider');
  expect(mockGetKey).toHaveBeenCalledWith('image-provider');
  expect(mockFetch).toHaveBeenCalledWith('https://image.example/v1/images/generations', expect.objectContaining({ method: 'HEAD', headers: { Authorization: 'Bearer private-key' } }));
});

test('closing diagnostics aborts the active request', async () => {
  mockFetch.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
  }));
  const onClose = jest.fn();
  const screen = await render(<NetworkDiagnostics visible onClose={onClose} providerId="provider" baseUrl="https://api.example" />);
  await fireEvent.press(screen.getByText('检测当前网络'));
  await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  await fireEvent.press(screen.getByLabelText('关闭'));
  expect(mockFetch.mock.calls[0][1].signal.aborted).toBe(true);
  expect(onClose).toHaveBeenCalledTimes(1);
});
