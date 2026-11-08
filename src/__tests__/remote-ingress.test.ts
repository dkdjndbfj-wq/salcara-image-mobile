import { generateKeyPairSync, sign } from 'node:crypto';
import { createIngressRouter, parseIngressManifest, verifyIngressProof, type IngressManifest } from '../remote/ingress';
import { command, devices, openStream, setHubFetch, type FetchLike } from '../remote/client';

const canonical = 'https://hub.example/salcara-hub/v1', backup = 'https://entry.example/salcara-hub/v1';
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const hubId = 'a'.repeat(32), nonce = 'b'.repeat(64);
const json = (value: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value) });
function manifest(now = Date.now()): IngressManifest {
  return { version: 1, hub_instance_id: hubId, identity_public_key: publicKey, canonical_url: canonical, revision: 3,
    issued_at: now, expires_at: now + 86_400_000, endpoints: [{ id: 'canonical', url: canonical, priority: 100 }, { id: 'backup', url: backup, priority: 50 }] };
}
function proof(n = nonce, now = Date.now(), patch: Record<string, unknown> = {}) {
  const body = { version: 1, hub_instance_id: hubId, nonce: n, issued_at: now, expires_at: now + 30_000, ...patch };
  const bytes = Buffer.from(`salcara-ingress-proof-v1\n${body.hub_instance_id}\n${body.nonce}\n${body.issued_at}\n${body.expires_at}`);
  return { ...body, signature: sign(null, bytes, keys.privateKey).toString('base64') };
}
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
afterEach(() => { setHubFetch(null); jest.useRealTimers(); });

test('accepts a real Ed25519 signature from the Hub contract', () => {
  const now = Date.now(), m = manifest(now);
  expect(parseIngressManifest(m, canonical, now)).toEqual(m);
  expect(verifyIngressProof(proof(nonce, now), m, nonce, now)).toBe(true);
  expect(verifyIngressProof({ ...proof(nonce, now), signature: 'A'.repeat(86) + '==' }, m, nonce, now)).toBe(false);
});

test.each([
  { nonce: 'c'.repeat(64) }, { hub_instance_id: 'd'.repeat(32) }, { version: 2 },
  { issued_at: 0, expires_at: 30_000 }, { expires_at: Date.now() + 90_000 },
])('rejects a correctly signed but mismatched or stale proof: %j', patch => {
  expect(verifyIngressProof(proof(nonce, Date.now(), patch), manifest(), nonce)).toBe(false);
});

test.each([
  { endpoints: [{ id: 'canonical', url: canonical, priority: 1 }, { id: 'other', url: 'http://evil.example/salcara-hub/v1', priority: 2 }] },
  { endpoints: [{ id: 'canonical', url: canonical, priority: 1 }, { id: 'other', url: 'https://127.0.0.1/salcara-hub/v1', priority: 2 }] },
  { endpoints: [{ id: 'canonical', url: canonical, priority: 1 }, { id: 'other', url: canonical, priority: 2 }] },
  { canonical_url: backup }, { identity_public_key: 'A'.repeat(44) }, { revision: 1.5 }, { expires_at: Date.now() - 1 },
])('rejects invalid manifest authority: %j', patch => {
  expect(() => parseIngressManifest({ ...manifest(), ...patch }, canonical)).toThrow();
});

test('loads persisted authority, preflights fallback without credentials, and keeps canonical identity', async () => {
  const m = manifest(), calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith(`${canonical}/ingress/identity`)) throw new Error('offline');
    if (url.startsWith(`${backup}/ingress/identity`)) return json(proof(new URL(url).searchParams.get('nonce')!));
    return json({ devices: [] });
  };
  const router = createIngressRouter({ fetch, nonce: () => nonce, storage: { read: async () => JSON.stringify(m), write: async () => undefined } });
  const result = await router.fetch(canonical, '/app/devices', { method: 'GET', headers: { 'X-Salcara-Pair-Token': 'private' } });
  expect(result.endpoint).toBe(backup);
  expect(calls.at(-1)?.url).toBe(`${backup}/app/devices`);
  expect(calls.slice(0, -1).every(call => JSON.stringify(call.init).includes('private') === false)).toBe(true);
  expect(calls.every(call => call.init.redirect === 'error' && call.init.credentials === 'omit')).toBe(true);
  expect(router.snapshot(canonical)?.canonical_url).toBe(canonical);
});

test('a response lost after POST does not cause replay on another ingress', async () => {
  let posts = 0;
  const fetch: FetchLike = async (url, init) => {
    if (url.endsWith('/manifest')) return json(manifest());
    if (url.includes('/identity?')) return json(proof(new URL(url).searchParams.get('nonce')!));
    if (init.method === 'POST') { posts++; throw new Error('response lost'); }
    return json({});
  };
  const router = createIngressRouter({ fetch, nonce: () => nonce });
  await router.refresh(canonical);
  await expect(router.fetch(canonical, '/app/command', { method: 'POST', body: '{"requestId":"stable"}' })).rejects.toThrow('response lost');
  expect(posts).toBe(1);
  expect(await router.resolve(canonical)).toBe(canonical);
});

test('failed GET can retry through a freshly verified backup, auth failures cannot', async () => {
  const visited: string[] = [];
  let status = 503;
  const fetch: FetchLike = async url => {
    if (url.endsWith('/manifest')) { const m = manifest(); m.endpoints[1].priority = 200; return json(m); }
    if (url.includes('/identity?')) return json(proof(new URL(url).searchParams.get('nonce')!));
    visited.push(url); return json({}, url.startsWith(canonical) ? status : 200);
  };
  let router = createIngressRouter({ fetch, nonce: () => nonce });
  await router.refresh(canonical);
  expect((await router.fetch(canonical, '/app/events', { method: 'GET' })).endpoint).toBe(backup);
  expect(visited).toHaveLength(2);
  status = 401; visited.length = 0;
  router = createIngressRouter({ fetch, nonce: () => nonce }); await router.refresh(canonical);
  expect((await router.fetch(canonical, '/app/events', { method: 'GET' })).response.status).toBe(401);
  expect(visited).toHaveLength(1);
});

test('healthy canonical endpoint requires no identity round trip', async () => {
  const calls: string[] = [];
  const router = createIngressRouter({ nonce: () => nonce, fetch: async url => {
    calls.push(url);
    if (url.endsWith('/manifest')) { const m = manifest(); m.endpoints[1].priority = 200; return json(m); }
    return json({});
  } });
  await router.refresh(canonical); calls.length = 0;
  await router.fetch(canonical, '/app/devices', { method: 'GET' });
  expect(calls).toEqual([`${canonical}/app/devices`]);
});

test('concurrent requests share proof checks, but still each send their own request', async () => {
  let checks = 0, requests = 0;
  const router = createIngressRouter({ nonce: () => nonce, fetch: async url => {
    if (url.endsWith('/manifest')) return json(manifest());
    if (url.includes('/identity?')) { checks++; await flush(); return json(proof()); }
    requests++; return json({});
  } });
  await router.refresh(canonical);
  await Promise.all(Array.from({ length: 12 }, () => router.fetch(canonical, '/app/devices', { method: 'GET' })));
  expect(checks).toBe(1); expect(requests).toBe(12);
});

test('expiry returns to original URL; alternate responses cannot renew trust', async () => {
  let now = Date.now(); const m = manifest(now), calls: string[] = [];
  const router = createIngressRouter({ now: () => now, nonce: () => nonce, fetch: async url => {
    calls.push(url);
    if (url.endsWith('/manifest')) return json(m);
    return json(proof(nonce, now));
  } });
  await router.refresh(canonical); now += 86_400_001;
  expect(await router.resolve(canonical)).toBe(canonical); await flush();
  expect(router.snapshot(canonical)).toBeUndefined();
  expect(calls.every(url => url.startsWith(canonical))).toBe(true);
});

test('rejects redirect and changed identity without publishing or persisting either', async () => {
  let now = Date.now(), response: unknown = manifest(now), redirected = false;
  const writes: string[] = [];
  const router = createIngressRouter({ now: () => now, nonce: () => nonce, storage: { read: async () => null, write: async (_, value) => { writes.push(value); } },
    fetch: async () => ({ ...json(response), redirected }) });
  await router.refresh(canonical);
  now += 7 * 60 * 60_000; response = { ...manifest(now), hub_instance_id: 'f'.repeat(32) };
  await router.refresh(canonical); expect(router.snapshot(canonical)?.hub_instance_id).toBe(hubId);
  now += 61_000; response = manifest(now); redirected = true;
  await router.refresh(canonical); expect(writes).toHaveLength(1);
});

test('abort during preflight never sends credentials afterward', async () => {
  const controller = new AbortController(); let credentialed = 0;
  const router = createIngressRouter({ nonce: () => nonce, fetch: async (url, init) => {
    if (url.endsWith('/manifest')) return json(manifest());
    if (url.includes('/identity?')) { controller.abort(); return json(proof()); }
    if (init.headers) credentialed++; return json({});
  } });
  await router.refresh(canonical);
  await expect(router.fetch(canonical, '/app/devices', { signal: controller.signal, headers: { Authorization: 'secret' } })).rejects.toThrow('cancelled');
  expect(credentialed).toBe(0);
});

test('bounds streamed authority and cancels oversized bodies', async () => {
  const cancel = jest.fn(async () => undefined);
  const router = createIngressRouter({ nonce: () => nonce, fetch: async () => ({ ok: true, status: 200,
    body: { getReader: () => ({ read: async () => ({ done: false, value: new Uint8Array(16_385) }), cancel }) } }) });
  await router.refresh(canonical);
  expect(router.snapshot(canonical)).toBeUndefined();
  expect(cancel).toHaveBeenCalledTimes(1);
});

test('a stalled public fetch times out even when the transport ignores abort', async () => {
  jest.useFakeTimers();
  const router = createIngressRouter({ nonce: () => nonce, fetch: () => new Promise(() => undefined) });
  const work = router.refresh(canonical);
  await flush(); await jest.advanceTimersByTimeAsync(2501); await work;
  expect(router.snapshot(canonical)).toBeUndefined();
});

test('HTTP integration changes only transport and preserves command identity', async () => {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/manifest')) return json(manifest());
    if (url.startsWith(`${canonical}/ingress/identity`)) throw new Error('offline');
    if (url.includes('/identity?')) return json(proof(new URL(url).searchParams.get('nonce')!));
    if (url.endsWith('/app/commands')) return json({ ok: true, result: {} });
    return json({ devices: [] });
  };
  setHubFetch(fetch, true);
  const hub = { url: canonical, pairToken: 'paired', deviceId: 'd1' };
  await devices(hub); await flush();
  await command(hub, 'd1', { type: 'sessions.list', tool: 'codex' }, 'same-request');
  const sent = calls.find(call => call.url.endsWith('/app/commands'))!;
  expect(sent.url).toBe(`${backup}/app/commands`);
  expect(sent.init.headers).toMatchObject({ 'X-Salcara-Pair-Token': 'paired' });
  expect(JSON.parse(sent.init.body as string).requestId).toBe('same-request');
  expect(hub.url).toBe(canonical);
});

test('SSE reconnect uses backup and resumes the same cursor', async () => {
  let learned = false, stream: ReturnType<typeof openStream> | undefined;
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => {
    if (url.endsWith('/manifest')) { learned = true; return json(manifest()); }
    if (url.startsWith(`${canonical}/ingress/identity`)) throw new Error('offline');
    if (url.includes('/identity?')) return json(proof(new URL(url).searchParams.get('nonce')!));
    if (url.includes('/app/stream')) { urls.push(url); return { ok: true, status: 200, headers: { get: () => 'text/event-stream' }, text: async () => '' }; }
    return json({ devices: [] });
  };
  setHubFetch(fetch, true);
  const hub = { url: canonical, pairToken: 'paired', deviceId: 'd1' };
  await devices(hub); await flush(); expect(learned).toBe(true);
  await new Promise<void>(resolve => {
    stream = openStream({ hub, after: 47, onEvent: () => undefined, onDevice: () => undefined,
      onState: state => { if (state === 'open') { stream?.close(); resolve(); } }, wait: async () => undefined });
  });
  expect(urls[0]).toBe(`${backup}/app/stream?after=47&deviceId=d1`);
  expect(stream?.lastSeq()).toBe(47); stream?.close();
});
