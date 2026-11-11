import { launchVerifiedApkInstaller } from '../apk-installer';

const contentUri = 'content://fixture/verified.apk';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

const pendingStages = ['uri', 'loader', 'install', 'fallback'] as const;
const lateOutcomes = ['resolve', 'reject'] as const;

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

test('an already cancelled installation does not resolve a URI or load native code', async () => {
  const controller = new AbortController(); controller.abort();
  const resolveUri = jest.fn(), load = jest.fn();
  await expect(launchVerifiedApkInstaller(resolveUri, load, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(resolveUri).not.toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();
});

test.each(pendingStages.flatMap(stage => lateOutcomes.map(lateOutcome => ({ stage, lateOutcome }))))(
  '$stage ignoring cancellation settles on abort before a late $lateOutcome, without another intent',
  async ({ stage, lateOutcome }) => {
    const controller = new AbortController();
    const entered = deferred<void>(), blocked = deferred<unknown>();
    const waitWithoutSignal = () => { entered.resolve(); return blocked.promise; };
    const firstFailure = new Error('OEM INSTALL_PACKAGE unavailable');
    const startActivityAsync = jest.fn((action: string) => {
      if (stage === 'install' || stage === 'fallback' && action === 'android.intent.action.VIEW') return waitWithoutSignal();
      if (stage === 'fallback') return Promise.reject(firstFailure);
      return Promise.resolve(undefined);
    });
    const installer = { startActivityAsync };
    const resolveUri = jest.fn(() => stage === 'uri' ? waitWithoutSignal() as Promise<string> : Promise.resolve(contentUri));
    const load = jest.fn(() => stage === 'loader' ? waitWithoutSignal() as Promise<typeof installer> : Promise.resolve(installer));
    const result = launchVerifiedApkInstaller(resolveUri, load, controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await entered.promise;
    controller.abort();
    // The native promise deliberately remains pending until AFTER this await.
    // Waiting only for its eventual result would hang the update UI here.
    await rejected;
    const expectedIntents = stage === 'fallback' ? 2 : stage === 'install' ? 1 : 0;
    expect(startActivityAsync).toHaveBeenCalledTimes(expectedIntents);
    expect(load).toHaveBeenCalledTimes(stage === 'uri' ? 0 : 1);
    if (lateOutcome === 'reject') blocked.reject(new Error('Late native failure'));
    else blocked.resolve(stage === 'uri' ? contentUri : stage === 'loader' ? installer : undefined);
    // Drain late native continuations: neither success nor failure may reopen
    // the installer or fall back to VIEW after the caller has cancelled.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(startActivityAsync).toHaveBeenCalledTimes(expectedIntents);
    expect(load).toHaveBeenCalledTimes(stage === 'uri' ? 0 : 1);
  },
);
