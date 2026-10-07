import { command, setHubFetch, type FetchLike } from '../remote/client';

afterEach(() => { setHubFetch(null); jest.useRealTimers(); });

test.each(['socket', 'body'])('read budget terminates an ignored abort in the %s within thirty seconds', async stage => {
  jest.useFakeTimers();
  let calls = 0;
  setHubFetch((async () => {
    calls += 1;
    if (stage === 'socket') return new Promise(() => undefined);
    return { ok: true, status: 200, text: () => new Promise(() => undefined) };
  }) as FetchLike);
  const read = command({ url: 'https://fixture.example/salcara-hub/v1' }, 'pc', { type: 'sessions.list', tool: 'codex', limit: 10 });
  const outcome = read.then(() => 'unexpected success', error => error.message);
  await jest.advanceTimersByTimeAsync(30_000);
  expect(await outcome).toMatch(/超时/);
  expect(calls).toBe(2); expect(jest.getTimerCount()).toBe(0);
});

test('cancelled reads do not issue a new command even if the native transport ignores its abort', async () => {
  let calls = 0;
  setHubFetch((async () => { calls += 1; return new Promise(() => undefined); }) as FetchLike);
  const controller = new AbortController();
  const read = command({ url: 'https://fixture.example/salcara-hub/v1' }, 'pc', { type: 'sessions.list', limit: 10 }, undefined, controller.signal);
  const outcome = read.then(() => 'unexpected success', error => error.code);
  await Promise.resolve(); controller.abort();
  expect(await outcome).toBe('aborted'); expect(calls).toBeLessThanOrEqual(1);
});

test.each(['before', 'immediately'])('a request cancelled %s dispatch never starts the transport', async timing => {
  let calls = 0;
  setHubFetch((async () => { calls += 1; return new Promise(() => undefined); }) as FetchLike);
  const controller = new AbortController();
  if (timing === 'before') controller.abort();
  const read = command({ url: 'https://fixture.example/salcara-hub/v1' }, 'pc', { type: 'sessions.list', limit: 10 }, undefined, controller.signal);
  const outcome = read.then(() => 'unexpected success', error => error.code);
  if (timing === 'immediately') controller.abort();
  expect(await outcome).toBe('aborted'); expect(calls).toBe(0);
});

test('task writes retain their original delivery timeout and are never automatically retried', async () => {
  jest.useFakeTimers(); let calls = 0;
  setHubFetch((async () => { calls += 1; return new Promise(() => undefined); }) as FetchLike);
  const write = command({ url: 'https://fixture.example/salcara-hub/v1' }, 'pc', { type: 'session.send', sessionKey: 'codex:fixture', text: 'fixture', controlSurface: 'cli' });
  const outcome = write.then(() => 'unexpected success', error => error.message);
  await jest.advanceTimersByTimeAsync(55_000);
  expect(await outcome).toMatch(/超时/); expect(calls).toBe(1);
});
