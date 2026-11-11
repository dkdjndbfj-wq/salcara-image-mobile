import { generateKeyPairSync, sign } from 'node:crypto';
import { createIngressRouter, IngressIdentityError, parseIngressManifest, verifyIngressProof, type IngressManifest } from '../remote/ingress';
import { command, confirmQrPair, devices, discoverStation, openStream, setHubFetch, type FetchLike } from '../remote/client';

const canonical = 'https://hub.example/salcara-hub/v1', backup = 'https://entry.example/salcara-hub/v1';
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const hubId = 'a'.repeat(32), nonce = 'b'.repeat(64);
const json = (value: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value) });
function manifest(now = Date.now()): IngressManifest {
  return { version: 1, hub_instance_id: hubId, identity_public_key: publicKey, canonical_url: canonical, revision: 3,
    issued_at: now, expires_at: now + 86_400_000, endpoints: [{ id: 'canonical', url: canonical, priority: 100 }, { id: 'backup', url: backup, priority: 50 }] };
}
function signedManifest(value = manifest()): IngressManifest {
  const { signed_payload: _payload, signature: _signature, ...payload } = value;
  const bytes = Buffer.from(JSON.stringify(payload));
  return { ...payload, signed_payload: bytes.toString('base64'), signature: sign(null, Buffer.concat([Buffer.from('salcara-ingress-manifest-v1\n'), bytes]), keys.privateKey).toString('base64') };
}
function proof(n = nonce, now = Date.now(), patch: Record<string, unknown> = {}) {
  const body = { version: 1, hub_instance_id: hubId, nonce: n, issued_at: now, expires_at: now + 30_000, ...patch };
  const bytes = Buffer.from(`salcara-ingress-proof-v1\n${body.hub_instance_id}\n${body.nonce}\n${body.issued_at}\n${body.expires_at}`);
  return { ...body, signature: sign(null, bytes, keys.privateKey).toString('base64') };
}
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

test('expired signed hints renew through a surviving entry and retain the retired logical profile across restart', async () => {
  const now = Date.now(), moved = 'https://moved.example/salcara-hub/v1';
  let saved = JSON.stringify(signedManifest(manifest(now - 86_400_001)));
  const next = signedManifest({ ...manifest(now), canonical_url: moved, revision: 4,
    endpoints: [{ id: 'canonical', url: moved, priority: 0 }] });
  const sent: string[] = [], publicCalls: Array<Record<string, unknown>> = [];
  const storage = { read: async () => saved, write: async (key: string, raw: string) => { expect(key).toBe(canonical); saved = raw; } };
  const fetch: FetchLike = async (url, init) => {
    if (url.includes('/ingress/')) publicCalls.push(init);
    if (url.startsWith(canonical)) throw new Error('old host gone');
    if (url.endsWith('/manifest')) return json(next);
    if (url.includes('/identity?')) return json(proof());
    sent.push(url); return json({ devices: [] });
  };
  for (let restart = 0; restart < 2; restart++) {
    const router = createIngressRouter({ now: () => now, nonce: () => nonce, storage, fetch });
    await router.fetch(canonical, '/app/devices', { headers: { 'X-Salcara-Bot-Token': 'private-token' } });
    expect(router.pinSnapshot(canonical)?.revision).toBe(4);
  }
  expect(sent).toEqual([`${moved}/app/devices`, `${moved}/app/devices`]);
  expect(publicCalls.every(init => JSON.stringify(init.headers) === '{"Accept":"application/json"}' && init.credentials === 'omit' && init.redirect === 'error')).toBe(true);
});

test('a replaced candidate cannot poison another valid same-pin renewal', async () => {
  const previous = signedManifest(manifest(Date.now() - 86_400_001));
  const sent: string[] = [];
  const router = createIngressRouter({ nonce: () => nonce, storage: { read: async () => JSON.stringify(previous), write: async () => undefined }, fetch: async url => {
    if (url.endsWith('/manifest')) return json(url.startsWith(canonical) ? signedManifest({ ...manifest(), hub_instance_id: 'e'.repeat(32) }) : signedManifest());
    if (url.includes('/identity?')) return json(proof());
    sent.push(url); return json({});
  } });
  await router.fetch(canonical, '/app/devices', { headers: { 'X-Salcara-Pair-Token': 'private' } });
  expect(sent).toEqual([`${backup}/app/devices`]);
  expect(router.pinSnapshot(canonical)?.hub_instance_id).toBe(hubId);
});

test('refresh checks all eight signed hints with bounded concurrency, coalescing and cooldown', async () => {
  jest.useFakeTimers();
  const previous = signedManifest({ ...manifest(Date.now() - 86_400_001), endpoints: [manifest().endpoints[0],
    ...Array.from({ length: 7 }, (_, index) => ({ id: `hint-${index}`, url: `https://hint-${index}.example/v1`, priority: index }))] });
  let attempts = 0;
  const router = createIngressRouter({ nonce: () => nonce, storage: { read: async () => JSON.stringify(previous), write: async () => undefined },
    fetch: async () => { attempts++; return new Promise(() => undefined); } });
  const rounds = Promise.all([router.refresh(canonical), router.refresh(canonical)]);
  await jest.advanceTimersByTimeAsync(8000); await rounds;
  expect(attempts).toBe(8);
  await router.refresh(canonical); expect(attempts).toBe(8);
});

test('a retired logical anchor cannot permanently starve the eighth signed hint', async () => {
  let now = Date.now();
  const hints = Array.from({ length: 8 }, (_, i) => ({ id: i === 0 ? 'canonical' : `edge-${i}`, url: `https://edge-${i}.example/v1`, priority: i }));
  const expired = signedManifest({ ...manifest(now - 86_400_001), canonical_url: hints[0].url, endpoints: hints });
  let saved = JSON.stringify(expired); const attempts: string[] = [];
  const router = createIngressRouter({ now: () => now, nonce: () => nonce,
    storage: { read: async () => saved, write: async (_key, value) => { saved = value; } }, fetch: async url => {
      attempts.push(url);
      if (url === `${hints[7].url}/ingress/manifest`) return json(signedManifest({ ...manifest(now), canonical_url: hints[7].url, revision: 4,
        endpoints: [{ ...hints[7], id: 'canonical' }] }));
      if (url.includes('/identity?')) return json(proof(nonce, now));
      if (url.endsWith('/app/devices')) return json({});
      throw new Error('retired');
    } });
  await router.refresh(canonical); expect(attempts).toHaveLength(8);
  now += 60_001; await router.refresh(canonical);
  expect(attempts).toContain(`${hints[7].url}/ingress/manifest`);
  expect(router.pinSnapshot(canonical)?.revision).toBe(4);
  const response = await router.fetch(canonical, '/app/devices', { headers: { 'X-Salcara-Bot-Token': 'private' } });
  expect(response.endpoint).toBe(hints[7].url);
});

test('polls longer than the cooldown still rotate past the first three unavailable nonce endpoints', async () => {
  let now = Date.now();
  const edges = Array.from({ length: 6 }, (_, i) => ({ id: `edge-${i}`, url: `https://nonce-${i}.example/v1`, priority: i }));
  const pin = signedManifest({ ...manifest(now), endpoints: [manifest().endpoints[0], ...edges] });
  const seen: string[] = [];
  const router = createIngressRouter({ nonce: () => nonce, now: () => now, storage: { read: async () => JSON.stringify(pin), write: async () => undefined }, fetch: async url => {
    seen.push(url);
    if (url.startsWith(edges[5].url)) return json(proof(nonce, now));
    throw new Error('unavailable');
  } });
  expect(await router.resolve(canonical)).toBe(canonical);
  now += 90_000;
  expect(await router.resolve(canonical)).toBe(edges[5].url);
  expect(seen).toHaveLength(6);
});
afterEach(() => { setHubFetch(null); jest.useRealTimers(); });

test('native routing hand-back persists the same pin under the old logical URL, but still requires fresh proof after restart', async () => {
  const moved = 'https://native-moved.example/v1';
  let saved = JSON.stringify(signedManifest());
  const next = signedManifest({ ...manifest(), canonical_url: moved, revision: 4, endpoints: [{ id: 'canonical', url: moved, priority: 0 }] });
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const storage = { read: async () => saved, write: async (url: string, raw: string) => { expect(url).toBe(canonical); saved = raw; } };
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    if (!url.startsWith(moved)) throw new Error('all old entries retired');
    if (url.endsWith('/manifest')) return json(next);
    if (url.includes('/identity?')) return json(proof());
    return json({});
  };
  const router = createIngressRouter({ nonce: () => nonce, storage, fetch });
  expect(await router.adoptPinnedManifest(canonical, next, () => true)).toBe(true);
  expect(calls).toEqual([]);
  const restarted = createIngressRouter({ nonce: () => nonce, storage, fetch });
  await restarted.fetch(canonical, '/app/devices', { headers: { 'X-Salcara-Pair-Token': 'private' } });
  expect(calls.filter(call => JSON.stringify(call.init.headers).includes('private')).map(call => call.url)).toEqual([`${moved}/app/devices`]);
  expect(calls.some(call => call.url.startsWith(`${moved}/ingress/identity?`))).toBe(true);
});

test.each(['new-identity', 'downgrade', 'unsigned', 'cancelled', 'no-pin'])('native hand-back rejects %s without network or pin replacement', async kind => {
  const previous = signedManifest(); let saved = kind === 'no-pin' ? '' : JSON.stringify(previous);
  const fetch = jest.fn(async () => json({}));
  const router = createIngressRouter({ nonce: () => nonce, storage: { read: async () => saved || null, write: async (_url, raw) => { saved = raw; } }, fetch });
  const next = kind === 'unsigned' ? manifest() : signedManifest({ ...manifest(),
    ...(kind === 'new-identity' ? { hub_instance_id: 'e'.repeat(32) } : {}), revision: kind === 'downgrade' ? 2 : 4 });
  expect(await router.adoptPinnedManifest(canonical, next, () => kind !== 'cancelled')).toBe(false);
  expect(saved).toBe(kind === 'no-pin' ? '' : JSON.stringify(previous));
  expect(fetch).not.toHaveBeenCalled();
});

test('accepts a real Ed25519 signature from the Hub contract', () => {
  const now = Date.now(), m = manifest(now);
  expect(parseIngressManifest(m, canonical, now)).toEqual(m);
  expect(verifyIngressProof(proof(nonce, now), m, nonce, now)).toBe(true);
  expect(verifyIngressProof({ ...proof(nonce, now), signature: 'A'.repeat(86) + '==' }, m, nonce, now)).toBe(false);
});

test('signed manifests use only the original signed bytes and ignore forged flat aliases', () => {
  const m = signedManifest(), evil = 'https://proxy.example/salcara-hub/v1';
  const parsed = parseIngressManifest({ ...m, endpoints: [...m.endpoints, { id: 'proxy', url: evil, priority: 0 }] }, canonical);
  expect(parsed.endpoints.some(item => item.url === evil)).toBe(false);
  const changed = Buffer.from(JSON.stringify({ ...manifest(), hub_instance_id: 'c'.repeat(32) })).toString('base64');
  expect(() => parseIngressManifest({ ...m, signed_payload: changed }, canonical)).toThrow('signature');
});

test('unsigned manifests never authorize an alternate, even with a forwarded valid nonce proof', async () => {
  const calls: string[] = [];
  const router = createIngressRouter({ nonce: () => nonce, fetch: async url => { calls.push(url); return url.endsWith('/manifest') ? json(manifest()) : json(proof()); } });
  await router.refresh(canonical);
  expect(await router.resolve(canonical)).toBe(canonical);
  expect(await router.verifyAlias(canonical, backup)).toBe(false);
  expect(calls.some(url => url.startsWith(`${backup}/ingress/identity`))).toBe(false);
  expect(router.snapshot(canonical)?.endpoints).toEqual([manifest().endpoints[0]]);
});

test('a verified same-Hub alias preserves the saved canonical identity and checks membership before proof', async () => {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const router = createIngressRouter({ nonce: () => nonce, storage: { read: async () => JSON.stringify(signedManifest()), write: async () => undefined }, fetch: async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith(canonical)) throw new Error('original offline');
    return url.endsWith('/manifest') ? json(signedManifest()) : json(proof());
  } });
  expect(await router.verifyAlias(canonical, backup)).toBe(true);
  expect(router.snapshot(canonical)?.canonical_url).toBe(canonical);
  expect(calls.every(call => JSON.stringify(call.init.headers) === '{"Accept":"application/json"}' && call.init.redirect === 'error' && call.init.credentials === 'omit')).toBe(true);
  expect(await router.verifyAlias(canonical, 'https://unlisted.example/salcara-hub/v1')).toBe(false);
  expect(calls.some(call => call.url.includes('unlisted.example') && call.url.includes('/identity?'))).toBe(false);
});

test('first pairing through a signed alias pins the Hub identity and preserves its logical URL across restart', async () => {
  let saved = '';
  const calls: string[] = [];
  const storage = { read: async () => saved || null, write: async (_key: string, raw: string) => { saved = raw; } };
  const fetch: FetchLike = async url => {
    calls.push(url);
    if (url.endsWith('/manifest')) return json(signedManifest());
    if (url.includes('/identity?')) return json(proof(new URL(url).searchParams.get('nonce')!));
    return json({ devices: [] });
  };
  const router = createIngressRouter({ nonce: () => nonce, storage, fetch });
  await router.confirmPairingIdentity(backup, () => true);
  expect(router.pinSnapshot(backup)?.canonical_url).toBe(canonical);
  expect(parseIngressManifest(signedManifest(), backup).canonical_url).toBe(canonical);
  expect(() => parseIngressManifest(signedManifest(), 'https://unlisted.example/v1')).toThrow('not authorized');
  const restarted = createIngressRouter({ nonce: () => nonce, storage, fetch });
  const result = await restarted.fetch(backup, '/app/devices', { headers: { 'X-Salcara-Pair-Token': 'private-pair' } });
  expect(result.endpoint).toBe(backup);
  expect(restarted.pinSnapshot(backup)?.hub_instance_id).toBe(hubId);
  expect(calls.filter(url => url.endsWith('/app/devices'))).toEqual([`${backup}/app/devices`]);
});

test('a durable alias pin is retained when a newer signed routing list retires that logical URL', async () => {
  const replacement = 'https://new-entry.example/Custom/v1';
  const current = signedManifest({ ...manifest(), endpoints: [manifest().endpoints[0], { id: 'replacement', url: replacement, priority: 1 }] });
  let sent = '';
  const router = createIngressRouter({ nonce: () => nonce, storage: { read: async () => JSON.stringify(current), write: async () => undefined }, fetch: async (url, init) => {
    if (url.endsWith('/manifest')) throw new Error('retired alias');
    if (url.includes('/identity?')) return json(proof(new URL(url).searchParams.get('nonce')!));
    if ((init.headers as Record<string, string>)['X-Salcara-Pair-Token']) sent = url;
    return json({ devices: [] });
  } });
  await router.fetch(backup, '/app/devices', { headers: { 'X-Salcara-Pair-Token': 'private-pair' } });
  expect(sent).toBe(`${replacement}/app/devices`);
  expect(router.pinSnapshot(backup)?.hub_instance_id).toBe(hubId);
});

test('a replacement QR claim and anonymous discovery never use an older Hub routing authority', async () => {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  setHubFetch(async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/manifest')) return json(signedManifest());
    if (url.includes('/identity?')) return json(proof(new URL(url).searchParams.get('nonce')!));
    if (url.endsWith('/ping')) return json({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'], capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1'] });
    if (url.endsWith('/app/pair/qr')) return json({ pair_token: 'd'.repeat(64), device: { deviceId: 'replacement-device', name: 'New computer', tools: [], projects: [] } });
    return json({ devices: [] });
  }, true);
  await devices({ url: canonical, pairToken: 'old-pair', deviceId: 'old-device' });
  expect(calls.some(call => call.url === `${backup}/app/devices`)).toBe(true);
  await discoverStation(canonical);
  await confirmQrPair({ type: 'salcara-remote-pair', version: 1, hubUrl: canonical, deviceId: 'replacement-device', deviceName: 'New computer', ticket: 'e'.repeat(64), expiresAt: Date.now() + 300_000 });
  expect(calls.filter(call => call.url.endsWith('/ping')).map(call => call.url)).toEqual([`${canonical}/ping`]);
  const claim = calls.find(call => call.url.endsWith('/app/pair/qr'))!;
  expect(claim.url).toBe(`${canonical}/app/pair/qr`);
  expect(JSON.parse(claim.init.body as string).ticket).toBe('e'.repeat(64));
  expect(claim.init.redirect).toBe('error'); expect(claim.init.credentials).toBe('omit');
  expect(claim.init.headers).not.toHaveProperty('X-Salcara-Pair-Token');
});

test('expired stored authority retains its pin and does not forward credentials after a Hub reset', async () => {
  const now = Date.now(), previous = signedManifest(manifest(now - 86_400_001)); let credentialed = 0;
  const router = createIngressRouter({ now: () => now, nonce: () => nonce, storage: { read: async () => JSON.stringify(previous), write: async () => undefined }, fetch: async (url, init) => {
    if (JSON.stringify(init.headers).includes('private-pair')) credentialed++;
    return url.endsWith('/manifest') ? json(signedManifest({ ...manifest(now), hub_instance_id: 'e'.repeat(32) })) : json(proof());
  } });
  await expect(router.fetch(canonical, '/app/devices', { headers: { 'X-Salcara-Pair-Token': 'private-pair' } })).rejects.toBeInstanceOf(IngressIdentityError);
  expect(credentialed).toBe(0); expect(router.pinSnapshot(canonical)?.hub_instance_id).toBe(hubId);
});

test('only a successful explicitly confirmed pairing may replace a reset identity pin', async () => {
  const next = signedManifest({ ...manifest(), hub_instance_id: 'e'.repeat(32) });
  const router = createIngressRouter({ nonce: () => nonce, storage: { read: async () => JSON.stringify(signedManifest()), write: async () => undefined }, fetch: async () => json(next) });
  await router.confirmPairingIdentity(canonical, () => false);
  expect(router.pinSnapshot(canonical)?.hub_instance_id).toBe(hubId);
  await router.confirmPairingIdentity(canonical, () => true);
  expect(router.pinSnapshot(canonical)?.hub_instance_id).toBe(next.hub_instance_id);
});

test('a late old manifest storage write cannot overwrite a newly paired Hub identity on restart', async () => {
  let release!: () => void, entered = false, calls = 0, saved = '';
  const oldWrite = new Promise<void>(done => { release = done; });
  const next = signedManifest({ ...manifest(), hub_instance_id: 'e'.repeat(32) });
  const storage = { read: async () => saved || null, write: async (_url: string, value: string) => {
    if (!entered) { entered = true; await oldWrite; } saved = value;
  } };
  const router = createIngressRouter({ nonce: () => nonce, storage, fetch: async () => json(++calls === 1 ? signedManifest() : next) });
  const refreshing = router.refresh(canonical); await flush(); expect(entered).toBe(true);
  const pairing = router.confirmPairingIdentity(canonical, () => true); await flush(); release();
  await Promise.all([refreshing, pairing]);
  const restarted = createIngressRouter({ nonce: () => nonce, storage, fetch: async () => json({}, 503) });
  await restarted.resolve(canonical);
  expect(restarted.pinSnapshot(canonical)?.hub_instance_id).toBe(next.hub_instance_id);
});

test('evicting a cache entry cannot let its delayed storage write restore an older pairing pin', async () => {
  let release!: () => void, entered = false, calls = 0, saved = '';
  const blocked = new Promise<void>(done => { release = done; });
  const next = signedManifest({ ...manifest(), hub_instance_id: 'e'.repeat(32) });
  const storage = { read: async (url: string) => url === canonical ? saved || null : null, write: async (_url: string, value: string) => {
    if (!entered) { entered = true; await blocked; } saved = value;
  } };
  const router = createIngressRouter({ nonce: () => nonce, storage, fetch: async () => json(++calls === 1 ? signedManifest() : next) });
  const refreshing = router.refresh(canonical); await flush(); expect(entered).toBe(true);
  for (let i = 0; i < 32; i++) await router.resolve(`https://entry-${i}.example/v1`);
  const pairing = router.confirmPairingIdentity(canonical, () => true);
  await flush(); release(); await Promise.all([refreshing, pairing]);
  const restarted = createIngressRouter({ nonce: () => nonce, storage, fetch: async () => json({}, 503) });
  await restarted.resolve(canonical);
  expect(restarted.pinSnapshot(canonical)?.hub_instance_id).toBe(next.hub_instance_id);
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
  const m = signedManifest(), calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    if (url === `${canonical}/ingress/manifest`) throw new Error('offline');
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
    if (url.endsWith('/manifest')) return json(signedManifest());
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
    if (url.endsWith('/manifest')) { const m = manifest(); m.endpoints[1].priority = 200; return json(signedManifest(m)); }
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
    if (url.endsWith('/manifest')) { const m = manifest(); m.endpoints[1].priority = 200; return json(signedManifest(m)); }
    return json({});
  } });
  await router.refresh(canonical); calls.length = 0;
  await router.fetch(canonical, '/app/devices', { method: 'GET' });
  expect(calls).toEqual([`${canonical}/app/devices`]);
});

test('concurrent requests share proof checks, but still each send their own request', async () => {
  let checks = 0, requests = 0;
  const router = createIngressRouter({ nonce: () => nonce, fetch: async url => {
    if (url.endsWith('/manifest')) return json(signedManifest());
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
    if (url.endsWith('/manifest')) return json(signedManifest());
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
    if (url.endsWith('/manifest')) return json(signedManifest());
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
    if (url.endsWith('/manifest')) { learned = true; return json(signedManifest()); }
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
