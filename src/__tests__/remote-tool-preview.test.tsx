import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { RemoteToolPreview } from '../remote/RemoteToolPreview';

test('direct LAN/VPN services render in an isolated inline preview', async () => {
  const view = await render(<RemoteToolPreview target={{ kind: 'local-service', url: 'http://192.168.1.8:3000/app' }} onBack={jest.fn()} />);
  const webview = view.getByTestId('remote-tool-preview-webview');
  expect(webview.props.source).toEqual({ uri: 'http://192.168.1.8:3000/app' });
  expect(webview.props.incognito).toBe(true);
  expect(webview.props.cacheEnabled).toBe(false);
  expect(webview.props.sharedCookiesEnabled).toBe(false);
  expect(webview.props.allowFileAccess).toBe(false);
  expect(webview.props.allowUniversalAccessFromFileURLs).toBe(false);
  expect(webview.props.setSupportMultipleWindows).toBe(false);
  expect(webview.props.javaScriptCanOpenWindowsAutomatically).toBe(false);
  expect(webview.props.javaScriptEnabled).toBe(true);
  expect(webview.props.domStorageEnabled).toBe(true);
  expect(String(view.getByTestId('remote-tool-preview-status').props.children)).toContain('电脑直连');
  await act(async () => { webview.props.onLoadEnd?.(); });
  expect(String(view.getByTestId('remote-tool-preview-status').props.children)).toContain('可交互');
  expect(view.queryByLabelText('在手机浏览器打开局域网服务')).toBeNull();
});

test('localhost is kept as a desktop-only address and never mounted in WebView', async () => {
  const view = await render(<RemoteToolPreview target={{ kind: 'local-service', url: 'http://localhost:5173/' }} onBack={jest.fn()} />);
  expect(view.queryByTestId('remote-tool-preview-webview')).toBeNull();
  expect(view.getByLabelText('在手机浏览器打开局域网服务')).toBeTruthy();
  expect(view.getByText(/手机无法直接访问/)).toBeTruthy();
});

test('public websites stay in the system browser instead of an embedded surface', async () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  const view = await render(<RemoteToolPreview target={{ kind: 'web', url: 'https://example.com/docs' }} onBack={jest.fn()} />);
  expect(view.queryByTestId('remote-tool-preview-webview')).toBeNull();
  await fireEvent.press(view.getByLabelText('在浏览器打开网页'));
  expect(open).toHaveBeenCalledWith('https://example.com/docs');
  open.mockRestore();
});

test('inline navigation only permits the original HTTP(S) origin', async () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  const view = await render(<RemoteToolPreview target={{ kind: 'local-service', url: 'http://10.8.0.4:4173/' }} onBack={jest.fn()} />);
  const webview = view.getByTestId('remote-tool-preview-webview');
  const allow = webview.props.onShouldStartLoadWithRequest as (request: { url: string }) => boolean;
  expect(allow({ url: 'http://10.8.0.4:4173/settings' })).toBe(true);
  expect(allow({ url: 'https://10.8.0.4:4173/settings' })).toBe(false);
  expect(allow({ url: 'http://192.168.1.9:4173/private' })).toBe(false);
  expect(allow({ url: 'https://example.com/' })).toBe(false);
  expect(open).toHaveBeenCalledWith('https://example.com/');
  open.mockRestore();
});

test('a failed inline preview keeps a browser fallback without changing the target', async () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  const view = await render(<RemoteToolPreview target={{ kind: 'local-service', url: 'http://192.168.1.8:3000/' }} onBack={jest.fn()} />);
  await act(async () => { view.getByTestId('remote-tool-preview-webview').props.onError?.({ nativeEvent: { description: 'offline' } }); });
  expect(view.queryByTestId('remote-tool-preview-webview')).toBeNull();
  expect(String(view.getByTestId('remote-tool-preview-status').props.children)).toContain('无法加载');
  await fireEvent.press(view.getByLabelText('在手机浏览器打开局域网服务'));
  expect(open).toHaveBeenCalledWith('http://192.168.1.8:3000/');
  open.mockRestore();
});

test('changing the target retires a previous failed load state', async () => {
  const view = await render(<RemoteToolPreview target={{ kind: 'local-service', url: 'http://192.168.1.8:3000/' }} onBack={jest.fn()} />);
  await act(async () => { view.getByTestId('remote-tool-preview-webview').props.onError?.({ nativeEvent: { description: 'offline' } }); });
  expect(view.queryByTestId('remote-tool-preview-webview')).toBeNull();
  await view.rerender(<RemoteToolPreview target={{ kind: 'local-service', url: 'http://10.8.0.4:4173/' }} onBack={jest.fn()} />);
  expect(view.getByTestId('remote-tool-preview-webview')).toBeTruthy();
  expect(String(view.getByTestId('remote-tool-preview-status').props.children)).toContain('正在加载');
});

test('callbacks from a retired WebView cannot change the new target state', async () => {
  const view = await render(<RemoteToolPreview target={{ kind: 'local-service', url: 'http://192.168.1.8:3000/' }} onBack={jest.fn()} />);
  const oldWebView = view.getByTestId('remote-tool-preview-webview');
  const oldOnError = oldWebView.props.onError;
  await view.rerender(<RemoteToolPreview target={{ kind: 'local-service', url: 'http://10.8.0.4:4173/' }} onBack={jest.fn()} />);
  const nextWebView = view.getByTestId('remote-tool-preview-webview');
  expect(String(view.getByTestId('remote-tool-preview-status').props.children)).toContain('正在加载');
  await act(async () => { oldOnError?.({ nativeEvent: { description: 'stale offline' } }); });
  expect(String(view.getByTestId('remote-tool-preview-status').props.children)).toContain('正在加载');
  await act(async () => { nextWebView.props.onLoadEnd?.(); });
  expect(String(view.getByTestId('remote-tool-preview-status').props.children)).toContain('可交互');
});
