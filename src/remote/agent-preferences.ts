import { sha256 } from '@noble/hashes/sha2.js';
import { getSetting, setSetting } from '../storage/database';
import type { AgentId } from './client';
import { validAgentId } from './projection';

/** Navigation preference, never authorization. Remote IDs include the exact
 * relay/Bot profile; Direct uses its credential/fingerprint delivery scope. */
export interface AgentPreferenceScope { kind: 'remote' | 'direct'; connectionId: string; deviceId: string }
const PREFIX = 'remote_agent_preference_v2_';
let tail: Promise<void> = Promise.resolve();
function serialized<T>(action: () => Promise<T>): Promise<T> {
  const operation = tail.then(action, action);
  tail = operation.then(() => undefined, () => undefined);
  return operation;
}
function keyFor(scope: AgentPreferenceScope | null | undefined): string | null {
  if (!scope || !['remote', 'direct'].includes(scope.kind)
    || typeof scope.connectionId !== 'string' || !scope.connectionId || scope.connectionId.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(scope.connectionId)
    || typeof scope.deviceId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(scope.deviceId)) return null;
  const identity = JSON.stringify([scope.kind, scope.connectionId, scope.deviceId]);
  return PREFIX + Array.from(sha256(new TextEncoder().encode(identity)), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** No legacy global migration: its originating computer is unknowable. */
export function readPreferredAgent(scope: AgentPreferenceScope | null | undefined): Promise<AgentId | null> {
  const key = keyFor(scope);
  if (!key) return Promise.resolve(null);
  return serialized(async () => {
    const saved = await getSetting(key);
    return validAgentId(saved) ? saved : null;
  });
}
export function rememberPreferredAgent(scope: AgentPreferenceScope | null | undefined, agent: AgentId): Promise<void> {
  const key = keyFor(scope);
  if (!key || !validAgentId(agent)) return Promise.reject(new Error('电脑 Agent 选择无效'));
  return serialized(() => setSetting(key, agent));
}
export function clearPreferredAgent(scope: AgentPreferenceScope | null | undefined): Promise<void> {
  const key = keyFor(scope);
  return key ? serialized(() => setSetting(key, null)) : Promise.resolve();
}
