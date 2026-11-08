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
  type Turn = { id?: string; started?: number; lastAssistant?: string; terminal?: Extract<TimelineItem, { kind: 'turn' }> };
  const identified = new Map<string, Turn>();
  const turns = new Set<Turn>();
  const create = (id?: string): Turn => {
    const turn: Turn = { id };
    turns.add(turn);
    if (id) identified.set(id, turn);
    return turn;
  };
  let current = create();
  const knownTurn = (id: string): Turn => identified.get(id) ?? create(id);
  for (const item of items) {
    if ('parentId' in item && item.parentId) continue;
    if (item.kind === 'turn' && item.status === 'started') {
      current = item.turnId ? knownTurn(item.turnId) : create();
      current.started ??= item.ts;
      continue;
    }
    if (item.kind === 'message') {
      // A new unlabelled user turn is a boundary even when old history lacks
      // start markers. Local queued prompts are not evidence of a new turn.
      if (item.role === 'user' && !item.local && !item.turnId && !current.id && current.lastAssistant) current = create();
      if (item.role === 'assistant' && item.final && item.messagePhase !== 'commentary' && item.text.trim()) {
        const turn = item.turnId ? knownTurn(item.turnId) : current;
        turn.lastAssistant = item.id;
      }
      continue;
    }
    if (item.kind === 'turn') {
      // Stable host IDs win over arrival order: an old completion may arrive
      // after the next turn has already produced its answer.
      let turn = item.turnId ? identified.get(item.turnId) : current;
      if (!turn && !current.id && !current.terminal) {
        turn = current;
        turn.id = item.turnId;
        identified.set(item.turnId!, turn);
      }
      turn ??= knownTurn(item.turnId!);
      turn.terminal = item;
      if (turn === current) current = create();
    }
  }
  for (const turn of turns) {
    const item = turn.terminal;
    if (!item || item.status !== 'completed' || !turn.lastAssistant) continue;
    const validCount = (value?: number) => value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : 0;
    const tokens = validCount(item.usage?.inputTokens) + validCount(item.usage?.outputTokens);
    const stat: TurnStat = {};
    if (item.durationMs !== undefined && Number.isSafeInteger(item.durationMs) && item.durationMs >= 0) stat.durationMs = item.durationMs;
    else if (turn.started !== undefined && Number.isFinite(turn.started) && Number.isFinite(item.ts) && item.ts >= turn.started) stat.durationMs = item.ts - turn.started;
    if (tokens > 0 && Number.isSafeInteger(tokens)) stat.tokens = tokens;
    if (stat.durationMs !== undefined || stat.tokens !== undefined) stats.set(turn.lastAssistant, stat);
  }
  return stats;
}

/** When the current run began: the latest start marker that has not completed yet. */
export function runningSince(items: readonly TimelineItem[]): number | undefined {
  return activeTurn(items)?.ts;
}

function activeTurn(items: readonly TimelineItem[]): Extract<TimelineItem, { kind: 'turn' }> | undefined {
  let current: Extract<TimelineItem, { kind: 'turn' }> | undefined;
  for (const item of items) {
    if (item.kind !== 'turn' || item.parentId) continue;
    if (item.status === 'started') current = item;
    else if (!item.turnId || !current?.turnId || item.turnId === current.turnId) current = undefined;
  }
  return current;
}

/** Put live elapsed time above the first reply of the observed current turn. */
export function runningTurnHeading(items: readonly TimelineItem[]): { messageId: string; startedAt: number } | undefined {
  const turn = activeTurn(items);
  if (!turn || !Number.isFinite(turn.ts)) return undefined;
  const index = items.indexOf(turn);
  const reply = items.find((item, position) => position > index && item.kind === 'message' && item.role === 'assistant'
    && !item.parentId && item.text.trim() && item.ts >= turn.ts
    && (!turn.turnId || !item.turnId || turn.turnId === item.turnId));
  return reply ? { messageId: reply.id, startedAt: turn.ts } : undefined;
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

/** Search only display fields; IDs, credentials and attachment payloads are not text. */
export function searchItemMatches(item: unknown, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle || !item || typeof item !== 'object') return false;
  const row = item as Record<string, unknown>;
  return ['text', 'title', 'detail', 'output', 'diff', 'error'].some(field =>
    typeof row[field] === 'string' && row[field].toLowerCase().includes(needle));
}

interface SearchableBlock {
  type: string; item?: unknown; items?: readonly unknown[]; children?: readonly unknown[];
  parts?: readonly SearchableBlock[]; files?: readonly { path: string; diff?: string }[];
  steps?: readonly { text: string }[]; summary?: string; current?: string;
}

function blockMatches(block: SearchableBlock, query: string): boolean {
  if (searchItemMatches(block.item, query)) return true;
  if (block.type !== 'activity' && block.type !== 'work' && block.type !== 'plan' && block.type !== 'subagent') return false;
  return searchItemMatches({ text: block.summary, detail: block.current }, query)
    || Boolean(block.items?.some(item => searchItemMatches(item, query)))
    || Boolean(block.children?.some(item => searchItemMatches(item, query)))
    || Boolean(block.steps?.some(step => searchItemMatches(step, query)))
    || Boolean(block.files?.some(file => searchItemMatches({ text: file.path, diff: file.diff }, query)))
    || Boolean(block.parts?.some(part => blockMatches(part, query)));
}

/** Loaded conversation content, including folded work, plans, diffs and child tasks. */
export function searchBlocks(blocks: readonly SearchableBlock[], query: string): number[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: number[] = [];
  blocks.forEach((block, index) => {
    if (blockMatches(block, needle)) hits.push(index);
  });
  return hits;
}

