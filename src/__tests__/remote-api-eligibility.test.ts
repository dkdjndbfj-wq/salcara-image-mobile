import { eligibleApiStations, parseRemoteApiMetadata, remoteApiProblem } from '../remote/api-eligibility';
import type { RemoteApiOption } from '../remote/client';
import type { RemoteConnection } from '../remote/connections';

const api: RemoteApiOption = { id: 'api_aaaaaaaa', name: 'Fixture', models: [], sourceType: 'official_account' };
const current: RemoteConnection = { id: 'a', hubUrl: 'https://a.example/salcara-hub/v1', deviceId: 'a-pc', deviceName: 'Fixture', computerId: 'same-pc', pairedAt: 1 };
const target: RemoteConnection = { ...current, id: 'b', hubUrl: 'https://b.example/salcara-hub/v1', deviceId: 'b-pc' };

test('official account remote needs explicit support, never inferred from key names', () => {
  expect(remoteApiProblem(api)).toBeTruthy();
  expect(remoteApiProblem({ ...api, name: 'safe name', remoteEligibility: { supported: true, reason: 'supported', apiRemote: true, accountRemote: false } })).toBe('本站暂不支持账号远程');
  expect(remoteApiProblem({ ...api, remoteEligibility: { supported: true, reason: 'supported', apiRemote: false, accountRemote: true } })).toBe('');
  expect(remoteApiProblem({ ...api, sourceType: 'api_key', remoteEligibility: { supported: false, reason: 'station_mismatch', apiRemote: true, accountRemote: true } })).toBe('此 API 属于其他中转站');
  expect(remoteApiProblem({ ...api, sourceType: undefined }, true)).toBeTruthy();
});

test('suggested station must belong to the same physical paired computer and be recently checked', () => {
  const now = Date.now();
  const stations = [{ hubUrl: target.hubUrl, deviceId: target.deviceId, apiRemote: false, accountRemote: true, checkedAt: now }];
  expect(eligibleApiStations({ ...api, stations }, current, [current, target], now)).toEqual([target]);
  expect(eligibleApiStations({ ...api, stations }, current, [{ ...target, computerId: 'someone-else' }], now)).toEqual([]);
  expect(eligibleApiStations({ ...api, stations }, current, [{ ...target, deviceId: 'other' }], now)).toEqual([]);
  expect(eligibleApiStations({ ...api, stations }, current, [{ ...target, hubUrl: 'https://other.example/salcara-hub/v1' }], now)).toEqual([]);
  for (const checkedAt of [now - 301000, now + 61000]) expect(eligibleApiStations({ ...api, stations: [{ ...stations[0], checkedAt }] }, current, [target], now)).toEqual([]);
  expect(eligibleApiStations({ ...api, stations: [{ ...stations[0], accountRemote: false }] }, current, [target], now)).toEqual([]);
});

test('metadata parser drops credentials and cannot grant from truthy or unknown input', () => {
  const raw = { sourceType: 'official_account', key: 'synthetic-secret', remoteEligibility: { supported: 'true', reason: 'supported', apiRemote: 1, accountRemote: 'true', token: 'synthetic' },
    stations: [{ ...target, checkedAt: Date.now(), accountRemote: true, apiRemote: false, secret: 'synthetic' },
      { ...target, checkedAt: Date.now(), accountRemote: true, apiRemote: false },
      { ...target, hubUrl: 'https://name:secret@bad.example/salcara-hub/v1', checkedAt: Date.now(), accountRemote: true }] };
  const parsed = parseRemoteApiMetadata(raw);
  expect(parsed.remoteEligibility).toEqual({ supported: false, reason: 'supported', apiRemote: false, accountRemote: false });
  expect(parsed.stations).toHaveLength(1); expect(JSON.stringify(parsed)).not.toMatch(/synthetic|secret|name:|computerId/);
  expect(parseRemoteApiMetadata({ sourceType: 'future', remoteEligibility: { supported: true, reason: 'supported', accountRemote: true } }).remoteEligibility?.supported).toBe(false);
});

test.each([
  ['api_key', 'external_api_not_allowed', '本站未授权此 API 地址'],
  ['reverse_proxy', 'reverse_proxy_not_allowed', '本站未授权此逆向代理地址'],
] as const)('renders %s scope denial without turning public metadata into a grant', (sourceType, reason, message) => {
  for (const apiRemote of [true, false]) {
    const metadata = parseRemoteApiMetadata({ sourceType, remoteEligibility: { supported: true, reason, apiRemote, accountRemote: false } });
    expect(metadata.remoteEligibility).toEqual({ supported: false, reason, apiRemote, accountRemote: false });
    expect(remoteApiProblem({ ...api, ...metadata }, true)).toBe(message);
  }
  const allowed = parseRemoteApiMetadata({ sourceType, remoteEligibility: { supported: true, reason: 'supported', apiRemote: true, accountRemote: false } });
  expect(remoteApiProblem({ ...api, ...allowed }, true)).toBe('');
});

test('unrecognized source-scope reasons remain unavailable and cannot permit sending', () => {
  const metadata = parseRemoteApiMetadata({ sourceType: 'api_key', remoteEligibility: { supported: true, reason: 'future_scope', apiRemote: true, accountRemote: true } });
  expect(metadata.remoteEligibility?.reason).toBe('unavailable');
  expect(metadata.remoteEligibility?.supported).toBe(false);
  expect(remoteApiProblem({ ...api, ...metadata }, true)).toBe('尚未确认本站远程能力，请刷新');
});
