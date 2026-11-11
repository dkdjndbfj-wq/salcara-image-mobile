import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { AppState, Platform } from 'react-native';

const mockCheck = jest.fn();
const mockDownload = jest.fn();
const mockVerify = jest.fn();
const mockLaunch = jest.fn();
const mockSettings = jest.fn();
const mockMove = jest.fn();
const mockFiles = new Map<string, number>();
const mockIndexes = new Map<string, string>();
jest.mock('expo-application', () => ({ applicationId: 'top.salcara.image', nativeApplicationVersion: '1.8.3' }));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({ getContentUriAsync: jest.fn() }));
jest.mock('expo-file-system', () => {
  class FakeFile {
    uri: string;
    constructor(...parts: string[]) { this.uri = parts.join('/'); }
    get exists() { return mockFiles.has(this.uri) || mockIndexes.has(this.uri); }
    get size() { return mockFiles.get(this.uri) ?? 0; }
    get contentUri() { return `content://fixture/${this.uri.split('/').pop()}`; }
    open() { return { readBytes: () => new Uint8Array(), close: jest.fn() }; }
    delete() { mockFiles.delete(this.uri); mockIndexes.delete(this.uri); }
    textSync() { return mockIndexes.get(this.uri) ?? ''; }
    write(value: string) { mockIndexes.set(this.uri, value); }
    move(target: FakeFile) { return mockMove(this, target); }
    static downloadFileAsync(...args: unknown[]) { return mockDownload(...args); }
  }
  return { File: FakeFile, Paths: { cache: 'file:///update-cache' } };
});
jest.mock('../update', () => ({ ...jest.requireActual('../update'), fetchLatestRelease: (...args: unknown[]) => mockCheck(...args) }));
jest.mock('../apk-download', () => ({
  ...jest.requireActual('../apk-download'),
  apkFileStream: jest.fn(() => ({})),
  verifyDownloadedApk: (...args: unknown[]) => mockVerify(...args),
}));
jest.mock('../apk-installer', () => ({
  launchVerifiedApkInstaller: (...args: unknown[]) => mockLaunch(...args),
  loadAndroidUpdateInstaller: async () => ({
    ActivityAction: { MANAGE_UNKNOWN_APP_SOURCES: 'settings' },
    startActivityAsync: (...args: unknown[]) => mockSettings(...args),
  }),
}));
jest.mock('../components/ui', () => {
  const React = require('react');
  const { Text, View, Pressable } = require('react-native');
  return {
    BrandFill: () => null,
    AppDialog: ({ visible, title, message, actions, children, dismissible = true, onClose }: any) => !visible ? null : React.createElement(View, {
      testID: 'update-dialog', onRequestClose: () => { if (dismissible) onClose(); },
    },
      React.createElement(Text, null, title), React.createElement(Text, null, message), children,
      ...actions.map((action: any) => React.createElement(Pressable, { testID: 'update-action', key: action.label, onPress: action.onPress, disabled: action.disabled },
        React.createElement(Text, null, action.label)))),
  };
});
jest.mock('../components/Skeleton', () => ({ Skeleton: () => null, SkeletonGroup: () => null }));

import { UpdateManager } from '../components/UpdateManager';

const release = {
  version: '1.8.4', tagName: 'v1.8.4', title: 'Salcara', notes: 'Updates', pageUrl: 'https://github.com/release',
  publishedAt: '2026-11-10T03:10:51Z',
  apk: { name: 'salcara-image-android-v1.8.4.apk', url: 'https://github.com/release.apk', size: 100, digest: `sha256:${'a'.repeat(64)}` },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const originalOS = Platform.OS;
let resume: ((state: string) => void) | undefined;
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-11-10T12:00:00Z'));
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    resume = listener as typeof resume;
    return { remove: jest.fn() };
  });
  mockFiles.clear();
  mockIndexes.clear();
  mockMove.mockReset().mockImplementation(async (file, target) => {
    mockFiles.set(target.uri, file.size);
    mockFiles.delete(file.uri);
    file.uri = target.uri;
  });
  mockCheck.mockReset().mockResolvedValue(release);
  mockVerify.mockReset().mockResolvedValue(undefined);
  mockLaunch.mockReset().mockResolvedValue(undefined);
  mockSettings.mockReset().mockResolvedValue(undefined);
  mockDownload.mockReset().mockImplementation(async (_url, file, options) => {
    mockFiles.set(file.uri, release.apk.size);
    options.onProgress({ bytesWritten: 100, totalBytes: 100 });
    return file;
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS });
});

test('a check that ignores cancellation times out and can be checked again', async () => {
  mockCheck.mockImplementationOnce(() => new Promise(() => undefined));
  const screen = await render(<UpdateManager manualCheckToken={1} />);
  expect(screen.getByText('正在检查更新')).toBeTruthy();
  await act(async () => { await jest.advanceTimersByTimeAsync(12_000); });
  expect(screen.getByText('更新没有完成')).toBeTruthy();
  expect(screen.queryByText('再次下载')).toBeNull();
  expect(screen.getAllByTestId('update-action')).toHaveLength(1);
  await fireEvent.press(screen.getByText('重新检查'));
  expect(screen.getByText('发现新版本 v1.8.4')).toBeTruthy();
});

test('closing a pending check cancels it and its late result cannot reopen the dialog', async () => {
  const pending = deferred<typeof release>();
  mockCheck.mockReturnValueOnce(pending.promise);
  const screen = await render(<UpdateManager manualCheckToken={1} />);
  const signal = mockCheck.mock.calls[0][0];
  await fireEvent.press(screen.getByText('取消检查'));
  expect(signal.aborted).toBe(true);
  await act(async () => { pending.resolve(release); });
  expect(screen.toJSON()).toBeNull();
});

test('a non-cooperative download can be cancelled; late completion cannot touch the retry file', async () => {
  const pending = deferred<any>();
  let oldFile: any;
  mockDownload.mockImplementationOnce((_url, file) => { oldFile = file; return pending.promise; });
  const screen = await render(<UpdateManager manualCheckToken={1} />);
  await fireEvent.press(screen.getByText('应用内下载'));
  await fireEvent(screen.getByTestId('update-dialog'), 'requestClose');
  expect(screen.getByText('正在下载更新')).toBeTruthy();
  await fireEvent.press(screen.getByText('取消下载'));
  expect(screen.getByText('发现新版本 v1.8.4')).toBeTruthy();
  await fireEvent.press(screen.getByText('应用内下载'));
  expect(screen.getByText('安装包已准备好')).toBeTruthy();
  const verifiedPaths = [...mockFiles.keys()];
  expect(verifiedPaths).toHaveLength(1);
  expect(verifiedPaths[0]).not.toBe(oldFile.uri);
  await act(async () => { mockFiles.set(oldFile.uri, 100); pending.resolve(oldFile); });
  expect([...mockFiles.keys()]).toEqual(verifiedPaths);
  expect(mockLaunch).toHaveBeenCalledTimes(1);
});

test('stalled mirror advances; duplicate progress does not extend its idle deadline', async () => {
  let report!: (progress: { bytesWritten: number; totalBytes: number }) => void;
  mockDownload.mockImplementationOnce((_url, _file, options) => { report = options.onProgress; return new Promise(() => undefined); });
  const screen = await render(<UpdateManager manualCheckToken={1} />);
  await fireEvent.press(screen.getByText('应用内下载'));
  await act(async () => {
    report({ bytesWritten: 1, totalBytes: 100 });
    await jest.advanceTimersByTimeAsync(60_000);
    report({ bytesWritten: 1, totalBytes: 100 });
    await jest.advanceTimersByTimeAsync(30_001);
  });
  expect(mockDownload).toHaveBeenCalledTimes(2);
  expect(screen.getByText('安装包已准备好')).toBeTruthy();
});

test('verification is a separate cancellable stage; a late verify cannot launch installation', async () => {
  const pending = deferred<void>();
  mockVerify.mockReturnValueOnce(pending.promise);
  const screen = await render(<UpdateManager manualCheckToken={1} />);
  await fireEvent.press(screen.getByText('应用内下载'));
  expect(screen.getByText('正在校验安装包')).toBeTruthy();
  await fireEvent.press(screen.getByText('取消校验'));
  await act(async () => { pending.resolve(); });
  expect(screen.getByText('发现新版本 v1.8.4')).toBeTruthy();
  expect(mockLaunch).not.toHaveBeenCalled();
  expect(mockFiles.size).toBe(0);
});

test('pending installer returns to a reusable verified package without another download', async () => {
  const pending = deferred<void>();
  mockLaunch.mockReturnValueOnce(pending.promise);
  const screen = await render(<UpdateManager manualCheckToken={1} />);
  await fireEvent.press(screen.getByText('应用内下载'));
  expect(screen.getByText('请在系统中完成安装')).toBeTruthy();
  await act(async () => { await jest.advanceTimersByTimeAsync(30_000); });
  expect(screen.getByText('安装包已准备好')).toBeTruthy();
  await fireEvent.press(screen.getByText('继续安装'));
  expect(mockDownload).toHaveBeenCalledTimes(1);
  expect(mockLaunch).toHaveBeenCalledTimes(2);
  await act(async () => { pending.reject(new Error('late native error')); });
  expect(screen.getByText('安装包已准备好')).toBeTruthy();
});

test('available and ready have one main action; system back preserves a verified package for reuse', async () => {
  const screen = await render(<UpdateManager manualCheckToken={1} />);
  expect(screen.getAllByTestId('update-action')).toHaveLength(1);
  expect(screen.queryByText('稍后')).toBeNull();
  await fireEvent.press(screen.getByText('应用内下载'));
  expect(screen.getAllByTestId('update-action')).toHaveLength(1);
  expect(screen.getByLabelText('安装权限')).toBeTruthy();
  const verifiedFiles = [...mockFiles.keys()];
  await fireEvent(screen.getByTestId('update-dialog'), 'requestClose');
  expect(screen.toJSON()).toBeNull();
  expect([...mockFiles.keys()]).toEqual(verifiedFiles);
  await screen.rerender(<UpdateManager manualCheckToken={2} />);
  await fireEvent.press(screen.getByText('应用内下载'));
  expect(mockDownload).toHaveBeenCalledTimes(1);
  expect(mockLaunch).toHaveBeenCalledTimes(2);
});

test('download failure offers only retry and can be dismissed with system back', async () => {
  mockDownload.mockRejectedValue(new Error('offline'));
  const screen = await render(<UpdateManager manualCheckToken={1} />);
  await fireEvent.press(screen.getByText('应用内下载'));
  expect(screen.getAllByTestId('update-action')).toHaveLength(1);
  expect(screen.getByText('再次下载')).toBeTruthy();
  expect(screen.queryByText('重新检查')).toBeNull();
  expect(screen.queryByText('关闭')).toBeNull();
  await fireEvent(screen.getByTestId('update-dialog'), 'requestClose');
  expect(screen.toJSON()).toBeNull();
});

test('system back leaves a pending installer without deleting the verified package or accepting late completion', async () => {
  const pending = deferred<void>();
  mockLaunch.mockReturnValueOnce(pending.promise);
  const screen = await render(<UpdateManager manualCheckToken={1} />);
  await fireEvent.press(screen.getByText('应用内下载'));
  const verifiedFiles = [...mockFiles.keys()];
  await fireEvent(screen.getByTestId('update-dialog'), 'requestClose');
  await act(async () => { pending.resolve(); });
  expect(screen.toJSON()).toBeNull();
  expect([...mockFiles.keys()]).toEqual(verifiedFiles);
});

test('dismissed permission settings cannot trigger a late installer or reopen the dialog', async () => {
  const pending = deferred<void>();
  mockSettings.mockReturnValueOnce(pending.promise);
  const screen = await render(<UpdateManager manualCheckToken={1} />);
  await fireEvent.press(screen.getByText('应用内下载'));
  await fireEvent.press(screen.getByLabelText('安装权限'));
  expect(screen.getByText('请在系统中允许安装')).toBeTruthy();
  await fireEvent(screen.getByTestId('update-dialog'), 'requestClose');
  await act(async () => { pending.resolve(); });
  expect(screen.toJSON()).toBeNull();
  expect(mockLaunch).toHaveBeenCalledTimes(1);
});

test('foreground resume cannot start a new check during download, and unmount prevents a late install', async () => {
  const pending = deferred<any>();
  let file: any;
  mockDownload.mockImplementationOnce((_url, target) => { file = target; return pending.promise; });
  const screen = await render(<UpdateManager manualCheckToken={1} />);
  await fireEvent.press(screen.getByText('应用内下载'));
  await act(async () => { jest.setSystemTime(Date.now() + 7 * 60 * 60_000); resume?.('active'); });
  expect(mockCheck).toHaveBeenCalledTimes(1);
  await screen.unmount();
  await act(async () => { mockFiles.set(file.uri, 100); pending.resolve(file); });
  expect(mockLaunch).not.toHaveBeenCalled();
  expect(mockFiles.size).toBe(0);
});

test('overall download deadline stops a never-ending download even when bytes keep arriving', async () => {
  let report!: (progress: { bytesWritten: number; totalBytes: number }) => void;
  mockDownload.mockImplementationOnce((_url, _file, options) => { report = options.onProgress; return new Promise(() => undefined); });
  const screen = await render(<UpdateManager manualCheckToken={1} />);
  await fireEvent.press(screen.getByText('应用内下载'));
  await act(async () => {
    for (let minute = 1; minute <= 9; minute += 1) {
      await jest.advanceTimersByTimeAsync(60_000);
      report({ bytesWritten: minute, totalBytes: 100 });
    }
    await jest.advanceTimersByTimeAsync(60_001);
  });
  expect(screen.getByText('更新没有完成')).toBeTruthy();
  expect(screen.getByText(/下载超过 10 分钟/)).toBeTruthy();
  expect(mockDownload).toHaveBeenCalledTimes(1);
  expect(mockLaunch).not.toHaveBeenCalled();
});

test('a changed package on every mirror is never exposed to the installer', async () => {
  mockVerify.mockRejectedValue(new Error('更新包 SHA-256 校验失败，已停止安装'));
  const screen = await render(<UpdateManager manualCheckToken={1} />);
  await fireEvent.press(screen.getByText('应用内下载'));
  expect(screen.getByText('更新没有完成')).toBeTruthy();
  expect(screen.getByText(/SHA-256 校验失败/)).toBeTruthy();
  expect(mockFiles.size).toBe(0);
  expect(mockLaunch).not.toHaveBeenCalled();
});

test('a verification that ignores cancellation times out without being installed', async () => {
  mockVerify.mockImplementation(() => new Promise(() => undefined));
  const screen = await render(<UpdateManager manualCheckToken={1} />);
  await fireEvent.press(screen.getByText('应用内下载'));
  await act(async () => { await jest.advanceTimersByTimeAsync(240_001); });
  expect(screen.getByText('更新没有完成')).toBeTruthy();
  expect(screen.getByText(/校验超时/)).toBeTruthy();
  expect(mockLaunch).not.toHaveBeenCalled();
  expect(mockFiles.size).toBe(0);
});

test('permission settings returning from background retain the package and require an explicit install tap', async () => {
  const pending = deferred<void>();
  mockSettings.mockReturnValueOnce(pending.promise);
  const screen = await render(<UpdateManager manualCheckToken={1} />);
  await fireEvent.press(screen.getByText('应用内下载'));
  await fireEvent.press(screen.getByLabelText('安装权限'));
  await act(async () => { resume?.('background'); resume?.('active'); pending.resolve(); });
  expect(screen.getByText('安装包已准备好')).toBeTruthy();
  expect(mockLaunch).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByText('继续安装'));
  expect(mockLaunch).toHaveBeenCalledTimes(2);
  expect(mockDownload).toHaveBeenCalledTimes(1);
});

test('a native file move that ignores cancellation cannot lock retries or delete their final package', async () => {
  const pending = deferred<void>();
  let oldFinal: string;
  mockMove.mockImplementationOnce((_file, target) => { oldFinal = target.uri; return pending.promise; });
  const screen = await render(<UpdateManager manualCheckToken={1} />);
  await fireEvent.press(screen.getByText('应用内下载'));
  await fireEvent.press(screen.getByText('取消校验'));
  await fireEvent.press(screen.getByText('应用内下载'));
  expect(screen.getByText('安装包已准备好')).toBeTruthy();
  const retryFile = [...mockFiles.keys()][0];
  await act(async () => { mockFiles.set(oldFinal!, 100); pending.resolve(); });
  expect([...mockFiles.keys()]).toEqual([retryFile]);
  expect(mockDownload).toHaveBeenCalledTimes(2);
  expect(mockLaunch).toHaveBeenCalledTimes(1);
});

test('a hung native file move times out and a later mirror can complete', async () => {
  const pending = deferred<void>();
  let oldFinal!: string;
  mockMove.mockImplementationOnce((_file, target) => { oldFinal = target.uri; return pending.promise; });
  const screen = await render(<UpdateManager manualCheckToken={1} />);
  await fireEvent.press(screen.getByText('应用内下载'));
  await act(async () => { await jest.advanceTimersByTimeAsync(15_001); });
  expect(screen.getByText('安装包已准备好')).toBeTruthy();
  expect(mockDownload).toHaveBeenCalledTimes(2);
  expect(mockLaunch).toHaveBeenCalledTimes(1);
  const retryFile = [...mockFiles.keys()][0];
  await act(async () => { mockFiles.set(oldFinal, 100); pending.resolve(); });
  expect([...mockFiles.keys()]).toEqual([retryFile]);
});

test('remounting reuses the indexed APK only after verifying it again', async () => {
  const first = await render(<UpdateManager manualCheckToken={1} />);
  await fireEvent.press(first.getByText('应用内下载'));
  const originalFile = [...mockFiles.keys()][0];
  await first.unmount();
  const second = await render(<UpdateManager manualCheckToken={1} />);
  await fireEvent.press(second.getByText('应用内下载'));
  expect(second.getByText('安装包已准备好')).toBeTruthy();
  expect([...mockFiles.keys()]).toEqual([originalFile]);
  expect(mockVerify).toHaveBeenCalledTimes(2);
  expect(mockDownload).toHaveBeenCalledTimes(1);
});

test('corrupted cached bytes are removed and downloaded again before installation', async () => {
  const first = await render(<UpdateManager manualCheckToken={1} />);
  await fireEvent.press(first.getByText('应用内下载'));
  const corrupt = [...mockFiles.keys()][0];
  await first.unmount();
  mockVerify.mockRejectedValueOnce(new Error('更新包 SHA-256 校验失败'));
  const second = await render(<UpdateManager manualCheckToken={1} />);
  await fireEvent.press(second.getByText('应用内下载'));
  expect(second.getByText('安装包已准备好')).toBeTruthy();
  expect(mockFiles.has(corrupt)).toBe(false);
  expect(mockDownload).toHaveBeenCalledTimes(2);
  expect(mockLaunch).toHaveBeenCalledTimes(2);
});

test.each(['../private.apk', '/private.apk', 'salcara-image-update-1.8.4-1-1.apk/../../../private.apk'])(
  'cache index cannot point outside this updater: %s', async name => {
    mockIndexes.set('file:///update-cache/salcara-image-update-1.8.4.json', JSON.stringify({
      version: release.version, digest: release.apk.digest, size: release.apk.size, name,
    }));
    const screen = await render(<UpdateManager manualCheckToken={1} />);
    await fireEvent.press(screen.getByText('应用内下载'));
    expect(mockDownload).toHaveBeenCalledTimes(1);
    expect(mockVerify).toHaveBeenCalledTimes(1);
  },
);
