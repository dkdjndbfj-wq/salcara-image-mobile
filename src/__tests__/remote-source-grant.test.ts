import { command, discoverStation, ping, setHubFetch, type Command, type FetchLike } from '../remote/client';
import { workspaceCommands } from './fixtures/workspace-commands';

jest.mock('expo-crypto', () => ({ randomUUID: () => '10000000-0000-4000-8000-000000000009' }));
afterEach(() => setHubFetch(null));
const response = (data: unknown, status = 200) => ({ ok: status === 200, status, text: async () => JSON.stringify(data) });
const grant = { payload: 'YWJj', signature: 'a'.repeat(86) };

test.each(workspaceCommands)('$type never acquires a model API grant for a local workspace operation', async cmd => {
  const calls: string[] = [];
  setHubFetch((async url => { calls.push(url); return response({ code: 'source_grant_required' }, 403); }) as FetchLike);
  await expect(command({ url: 'https://station.test/salcara-hub/v1', pairToken: 'synthetic-pair' }, 'pc', cmd)).rejects.toMatchObject({ code: 'source_grant_required' });
  expect(calls).toEqual(['https://station.test/salcara-hub/v1/app/commands']);
});

test.each(workspaceCommands)('$type retries only read operations after a transport failure', async cmd => {
  jest.useFakeTimers();
  try {
    const calls: unknown[] = [];
    setHubFetch((async (_url, init) => { calls.push(JSON.parse(String(init.body))); return calls.length === 1 ? response({ error: 'temporary' }, 503) : response({ ok: true, result: {} }); }) as FetchLike);
    const outcome = command({ url: 'https://station.test/salcara-hub/v1' }, 'pc', cmd).then(() => 'success', () => 'failure');
    await jest.advanceTimersByTimeAsync(601);
    const read = cmd.type === 'workspace.terminal.read' || cmd.type === 'workspace.preview.frame' || cmd.type === 'workspace.git.read';
    expect(await outcome).toBe(read ? 'success' : 'failure');
    expect(calls).toHaveLength(read ? 2 : 1);
    if (read) expect(calls[1]).toEqual(calls[0]);
  } finally { jest.useRealTimers(); }
});

test('oversized escaped structured command is rejected before any network side effect', async () => {
  const fetch = jest.fn(); setHubFetch(fetch as FetchLike);
  await expect(command({ url: 'https://station.test/salcara-hub/v1' }, 'pc', {
    type: 'session.send', sessionKey: 'codex:s', controlSurface: 'cli', text: '"'.repeat(123000),
  })).rejects.toMatchObject({ status: 413, code: 'command_too_large' });
  expect(fetch).not.toHaveBeenCalled();
});

test('a maximal source grant cannot push the final envelope past the Hub body limit', async () => {
  const calls: string[] = [];
  setHubFetch((async url => {
    calls.push(url);
    if (url.endsWith('/app/source/challenge')) return response({ challengeId: 'challenge-size' });
    if (url.endsWith('/app/source/grant')) return response({ sourceGrant: { ...grant, payload: 'a'.repeat(87382) } });
    return response({ code: 'source_grant_required' }, 403);
  }) as FetchLike);
  const cmd: Command = { type: 'session.send', sessionKey: 'codex:s', controlSurface: 'cli', text: '' };
  cmd.text = 'x'.repeat(240 * 1024 - new TextEncoder().encode(JSON.stringify(cmd)).length);
  await expect(command({ url: 'https://station.test/salcara-hub/v1' }, 'pc', cmd)).rejects.toMatchObject({ status: 413, code: 'command_too_large' });
  expect(calls.filter(url => url.endsWith('/app/commands'))).toHaveLength(1);
});

test.each([
  { name: 'the full 64 KiB snapshot encoding', payload: 'a'.repeat(87382), accepted: true },
  { name: 'one character over the snapshot encoding budget', payload: 'a'.repeat(87383), accepted: false },
  { name: 'an empty payload', payload: '', accepted: false },
  { name: 'non-base64url payload characters', payload: 'abc+', accepted: false },
])('$name is bounded before a second execution request', async ({ payload, accepted }) => {
  const bodies: Array<Record<string, unknown>> = [];
  setHubFetch((async (url, init) => {
    if (url.endsWith('/app/source/challenge')) return response({ challengeId: 'challenge-size' });
    if (url.endsWith('/app/source/grant')) return response({ sourceGrant: { ...grant, payload } });
    bodies.push(JSON.parse(String(init.body)));
    return bodies.length === 1 ? response({ code: 'source_grant_required' }, 403) : response({ ok: true });
  }) as FetchLike);
  const result = command({ url: 'https://station.test/salcara-hub/v1' }, 'pc', { type: 'models.list', tool: 'codex' });
  if (accepted) {
    await expect(result).resolves.toEqual({});
    expect(bodies[1].sourceGrant).toEqual({ ...grant, payload });
  } else {
    await expect(result).rejects.toThrow('中转站未返回完整的来源授权');
  }
  expect(bodies).toHaveLength(accepted ? 2 : 1);
});

test('an escaped maximum-length source URL survives grant forwarding unchanged', async () => {
  const prefix = 'https://api.example/team/';
  const snapshot = { version: 1, apiBase: prefix + '&'.repeat(4096 - prefix.length) };
  // Go's JSON encoder escapes &, so a legal URL exceeds the previous 16 KiB limit.
  const payload = Buffer.from(JSON.stringify(snapshot).replace(/&/g, '\\u0026')).toString('base64url');
  expect(payload.length).toBeGreaterThan(16384);
  const issued = { ...grant, payload };
  const bodies: Array<Record<string, unknown>> = [];
  setHubFetch((async (url, init) => {
    if (url.endsWith('/app/source/challenge')) return response({ challengeId: 'challenge-escaped' });
    if (url.endsWith('/app/source/grant')) return response({ sourceGrant: issued });
    bodies.push(JSON.parse(String(init.body)));
    return bodies.length === 1 ? response({ code: 'source_grant_required' }, 403) : response({ ok: true });
  }) as FetchLike);
  await command({ url: 'https://station.test/salcara-hub/v1' }, 'pc', { type: 'models.list', tool: 'codex' });
  expect(bodies).toHaveLength(2);
  expect(bodies[1].sourceGrant).toEqual(issued);
});

test('discovery and ping accept a full escaped v2 station policy', async () => {
  const bases = Array.from({ length: 32 }, (_, index) => {
    const prefix = `https://api.example/team${index}/`;
    return prefix + '&'.repeat(4096 - prefix.length);
  });
  const body = JSON.stringify({
    service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1,
    authModes: ['device-pairing'],
    capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1'],
    stationPolicy: { version: 2, apiBases: bases.slice(0, 16), externalApiBases: bases.slice(16), reverseProxyApiBases: bases, allowOfficialAccounts: false },
  }).replace(/&/g, '\\u0026');
  expect(body.length).toBeGreaterThan(1024 * 1024);
  const fetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => body }));
  setHubFetch(fetch as FetchLike);
  const url = 'https://station.test/salcara-hub/v1';
  await expect(discoverStation(url)).resolves.toMatchObject({ url, service: 'salcara-hub' });
  await expect(ping(url)).resolves.toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
});

test.each(['models.list', 'session.steer'] as const)('%s obtains one source grant and preserves the original source', async type => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const cmd: Command = type === 'models.list' ? { type, tool: 'codex', accountId: 'api_aaaaaaaa', refresh: true }
    : { type, sessionKey: 'codex:s', text: 'focus', expectedTurnId: 'turn-1', operationId: '10000000-0000-4000-8000-000000000001', accountId: 'api_aaaaaaaa', controlSurface: 'cli' };
  setHubFetch((async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    if (calls.length === 1) return response({ code: 'source_grant_required' }, 403);
    if (url.endsWith('/app/source/challenge')) return response({ challengeId: 'challenge-fixture' });
    if (url.endsWith('/app/source/grant')) return response({ sourceGrant: grant });
    return response({ ok: true, result: {} });
  }) as FetchLike);
  await command({ url: 'https://station.test/salcara-hub/v1' }, 'pc', cmd,
    cmd.type === 'session.steer' ? cmd.operationId : undefined);
  expect(calls).toHaveLength(4);
  expect(calls[1].body.command).toEqual(cmd);
  expect(calls[3].body).toEqual({ ...calls[1].body, sourceGrant: grant });
});

test('source acquisition sends the frozen command, ID and paired station after caller mutation', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const hub = { url: 'https://station.test/salcara-hub/v1', pairToken: 'fixture-pair' };
  const cmd: Command = { type: 'session.send', sessionKey: 'codex:s', text: 'original', accountId: 'handle-a', controlSurface: 'cli' };
  setHubFetch((async (url, init) => {
    const body = JSON.parse(String(init.body)); calls.push({ url, body });
    if (calls.length === 1) { cmd.text = 'changed'; cmd.accountId = 'handle-b'; hub.url = 'https://other.test/salcara-hub/v1'; return response({ code: 'source_grant_required' }, 403); }
    if (url.endsWith('/app/source/challenge')) return response({ challengeId: 'challenge-fixture' });
    if (url.endsWith('/app/source/grant')) return response({ sourceGrant: grant });
    return response({ ok: true, result: { sent: true } });
  }) as FetchLike);
  await expect(command(hub, 'pc', cmd, '10000000-0000-4000-8000-000000000001')).resolves.toEqual({ sent: true });
  expect(calls.map(call => call.url)).toEqual(['/app/commands', '/app/source/challenge', '/app/source/grant', '/app/commands'].map(path => 'https://station.test/salcara-hub/v1'+path));
  expect(calls[1].body.command).toEqual({ type: 'session.send', sessionKey: 'codex:s', text: 'original', accountId: 'handle-a', controlSurface: 'cli' });
  expect(calls[3].body).toEqual({ ...calls[1].body, sourceGrant: grant });
  expect(JSON.stringify(calls)).not.toMatch(/apiKey|credentialValue|issuerURL/);
});

test('missing connector stays closed without resending execution', async () => {
  const paths: string[] = [];
  setHubFetch((async (url) => {
    paths.push(url);
    return url.endsWith('/app/commands') ? response({ code: 'source_grant_required' }, 403)
      : url.endsWith('/app/source/challenge') ? response({ challengeId: 'challenge-fixture' })
      : response({ code: 'source_acquisition_unsupported' }, 403);
  }) as FetchLike);
  await expect(command({ url: 'https://station.test/salcara-hub/v1' }, 'pc', { type: 'session.start', tool: 'codex', cwd: '/fixture', prompt: 'test', accountId: 'handle' })).rejects.toMatchObject({ code: 'source_acquisition_unsupported' });
  expect(paths.filter(path => path.endsWith('/app/commands'))).toHaveLength(1);
});

test('a malformed or stale grant cannot restart the acquisition loop', async () => {
  let acquisitions = 0; let writes = 0;
  setHubFetch((async (url) => {
    if (url.endsWith('/app/commands')) { writes++; return response({ code: 'source_grant_required' }, 403); }
    if (url.endsWith('/app/source/challenge')) return response({ challengeId: 'challenge-fixture' });
    acquisitions++; return response({ sourceGrant: grant });
  }) as FetchLike);
  await expect(command({ url: 'https://station.test/salcara-hub/v1' }, 'pc', { type: 'agents.api.set', agent: 'codex', accountId: 'handle' })).rejects.toMatchObject({ code: 'source_grant_required' });
  expect(acquisitions).toBe(1); expect(writes).toBe(2);
});

test('v2 transport handover never acquires an execution grant even when a server asks for one', async () => {
  const calls: string[] = [];
  setHubFetch((async url => { calls.push(url); return response({ code: 'source_grant_required' }, 403); }) as FetchLike);
  await expect(command({ url: 'https://station.test/salcara-hub/v1' }, 'pc', {
    type: 'remote.station.switch', targetHubUrl: 'https://target.test/salcara-hub/v1', targetDeviceId: 'pc-b',
    targetComputerId: 'physical-pc', operationId: '10000000-0000-4000-8000-000000000001',
  }, undefined, undefined, { transportOnlyHandover: true })).rejects.toMatchObject({ code: 'source_grant_required' });
  expect(calls).toEqual(['https://station.test/salcara-hub/v1/app/commands']);
});

test('transport-only hint never exempts model reads or task writes from grant acquisition', async () => {
  const calls: string[] = [];
  setHubFetch((async url => {
    calls.push(url);
    if (url.endsWith('/app/source/challenge')) return response({ challengeId: 'challenge-fixture' });
    if (url.endsWith('/app/source/grant')) return response({ sourceGrant: grant });
    return calls.length === 1 ? response({ code: 'source_grant_required' }, 403) : response({ ok: true });
  }) as FetchLike);
  await command({ url: 'https://station.test/salcara-hub/v1' }, 'pc', { type: 'models.list', tool: 'codex' }, undefined, undefined, { transportOnlyHandover: true });
  expect(calls).toHaveLength(4);
});

test.each(['challenge', 'grant'] as const)('model discovery shares its 30 second budget with a stalled source %s', async stalled => {
  jest.useFakeTimers();
  try {
    const calls: string[] = [];
    setHubFetch((async url => {
      calls.push(url);
      if (url.endsWith('/app/commands')) {
        await new Promise(resolve => setTimeout(resolve, 18_000));
        return response({ code: 'source_grant_required' }, 403);
      }
      if (url.endsWith('/app/source/challenge') && stalled === 'grant') {
        await new Promise(resolve => setTimeout(resolve, 9_000));
        return response({ challengeId: 'challenge-fixture' });
      }
      // Deliberately ignore AbortSignal, like a native body read that stalls.
      return new Promise(() => undefined);
    }) as FetchLike);
    let settled = false;
    const result = command({ url: 'https://station.test/salcara-hub/v1' }, 'pc', { type: 'models.list', tool: 'codex' })
      .then(() => { throw new Error('unexpected success'); }, error => { settled = true; return error; });
    await jest.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await result).toBeInstanceOf(Error);
    expect(calls).toHaveLength(stalled === 'grant' ? 3 : 2);
    expect(calls.filter(url => url.endsWith('/app/commands'))).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});
