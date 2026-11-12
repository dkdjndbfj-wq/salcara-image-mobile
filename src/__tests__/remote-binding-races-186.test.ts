import { setHubFetch } from '../remote/client';
import { bootRemote, getRemoteState, loadAgentProfiles, openSession, pairScannedRemoteQr, parseScannedRemoteQr,
  refreshDevices, resetRemoteForTests, syncSessionEvents } from '../remote/store';
const mockSettings = new Map<string, string>(), mockSecrets = new Map<string, string>();
jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID(), getRandomBytesAsync: async () => new Uint8Array(32).fill(23) }));
jest.mock('../storage/database', () => ({
  getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); },
}));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'fixture',
  getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); },
  deleteItemAsync: async (key: string) => { mockSecrets.delete(key); },
}));
const url = 'https://mobile186-fixture.example/salcara-hub/v1';
const device = { deviceId: 'pc', name: 'Fixture', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 };
const capabilities = ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1'];
const discovery = { service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'], capabilities };
const reply = (value: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value) });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const qr = (ticket: string) => parseScannedRemoteQr(JSON.stringify({ type: 'salcara-remote-pair', version: 1, hubUrl: url, deviceId: 'pc',
  deviceName: 'Fixture', ticket: ticket.repeat(64), expiresAt: Date.now() + 120_000 }));
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function until(check: () => boolean) { for (let i = 0; i < 30 && !check(); i++) await tick(); expect(check()).toBe(true); }
beforeEach(() => { resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); });
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });

test('an older phone-token rejection cannot supersede an already-started new QR claim', async () => {
  const oldDevices = deferred<ReturnType<typeof reply>>(), claim = deferred<ReturnType<typeof reply>>();
  let claims = 0, devicesEntered = false, claimEntered = false;
  setHubFetch(async endpoint => {
    if (endpoint.endsWith('/ping')) return reply(discovery);
    if (endpoint.endsWith('/app/pair/qr')) {
      if (++claims === 1) return reply({ pair_token: 'a'.repeat(64), device });
      claimEntered = true; return claim.promise;
    }
    if (endpoint.endsWith('/app/devices')) { devicesEntered = true; return oldDevices.promise; }
    return reply({ events: [], nextSeq: 0, lastSeq: 0, hasMore: false });
  });
  await bootRemote([]); await pairScannedRemoteQr(qr('b'));
  const id = getRemoteState().connectionId;
  const reading = refreshDevices().catch(() => undefined); await until(() => devicesEntered);
  const pairing = pairScannedRemoteQr(qr('d')); await until(() => claimEntered);
  oldDevices.resolve(reply({ code: 'pair_credentials_invalid' }, 403)); await reading;
  claim.resolve(reply({ pair_token: 'c'.repeat(64), device })); await pairing;
  expect(getRemoteState()).toMatchObject({ phase: 'ready', connectionId: id, connection: 'open', connectionError: undefined });
});

test('an old delayed transcript repair cannot clear the current re-pair requirement', async () => {
  const repair = deferred<ReturnType<typeof reply>>();
  let opens = 0, repairEntered = false, rejectDevices = false;
  const session = { sessionKey: 'codex:fixture', tool: 'codex', client: 'Codex', title: 'Fixture', cwd: 'C:/fixture',
    updatedAt: 1, status: 'idle', controllable: true, controlSurface: 'cli' };
  const partial = { type: 'message', deviceId: 'pc', sessionKey: session.sessionKey, tool: 'codex', id: 'assistant',
    role: 'assistant', text: 'partial', final: false, turnId: 'turn-1', ts: 10, seq: 10 };
  const history = () => reply({ ok: true, result: { session, events: [partial] } });
  setHubFetch(async (endpoint, init) => {
    if (endpoint.endsWith('/ping')) return reply(discovery);
    if (endpoint.endsWith('/app/pair/qr')) return reply({ pair_token: 'a'.repeat(64), device });
    if (endpoint.endsWith('/app/devices')) return rejectDevices ? reply({ code: 'pair_credentials_invalid' }, 403) : reply({ devices: [device] });
    if (endpoint.endsWith('/app/commands')) {
      const command = JSON.parse(String(init.body)).command;
      if (command.type === 'agents.status') return reply({ ok: true, result: { agents: [{ id: 'codex', tool: 'codex', name: 'Codex',
        available: true, remoteSendSupported: true, capabilities: { list: true, read: true, send: true }, api: { configured: true, source: 'computer' } }] } });
      if (command.type === 'session.open') {
        if (++opens === 1) return history();
        repairEntered = true; return repair.promise;
      }
      throw new Error('Unexpected synthetic command ' + command.type);
    }
    if (new URL(endpoint).searchParams.get('limit') === '1') return reply({ events: [], nextSeq: 0, lastSeq: 10, hasMore: false });
    return reply({ events: [{ type: 'turn', deviceId: 'pc', sessionKey: session.sessionKey, tool: 'codex',
      status: 'completed', turnId: 'turn-1', ts: 11, seq: 11 }], nextSeq: 11, lastSeq: 11, hasMore: false });
  });
  await bootRemote([]); await pairScannedRemoteQr(qr('b')); await loadAgentProfiles('pc'); await openSession('pc', session.sessionKey);
  const syncing = syncSessionEvents('pc', session.sessionKey); await until(() => repairEntered);
  rejectDevices = true; await refreshDevices().catch(() => undefined);
  expect(getRemoteState()).toMatchObject({ phase: 'pairing', connection: 'error', connectionProblem: 'pairing' });
  repair.resolve(history()); await syncing;
  expect(getRemoteState()).toMatchObject({ phase: 'pairing', connection: 'error', connectionProblem: 'pairing' });
});
