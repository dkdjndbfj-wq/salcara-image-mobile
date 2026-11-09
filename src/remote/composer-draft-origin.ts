export interface ComposerDraftOrigin {
  transport: 'hub' | 'direct';
  deviceId: string;
  agentId: string;
  cwd: string;
  projectless?: true;
  mode: 'code' | 'work';
  apiIdentity: string;
  sessionKey?: string;
}
export interface MissingSessionEvidence { kind: 'session_not_found' | 'deleted'; deviceId: string; sessionKey: string }
const bounded = (value: unknown, limit: number, empty = false): value is string => typeof value === 'string' && (empty || value.length > 0) && value.length <= limit && !/[\r\n\0]/u.test(value);
export function validComposerDraftOrigin(value: unknown): value is ComposerDraftOrigin {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as ComposerDraftOrigin;
  return Object.keys(v).every(key => ['transport', 'deviceId', 'agentId', 'cwd', 'projectless', 'mode', 'apiIdentity', 'sessionKey'].includes(key))
    && (v.transport === 'hub' || v.transport === 'direct') && bounded(v.deviceId, 256) && !v.deviceId.includes('|')
    && bounded(v.agentId, 1024) && !v.agentId.includes('|') && bounded(v.cwd, 4096, v.projectless === true) && (v.projectless === undefined || v.projectless === true && (Boolean(v.sessionKey) || v.cwd === ''))
    && (v.mode === 'code' || v.mode === 'work') && bounded(v.apiIdentity, 16384, true)
    && (v.sessionKey === undefined || bounded(v.sessionKey, 1024) && /^[a-z][a-z0-9_-]*:[^|]+$/i.test(v.sessionKey));
}
export function sameComposerDraftOrigin(a: ComposerDraftOrigin, b: ComposerDraftOrigin, includeSession = true): boolean {
  return validComposerDraftOrigin(a) && validComposerDraftOrigin(b) && a.transport === b.transport && a.deviceId === b.deviceId && a.agentId === b.agentId
    && a.cwd === b.cwd && a.projectless === b.projectless && a.mode === b.mode && a.apiIdentity === b.apiIdentity && (!includeSession || a.sessionKey === b.sessionKey);
}
export function composerOriginMatchesKey(origin: ComposerDraftOrigin, key: string, scope: string): boolean {
  if (!validComposerDraftOrigin(origin) || !key.startsWith(`${scope}|${origin.deviceId}|`)) return false;
  const suffix = key.slice(`${scope}|${origin.deviceId}|`.length);
  return origin.transport === 'direct' ? /^direct-composer:[a-f0-9]{64}$/.test(suffix)
    : suffix === (origin.sessionKey ?? `new:${origin.agentId}:${origin.mode}:${origin.projectless ? 'projectless' : encodeURIComponent(origin.cwd)}`);
}
/** A network timeout or a missing cached row never establishes deletion. */
export function confirmedMissingSession(evidence: MissingSessionEvidence | undefined, origin?: ComposerDraftOrigin): boolean {
  return Boolean(evidence && (evidence.kind === 'session_not_found' || evidence.kind === 'deleted')
    && bounded(evidence.deviceId, 256) && bounded(evidence.sessionKey, 1024)
    && (!origin || validComposerDraftOrigin(origin) && origin.deviceId === evidence.deviceId && origin.sessionKey === evidence.sessionKey));
}
