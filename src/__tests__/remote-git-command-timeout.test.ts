import { command, setHubFetch, type Command, type FetchLike } from '../remote/client';

const hub = { url: 'https://fixture.example/salcara-hub/v1', deviceId: 'pc', pairToken: 'paired' };
const selection = { sessionKey: 'codex:fixture', controlSurface: 'cli' as const, expectedCwd: '/workspace' };
const response = { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { completed: true } }) };

beforeEach(() => jest.useFakeTimers());
afterEach(() => { setHubFetch(null); jest.useRealTimers(); });

test.each(['status', 'diff', 'staged-diff', 'review', 'repositories'] as const)(
  'Hub Git %s can finish after the ordinary read budget without restarting the operation', async action => {
    const fetch = jest.fn(async (_url: string, _init: Record<string, unknown>) => new Promise(resolve => setTimeout(() => resolve(response), 94_000)));
    setHubFetch(fetch as FetchLike);
    const pending = command(hub, 'pc', { type: 'workspace.git.read', ...selection, action, repositoryPath: 'mobile' });
    const outcome = pending.then(value => value, error => error);
    await jest.advanceTimersByTimeAsync(94_000);
    expect(await outcome).toEqual({ completed: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).command.repositoryPath).toBe('mobile');
  },
);

test.each(['read', 'mutate'] as const)('Git %s stops within one hundred seconds and never replays an uncertain mutation', async kind => {
  const fetch = jest.fn(async () => new Promise(() => undefined));
  setHubFetch(fetch as FetchLike);
  const cmd: Command = kind === 'read'
    ? { type: 'workspace.git.read', ...selection, action: 'review', reviewScope: 'unstaged' }
    : { type: 'workspace.git.mutate', ...selection, action: 'stage', path: 'main.ts', expectedRevision: 'a'.repeat(64) };
  const pending = command(hub, 'pc', cmd);
  let settled = false;
  const outcome = pending.then(() => 'unexpected success', error => error.message).finally(() => { settled = true; });
  await jest.advanceTimersByTimeAsync(99_999);
  expect(settled).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
  expect(await outcome).toMatch(/超时/);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

test('Git retries share their hundred-second budget and cancellation remains immediate', async () => {
  const fetch = jest.fn(async () => new Promise(() => undefined));
  fetch.mockImplementationOnce(async () => { throw new Error('connection replaced'); });
  setHubFetch(fetch as FetchLike);
  const pending = command(hub, 'pc', { type: 'workspace.git.read', ...selection, action: 'repositories' });
  const outcome = pending.then(() => 'unexpected success', error => error.message);
  await jest.advanceTimersByTimeAsync(100_000);
  expect(await outcome).toMatch(/超时/);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(jest.getTimerCount()).toBe(0);

  const controller = new AbortController();
  const cancelled = command(hub, 'pc', { type: 'workspace.git.read', ...selection, action: 'status' }, undefined, controller.signal);
  const cancellation = cancelled.catch(error => error.code);
  await jest.advanceTimersByTimeAsync(0);
  controller.abort();
  expect(await cancellation).toBe('aborted');
  expect(jest.getTimerCount()).toBe(0);
});
