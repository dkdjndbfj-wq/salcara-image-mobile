import { remoteConnectionState, remoteDeviceConnected } from '../remote/connection-state';

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
