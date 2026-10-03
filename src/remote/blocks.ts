import type { TimelineItem } from './store';
import type { ToolId } from './client';

type ToolItem = Extract<TimelineItem, { kind: 'tool' }>;
type WorkItem = Extract<TimelineItem, { kind: 'reasoning' | 'tool' | 'approval' | 'notice' }>;

/**
 * A thread renders like the Codex app: user and assistant messages stay in the
 * main column; everything the agent did in between (thinking, commands, reads,
 * edits) folds into one "work" block, with edited files kept visible.
 */
export type Block =
  | { type: 'user'; id: string; item: Extract<TimelineItem, { kind: 'message' }> }
  | { type: 'assistant'; id: string; item: Extract<TimelineItem, { kind: 'message' }> }
  | { type: 'work'; id: string; items: WorkItem[]; files: FileEdit[]; live: boolean; summary: string; current?: string }
  | { type: 'turn'; id: string; item: Extract<TimelineItem, { kind: 'turn' }> }
  | { type: 'plan'; id: string; item: ToolItem; steps: PlanStep[] }
  | { type: 'subagent'; id: string; item: ToolItem; children: TimelineItem[]; unlinked?: boolean }
  | { type: 'notice'; id: string; item: Extract<TimelineItem, { kind: 'notice' }> };

export interface PlanStep { text: string; status: 'done' | 'active' | 'pending' }

/** Codex's to-do list arrives as "✓ / ▸ / ○ step" lines; anything else is plain text. */
export function planSteps(output?: string): PlanStep[] {
  const steps: PlanStep[] = [];
  for (const line of (output ?? '').split('\n')) {
    const match = line.match(/^\s*(✓|▸|○)\s+(.+)$/);
    if (match) steps.push({ text: match[2].trim(), status: match[1] === '✓' ? 'done' : match[1] === '▸' ? 'active' : 'pending' });
  }
  return steps;
}

export interface FileEdit { id: string; path: string; add: number; del: number; diff?: string; status: ToolItem['status'] }

type ActivityPart = Extract<Block, { type: 'work' | 'plan' | 'subagent' }>;
export type ConversationBlock = Exclude<Block, ActivityPart> | {
  type: 'activity'; id: string; parts: ActivityPart[]; files: FileEdit[]; live: boolean; summary: string; current?: string; subagentCount: number;
};

export function subagentStatus(block: Extract<Block, { type: 'subagent' }>, tool?: ToolId): 'running' | 'done' | 'failed' | 'unknown' {
  // Claude's parent Task carries its real lifecycle; Codex's spawn/wait call does not.
  if (tool === 'claude' && !block.unlinked) return block.item.status;
  const states = block.children.filter((item): item is ToolItem => item.kind === 'tool' && item.tool === 'subagent');
  if (states.some((item) => item.status === 'running')) return 'running';
  if (states.some((item) => item.status === 'failed')) return 'failed';
  // A completed spawn tool is not proof that its child has finished.
  const allChildrenKnown = (block.item.childSessionKeys ?? []).every((key) => states.some((item) => item.childSessionKeys?.includes(key)));
  if (states.length && allChildrenKnown && states.every((item) => item.status === 'done')) return 'done';
  if (block.item.status === 'running' || block.children.some((item) => (item.kind === 'tool' && item.status === 'running') || ((item.kind === 'message' || item.kind === 'reasoning') && !item.final))) return 'running';
  if (block.item.status === 'failed' || block.children.some((item) => item.kind === 'tool' && item.status === 'failed')) return 'failed';
  return 'unknown';
}

/** Presentation only: fold adjacent tools, plans and child tasks into one summary. */
export function conversationBlocks(source: Block[], tool?: ToolId): ConversationBlock[] {
  // Later wait/follow-up records update the same real child, even across reply boundaries.
  // Keep the stored timeline untouched; do not leave an earlier spawn spinning forever.
  const latest = new Map<string, ToolItem>();
  const referencedKeys = (block: Extract<Block, { type: 'subagent' }>, item: ToolItem) => item.childSessionKeys?.length ? item.childSessionKeys
    // notFound intentionally has no navigable handle; match its protocol ID only to
    // a real receiver already referenced by the parent, never to a guessed title.
    : (block.item.childSessionKeys ?? []).filter((key) => key.startsWith('codex:') && item.id === `${block.item.id}:child:${key.slice(6)}`);
  if (tool !== 'claude') for (const block of source) {
    if (block.type !== 'subagent') continue;
    for (const item of block.children) if (item.kind === 'tool' && item.tool === 'subagent') {
      for (const key of referencedKeys(block, item)) if (!latest.has(key) || latest.get(key)!.ts <= item.ts) latest.set(key, item);
    }
  }
  const currentChildren = (block: Block): Block => {
    if (block.type !== 'subagent' || !latest.size) return block;
    const known = new Set<string>();
    const children = block.children.map((item) => {
      if (item.kind !== 'tool' || item.tool !== 'subagent') return item;
      const keys = referencedKeys(block, item);
      keys.forEach((key) => known.add(key));
      const current = keys.length === 1 ? latest.get(keys[0]) : undefined;
      return current ? { ...item, status: current.status, output: current.output } : item;
    });
    for (const key of block.item.childSessionKeys ?? []) {
      const current = latest.get(key);
      if (!known.has(key) && current) { children.push({ ...current, parentId: block.item.id }); known.add(key); }
    }
    return { ...block, children };
  };
  const result: ConversationBlock[] = [];
  let parts: ActivityPart[] = [];
  const flush = () => {
    if (!parts.length) return;
    const work = parts.filter((part): part is Extract<Block, { type: 'work' }> => part.type === 'work');
    const subagents = parts.filter((part): part is Extract<Block, { type: 'subagent' }> => part.type === 'subagent');
    const ids = new Set<string>();
    for (const part of subagents) {
      const keys = [...(part.item.childSessionKeys ?? []), ...part.children.flatMap((item) => item.kind === 'tool' ? item.childSessionKeys ?? [] : [])];
      if (keys.length) keys.forEach((key) => ids.add(`session:${key}`));
      else ids.add(`task:${part.item.id}`);
    }
    const plans = parts.filter((part): part is Extract<Block, { type: 'plan' }> => part.type === 'plan');
    const live = work.some((part) => part.live) || plans.some((part) => part.item.status === 'running') || subagents.some((part) => subagentStatus(part, tool) === 'running');
    const current = [...work].reverse().find((part) => part.current)?.current;
    const descriptions: string[] = [];
    if (ids.size) descriptions.push(`${ids.size} 个子智能体${subagents.some((part) => subagentStatus(part, tool) === 'running') ? ' · 进行中' : subagents.some((part) => subagentStatus(part, tool) === 'failed') ? ' · 有失败' : ''}`);
    if (work.length) descriptions.push(workSummary(work.flatMap((part) => part.items)));
    if (plans.length) {
      const plan = plans[plans.length - 1];
      descriptions.push(plan.steps.length ? `计划 ${plan.steps.filter((step) => step.status === 'done').length}/${plan.steps.length}` : '计划');
    }
    result.push({ type: 'activity', id: `activity:${parts[0].id}`, parts, files: work.flatMap((part) => part.files), live,
      summary: descriptions.join(' · ') || '处理摘要', current, subagentCount: ids.size });
    parts = [];
  };
  for (const entry of source) {
    const block = currentChildren(entry);
    if (block.type === 'work' || block.type === 'plan' || block.type === 'subagent') parts.push(block);
    else { flush(); result.push(block); }
  }
  flush();
  return result;
}

export function diffStats(diff?: string): { add: number; del: number } {
  let add = 0; let del = 0;
  for (const line of (diff ?? '').split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) add += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) del += 1;
  }
  return { add, del };
}

/** Splits a multi-file unified diff into per-file edits; falls back to the tool title. */
export function fileEdits(item: ToolItem): FileEdit[] {
  const diff = item.diff ?? '';
  const parts = diff.split(/(?=^diff --git |^--- (?:a\/|\/dev\/null))/m).filter((part) => /^\+\+\+ /m.test(part));
  if (parts.length > 1) {
    return parts.map((part, index) => {
      const path = (part.match(/^\+\+\+ (?:b\/)?(.+)$/m)?.[1] ?? '').trim();
      return { id: `${item.id}:${index}`, path: path === '/dev/null' ? (part.match(/^--- (?:a\/)?(.+)$/m)?.[1] ?? '').trim() : path, ...diffStats(part), diff: part, status: item.status };
    });
  }
  const path = (diff.match(/^\+\+\+ (?:b\/)?(.+)$/m)?.[1] ?? item.detail ?? item.title.replace(/^(修改|编辑|新建|删除|创建)\s*/, '')).trim();
  return [{ id: item.id, path, ...diffStats(diff), diff: diff || undefined, status: item.status }];
}

function plural(count: number, unit: string, verb: string) {
  return count ? `${verb} ${count} ${unit}` : '';
}

export function workSummary(items: WorkItem[]): string {
  const tools = items.filter((item): item is ToolItem => item.kind === 'tool');
  const commands = tools.filter((item) => item.tool === 'command').length;
  const files = new Set(tools.filter((item) => item.tool === 'file_change').flatMap((item) => fileEdits(item).map((edit) => edit.path))).size;
  const reads = tools.filter((item) => item.tool === 'read' || item.tool === 'search').length;
  const web = tools.filter((item) => item.tool === 'web').length;
  const other = tools.filter((item) => item.tool === 'mcp' || item.tool === 'other').length;
  const parts = [plural(commands, '条命令', '运行了'), plural(files, '个文件', '编辑了'), plural(reads, '处', '查看了'), plural(web, '次', '搜索网页'), plural(other, '个工具', '调用了')].filter(Boolean);
  if (parts.length) return parts.join(' · ');
  return items.some((item) => item.kind === 'reasoning') ? '思考过程' : '过程';
}

function currentStep(items: WorkItem[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === 'tool' && item.status === 'running') return item.title;
    if (item.kind === 'reasoning' && !item.final) {
      const first = item.text.trim().split('\n')[0]?.replace(/^\*\*|\*\*$/g, '').trim();
      return first ? `思考：${first}` : '正在思考';
    }
  }
  return undefined;
}

export function buildBlocks(items: TimelineItem[], running: boolean): Block[] {
  const blocks: Block[] = [];
  const tools = new Map(items.filter((item): item is ToolItem => item.kind === 'tool').map((item) => [item.id, item]));
  const rootOf = (id: string) => {
    const seen = new Set<string>();
    while (tools.get(id)?.parentId && seen.size < 256 && !seen.has(id)) {
      seen.add(id); id = tools.get(id)!.parentId!;
    }
    return id;
  };
  const parentIds = new Set(items.filter((item) => 'parentId' in item && item.parentId).map((item) => rootOf((item as { parentId: string }).parentId)));
  const parents = new Set(items.filter((item) => item.kind === 'tool' && (item.tool === 'subagent' || parentIds.has(item.id)) && !item.parentId).map((item) => item.id));
  const childGroups = new Map<string, TimelineItem[]>();
  for (const item of items) {
    if ('parentId' in item && item.parentId) { const root = rootOf(item.parentId); childGroups.set(root, [...(childGroups.get(root) ?? []), item]); }
  }
  const emitted = new Set<string>();
  let work: WorkItem[] = [];
  const flush = (live: boolean) => {
    if (!work.length) return;
    const files = work.filter((item): item is ToolItem => item.kind === 'tool' && item.tool === 'file_change').flatMap(fileEdits);
    blocks.push({ type: 'work', id: `work:${work[0].kind}:${work[0].id}`, items: work, files, live, summary: workSummary(work), current: live ? currentStep(work) : undefined });
    work = [];
  };
  for (const item of items) {
    if ('parentId' in item && item.parentId) {
      const root = rootOf(item.parentId);
      if (!parents.has(root) && !emitted.has(root)) {
        flush(false); emitted.add(root);
        const children = childGroups.get(root) ?? [];
        blocks.push({ type: 'subagent', id: `sub:${root}`, item: { kind: 'tool', id: root, tool: 'subagent', title: '子任务', status: 'done', ts: item.ts }, children, unlinked: true });
      }
      continue;
    }
    switch (item.kind) {
      case 'message':
        flush(false);
        blocks.push({ type: item.role === 'user' ? 'user' : 'assistant', id: `m:${item.id}`, item } as Block);
        break;
      case 'turn':
        flush(false);
        if (item.status === 'failed' || item.status === 'interrupted') blocks.push({ type: 'turn', id: `t:${item.id}`, item });
        break;
      case 'notice':
        if (item.level === 'error') { flush(false); blocks.push({ type: 'notice', id: `n:${item.id}`, item }); }
        else work.push(item);
        break;
      case 'approval':
        if (item.state !== 'pending') work.push(item);
        break;
      case 'tool':
        if (item.tool === 'subagent' || parentIds.has(item.id)) { flush(false); blocks.push({ type: 'subagent', id: `sub:${item.id}`, item, children: childGroups.get(item.id) ?? [] }); }
        else if (item.tool === 'plan') { flush(false); blocks.push({ type: 'plan', id: `p:${item.id}`, item, steps: planSteps(item.output) }); }
        else work.push(item);
        break;
      default:
        work.push(item);
    }
  }
  flush(running);
  return blocks;
}
