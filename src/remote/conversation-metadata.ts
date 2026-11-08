import { copyContextReferences, type ContextReference } from './context-references';

export function messageContextReferences(value: unknown, role: unknown = 'user'): ContextReference[] | undefined {
  return role === 'user' ? copyContextReferences(value) : undefined;
}

import type { MessageOrigin, SessionInfo } from './client';
import { validSkillReferences, type SkillReference } from './agent-features';
import { copySkillReference } from './skill-display-metadata';

/** Explicit message references are display metadata, never a fresh send intent.
 * Do not recover them from $tokens, command text, or the current skill catalog. */
export function messageSkills(value: unknown, role: unknown = 'user'): SkillReference[] | undefined {
  return role === 'user' && validSkillReferences(value)
    ? value.map(copySkillReference) : undefined;
}

/** Do not expose guessed sender links or carry arbitrary upstream properties
 * (such as a URL or token) into a cache. This is display metadata, not auth. */
export function messageOrigin(value: unknown): MessageOrigin | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const origin = value as MessageOrigin;
  if (origin.kind === 'delegation') return origin.verification === 'native_reported' && typeof origin.sourceSessionKey === 'string' && /^claude:[A-Za-z0-9_-]{1,160}$/.test(origin.sourceSessionKey)
    ? { kind: 'delegation', verification: 'native_reported', sourceSessionKey: origin.sourceSessionKey } : { kind: 'delegation' };
  if (origin.kind !== 'user_cross_task' || origin.verification !== 'bridge_receipt'
    || typeof origin.sourceSessionKey !== 'string' || typeof origin.targetSessionKey !== 'string'
    || !/^(codex|claude):[A-Za-z0-9_-]{1,160}$/.test(origin.sourceSessionKey) || !/^(codex|claude):[A-Za-z0-9_-]{1,160}$/.test(origin.targetSessionKey)
    || origin.sourceSessionKey === origin.targetSessionKey || origin.sourceSessionKey.split(':')[0] !== origin.targetSessionKey.split(':')[0]
    || typeof origin.receiptId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(origin.receiptId)) return undefined;
  return { kind: 'user_cross_task', verification: 'bridge_receipt', sourceSessionKey: origin.sourceSessionKey, targetSessionKey: origin.targetSessionKey,
    receiptId: origin.receiptId, sourceTitle: boundedAgentLabel(origin.sourceTitle) };
}

export function boundedAgentLabel(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 640 || Array.from(value).length > 160 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value.trim() || undefined;
}

/** Nickname is preferred only for an actual child, never as an identity key. */
export function childAgentTitle(session: Pick<SessionInfo, 'title' | 'agentNickname'>): string {
  return boundedAgentLabel(session.agentNickname) ?? session.title;
}

export function boundedClientId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}

function boundedTurnId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value) ? value : undefined;
}

/** Related handles remain display metadata; never an authorized send target. */
export function sessionMetadata(session: SessionInfo): SessionInfo {
  const fork = session.forkedFromSessionKey;
  return { ...session, activeTurnId: boundedTurnId(session.activeTurnId), lastTerminalTurnId: boundedTurnId(session.lastTerminalTurnId),
    agentNickname: boundedAgentLabel(session.agentNickname), agentRole: boundedAgentLabel(session.agentRole),
    forkedFromSessionKey: typeof fork === 'string' && fork.startsWith(`${session.tool}:`)
      && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}:[^|\u0000-\u001f\u007f]{1,160}$/.test(fork) ? fork : undefined };
}
