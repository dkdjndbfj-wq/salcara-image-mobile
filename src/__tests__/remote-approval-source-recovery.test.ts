import { setHubFetch, type FetchLike } from '../remote/client';
import {
  bootRemote, connectStation, getRemoteState, loadAgentProfiles, pairRemoteQr,
  parseRemoteQr, remoteDeliveryScope, resetRemoteForTests, respondApproval, snapshotQuestionCommand, timelineKey,
} from '../remote/store';
import { markQuestionAttempt, pendingQuestionReceipts, prepareQuestionReceipt, resetQuestionOutboxForTests } from '../remote/question-outbox';

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

const origin = 'https://approval-source-recovery.example';
const sessionKey = 'codex:10000000-0000-4000-8000-000000000001';
const approvalId = '10000000-0000-4000-8000-000000000002';
const device = { deviceId: 'pc', name: 'Fixture', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 };
const reply = (value: unknown, status = 200) => ({ ok: status === 200, status, text: async () => JSON.stringify(value) });

beforeEach(() => { resetRemoteForTests(); resetQuestionOutboxForTests(); mockSettings.clear(); mockSecrets.clear(); });
afterEach(() => { resetRemoteForTests(); resetQuestionOutboxForTests(); setHubFetch(null); });

test.each([
  { name: 'changed source uses the original receipt only', changed: true, receiptOnly: true, legacy: false },
  { name: 'changed source fails closed without receipt-only capability', changed: true, receiptOnly: false, legacy: false },
  { name: 'unchanged handle uses receipt-only even when the card secret may have changed', changed: false, receiptOnly: true, legacy: false },
  { name: 'unchanged handle cannot authorize redispatch on older Hubs', changed: false, receiptOnly: false, legacy: false },
  { name: 'legacy attempted receipts never invent a source snapshot', changed: true, receiptOnly: true, legacy: true },
])('unknown question acknowledgement: $name', async scenario => {
  let accountId = 'api_aaaaaaaa';
  let acceptedCommand = '';
  const deliveries: Array<{ requestId: string; command: { accountId?: string }; receiptOnly?: boolean }> = [];
  setHubFetch((async (url, init) => {
    if (url.endsWith('/ping')) return reply({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1,
      authModes: ['device-pairing'], capabilities: ['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1', 'commands.idempotency.v1', ...(scenario.receiptOnly ? ['commands.receipt-only.v1'] : [])] });
    if (url.endsWith('/app/pair/qr')) return reply({ pair_token: 'a'.repeat(64), device });
    if (url.endsWith('/app/devices')) return reply({ devices: [device] });
    const body = JSON.parse(String(init.body));
    if (body.command?.type === 'agents.status') return reply({ ok: true, result: { agents: [{
      id: 'codex', available: true, remoteSendSupported: true,
      api: { source: 'computer', configured: true, accountId },
    }] } });
    if (body.command?.type === 'approval.respond') {
      deliveries.push(body);
      const encoded = JSON.stringify(body.command);
      if (!acceptedCommand) {
        acceptedCommand = encoded;
        return reply({ error: 'Synthetic acknowledgement lost after acceptance' }, 504);
      }
      if (encoded !== acceptedCommand) return reply({ code: 'request_id_conflict', error: 'Same request ID changed command' }, 409);
      return reply({ ok: true, result: {} });
    }
    throw new Error('Unexpected fixture endpoint');
  }) as FetchLike);
  await bootRemote([]); await connectStation(origin);
  await pairRemoteQr(parseRemoteQr(JSON.stringify({ type: 'salcara-remote-pair', version: 1,
    hubUrl: `${origin}/salcara-hub/v1`, deviceId: 'pc', deviceName: 'Fixture', ticket: 'b'.repeat(64), expiresAt: Date.now() + 60_000 })));
  await loadAgentProfiles('pc');
  const expiresAt = Date.now() + 60_000;
  getRemoteState().timelines[timelineKey('pc', sessionKey)] = { loading: false, items: [{
    kind: 'approval', id: approvalId, approval: 'question', title: 'Synthetic question', state: 'pending', ts: Date.now(), expiresAt,
  }] };
  const answers = { choice: ['yes'] };
  const target = { approvalId, deviceId: 'pc', sessionKey };
  const saved = await prepareQuestionReceipt({ scope: remoteDeliveryScope(), ...target, decision: 'allow', answers, expiresAt,
    ...(scenario.legacy ? {} : { command: snapshotQuestionCommand(target, 'allow', undefined, answers) }) });
  await markQuestionAttempt(saved);
  const receipt = { requestId: saved.requestId, retrying: false, scope: saved.scope, expiresAt, signal: new AbortController().signal, command: saved.command };
  await expect(respondApproval({ approvalId, deviceId: 'pc', sessionKey }, 'allow', undefined, answers, receipt)).rejects.toMatchObject({ status: 504 });

  // Another surface may change the API; the phone's local picker lock does
  // not serialize desktop configuration changes with this unknown receipt.
  accountId = scenario.changed ? 'api_bbbbbbbb' : accountId;
  await loadAgentProfiles('pc');
  resetQuestionOutboxForTests();
  const restored = (await pendingQuestionReceipts({ scope: saved.scope, deviceId: 'pc', sessionKey }))[0];
  const recovery = respondApproval(target, 'allow', restored.message, restored.answers, { ...receipt, retrying: true, command: restored.command });
  if (scenario.legacy || !scenario.receiptOnly) {
    await expect(recovery).rejects.toMatchObject({ code: scenario.legacy ? 'question_source_unconfirmed' : 'question_retry_unsupported' });
    expect(deliveries).toHaveLength(1);
    expect((await pendingQuestionReceipts({ scope: saved.scope, deviceId: 'pc', sessionKey }))[0].requestId).toBe(saved.requestId);
    return;
  }
  await expect(recovery).resolves.toBeUndefined();
  expect(deliveries).toHaveLength(2);
  expect(deliveries[1].command).toEqual(deliveries[0].command);
  expect(deliveries[1].requestId).toBe(deliveries[0].requestId);
  expect(deliveries[1].receiptOnly === true).toBe(scenario.receiptOnly);
  expect(deliveries[1].command.accountId).toBe('api_aaaaaaaa');
});
