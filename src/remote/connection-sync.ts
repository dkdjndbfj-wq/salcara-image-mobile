import { canonicalHubUrl } from './pairing';

export interface SyncedPhoneConnection { hubUrl: string; deviceId: string; deviceName: string; token?: string; error?: string; retained?: true }
export interface ConnectionSyncResult { computerId: string; connections: SyncedPhoneConnection[] }

/** Only an authenticated Bridge reply is admitted. Never import a catalog
 * from a QR, discovery response, device name, or arbitrary link. */
export function parseConnectionSync(value: unknown, computerId: string): ConnectionSyncResult {
  const invalid = () => new Error('电脑返回的中转站绑定信息无效');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const result = value as Record<string, unknown>;
  if (result.computerId !== computerId || !Array.isArray(result.connections) || result.connections.length > 32) throw invalid();
  const seen = new Set<string>();
  const connections = result.connections.map((value): SyncedPhoneConnection => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
    const row = value as Record<string, unknown>;
    if (typeof row.hubUrl !== 'string' || typeof row.deviceId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(row.deviceId)
      || typeof row.deviceName !== 'string' || !row.deviceName.trim() || row.deviceName.length > 200 || /[\u0000-\u001f]/.test(row.deviceName)) throw invalid();
    const hubUrl = canonicalHubUrl(row.hubUrl);
    const identity = `${hubUrl}\u0000${row.deviceId}`;
    if (seen.has(identity)) throw invalid();
    seen.add(identity);
    if (row.retained === true) {
      if (row.token !== undefined || row.error !== undefined) throw invalid();
      return { hubUrl, deviceId: row.deviceId, deviceName: row.deviceName, retained: true };
    }
    if (row.retained !== undefined) throw invalid();
    if (row.token !== undefined) {
      if (typeof row.token !== 'string' || !/^[a-f0-9]{64}$/.test(row.token) || row.error !== undefined) throw invalid();
      return { hubUrl, deviceId: row.deviceId, deviceName: row.deviceName, token: row.token };
    }
    if (typeof row.error !== 'string' || !row.error || row.error.length > 200 || /[\u0000-\u001f]/.test(row.error)) throw invalid();
    return { hubUrl, deviceId: row.deviceId, deviceName: row.deviceName, error: row.error };
  });
  return { computerId, connections };
}
