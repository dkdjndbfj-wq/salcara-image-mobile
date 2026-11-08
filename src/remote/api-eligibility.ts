import type { RemoteApiOption } from './client';
import type { RemoteConnection } from './connections';
import { canonicalHubUrl } from './pairing';

export const officialRemoteApi = (option: RemoteApiOption | undefined) => option?.sourceType === 'official_account' || option?.sourceType === 'oauth';
const SOURCE_TYPES = new Set(['api_key', 'reverse_proxy', 'official_account', 'oauth']);
const REASONS = new Set(['unsupported', 'station_mismatch', 'external_api_not_allowed', 'reverse_proxy_not_allowed', 'unavailable', 'supported']);

/** Public presentation metadata, never a source grant or a credential. */
export function parseRemoteApiMetadata(item: Record<string, unknown>): Pick<RemoteApiOption, 'sourceType' | 'remoteEligibility' | 'stations'> {
  const sourceType = typeof item.sourceType === 'string' && SOURCE_TYPES.has(item.sourceType) ? item.sourceType as RemoteApiOption['sourceType'] : undefined;
  const raw = item.remoteEligibility && typeof item.remoteEligibility === 'object' && !Array.isArray(item.remoteEligibility)
    ? item.remoteEligibility as Record<string, unknown> : {};
  const reason = typeof raw.reason === 'string' && REASONS.has(raw.reason) ? raw.reason as NonNullable<RemoteApiOption['remoteEligibility']>['reason'] : 'unavailable';
  const remoteEligibility = item.remoteEligibility === undefined ? undefined : {
    supported: raw.supported === true && reason === 'supported' && Boolean(sourceType), reason,
    apiRemote: raw.apiRemote === true, accountRemote: raw.accountRemote === true,
  };
  const seen = new Set<string>();
  const stations = Array.isArray(item.stations) ? item.stations.slice(0, 32).flatMap((value): NonNullable<RemoteApiOption['stations']> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const raw = value as Record<string, unknown>;
    if (typeof raw.hubUrl !== 'string' || raw.hubUrl.length > 512 || typeof raw.deviceId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(raw.deviceId)
      || typeof raw.checkedAt !== 'number' || !Number.isSafeInteger(raw.checkedAt) || raw.checkedAt <= 0) return [];
    try {
      const url = new URL(raw.hubUrl);
      if (url.username || url.password || url.search || url.hash) return [];
      const hubUrl = canonicalHubUrl(raw.hubUrl), key = `${hubUrl}|${raw.deviceId}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ hubUrl, deviceId: raw.deviceId, apiRemote: raw.apiRemote === true, accountRemote: raw.accountRemote === true, checkedAt: raw.checkedAt }];
    } catch { return []; }
  }) : undefined;
  return { ...(sourceType ? { sourceType } : {}), ...(remoteEligibility ? { remoteEligibility } : {}), ...(stations ? { stations } : {}) };
}

export function remoteApiProblem(option: RemoteApiOption | undefined, strict = false): string {
  if (!option) return strict ? '请先刷新电脑的 API 信息' : '';
  const eligibility = option.remoteEligibility;
  if (!eligibility) return officialRemoteApi(option) || strict ? '尚未确认本站远程能力，请刷新' : '';
  const account = officialRemoteApi(option);
  if (account && !eligibility.accountRemote) return '本站暂不支持账号远程';
  if (eligibility.reason === 'station_mismatch') return '此 API 属于其他中转站';
  if (eligibility.reason === 'external_api_not_allowed') return '本站未授权此 API 地址';
  if (eligibility.reason === 'reverse_proxy_not_allowed') return '本站未授权此逆向代理地址';
  if (!account && !eligibility.apiRemote) return '本站暂不支持 API 远程';
  return eligibility.supported && eligibility.reason === 'supported' ? '' : '尚未确认本站远程能力，请刷新';
}

/** Suggestions must intersect the phone's own paired computer identity. A
 * desktop cannot inject another user's connection or an arbitrary new URL. */
export function eligibleApiStations(option: RemoteApiOption | undefined, current: RemoteConnection | undefined, connections: readonly RemoteConnection[], now = Date.now()): RemoteConnection[] {
  if (!option || !current?.computerId) return [];
  const account = officialRemoteApi(option);
  const candidates = (option.stations ?? []).filter(station => station.checkedAt <= now + 60_000 && now - station.checkedAt <= 5 * 60_000
    && (account ? station.accountRemote : station.apiRemote));
  return connections.filter(connection => connection.id !== current.id && connection.computerId === current.computerId
    && candidates.some(candidate => candidate.deviceId === connection.deviceId && candidate.hubUrl === connection.hubUrl));
}
