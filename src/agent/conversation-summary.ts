import { runAgentTurn } from '../api/chat-api';
import type { ChatApi } from '../domain';
import { getSetting, listMessages, setSetting } from '../storage/database';
import { pairsToFold, summaryPrompt, SUMMARY_SYSTEM, type ConversationSummary } from './context-window';

/** Rolling summaries of assistant conversations, kept in the settings table (one row per conversation). */

const keyFor = (conversationId: string) => `conversation_summary:${conversationId}`;

export async function loadConversationSummary(conversationId: string): Promise<ConversationSummary | null> {
  try {
    const value: unknown = JSON.parse((await getSetting(keyFor(conversationId))) || 'null');
    const record = value as ConversationSummary | null;
    return record && typeof record.text === 'string' && typeof record.until === 'number' ? record : null;
  } catch {
    return null;
  }
}

export async function deleteConversationSummary(conversationId: string): Promise<void> {
  await setSetting(keyFor(conversationId), null).catch(() => undefined);
}

export interface SummaryModel { baseUrl: string; apiKey: string; model: string; api?: ChatApi }

const running = new Map<string, Promise<ConversationSummary | null>>();

/**
 * Folds old turns into the summary. Runs in the background after a reply; `force` folds even small
 * backlogs (used when a smaller model can't fit the unsummarized history). One run per conversation at a
 * time; a few chunks per run so a very long imported history catches up without one huge request.
 */
export function compactConversation(conversationId: string, model: SummaryModel, options: { force?: boolean; signal?: AbortSignal; maxChunks?: number } = {}): Promise<ConversationSummary | null> {
  const existing = running.get(conversationId);
  if (existing) return existing;
  const job = (async () => {
    let summary = await loadConversationSummary(conversationId);
    const history = await listMessages(conversationId);
    for (let chunk = 0; chunk < (options.maxChunks ?? 3); chunk += 1) {
      const pairs = pairsToFold(history, summary, options.force);
      if (!pairs.length) break;
      const result = await runAgentTurn({
        ...model, prompt: summaryPrompt(summary?.text ?? '', pairs), history: [], system: SUMMARY_SYSTEM, toolMode: 'none', signal: options.signal,
      });
      const text = result.text.trim();
      if (!text) break;
      // The conversation may have been deleted meanwhile; don't resurrect its summary.
      if (!(await listMessages(conversationId)).length) return null;
      summary = { text: text.slice(0, 6000), until: pairs[pairs.length - 1][1].createdAt, updatedAt: Date.now() };
      await setSetting(keyFor(conversationId), JSON.stringify(summary));
    }
    return summary;
  })().finally(() => running.delete(conversationId));
  running.set(conversationId, job);
  return job;
}
