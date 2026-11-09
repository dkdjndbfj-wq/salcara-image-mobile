import { remoteConnectionState, remoteDeviceConnected } from '../remote/connection-state';
import { connectionFailure } from '../remote/connection-errors';
import { HubError } from '../remote/client';

test.each([
  new HubError('private raw upstream body with secret-pair-token', 503),
  new HubError('private raw upstream body with secret-pair-token', 403, 'unknown_access_policy'),
  new HubError('private raw upstream body with secret-pair-token', 403, 'device_credentials_invalid'),
  new Error('private raw upstream body with secret-pair-token'),
])('transport connection state never persists an arbitrary server body: %s', error => {
  const failure = connectionFailure(error);
  expect(failure.connectionError).toBeTruthy();
  expect(JSON.stringify(failure)).not.toMatch(/private|upstream|secret-pair-token/);
});

test('a cached online computer never bypasses a disconnected Hub transport', () => {
  const device = { online: true };
  for (const connection of ['idle', 'connecting', 'retrying', 'error'] as const) {
    expect(remoteDeviceConnected({ connection }, device)).toBe(false);
  }
  expect(remoteDeviceConnected({ connection: 'open', connectionError: 'failed' }, device)).toBe(false);
  expect(remoteDeviceConnected({ connection: 'open' }, device)).toBe(true);
  expect(remoteDeviceConnected({ connection: 'open' }, { online: false })).toBe(false);
  expect(remoteDeviceConnected({ connection: 'open' })).toBe(false);
});

test('the one-dot status explains state without leaking transport error content', () => {
  const status = remoteConnectionState({ connection: 'open', connectionError: 'PRIVATE_CREDENTIAL' }, { online: true });
  expect(status.tone).toBe('error');
  expect(JSON.stringify(status)).not.toContain('PRIVATE_CREDENTIAL');
  expect(remoteConnectionState({ connection: 'open' }, { online: false }).label).toBe('电脑离线');
  expect(remoteConnectionState({ connection: 'retrying' }, { online: true }).tone).toBe('pending');
  expect(remoteConnectionState({ connection: 'open' }, { online: true }).tone).toBe('connected');
});

test('connection details use the selected Bot or relay and reject another computer\'s cached online state', () => {
  const relay = { id: 'relay-a', hubUrl: 'https://private.example', deviceId: 'pc-a', deviceName: '电脑 A', pairedAt: 1 };
  const bot = { ...relay, id: 'bot-b', deviceId: 'pc-b', deviceName: '电脑 B', botGroupId: 'private-group' };
  const remote = { connection: 'open' as const, connections: [relay, bot], connectionId: bot.id };
  const status = remoteConnectionState(remote, { deviceId: relay.deviceId, online: true });
  expect(status.label).toBe('电脑离线');expect(status.detail).toContain('Bot');expect(status.detail).not.toContain('中转站');
  for (const connection of ['connecting', 'retrying', 'error'] as const) {
    const details = remoteConnectionState({ ...remote, connection }, { deviceId: bot.deviceId, online: true });
    expect(details.detail).toContain('Bot');expect(details.detail).not.toContain('中转站');
  }
  expect(remoteConnectionState(remote, { deviceId: bot.deviceId, online: true }).tone).toBe('connected');
  expect(remoteConnectionState({ ...remote, connectionId: relay.id }, { deviceId: relay.deviceId, online: false }).detail).toContain('中转站');
  expect(JSON.stringify(status)).not.toMatch(/private\.example|private-group|pc-a|pc-b/);
});

test.each([
  ['pairing', '需要重新绑定'], ['permission', '远程访问受限'], ['enrollment', '电脑需要重新登记'],
  ['unsupported', '远程服务不兼容'], ['unavailable', '远程服务暂不可用'], ['timeout', '远程连接超时'],
] as const)('status preserves the safe %s reason without displaying raw service response data', (connectionProblem, label) => {
  const status = remoteConnectionState({ connection: 'error', connectionError: 'PRIVATE_CREDENTIAL', connectionProblem });
  expect(status.label).toBe(label); expect(JSON.stringify(status)).not.toContain('PRIVATE_CREDENTIAL');
});
