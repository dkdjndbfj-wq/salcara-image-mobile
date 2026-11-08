import type { TimelineItem } from './store';
import type { ToolId } from './client';

type ToolItem = Extract<TimelineItem, { kind: 'tool' }>;
type WorkItem = Extract<TimelineItem, { kind: 'reasoning' | 'tool' | 'approval' | 'notice' | 'turn' }>;

/**
 * Keep prose boundaries and the first-observed ordering of work items.
 * Work groups aggregate artifacts without concealing their execution rows.
 */
export type Block =
  | { type: 'user'; id: string; item: Extract<TimelineItem, { kind: 'message' }> }
  | { type: 'assistant'; id: string; item: Extract<TimelineItem, { kind: 'message' }> }
  | { type: 'work'; id: string; items: WorkItem[]; files: FileEdit[]; live: boolean; summary: string; current?: string; currentItemId?: string }
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
export type ConversationBlock = (Exclude<Block, ActivityPart> | Extract<Block, { type: 'plan' }> | {
  type: 'activity'; id: string; parts: ActivityPart[]; files: FileEdit[]; live: boolean; summary: string; current?: string; currentItemId?: string; subagentCount: number; collapsible: boolean; finalized?: boolean;
}) & { completedChanges?: FileEdit[] };

function interruptedSubagentResult(item: ToolItem): boolean {
  return /^(?:已中断|被中断|已停止|中断)(?:\b|\s|$)/i.test((item.output ?? '').trim());
}

type TurnItem = Extract<TimelineItem, { kind: 'turn' }>;
function laterEvent(next: TimelineItem, previous: TimelineItem): boolean {
  const nextSeq = next.orderSeq ?? next.seq, previousSeq = previous.orderSeq ?? previous.seq;
  return nextSeq !== undefined && previousSeq !== undefined ? nextSeq >= previousSeq : next.ts >= previous.ts;
}
function childTurnStates(children: TimelineItem[]): Map<string, TurnItem> {
  const turns = new Map<string, TurnItem>();
  for (const item of children) {
    if (item.kind !== 'turn' || !item.turnId) continue;
    const key = JSON.stringify([item.parentId, item.turnId]), previous = turns.get(key);
    if (!previous || laterEvent(item, previous)) turns.set(key, item);
  }
  return turns;
}

export function subagentStatus(block: Extract<Block, { type: 'subagent' }>, tool?: ToolId): 'running' | 'done' | 'failed' | 'interrupted' | 'unknown' {
  // Claude's parent Task carries its real lifecycle; Codex's spawn/wait call does not.
  if (tool === 'claude' && !block.unlinked) return block.item.status === 'failed' && interruptedSubagentResult(block.item) ? 'interrupted' : block.item.status;
  if (block.item.status === 'interrupted') return 'interrupted';
  const turns = childTurnStates(block.children);
  if ([...turns.values()].some(item => item.status === 'started')) return 'running';
  const states = block.children.filter((item): item is ToolItem => item.kind === 'tool' && item.tool === 'subagent');
  if (states.some((item) => item.status === 'running')) return 'running';
  if (states.some((item) => item.status === 'interrupted')) return 'interrupted';
  if (states.some((item) => item.status === 'failed' && !interruptedSubagentResult(item))) return 'failed';
  if (states.some((item) => item.status === 'failed' && interruptedSubagentResult(item))) return 'interrupted';
  // A completed spawn tool is not proof that its child has finished.
  const allChildrenKnown = (block.item.childSessionKeys ?? []).every((key) => states.some((item) => item.childSessionKeys?.includes(key)));
  if (states.length && allChildrenKnown && states.every((item) => item.status === 'done')) return 'done';
  if (block.item.status === 'running' || block.children.some((item) => {
    const terminal = item.turnId ? turns.get(JSON.stringify(['parentId' in item ? item.parentId : undefined, item.turnId])) : undefined;
    if (terminal && terminal.status !== 'started' && laterEvent(terminal, item)) return false;
    return item.kind === 'tool' && item.status === 'running' || (item.kind === 'message' || item.kind === 'reasoning') && !item.final;
  })) return 'running';
  if (block.item.status === 'failed') return interruptedSubagentResult(block.item) ? 'interrupted' : 'failed';
  if (block.children.some((item) => item.kind === 'tool' && item.status === 'failed')) return 'failed';
  // A single referenced child can be identified by its direct parent. With
  // several child handles, one reply/turn cannot establish that all finished.
  if (block.item.childSessionKeys?.length === 1) {
    const directTurns = [...turns.values()].filter(item => item.parentId === block.item.id);
    if (directTurns.length) return directTurns.some(item => item.status === 'failed') ? 'failed'
      : directTurns.some(item => item.status === 'interrupted') ? 'interrupted' : 'done';
    if (block.children.some(item => item.kind === 'message' && item.parentId === block.item.id && item.role === 'assistant'
      && item.final && item.messagePhase === 'final_answer' && item.text.trim())) return 'done';
  }
  return 'unknown';
}

/** A group's failure is visible immediately, but cannot prove its other
 * referenced children have stopped. File summaries require every handle. */
function subagentCompletionPending(block: Extract<Block, { type: 'subagent' }>, tool?: ToolId): boolean {
  const state = subagentStatus(block, tool);
  if (state === 'running') return true;
  if (tool === 'claude' && !block.unlinked) return false;
  const states = new Map<string, ToolItem>();
  for (const item of block.children) if (item.kind === 'tool' && item.tool === 'subagent') {
    for (const key of item.childSessionKeys ?? []) {
      const previous = states.get(key);
      if (!previous || laterEvent(item, previous)) states.set(key, item);
    }
  }
  const keys = new Set([...(block.item.childSessionKeys ?? []), ...states.keys()]);
  if (!keys.size) return false; // Old unlinked history has no verifiable handles.
  if ([...keys].every(key => states.has(key) && states.get(key)!.status !== 'running')) return false;
  if (keys.size !== 1 || block.item.childSessionKeys?.length !== 1) return true;
  const turns = [...childTurnStates(block.children).values()].filter(item => item.parentId === block.item.id);
  if (turns.length && turns.every(item => item.status !== 'started')) return false;
  return !block.children.some(item => item.kind === 'message' && item.parentId === block.item.id && item.role === 'assistant'
    && item.final && item.messagePhase === 'final_answer' && item.text.trim());
}

/** Show only a short live preview in the compact activity header. */
function reasoningPreview(text: string): string {
  const preview = text.replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
  if (!preview) return '';
  return preview.length > 72 ? `${preview.slice(0, 71).trimEnd()}…` : preview;
}

function currentReasoningStep(text: string): string {
  const preview = reasoningPreview(text);
  return preview ? `正在思考 · ${preview}` : '正在思考';
}

/** Presentation only: fold adjacent tools, plans and child tasks into one summary. */
export function conversationBlocks(source: Block[], tool?: ToolId, currentTurnActive = false): ConversationBlock[] {
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
      for (const key of referencedKeys(block, item)) {
        const previous = latest.get(key);
        const newer = !previous || previous.seq === undefined || item.seq === undefined
          ? !previous || previous.ts <= item.ts
          : previous.seq <= item.seq;
        if (newer) latest.set(key, item);
      }
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
    // Task snapshots are immutable successful observations, not running tools.
    // Within one activity show the latest list per real parent scope; retain
    // all timeline records and the earlier snapshots across message boundaries.
    const latestTasks = new Map<string, ActivityPart>();
    for (const part of parts) if (part.type === 'plan' && part.item.planKind === 'tasks') latestTasks.set(part.item.parentId ?? '', part);
    parts = parts.filter(part => part.type !== 'plan' || part.item.planKind !== 'tasks' || latestTasks.get(part.item.parentId ?? '') === part);
    const work = parts.filter((part): part is Extract<Block, { type: 'work' }> => part.type === 'work');
    const subagents = parts.filter((part): part is Extract<Block, { type: 'subagent' }> => part.type === 'subagent');
    const ids = new Set<string>();
    for (const part of subagents) {
      const keys = [...(part.item.childSessionKeys ?? []), ...part.children.flatMap((item) => item.kind === 'tool' ? item.childSessionKeys ?? [] : [])];
      if (keys.length) keys.forEach((key) => ids.add(`session:${key}`));
      else ids.add(`task:${part.item.id}`);
    }
    const plans = parts.filter((part): part is Extract<Block, { type: 'plan' }> => part.type === 'plan' && part.item.planKind !== 'tasks');
    const live = work.some((part) => part.live) || plans.some((part) => part.item.status === 'running') || subagents.some((part) => subagentStatus(part, tool) === 'running');
    const current = [...parts].reverse().map((part) => {
      if (part.type === 'work') return part.current ? { text: part.current, itemId: part.currentItemId } : part.live ? { text: '正在处理' } : undefined;
      if (part.type === 'plan') {
        if (part.item.planKind === 'tasks') return undefined;
        if (part.item.status !== 'running') return undefined;
        const activeStep = part.steps.find((step) => step.status === 'active');
        return { text: activeStep ? `正在执行计划 · ${activeStep.text}` : '正在编写计划', itemId: part.item.id };
      }
      if (subagentStatus(part, tool) !== 'running') return undefined;
      for (let index = part.children.length - 1; index >= 0; index -= 1) {
        const child = part.children[index];
        if (child.kind === 'tool' && child.status === 'running') return { text: currentToolStep(child), itemId: child.id };
        if (child.kind === 'reasoning' && !child.final) {
          const preview = reasoningPreview(child.text);
          return { text: preview ? `子任务正在思考 · ${preview}` : '子任务正在思考', itemId: child.id };
        }
        if (child.kind === 'message' && child.role === 'assistant' && !child.final) return { text: '子任务正在回复', itemId: child.id };
      }
      return { text: '正在运行子任务', itemId: part.item.id };
    }).find((value) => value !== undefined);
    const descriptions: string[] = [];
    if (ids.size) descriptions.push(`${ids.size} 个子智能体${subagents.some((part) => subagentStatus(part, tool) === 'running') ? ' · 进行中' : subagents.some((part) => subagentStatus(part, tool) === 'failed') ? ' · 有失败' : ''}`);
    if (work.length) descriptions.push(workSummary(work.flatMap((part) => part.items)));
    if (plans.length) {
      const plan = plans[plans.length - 1];
      descriptions.push(plan.steps.length ? `计划 ${plan.steps.filter((step) => step.status === 'done').length}/${plan.steps.length}` : '计划');
    }
    for (const taskList of latestTasks.values()) if (taskList.type === 'plan') descriptions.push(taskList.item.title || '任务列表');
    const activityFiles = work.flatMap((part) => part.files);
    // A single command/file/reasoning row is already the useful detail. Only
    // create the outer Codex-style disclosure when there is more than one
    // meaningful activity entry to group.
    const meaningful = parts.reduce((count, part) => {
      if (part.type === 'work') return count + part.items.filter((item) => item.kind !== 'reasoning' || item.text.trim()).length;
      if (part.type === 'subagent') {
        const sessions = new Set([...(part.item.childSessionKeys ?? []), ...part.children.flatMap((item) => item.kind === 'tool' ? item.childSessionKeys ?? [] : [])]);
        // Keep child conversation, result, and progress details tucked behind
        // the activity summary even when this is the only top-level activity.
        return count + 1 + part.children.length + sessions.size + Number(Boolean(part.item.detail)) + Number(Boolean(part.item.output));
      }
      return count + 1;
    }, 0) + Math.max(0, activityFiles.length - 1);
    result.push({ type: 'activity', id: `activity:${parts[0].id}`, parts, files: activityFiles, live,
      summary: descriptions.join(' · ') || '处理摘要', current: current?.text, currentItemId: current?.itemId, subagentCount: ids.size,
      collapsible: meaningful > 1 || subagents.length > 0 });
    parts = [];
  };
  for (const entry of source) {
    const block = currentChildren(entry);
    if (block.type === 'plan' && block.item.planKind === 'proposal') { flush(); result.push(block); }
    else if (block.type === 'work' || block.type === 'plan' || block.type === 'subagent') parts.push(block);
    else { flush(); result.push(block); }
  }
  flush();
  // Only a real reply or terminal turn marks the activity as the completed
  // work for this turn. A child changing from running to done is not enough:
  // the user may still be inspecting its details while the parent continues.
  const finalizedBlocks = result.map((block, index) => {
    if (block.type !== 'activity') return block;
    let finalized = false;
    for (const next of result.slice(index + 1)) {
      if (next.type === 'user' && !next.item.local) break;
      if (next.type === 'assistant' && next.item.final && next.item.messagePhase !== 'commentary' && next.item.text.trim()) { finalized = true; break; }
      if (next.type === 'turn' && next.item.status !== 'started') { finalized = true; break; }
    }
    return { ...block, finalized };
  });
  return completedChangeSummaries(finalizedBlocks, tool, currentTurnActive);
}

/** Collect a turn's edits at its final row, never beside an earlier edit step.
 * Keep the original activity files for search/review and historical summaries
 * during a newer turn. A queued user message cannot own the result card. */
function completedChangeSummaries(blocks: ConversationBlock[], tool: ToolId | undefined, currentTurnActive: boolean): ConversationBlock[] {
  type Round = { turnId?: string; blocks: ConversationBlock[]; rootActive: boolean; childActive: boolean };
  const rounds: Round[] = [];
  const byTurn = new Map<string, Round>();
  let current: Round = { blocks: [], rootActive: false, childActive: false };
  rounds.push(current);
  const activeItem = (item: WorkItem) => item.kind === 'tool' && item.status === 'running'
    || item.kind === 'reasoning' && !item.final
    || item.kind === 'approval' && item.state === 'pending'
    || item.kind === 'notice' && item.noticeKind === 'context_compaction' && item.progress === true;
  for (const block of blocks) {
    const rootItems = block.type === 'activity'
      ? block.parts.flatMap(part => part.type === 'work' ? part.items : [part.item]) : [block.item];
    const turnId = rootItems.find(item => item.turnId)?.turnId;
    const known = turnId ? byTurn.get(turnId) : undefined;
    if (known) current = known;
    else if (current.blocks.length && (block.type === 'user' && !block.item.local
      || turnId && current.turnId && turnId !== current.turnId)) {
      current = { blocks: [], rootActive: false, childActive: false }; rounds.push(current);
    }
    if (turnId && !current.turnId) { current.turnId = turnId; byTurn.set(turnId, current); }
    current.blocks.push(block);
    if (block.type === 'activity') for (const part of block.parts) {
      if (part.type === 'subagent') {
        current.childActive ||= subagentCompletionPending(part, tool);
      }
      else current.rootActive ||= part.type === 'work' ? part.live || part.items.some(activeItem)
        : part.item.planKind !== 'tasks' && part.item.status === 'running';
    }
    else if (block.type === 'assistant') {
      if (block.item.final && block.item.messagePhase !== 'commentary' && block.item.text.trim()) current.rootActive = false;
      else current.rootActive ||= !block.item.final;
    } else if (block.type === 'turn' && block.item.status !== 'started') current.rootActive = false;
    else if (block.type === 'plan') current.rootActive ||= block.item.status === 'running';
    else if (block.type === 'notice') current.rootActive ||= activeItem(block.item);
  }
  const latest = rounds[rounds.length - 1];
  const summaries = new Map<string, FileEdit[]>();
  const positions = new Map(blocks.map((block, index) => [block.id, index]));
  for (const [index, round] of rounds.entries()) {
    if (round.rootActive || round.childActive || round === latest && currentTurnActive) continue;
    const activities = round.blocks.filter((block): block is Extract<ConversationBlock, { type: 'activity' }> => block.type === 'activity');
    if (!activities.some(block => block.finalized)) continue;
    const files = activities.flatMap(block => block.files);
    // A delayed event from an older turn may arrive after newer work. Keep its
    // result with the original turn instead of moving it below the new task.
    const nextStart = rounds[index + 1]?.blocks[0];
    const end = nextStart ? positions.get(nextStart.id)! : blocks.length;
    const anchor = [...round.blocks].reverse().find(block => block.type !== 'user' && positions.get(block.id)! < end);
    if (files.length && anchor) summaries.set(anchor.id, files);
  }
  return blocks.map(block => summaries.has(block.id) ? { ...block, completedChanges: summaries.get(block.id) } : block);
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
  const nextPath = diff.match(/^\+\+\+ (?:b\/)?(.+)$/m)?.[1];
  const path = (nextPath === '/dev/null' ? diff.match(/^--- (?:a\/)?(.+)$/m)?.[1] ?? '' : nextPath ?? item.detail ?? item.title.replace(/^(修改|编辑|新建|删除|创建)\s*/, '')).trim();
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
  const images = tools.filter((item) => item.tool === 'image_view' || item.tool === 'image_generation').length;
  const web = tools.filter((item) => item.tool === 'web').length;
  const skills = tools.filter((item) => item.tool === 'skill').length;
  const other = tools.filter((item) => item.tool === 'mcp' || item.tool === 'other').length;
  const parts = [plural(commands, '条命令', '运行了'), plural(files, '个文件', '编辑了'), plural(reads, '处', '查看了'), plural(skills, '项技能', '使用了'), plural(images, '张图片', '处理了'), plural(web, '次', '搜索网页'), plural(other, '个工具', '调用了')].filter(Boolean);
  if (parts.length) return parts.join(' · ');
  if (items.some((item) => item.kind === 'turn' && item.status === 'interrupted')) return '中断记录';
  return items.some((item) => item.kind === 'reasoning') ? '思考过程' : '过程';
}

/** Keep an old interruption in work details only after a later host turn is observed.
 * A local queued prompt, a reconnect, or a late update to the same turn is not
 * evidence of resuming. This is presentation only; controls retain all boundaries.
 */
function historicalInterruptions(items: TimelineItem[]): Set<string> {
  const historical = new Set<string>();
  const firstTurnPosition = new Map<string, number>();
  const isTopLevel = (item: TimelineItem) => !('parentId' in item && item.parentId) && !(item.kind === 'message' && item.local);
  const isTurnEvidence = (item: TimelineItem) => item.kind === 'turn' || item.kind === 'message' || item.kind === 'reasoning' || item.kind === 'tool';
  let newestObservedTurnPosition = -1;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (isTopLevel(item) && isTurnEvidence(item) && item.turnId && !firstTurnPosition.has(item.turnId)) {
      firstTurnPosition.set(item.turnId, index);
      newestObservedTurnPosition = index;
    }
  }
  let newestLaterTurnPosition = -1;
  let laterAnonymousBoundary = false;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!isTopLevel(item)) continue;
    // A terminal event can arrive after the next turn has already started.
    // Compare known turn chronology, not the terminal event's arrival position.
    if (item.kind === 'turn' && item.status === 'interrupted' && (laterAnonymousBoundary
      || (item.turnId ? newestObservedTurnPosition > firstTurnPosition.get(item.turnId)! : newestLaterTurnPosition > index))) historical.add(item.id);
    if (isTurnEvidence(item)) {
      // A previously observed older turn may emit a late item with a new ID.
      // Its later arrival cannot prove that the interrupted turn was resumed.
      if (item.turnId) newestLaterTurnPosition = Math.max(newestLaterTurnPosition, firstTurnPosition.get(item.turnId)!);
      else if (item.kind === 'turn') laterAnonymousBoundary = true;
    }
  }
  return historical;
}

const TOOL_ACTIVITY_LABEL: Record<ToolItem['tool'], string> = {
  command: '正在运行', file_change: '正在编辑', read: '正在读取', image_view: '正在查看图片',
  image_generation: '正在生成图片', search: '正在搜索', web: '正在搜索网页', mcp: '正在调用工具',
  plan: '正在编写计划', subagent: '正在运行子任务', skill: '正在使用技能', other: '正在处理',
};

/** A short, user-facing verb for an explicit in-progress host tool event. */
export function toolActivityLabel(tool: ToolItem['tool']): string {
  return TOOL_ACTIVITY_LABEL[tool];
}

function activityTarget(title: string, verbs: string[]): string {
  const prefix = new RegExp(`^(?:正在)?(?:${verbs.join('|')})\\s*(?:[·:：]\\s*)?`);
  return title.replace(prefix, '').trim();
}

function currentToolStep(item: ToolItem): string {
  const label = toolActivityLabel(item.tool);
  if (item.tool === 'file_change') {
    const files = fileEdits(item);
    const target = files.length > 1 ? `${files.length} 个文件` : files[0]?.path || activityTarget(item.title, ['编辑', '修改', '新建', '创建', '删除']);
    return target ? `${label} · ${target}` : label;
  }
  const verbs = item.tool === 'command' ? ['运行', '执行']
    : item.tool === 'read' ? ['读取', '查看', '打开']
      : item.tool === 'search' || item.tool === 'web' ? ['搜索', '查找', '查询']
        : item.tool === 'image_view' ? ['查看', '读取']
          : item.tool === 'image_generation' ? ['生成', '创建']
            : item.tool === 'mcp' ? ['调用']
              : item.tool === 'skill' ? ['使用', '调用']
              : item.tool === 'subagent' ? ['启动', '运行', '等待'] : [];
  const target = activityTarget(item.title, verbs);
  return target ? `${label} · ${target}` : label;
}

function currentStep(items: WorkItem[]): { text: string; itemId: string } | undefined {
  let runningTool: ToolItem | undefined;
  let lastReasoning = -1;
  let lastNonReasoning = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === 'tool' && item.status === 'running' && !runningTool) runningTool = item;
    if (item.kind === 'reasoning' && lastReasoning < 0) lastReasoning = index;
    else if (item.kind !== 'reasoning' && lastNonReasoning < 0) lastNonReasoning = index;
  }
  // A newer completed command must not hide another command that is still
  // running in parallel. Select the newest explicit live tool event.
  if (runningTool) return { text: currentToolStep(runningTool), itemId: runningTool.id };
  const latest = lastReasoning > lastNonReasoning ? items[lastReasoning] : undefined;
  return latest?.kind === 'reasoning' && !latest.final ? { text: currentReasoningStep(latest.text), itemId: latest.id } : undefined;
}

/**
 * Reasoning events are transient progress, not a transcript of separate
 * assistant replies. Keep only a trailing live update or the latest completed
 * summary; a later concrete action supersedes it in the expanded activity too.
 */
export function visibleReasoningId(items: readonly TimelineItem[], live: boolean, searchQuery = ''): string | undefined {
  let lastReasoning = -1;
  let lastAction = -1;
  let searchedReasoning = -1;
  let hasRunningTool = false;
  const query = searchQuery.trim().toLowerCase();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.kind === 'reasoning') {
      lastReasoning = index;
      if (query && item.text.toLowerCase().includes(query)) searchedReasoning = index;
    }
    else {
      lastAction = index;
      if (item.kind === 'tool' && item.status === 'running') hasRunningTool = true;
    }
  }
  const trailingReasoning = lastReasoning > lastAction ? items[lastReasoning] : undefined;
  const showTrailingReasoning = !hasRunningTool && trailingReasoning?.kind === 'reasoning'
    && (live ? !trailingReasoning.final : trailingReasoning.final) && Boolean(trailingReasoning.text.trim());
  const visibleReasoning = query && searchedReasoning >= 0 ? items[searchedReasoning]
    : showTrailingReasoning ? trailingReasoning : undefined;
  return visibleReasoning?.kind === 'reasoning' ? visibleReasoning.id : undefined;
}

export function visibleWorkItems(items: WorkItem[], live: boolean, searchQuery = ''): WorkItem[] {
  const visibleReasoning = visibleReasoningId(items, live, searchQuery);
  return items.filter(item => item.kind !== 'reasoning' || item.id === visibleReasoning);
}

export function buildBlocks(items: TimelineItem[], running: boolean): Block[] {
  const blocks: Block[] = [];
  const oldInterruptions = historicalInterruptions(items);
  const lastBoundary = [...items].reverse().find(item => item.kind === 'turn' && !('parentId' in item && item.parentId));
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
  // A normal Codex turn ends with a visible assistant message.  If the
  // provider completes without one (for example a tool-only run, an empty
  // response, or a history slice that omits the reply), keep a compact
  // completion row instead of silently dropping the turn boundary.
  let hasTopLevelReply = false;
  const flush = (live: boolean) => {
    if (!work.length) return;
    const files = work.filter((item): item is ToolItem => item.kind === 'tool' && item.tool === 'file_change').flatMap(fileEdits);
    const current = live ? currentStep(work) : undefined;
    blocks.push({ type: 'work', id: `work:${work[0].kind}:${work[0].id}`, items: work, files, live, summary: workSummary(work), current: current?.text, currentItemId: current?.itemId });
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
        if (item.role === 'user' && !item.parentId) hasTopLevelReply = false;
        else if (item.role === 'assistant' && !item.parentId && item.final && item.messagePhase !== 'commentary' && item.text.trim()) hasTopLevelReply = true;
        blocks.push({ type: item.role === 'user' ? 'user' : 'assistant', id: `m:${item.id}`, item } as Block);
        break;
      case 'turn':
        if (item.status === 'interrupted' && oldInterruptions.has(item.id)) {
          work.push(item);
          flush(false);
          hasTopLevelReply = false;
          break;
        }
        // Native history appends its in-progress boundary after the items.
        // Preserve the current work's live state, but never revive an old turn.
        flush(running && item === lastBoundary && item.status === 'started' && Boolean(item.turnId)
          && work.some(part => part.turnId === item.turnId));
        if (item.status === 'failed' || item.status === 'interrupted') blocks.push({ type: 'turn', id: `t:${item.id}`, item });
        else if (item.status === 'completed' && !hasTopLevelReply) blocks.push({ type: 'turn', id: `t:${item.id}`, item });
        if (item.status !== 'started') hasTopLevelReply = false;
        break;
      case 'notice':
        // Warnings are actionable state (for example an unconfirmed stop), so
        // keep them visible in the conversation. Native lifecycle progress is
        // also visible even when it is informational; routine info stays folded.
        if (item.level !== 'info' || item.noticeKind === 'context_compaction') { flush(false); blocks.push({ type: 'notice', id: `n:${item.id}`, item }); }
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
