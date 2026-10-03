import type { RefObject } from 'react';
import { Platform, type View } from 'react-native';
import { captureModelBackdrop } from '../remote/model-backdrop';
const mockCapture = jest.fn();
jest.mock('react-native-view-shot', () => ({ captureRef: (...args: unknown[]) => mockCapture(...args) }));
const ref = { current: {} } as RefObject<View | null>;
beforeEach(() => { jest.useFakeTimers(); mockCapture.mockReset(); });
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test('native blur captures only local in-memory base64 pixels', async () => {
  jest.replaceProperty(Platform, 'OS', 'android'); mockCapture.mockResolvedValue('synthetic-pixels');
  expect(await captureModelBackdrop(ref)).toBe('data:image/jpeg;base64,synthetic-pixels');
  expect(mockCapture).toHaveBeenCalledWith(ref, { format: 'jpg', quality: 0.65, result: 'base64' });
  expect(jest.getTimerCount()).toBe(0);
});
test('web and absent native surfaces do not capture', async () => {
  jest.replaceProperty(Platform, 'OS', 'web'); expect(await captureModelBackdrop(ref)).toBeUndefined();
  jest.replaceProperty(Platform, 'OS', 'android'); expect(await captureModelBackdrop({ current: null })).toBeUndefined();
  expect(mockCapture).not.toHaveBeenCalled();
});
test('capture errors and empty textures use the lightweight fallback', async () => {
  jest.replaceProperty(Platform, 'OS', 'android'); mockCapture.mockRejectedValue(new Error('fixture'));
  expect(await captureModelBackdrop(ref)).toBeUndefined();
  mockCapture.mockResolvedValue(''); expect(await captureModelBackdrop(ref)).toBeUndefined();
  expect(jest.getTimerCount()).toBe(0);
});
test('a stalled capture does not hold the picker longer than 100 ms or retain a late texture', async () => {
  jest.replaceProperty(Platform, 'OS', 'android');
  let resolve!: (pixels: string) => void; mockCapture.mockReturnValue(new Promise<string>((finish) => { resolve = finish; }));
  const pending = captureModelBackdrop(ref); let finished = false; void pending.then(() => { finished = true; });
  await jest.advanceTimersByTimeAsync(99); expect(finished).toBe(false);
  await jest.advanceTimersByTimeAsync(1); expect(await pending).toBeUndefined();
  resolve('late-synthetic-pixels'); await Promise.resolve(); expect(await pending).toBeUndefined();
  expect(jest.getTimerCount()).toBe(0);
});
