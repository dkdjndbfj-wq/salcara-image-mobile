import type { AgentId, AgentProfile } from './client';
import { resolveAgentExecution } from './projection';

/** Claude remote execution is API-only, including Desktop Code's CLI adapter.
 * “Follow computer” is valid only after the computer confirms its applied API;
 * an installed CLI or its native login is not an execution credential. */
export function claudeApiAdmissionReady(profile: AgentProfile | undefined, legacyId?: AgentId): boolean {
  if (resolveAgentExecution(profile, legacyId)?.tool !== 'claude') return true;
  return profile?.api.configured === true && profile.api.pending === false
    && (profile.api.source === 'computer' || profile.api.source === 'phone')
    && /^api_[a-f0-9]{8,64}$/.test(profile.api.accountId ?? '');
}
