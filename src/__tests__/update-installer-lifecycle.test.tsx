import { launchVerifiedApkInstaller } from '../apk-installer';

const contentUri = 'content://fixture/verified.apk';

test('verified download opens the Android installer once', async () => {
  const startActivityAsync = jest.fn(async () => undefined);
  await launchVerifiedApkInstaller(async () => contentUri, async () => ({ startActivityAsync }));
  expect(startActivityAsync).toHaveBeenCalledWith('android.intent.action.INSTALL_PACKAGE', expect.objectContaining({ data: contentUri }));
  expect(startActivityAsync).toHaveBeenCalledTimes(1);
});

test('unmount cancellation during content URI resolution cannot launch a late installer', async () => {
  const controller = new AbortController(); const load = jest.fn();
  let finish!: (value: string) => void;
  const result = launchVerifiedApkInstaller(() => new Promise<string>(resolve => { finish = resolve; }), load, controller.signal);
  controller.abort(); finish(contentUri);
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  expect(load).not.toHaveBeenCalled();
});

test('cancellation during dynamic native module loading cannot launch an installer', async () => {
  const controller = new AbortController(); const startActivityAsync = jest.fn();
  await expect(launchVerifiedApkInstaller(async () => contentUri, async () => {
    controller.abort(); return { startActivityAsync };
  }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(startActivityAsync).not.toHaveBeenCalled();
});

test('cancellation after the first installer attempt prevents a late VIEW fallback', async () => {
  const controller = new AbortController();
  const startActivityAsync = jest.fn(async () => { controller.abort(); throw new Error('Old installer rejected'); });
  await expect(launchVerifiedApkInstaller(async () => contentUri, async () => ({ startActivityAsync }), controller.signal))
    .rejects.toMatchObject({ name: 'AbortError' });
  expect(startActivityAsync).toHaveBeenCalledTimes(1);
});

test('uncancelled OEM fallback still opens VIEW and retains its first error if both fail', async () => {
  const original = new Error('Original installer failure');
  const startActivityAsync = jest.fn().mockRejectedValueOnce(original).mockResolvedValueOnce(undefined);
  await launchVerifiedApkInstaller(async () => contentUri, async () => ({ startActivityAsync }));
  expect(startActivityAsync.mock.calls.map(call => call[0])).toEqual(['android.intent.action.INSTALL_PACKAGE', 'android.intent.action.VIEW']);
  startActivityAsync.mockReset().mockRejectedValueOnce(original).mockRejectedValueOnce(new Error('Fallback failure'));
  await expect(launchVerifiedApkInstaller(async () => contentUri, async () => ({ startActivityAsync }))).rejects.toBe(original);
});
