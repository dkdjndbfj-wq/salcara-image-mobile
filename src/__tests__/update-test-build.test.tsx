import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { File } from 'expo-file-system';
import { Platform } from 'react-native';

const mockFetchLatestRelease = jest.fn();
jest.mock('expo-application', () => ({
  applicationId: 'top.salcara.image.remotetest',
  nativeApplicationVersion: '1.7.0',
}));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({ getContentUriAsync: jest.fn() }));
jest.mock('expo-file-system', () => ({
  File: Object.assign(jest.fn(), { downloadFileAsync: jest.fn() }),
  Paths: { cache: 'file:///test-cache' },
}));
jest.mock('../update', () => ({
  ...jest.requireActual('../update'),
  fetchLatestRelease: (...args: unknown[]) => mockFetchLatestRelease(...args),
}));
jest.mock('../api/network', () => ({ networkFailureMessage: jest.fn() }));
jest.mock('../components/ui', () => {
  const ReactModule = require('react');
  const { Text, View, Pressable } = require('react-native');
  return {
    AppDialog: ({ visible, title, message, actions }: {
      visible: boolean; title: string; message: string;
      actions: Array<{ label: string; onPress?: () => void }>;
    }) => !visible ? null : ReactModule.createElement(View, null,
      ReactModule.createElement(Text, null, title),
      ReactModule.createElement(Text, null, message),
      ...actions.map((action) => ReactModule.createElement(Pressable, { key: action.label, onPress: action.onPress },
        ReactModule.createElement(Text, null, action.label))),
    ),
  };
});

import { UpdateManager } from '../components/UpdateManager';

const originalOS = Platform.OS;
beforeEach(() => {
  jest.useFakeTimers();
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
  mockFetchLatestRelease.mockClear();
  jest.mocked(File.downloadFileAsync).mockClear();
});
afterEach(() => {
  jest.useRealTimers();
  Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS });
});

test('the isolated test APK never silently queries production updates or downloads an APK', async () => {
  const screen = await render(<UpdateManager manualCheckToken={0} />);
  await act(async () => { jest.advanceTimersByTime(60_000); });
  expect(screen.toJSON()).toBeNull();
  expect(mockFetchLatestRelease).not.toHaveBeenCalled();
  expect(File.downloadFileAsync).not.toHaveBeenCalled();
});

test('manual update checks only explain test artifacts and never start a production download', async () => {
  const screen = await render(<UpdateManager manualCheckToken={1} />);
  expect(screen.getByText('独立远程测试版')).toBeTruthy();
  expect(screen.getByText(/测试版不检查或安装正式版更新/)).toBeTruthy();
  await fireEvent.press(screen.getByText('知道了'));
  expect(screen.toJSON()).toBeNull();
  await screen.rerender(<UpdateManager manualCheckToken={2} />);
  expect(screen.getByText('独立远程测试版')).toBeTruthy();
  expect(mockFetchLatestRelease).not.toHaveBeenCalled();
  expect(File.downloadFileAsync).not.toHaveBeenCalled();
});
