import type { TimelineItem } from './store';

/** Pure helpers for the remote conversation (kept free of React Native for tests). */

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60), rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

export function formatTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return String(Math.round(n));
}

export interface TurnStat { durationMs?: number; tokens?: number }

/**
 * Duration and token use of each finished turn, attached to that turn's last
 * assistant reply. Only reported numbers are shown; history without a start
 * marker or usage simply shows less.
 */
export function turnStats(items: readonly TimelineItem[]): Map<string, TurnStat> {
  const stats = new Map<string, TurnStat>();
  let started: number | undefined;
  let lastAssistant: string | undefined;
  for (const item of items) {
    if (item.kind === 'turn' && item.status === 'started') { started = item.ts; lastAssistant = undefined; continue; }
    if (item.kind === 'message' && item.role === 'assistant' && !item.parentId) lastAssistant = item.id;
    if (item.kind === 'turn' && item.status === 'completed') {
      const usage = item.usage;
      const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
      const stat: TurnStat = {};
      if (started !== undefined && item.ts >= started) stat.durationMs = item.ts - started;
      if (tokens > 0) stat.tokens = tokens;
      if (lastAssistant && (stat.durationMs !== undefined || stat.tokens !== undefined)) stats.set(lastAssistant, stat);
      started = undefined; lastAssistant = undefined;
    }
  }
  return stats;
}

/** When the current run began: the latest start marker that has not completed yet. */
export function runningSince(items: readonly TimelineItem[]): number | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind !== 'turn') continue;
    return item.status === 'started' ? item.ts : undefined;
  }
  return undefined;
}

export function clockText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** First lines of a reply as a Markdown quote, for "引用回复". */
export function quoteFor(text: string): string {
  const plain = text.replace(/```[\s\S]*?```/g, '[代码]').replace(/\s+\n/g, '\n').trim();
  const short = plain.length > 160 ? `${plain.slice(0, 160)}…` : plain;
  return `${short.split('\n').slice(0, 4).map((line) => `> ${line}`).join('\n')}\n\n`;
}

export interface SearchMatch { blockIndex: number }

/** Blocks whose visible text contains the query (case-insensitive). */
export function searchBlocks(blocks: readonly { type: string; item?: unknown }[], query: string): number[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: number[] = [];
  blocks.forEach((block, index) => {
    const item = block.item as { text?: string; error?: string } | undefined;
    const text = block.type === 'user' || block.type === 'assistant' || block.type === 'notice' ? item?.text : block.type === 'turn' ? item?.error : undefined;
    if (text && text.toLowerCase().includes(needle)) hits.push(index);
  });
  return hits;
}

