import { Alert, Linking, PermissionsAndroid, Platform } from 'react-native';
import { handleSystemPermissionError, isSystemPermissionError, requestMicrophonePermission, SystemPermissionError } from '../system-permissions';

const originalOS = Platform.OS;
let alert: jest.SpyInstance, settings: jest.SpyInstance, request: jest.SpyInstance;
beforeEach(() => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
  alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  settings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
  request = jest.spyOn(PermissionsAndroid, 'request').mockResolvedValue(PermissionsAndroid.RESULTS.GRANTED);
});
afterEach(() => {
  // An Android system Back cancels the recovery prompt without opening settings.
  for (const call of alert.mock.calls) call[3]?.onDismiss?.();
  jest.restoreAllMocks();
  Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS });
});

test('only a deliberate settings action opens Settings; dismissing leaves it closed', async () => {
  const failure = new SystemPermissionError('camera', false);
  expect(handleSystemPermissionError(failure)).toBe(true);
  expect(settings).not.toHaveBeenCalled();
  const buttons = alert.mock.calls[0][2];
  buttons.find((button: { text: string }) => button.text === '暂不').onPress();
  expect(settings).not.toHaveBeenCalled();
  handleSystemPermissionError(failure);
  alert.mock.calls[1][2].find((button: { text: string }) => button.text === '去设置').onPress();
  await Promise.resolve();
  expect(settings).toHaveBeenCalledTimes(1);
  expect(request).not.toHaveBeenCalled();
});

test('one pending recovery dialog absorbs repeated failures and system Back allows a later retry', () => {
  const failure = new SystemPermissionError('photo-save', false);
  handleSystemPermissionError(failure); handleSystemPermissionError(failure);
  expect(alert).toHaveBeenCalledTimes(1);
  alert.mock.calls[0][3].onDismiss();
  handleSystemPermissionError(failure);
  expect(alert).toHaveBeenCalledTimes(2);
});

test('an ordinary denial or unrelated error does not push the user into settings', () => {
  expect(handleSystemPermissionError(new SystemPermissionError('microphone', true))).toBe(false);
  expect(handleSystemPermissionError(new Error('permission denied by server'))).toBe(false);
  expect(alert).not.toHaveBeenCalled();
});

test('an unavailable settings activity reports a manual recovery path without an unhandled rejection', async () => {
  settings.mockRejectedValueOnce(new Error('unavailable'));
  handleSystemPermissionError(new SystemPermissionError('camera', false));
  alert.mock.calls[0][2].find((button: { text: string }) => button.text === '去设置').onPress();
  await Promise.resolve(); await Promise.resolve();
  expect(alert).toHaveBeenLastCalledWith('无法打开系统设置', expect.stringContaining('应用列表'));
});

test('concurrent microphone actions share one OS request, and a later explicit retry rechecks', async () => {
  let finish!: (value: 'never_ask_again') => void;
  request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const first = requestMicrophonePermission(), second = requestMicrophonePermission();
  expect(request).toHaveBeenCalledTimes(1);
  const results = Promise.allSettled([first, second]);
  finish('never_ask_again');
  expect(await results).toEqual([
    { status: 'rejected', reason: expect.objectContaining({ permission: 'microphone', canAskAgain: false }) },
    { status: 'rejected', reason: expect.objectContaining({ permission: 'microphone', canAskAgain: false }) },
  ]);
  await expect(requestMicrophonePermission()).resolves.toBeUndefined();
  expect(request).toHaveBeenCalledTimes(2);
});

test('normal microphone denial remains retryable', async () => {
  request.mockResolvedValueOnce(PermissionsAndroid.RESULTS.DENIED);
  await expect(requestMicrophonePermission()).rejects.toMatchObject({ permission: 'microphone', canAskAgain: true });
});

test('iOS relies on native capture permission and handles only its stable rejection code', async () => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
  await requestMicrophonePermission();
  expect(request).not.toHaveBeenCalled();
  expect(isSystemPermissionError({ code: 'ERR_MIC_PERMISSION' })).toBe(true);
  expect(handleSystemPermissionError({ code: 'ERR_MIC_PERMISSION' })).toBe(true);
  expect(alert).toHaveBeenCalledWith('允许麦克风', expect.any(String), expect.any(Array), expect.any(Object));
  expect(isSystemPermissionError({ code: 'ERR_NETWORK' })).toBe(false);
});
