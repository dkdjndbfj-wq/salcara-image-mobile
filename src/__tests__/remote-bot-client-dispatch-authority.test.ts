import {
  acknowledgeOperation, acknowledgeSessionEvents, command, openStream, setHubFetch,
  type Command, type FetchLike, type Hub, type StreamState,
} from '../remote/client';
import { botStationFixture } from './fixtures/bot-station';

jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID(), getRandomBytes: (size: number) => new Uint8Array(require('node:crypto').randomBytes(size)) }));

const canonical = 'https://bot-dispatch-authority.example/salcara-hub/v1';
const station = botStationFixture(canonical);
const token = 'a'.repeat(64), deviceId = 'pc';
const requestId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const write: Command = { type: 'agents.api.set', agent: 'claude', accountId: 'configured-api', model: 'configured-model' };
const ticket = { operationId: requestId, ticket: 'saved-receipt-ticket', dispatchNotAfter: Date.now() + 60_000, storageEpoch: 'saved-epoch' };
const bot = (fields: Partial<Hub> = {}): Hub => ({ url: canonical, botToken: token, botPin: station.pin, deviceId, ...fields });
const reply = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
type RecordedRequest = { url: string; init: Parameters<FetchLike>[1] };
function recordAuthority(implementation: NonNullable<Hub['authorizeDispatch']>) {
  const calls = jest.fn();
  const authorize: NonNullable<Hub['authorizeDispatch']> = async <T,>(dispatch: () => T) => {
    calls(); return implementation(dispatch);
  };
  return { authorize, calls };
}
function installTransport(options: { pingGate?: ReturnType<typeof deferred<void>>; onPing?: () => void; business?: FetchLike } = {}) {
  const sent: RecordedRequest[] = [];
  let paused = false;
  setHubFetch(station.wrap(async (url, init) => {
    if (url.endsWith('/ping')) {
      expect(init.headers).not.toHaveProperty('X-Salcara-Bot-Token');
      if (!paused && options.pingGate) {
        paused = true; options.onPing?.(); await options.pingGate.promise;
      }
      return reply(station.discovery);
    }
    sent.push({ url, init });
    expect(init.headers).toMatchObject({ 'X-Salcara-Bot-Token': token });
    expect(init.headers).not.toHaveProperty('X-Salcara-Pair-Token');
    return options.business ? options.business(url, init) : reply({ ok: true, result: { recorded: true } });
  }), true);
  return sent;
}

afterEach(() => { setHubFetch(null); jest.restoreAllMocks(); jest.useRealTimers(); });

const requests: Array<{ name: string; invoke: (hub: Hub) => Promise<unknown>; path: string; body: Record<string, unknown> }> = [
  { name: 'ordinary read command', invoke: hub => command(hub, deviceId, { type: 'agents.status' }), path: '/app/commands', body: { deviceId, command: { type: 'agents.status' } } },
  { name: 'API configuration write', invoke: hub => command(hub, deviceId, write, requestId), path: '/app/commands', body: { deviceId, command: write, requestId } },
  { name: 'receipt-only write lookup', invoke: hub => command(hub, deviceId, write, requestId, undefined, { receiptOnly: true }), path: '/app/commands', body: { deviceId, command: write, requestId, receiptOnly: true } },
  { name: 'operation acknowledgement', invoke: hub => acknowledgeOperation(hub, deviceId, ticket), path: '/app/operations/ack', body: { deviceId, operationId: requestId, ticket: ticket.ticket } },
  { name: 'event acknowledgement', invoke: hub => acknowledgeSessionEvents(hub, deviceId, 'saved-thread', 17, 'saved-epoch'), path: '/app/events/ack', body: { deviceId, sessionKey: 'saved-thread', through: 17, storageEpoch: 'saved-epoch' } },
];

describe.each(requests)('$name through the shared request boundary', ({ invoke, path, body }) => {
  test('local revocation during anonymous discovery prevents every authenticated dispatch', async () => {
    const reached = deferred<void>(), release = deferred<void>();
    let allowed = true;
    const sent = installTransport({ pingGate: release, onPing: () => reached.resolve() });
    const pending = invoke(bot({ dispatchGuard: () => allowed }));
    const rejected = expect(pending).rejects.toMatchObject({ status: 409, code: 'bot_binding_changed' });
    try {
      await reached.promise;
      expect(sent).toEqual([]);
      allowed = false; release.resolve();
      await rejected;
      expect(sent).toEqual([]);
    } finally { release.resolve(); }
  });

  test('an unchanged owner dispatches the exact recorded request once', async () => {
    const reached = deferred<void>(), release = deferred<void>();
    const { authorize, calls } = recordAuthority(async <T,>(dispatch: () => T) => ({ value: dispatch() }));
    const sent = installTransport({ pingGate: release, onPing: () => reached.resolve() });
    const pending = invoke(bot({ dispatchGuard: () => true, authorizeDispatch: authorize }));
    try {
      await reached.promise;
      expect(sent).toEqual([]); expect(calls).not.toHaveBeenCalled();
      release.resolve(); await pending;
      expect(calls).toHaveBeenCalledTimes(1);
      expect(sent).toHaveLength(1);
      expect(sent[0].url).toBe(`${canonical}${path}`);
      expect(sent[0].init.method).toBe('POST');
      expect(JSON.parse(String(sent[0].init.body))).toEqual(body);
    } finally { release.resolve(); }
  });
});

test.each(['revoked', 'current'] as const)('SSE independently checks a %s owner after anonymous discovery', async state => {
  const reached = deferred<void>(), release = deferred<void>(), opened = deferred<void>(), closed = deferred<void>();
  let allowed = true;
  const cancel = jest.fn(), onEvent = jest.fn(), onDevice = jest.fn(), retry = jest.fn(async () => undefined);
  const states: StreamState[] = [];
  const sent = installTransport({ pingGate: release, onPing: () => reached.resolve(), business: async () => ({
    ok: true, status: 200, headers: { get: () => 'text/event-stream' },
    body: { getReader: () => ({ read: () => new Promise(() => undefined), cancel }) },
  }) });
  const handle = openStream({ hub: bot({ dispatchGuard: () => allowed }), after: 17, onEvent, onDevice, wait: retry,
    onState: value => { states.push(value); if (value === 'open') opened.resolve(); if (value === 'closed') closed.resolve(); } });
  try {
    await reached.promise;
    allowed = state === 'current'; release.resolve();
    if (state === 'current') {
      await opened.promise;
      expect(sent).toHaveLength(1);
      expect(sent[0].url).toBe(`${canonical}/app/stream?after=17&deviceId=${deviceId}`);
      expect(sent[0].init.headers).toMatchObject({ Accept: 'text/event-stream' });
      handle.close();
    }
    await closed.promise;
    expect(states).toEqual(state === 'current' ? ['connecting', 'open', 'closed'] : ['connecting', 'closed']);
    expect(sent).toHaveLength(state === 'current' ? 1 : 0);
    expect(retry).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled(); expect(onDevice).not.toHaveBeenCalled();
  } finally { release.resolve(); handle.close(); }
});

test.each(['guard revoked', 'proof lease expired', 'authority rejected'] as const)('a request rechecks %s after waiting for dispatch authority', async failure => {
  jest.useFakeTimers();
  const reached = deferred<void>(), release = deferred<void>();
  let allowed = true;
  const { authorize, calls } = recordAuthority(async <T,>(dispatch: () => T) => {
    reached.resolve(); await release.promise;
    return failure === 'authority rejected' ? null : { value: dispatch() };
  });
  const sent = installTransport();
  const pending = command(bot({ dispatchGuard: () => allowed, authorizeDispatch: authorize }), deviceId, write, requestId);
  const rejected = expect(pending).rejects.toMatchObject({ status: 409, code: failure === 'proof lease expired' ? 'bot_identity_unavailable' : 'bot_binding_changed' });
  try {
    await reached.promise; expect(sent).toEqual([]);
    if (failure === 'guard revoked') allowed = false;
    if (failure === 'proof lease expired') jest.setSystemTime(Date.now() + 10_001);
    release.resolve(); await rejected;
    expect(sent).toEqual([]); expect(calls).toHaveBeenCalledTimes(1);
  } finally { release.resolve(); }
});

test.each(['guard revoked', 'proof lease expired', 'authority rejected'] as const)('SSE rechecks %s after waiting for dispatch authority and does not reconnect', async failure => {
  jest.useFakeTimers();
  const reached = deferred<void>(), release = deferred<void>(), closed = deferred<void>();
  let allowed = true;
  const { authorize, calls } = recordAuthority(async <T,>(dispatch: () => T) => {
    reached.resolve(); await release.promise;
    return failure === 'authority rejected' ? null : { value: dispatch() };
  });
  const sent = installTransport(), states: StreamState[] = [];
  const retry = jest.fn(async () => undefined), onEvent = jest.fn(), onDevice = jest.fn();
  const handle = openStream({ hub: bot({ dispatchGuard: () => allowed, authorizeDispatch: authorize }), onEvent, onDevice, wait: retry,
    onState: value => { states.push(value); if (value === 'closed') closed.resolve(); } });
  try {
    await reached.promise; expect(sent).toEqual([]);
    if (failure === 'guard revoked') allowed = false;
    if (failure === 'proof lease expired') jest.setSystemTime(Date.now() + 10_001);
    release.resolve(); await closed.promise;
    expect(sent).toEqual([]); expect(calls).toHaveBeenCalledTimes(1);
    expect(states).toEqual(['connecting', 'closed']);
    expect(retry).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled(); expect(onDevice).not.toHaveBeenCalled();
  } finally { release.resolve(); handle.close(); }
});

test.each(['network failure', 'service unavailable', 'invalid response'] as const)('a dispatched API write with %s is never automatically replayed', async failure => {
  const sent = installTransport({ business: async () => {
    if (failure === 'network failure') throw new Error('socket closed after request dispatch');
    if (failure === 'service unavailable') return reply({ code: 'service_unavailable' }, 503);
    return { ok: true, status: 200, text: async () => '{truncated' };
  } });
  const { authorize, calls } = recordAuthority(async <T,>(dispatch: () => T) => ({ value: dispatch() }));
  await expect(command(bot({ authorizeDispatch: authorize, dispatchGuard: () => true }), deviceId, write, requestId)).rejects.toThrow();
  expect(calls).toHaveBeenCalledTimes(1); expect(sent).toHaveLength(1);
  expect(sent[0].url).toBe(`${canonical}/app/commands`);
  expect(JSON.parse(String(sent[0].init.body))).toEqual({ deviceId, command: write, requestId });
});
