import type { HubEvent } from './client';

export type ForegroundTaskNotice = { text: string; icon: 'checkCircle' | 'alert' | 'chat' };

/** Events worth interrupting the user for outside the currently open thread. */
export function taskNoticeKind(event: HubEvent): 'completed' | 'failed' | 'reply' | null {
  if (event.type === 'turn' && event.status === 'completed') return 'completed';
  if (event.type === 'turn' && event.status === 'failed') return 'failed';
  if (event.type === 'message' && event.role === 'assistant' && event.final
    && !event.parentId && event.messagePhase !== 'commentary') return 'reply';
  return null;
}

/** Keep foreground notices rare: only a completed/failed task or a final reply. */
export function foregroundTaskNotice(event: HubEvent, sessionTitle: string, isVisibleThread: boolean, agentName: string): ForegroundTaskNotice | null {
  if (isVisibleThread) return null;
  const name = sessionTitle.trim() || '远程任务';
  switch (taskNoticeKind(event)) {
    case 'completed': return { text: `${agentName} 已完成 · ${name}`, icon: 'checkCircle' };
    case 'failed': return { text: `${agentName} 失败 · ${name}`, icon: 'alert' };
    case 'reply': return { text: `${agentName} 有新回复 · ${name}`, icon: 'chat' };
    default: return null;
  }
}
