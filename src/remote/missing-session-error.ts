import { HubError } from './client';

/** Only a rejected read from the authenticated computer can establish this.
 * Offline, protocol failures, an empty directory and generic HTTP 404 cannot. */
export function missingSessionReadCode(error: unknown): 'session_not_found' | 'deleted' | undefined {
  if (!(error instanceof Error)) return;
  const coded = error as Error & { code?: string };
  const fromComputer = error instanceof HubError ? error.status === 200 : error.name === 'DirectApiError' && coded.code === 'remote';
  if (!fromComputer) return;
  if (coded.code === 'session_deleted') return 'deleted';
  if (coded.code === 'session_not_found' || coded.code === 'thread_not_found') return 'session_not_found';
  // Compatibility with older Bridge/CLI versions, whose exact read failures
  // have no typed condition. Do not search incidental words anywhere in prose.
  const message = error.message.trim();
  if (/^(?:找不到这个会话|会话不存在|会话已删除)(?:$|[:：]\s*[^\r\n]+$)/u.test(message)
    || /^(?:thread|session) (?:not found|does not exist)(?:$|:\s*[^\r\n]+$)/i.test(message)
    || /^(?:thread|session) [a-z0-9_-]+ (?:not found|does not exist)$/i.test(message)
    || /^no rollout found for thread id [a-z0-9_-]+$/i.test(message)) return 'session_not_found';
  return;
}
