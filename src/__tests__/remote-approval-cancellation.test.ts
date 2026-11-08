import { setHubFetch, type FetchLike } from '../remote/client';
import {
  bootRemote, connectStation, getRemoteState, loadAgentProfiles, pairRemoteQr,
  parseRemoteQr, remoteDeliveryScope, resetRemoteForTests, respondApproval, timelineKey,
} from '../remote/store';

const mockSettings = new Map<string, string>(), mockSecrets = new Map<string, string>();
jest.mock('../storage/database', () => ({
  getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); },
}));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'fixture',
  getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); },
  deleteItemAsync: async (key: string) => { mockSecrets.delete(key); },
}));
jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID() }));

const origin = 'https://approval-cancellation.example';
const sessionKey = 'codex:10000000-0000-4000-8000-000000000001';
const approvalId = '10000000-0000-4000-8000-000000000002';
const requestId = '10000000-0000-4000-8000-000000000003';
const device = { deviceId: 'pc', name: 'Fixture', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 };
const reply = (value: unknown, status = 200) => ({ ok: status === 200, status, text: async () => JSON.stringify(value) });

beforeEach(() => { resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); });
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });

test.each(['cli', 'desktop'] as const)('%s approval cancellation stops source acquisition before any authorized redispatch', async surface => {
  for (const cancelAt of ['challenge', 'grant'] as const) {
    const controller = new AbortController();
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    let approvalWrites = 0;
    setHubFetch((async (url, init) => {
      if (url.endsWith('/ping')) return reply({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1,
        authModes: ['device-pairing'], capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1', 'commands.idempotency.v1'] });
      if (url.endsWith('/app/pair/qr')) return reply({ pair_token: 'a'.repeat(64), device });
      if (url.endsWith('/app/devices')) return reply({ devices: [device] });
      const body = JSON.parse(String(init.body));
      if (body.command?.type === 'agents.status') return reply({ ok: true, result: { agents: [{
        id: 'codex', available: true, remoteSendSupported: true,
        api: { source: 'computer', configured: true, accountId: 'api_aaaaaaaa' },
        desktopLive: { active: true, expiresAt: Date.now() + 60_000, sessionKeys: [sessionKey],
          accountId: 'api_bbbbbbbb', approvalTransport: 'codex-hook-v1',
          capabilities: { list: true, read: true, send: true, approval: true } },
      }] } });
      const path = new URL(url).pathname;
      calls.push({ path, body });
      if (url.endsWith('/app/commands')) {
        approvalWrites += 1;
        return approvalWrites === 1 ? reply({ code: 'source_grant_required' }, 403) : reply({ ok: true, result: {} });
      }
      if (url.endsWith('/app/source/challenge')) {
        if (cancelAt === 'challenge') controller.abort();
        return reply({ challengeId: 'challenge-fixture' });
      }
      if (url.endsWith('/app/source/grant')) {
        controller.abort();
        return reply({ sourceGrant: { payload: 'YWJj', signature: 'a'.repeat(86) } });
      }
      throw new Error('Unexpected fixture endpoint');
    }) as FetchLike);
    await bootRemote([]); await connectStation(origin);
    await pairRemoteQr(parseRemoteQr(JSON.stringify({ type: 'salcara-remote-pair', version: 1,
      hubUrl: `${origin}/salcara-hub/v1`, deviceId: 'pc', deviceName: 'Fixture', ticket: 'b'.repeat(64), expiresAt: Date.now() + 60_000 })));
    await loadAgentProfiles('pc');
    const expiresAt = Date.now() + 60_000;
    getRemoteState().timelines[timelineKey('pc', sessionKey)] = { loading: false, items: [{
      kind: 'approval', id: approvalId, approval: 'command', title: 'Synthetic permission', state: 'pending', ts: Date.now(), expiresAt,
      ...(surface === 'desktop' ? { approvalTransport: 'codex-hook-v1' as const } : {}),
    }] };
    await expect(respondApproval({ approvalId, deviceId: 'pc', sessionKey, controlSurface: surface }, 'allow', undefined, undefined, {
      requestId, retrying: false, scope: remoteDeliveryScope(), expiresAt, signal: controller.signal,
    })).rejects.toMatchObject({ code: 'aborted' });
    expect(approvalWrites).toBe(1);
    expect(calls.map(call => call.path)).toEqual([
      '/salcara-hub/v1/app/commands', '/salcara-hub/v1/app/source/challenge',
      ...(cancelAt === 'grant' ? ['/salcara-hub/v1/app/source/grant'] : []),
    ]);
    expect(calls[0].body.requestId).toBe(requestId);
    expect(getRemoteState().timelines[timelineKey('pc', sessionKey)].items[0]).toMatchObject({ kind: 'approval', state: 'pending' });
    resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear();
  }
});
