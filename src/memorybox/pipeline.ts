import { useSyncExternalStore } from 'react';

import { rejectsMemory } from '../agent/memory';
import type { ChatMessage, ProviderProfile } from '../domain';
import { listMessagesBetween } from '../storage/database';
import { embeddingModelOf, embeddingProvider, embedTexts, loadMemoryBoxSettings, type MemoryBoxSettings } from './settings';
import { retrieve } from './search';
import { addLinks, loadBox, loadCharacters, newNote, patchNotes, putNotes, removeOrphans, updateCharacter, updateNote } from './store';
import { NOTE_TYPES, type Character, type MemNote, type NoteType } from './types';
import { completeJson, resolveWorker, type WorkerModel } from './worker';

/**
 * After each chat turn the memory box works in the background, in order:
 * 1. extract: turn new messages into note cards (add / update / supersede / link), like Mem0;
 * 2. embed: give new notes vectors for semantic recall;
 * 3. compact: fold old turns into 往事 summaries, and summaries into higher-level ones (MemGPT-style),
 *    so the conversation never hits a length limit;
 * 4. reflect: now and then, distil higher-level insights (Generative Agents).
 * Progress is stored on the character, so work interrupted by closing the app resumes next time.
 */

export interface PipelineEnv { providers: () => ProviderProfile[]; chatProvider: () => ProviderProfile | null }
let env: PipelineEnv | null = null;
export function configureMemoryPipeline(next: PipelineEnv): void { env = next; }

export type PipelineStatus = { state: 'idle' | 'working' | 'error'; detail?: string; at?: number };
const statuses = new Map<string, PipelineStatus>();
const listeners = new Set<() => void>();
let version = 0;
function setStatus(id: string, status: PipelineStatus) { statuses.set(id, status); version += 1; listeners.forEach((listener) => listener()); }
export function pipelineStatus(id: string): PipelineStatus { return statuses.get(id) ?? { state: 'idle' }; }
export function usePipelineStatus(id: string | null): PipelineStatus {
  useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => version, () => version);
  return id ? pipelineStatus(id) : { state: 'idle' };
}

const queues = new Map<string, Promise<void>>();
const rerun = new Set<string>();
const rewinds = new Map<string, number>();
const reflections = new Map<string, Array<{ resolve: () => void; reject: (error: unknown) => void }>>();

/**
 * Queues memory work for a character; calls while it runs coalesce into one more pass.
 * `rewindTo` re-reads messages after that time (a regenerated reply), applied inside the queue so a running pass can't overwrite it.
 */
export function scheduleMemoryWork(characterId: string, options: { rewindTo?: number } = {}): Promise<void> {
  if (options.rewindTo !== undefined) rewinds.set(characterId, Math.min(options.rewindTo, rewinds.get(characterId) ?? Number.MAX_SAFE_INTEGER));
  const running = queues.get(characterId);
  if (running) { rerun.add(characterId); return running; }
  const job = (async () => {
    try {
      do {
        rerun.delete(characterId);
        await processCharacter(characterId);
      } while (rerun.has(characterId));
    } finally {
      queues.delete(characterId);
      // Anyone still waiting on a reflection that never ran (character gone, app not ready) is released.
      reflections.get(characterId)?.forEach((waiter) => waiter.reject(new Error('没有完成整理')));
      reflections.delete(characterId);
    }
  })();
  queues.set(characterId, job);
  return job;
}

export const EXTRACT_BATCH = 12;
/** Raw turns kept verbatim: compaction starts at this many unsummarized messages and folds the oldest half. */
export const RAW_WINDOW = 24;
const FOLD = 12;
const ROLLUP_THRESHOLD = 8;
const ROLLUP_SIZE = 6;
export const REFLECT_EVERY = 12;

async function processCharacter(id: string): Promise<void> {
  if (!env) return;
  const settings = await loadMemoryBoxSettings();
  let character = (await loadCharacters()).find((item) => item.id === id);
  const rewind = rewinds.get(id);
  if (rewind !== undefined && character) {
    rewinds.delete(id);
    if (rewind < character.extractedUntil) character = (await updateCharacter(id, { extractedUntil: Math.max(0, rewind) })) ?? character;
  }
  const waiting = reflections.get(id) ?? [];
  reflections.delete(id);
  if (!settings.enabled || !character?.conversationId) {
    waiting.forEach((waiter) => waiter.reject(new Error(settings.enabled ? '还没有聊过天' : '记忆匣已关闭')));
    return;
  }
  const worker = resolveWorker(env.providers(), settings, character, env.chatProvider());
  if (!worker) { waiting.forEach((waiter) => waiter.reject(new Error('需要一个对话模型来整理记忆'))); return; }
  setStatus(id, { state: 'working', detail: waiting.length ? '正在反思…' : '整理记忆中…' });
  try {
    for (let pass = 0; pass < 3; pass += 1) {
      const progressed = await extract(character, worker, settings);
      character = (await loadCharacters()).find((item) => item.id === id);
      if (!character || !progressed) break;
    }
    if (!character) return;
    await embedMissing(character.id, settings);
    for (let pass = 0; pass < 4; pass += 1) {
      const folded = await compact(character, worker, settings);
      character = (await loadCharacters()).find((item) => item.id === id);
      if (!character || !folded) break;
    }
    if (!character) return;
    while (await rollUp(character, worker, settings)) { /* until every level is small */ }
    character = (await loadCharacters()).find((item) => item.id === id);
    if (!character) return;
    if (waiting.length || (settings.reflection && character.notesSinceReflection >= REFLECT_EVERY && character.memoryMode !== 'off')) await reflect(character, worker, settings);
    setStatus(id, { state: 'idle', at: Date.now() });
    waiting.forEach((waiter) => waiter.resolve());
  } catch (error) {
    setStatus(id, { state: 'error', detail: error instanceof Error ? error.message : '整理失败', at: Date.now() });
    waiting.forEach((waiter) => waiter.reject(error));
  } finally {
    // A character deleted mid-pass returns early: release its waiters too.
    waiting.forEach((waiter) => waiter.reject(new Error('角色已不存在')));
  }
}

function speaker(message: ChatMessage, character: Character): string {
  return message.role === 'user' ? '用户' : character.name;
}
function line(message: ChatMessage, character: Character): string {
  const time = new Date(message.createdAt);
  const stamp = `${time.getMonth() + 1}/${time.getDate()} ${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
  const raw = message.role === 'user' ? message.prompt : (message.text ?? '');
  const body = message.role === 'user' && raw.startsWith('〔拍一拍〕') ? '（拍了拍你）' : raw;
  const extra = [
    message.references.length ? `[发了 ${message.references.length} 张图片]` : '',
    message.role === 'assistant' && message.imageUri ? `[画了一张图：${(message.preparedPrompt ?? '').slice(0, 80)}]` : '',
  ].filter(Boolean).join(' ');
  return `[${stamp}] ${speaker(message, character)}：${body.slice(0, 1200)}${extra ? ` ${extra}` : ''}`;
}

const TYPE_HELP = 'person=人物（用户身边的人或宠物）, preference=喜好/习惯, event=发生的事或安排, fact=关于用户的事实, project=用户在做的事/计划, moment=你们一起做过的事, feeling=用户的心情状态';

export const EXTRACT_SYSTEM = `你是一个记忆整理器，为聊天角色维护关于“用户”和“你们之间”的长期记忆卡片。只输出 JSON，不要任何其他文字。
格式：{"ops":[...],"core":null}
ops 里每项是以下之一：
- {"op":"add","type":"类型","title":"简短标题","content":"一两句完整描述（写清谁、什么、何时）","importance":1-10,"about_user":true/false,"tags":["标签"],"links":[{"to":"N3","relation":"相关/属于/导致/提到"}]}
- {"op":"update","id":"N2","content":"补充后的完整描述","importance":7}
- {"op":"supersede","id":"N5","title":"新标题","content":"新的事实（旧的已不再成立）","type":"类型","importance":6}
- {"op":"link","from":"N1","to":"N2","relation":"关系"}
类型：${TYPE_HELP}。
规则：
1. 只记以后聊天还用得上的：身份、身边的人、喜好、计划、重要经历、情绪变化、你们的约定和一起做过的事。寒暄、一次性的问题、你自己说过的话不要记。
2. 已有卡片里有的就 update 或 noop，不要重复 add；事实发生变化用 supersede（例如搬家、换工作）。
3. about_user：这张卡片是关于用户本人的客观事实或喜好时为 true；你们之间的私密细节为 false。
4. 绝不记录密码、验证码、身份证号、银行卡号等。
5. 最多 6 个 ops；没有值得记的就返回 {"ops":[],"core":null}。
6. core：只有核心事实（用户的名字、最重要的人和事、你们的关系状态）变化时，给出完整的新核心记忆文本（不超过 800 字），否则为 null。`;

export function applyTypes(value: unknown, fallback: NoteType = 'fact'): NoteType {
  return typeof value === 'string' && (NOTE_TYPES as string[]).includes(value) && value !== 'episode' && value !== 'insight' ? value as NoteType : fallback;
}
const clampImportance = (value: unknown, fallback = 5) => (typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.min(10, Math.round(value))) : fallback);
const text = (value: unknown, max: number) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Applies extraction ops. Exported for tests. Returns how many notes were added. */
export async function applyExtraction(character: Character, payload: Record<string, unknown>, labels: Map<string, MemNote>, source: { conversationId: string; messageId: string | null; at: number }): Promise<number> {
  const ops = Array.isArray(payload.ops) ? payload.ops.slice(0, 8) : [];
  // Labels were made before the model call: resolve them against the box as it is now (notes may have been edited or deleted meanwhile).
  const box = await loadBox(character.id);
  const current = new Map(box.notes.map((note) => [note.id, note]));
  const added: MemNote[] = [];
  const changed: Array<{ id: string; patch: Partial<MemNote> }> = [];
  const links: Array<{ source: string; target: string; relation: string }> = [];
  const resolve = (label: unknown) => {
    const labelled = typeof label === 'string' ? labels.get(label.trim().toUpperCase()) : undefined;
    return labelled ? current.get(labelled.id) ?? null : null;
  };
  for (const raw of ops) {
    if (!raw || typeof raw !== 'object') continue;
    const op = raw as Record<string, unknown>;
    if (op.op === 'add' || op.op === 'supersede') {
      const title = text(op.title, 60);
      const content = text(op.content, 600);
      if (!title || rejectsMemory(`${title} ${content}`)) continue;
      const duplicate = box.notes.find((note) => note.validTo === null && note.type !== 'episode' && note.title === title);
      if (duplicate && op.op === 'add') {
        if (content && content !== duplicate.content) changed.push({ id: duplicate.id, patch: { content } });
        continue;
      }
      const note = newNote({
        owner: character.id, type: applyTypes(op.type), title, content, importance: clampImportance(op.importance),
        aboutUser: op.about_user === true, tags: Array.isArray(op.tags) ? op.tags.map((tag) => text(tag, 16)).filter(Boolean).slice(0, 5) : [],
        sourceConversationId: source.conversationId, sourceMessageId: source.messageId, validFrom: source.at,
      });
      added.push(note);
      if (op.op === 'supersede') {
        const old = resolve(op.id);
        if (old) {
          changed.push({ id: old.id, patch: { validTo: source.at, supersededBy: note.id } });
          links.push({ source: note.id, target: old.id, relation: '取代' });
          if (op.type === undefined) note.type = old.type;
          note.aboutUser = note.aboutUser || old.aboutUser;
        }
      }
      if (Array.isArray(op.links)) {
        for (const item of op.links.slice(0, 4)) {
          const target = resolve((item as Record<string, unknown>)?.to);
          if (target) links.push({ source: note.id, target: target.id, relation: text((item as Record<string, unknown>).relation, 8) || '相关' });
        }
      }
    } else if (op.op === 'update') {
      const target = resolve(op.id);
      if (!target) continue;
      const content = text(op.content, 600);
      if (content && rejectsMemory(content)) continue;
      changed.push({ id: target.id, patch: { ...(content ? { content } : {}), importance: clampImportance(op.importance, target.importance) } });
    } else if (op.op === 'link') {
      const from = resolve(op.from);
      const to = resolve(op.to);
      if (from && to) links.push({ source: from.id, target: to.id, relation: text(op.relation, 8) || '相关' });
    }
  }
  // A note may be changed twice in one batch: merge the patches, then write only those columns.
  const merged = new Map<string, Partial<MemNote>>();
  for (const { id, patch } of changed) merged.set(id, { ...(merged.get(id) ?? {}), ...patch });
  await putNotes(character.id, added);
  await patchNotes(character.id, [...merged].map(([id, patch]) => ({ id, patch })));
  await addLinks(character.id, links);
  const core = typeof payload.core === 'string' ? payload.core.trim().slice(0, 1500) : '';
  if (core && !rejectsMemory(core)) await updateCharacter(character.id, { coreMemory: core });
  return added.length;
}

function formatLabeled(notes: MemNote[]): { text: string; labels: Map<string, MemNote> } {
  const labels = new Map<string, MemNote>();
  const lines = notes.map((note, index) => {
    const label = `N${index + 1}`;
    labels.set(label, note);
    return `${label} [${note.type}] ${note.title}：${note.content}`;
  });
  return { text: lines.join('\n') || '（暂无）', labels };
}

const extractFailures = new Map<string, number>();

async function extract(character: Character, worker: WorkerModel, settings: MemoryBoxSettings): Promise<boolean> {
  const window = await listMessagesBetween(character.conversationId!, character.extractedUntil, Number.MAX_SAFE_INTEGER, EXTRACT_BATCH + 1);
  // Never read past a reply that is still being written.
  const firstPending = window.findIndex((message) => message.status === 'pending');
  const messages = firstPending >= 0 ? window.slice(0, firstPending) : window;
  const batch = messages.slice(0, EXTRACT_BATCH);
  if (!batch.length) return false;
  const until = batch[batch.length - 1].createdAt;
  const useful = batch.filter((message) => message.status === 'complete');
  const explicit = character.memoryMode === 'explicit';
  const wanted = character.memoryMode !== 'off' && useful.length > 0
    && (!explicit || useful.some((message) => message.role === 'user' && /记住|记下|别忘|不要忘/.test(message.prompt)));
  let added = 0;
  if (wanted) {
    const transcript = useful.map((message) => line(message, character)).join('\n');
    const box = await loadBox(character.id);
    // What the model needs to avoid duplicates and spot changed facts: related cards plus the freshest and core ones.
    const relevant = retrieve(box.notes, box.links, { query: transcript, limit: 12, includeOutdated: false }).map((item) => item.note);
    const live = box.notes.filter((note) => note.validTo === null && note.type !== 'episode' && note.type !== 'insight');
    const fresh = [...live].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8);
    const core = live.filter((note) => note.pinned || note.importance >= 8).slice(0, 8);
    const related = [...new Map([...relevant, ...core, ...fresh].map((note) => [note.id, note])).values()].slice(0, 24);
    const { text: known, labels } = formatLabeled(related);
    const payload = await completeJson(worker, EXTRACT_SYSTEM,
      `角色：${character.name}\n当前核心记忆：\n${character.coreMemory || '（空）'}\n\n已有的相关记忆卡片：\n${known}\n\n新的聊天记录：\n${transcript}${explicit ? '\n\n（用户选择了“只在要求时记住”：只记录用户明确要求记住的内容。）' : ''}`);
    if (payload) {
      const lastUser = [...useful].reverse().find((message) => message.role === 'user');
      added = await applyExtraction(character, payload, labels, { conversationId: character.conversationId!, messageId: lastUser?.id ?? null, at: lastUser?.createdAt ?? until });
    } else {
      // A batch the model keeps failing on is skipped after a retry, so it can't block memory (and 往事) for good.
      const key = `${character.id}:${until}`;
      const failures = (extractFailures.get(key) ?? 0) + 1;
      extractFailures.set(key, failures);
      if (failures < 2) throw new Error('记忆整理模型没有返回有效的 JSON');
      extractFailures.delete(key);
    }
  }
  const latest = (await loadCharacters()).find((item) => item.id === character.id) ?? character;
  await updateCharacter(character.id, { extractedUntil: until, notesSinceReflection: latest.notesSinceReflection + added });
  void settings;
  return messages.length > EXTRACT_BATCH;
}

async function embedMissing(owner: string, settings: MemoryBoxSettings): Promise<void> {
  if (!env) return;
  const provider = embeddingProvider(env.providers(), settings, env.chatProvider());
  if (!provider) return;
  const box = await loadBox(owner);
  const missing = box.notes.filter((note) => !note.embedding || note.embeddingModel !== embeddingModelOf(provider)).slice(0, 64);
  for (let start = 0; start < missing.length; start += 32) {
    const chunk = missing.slice(start, start + 32);
    const vectors = await embedTexts(provider, embeddingModelOf(provider), chunk.map((note) => `${note.title}\n${note.content}`));
    if (!vectors) return;
    // Only the vector columns: the note may have been edited while the request ran (an edit clears the vector again).
    const latest = new Map((await loadBox(owner)).notes.map((note) => [note.id, note]));
    await patchNotes(owner, chunk.flatMap((note, index) => {
      const now = latest.get(note.id);
      return now && now.title === note.title && now.content === note.content ? [{ id: note.id, patch: { embedding: vectors[index], embeddingModel: embeddingModelOf(provider), updatedAt: now.updatedAt } }] : [];
    }));
  }
}

export const EPISODE_SYSTEM = `你负责把一段聊天压缩成“往事”摘要，供聊天角色以后回忆。只输出 JSON：{"title":"不超过 16 字的标题","summary":"摘要"}
摘要要求：第三人称，200～400 字，按时间写清聊了什么、发生了什么、做了什么决定或约定、用户的情绪变化、你们一起做过的事（画了什么、查了什么），保留人名、数字、日期等关键细节。`;

async function compact(character: Character, worker: WorkerModel, settings: MemoryBoxSettings): Promise<boolean> {
  // Only fold turns that extraction has already read.
  const pending = (await listMessagesBetween(character.conversationId!, character.compactedUntil, character.extractedUntil, 400))
    .filter((message) => message.status === 'complete');
  if (pending.length < RAW_WINDOW) return false;
  const fold = pending.slice(0, FOLD);
  const start = fold[0].createdAt;
  const end = fold[fold.length - 1].createdAt;
  const payload = await completeJson(worker, EPISODE_SYSTEM, `角色：${character.name}\n聊天记录：\n${fold.map((message) => line(message, character)).join('\n')}`);
  const summary = text(payload?.summary, 1200);
  if (!summary) throw new Error('往事摘要生成失败');
  const episode = newNote({
    owner: character.id, type: 'episode', title: text(payload?.title, 24) || dateTitle(start, end), content: summary,
    importance: 4, level: 1, rangeStart: start, rangeEnd: end, validFrom: start, sourceConversationId: character.conversationId,
  });
  await putNotes(character.id, [episode]);
  const box = await loadBox(character.id);
  const ids = new Set(fold.map((message) => message.id));
  await addLinks(character.id, box.notes.filter((note) => note.sourceMessageId && ids.has(note.sourceMessageId)).map((note) => ({ source: episode.id, target: note.id, relation: '提到' })));
  await updateCharacter(character.id, { compactedUntil: end });
  void settings;
  return true;
}

function dateTitle(start: number, end: number): string {
  const a = new Date(start);
  const b = new Date(end);
  const day = (date: Date) => `${date.getMonth() + 1}月${date.getDate()}日`;
  return day(a) === day(b) ? `${day(a)}的聊天` : `${day(a)}–${day(b)}的聊天`;
}

/** Folds the oldest summaries of a level into one higher-level summary once a level grows long. */
async function rollUp(character: Character, worker: WorkerModel, settings: MemoryBoxSettings): Promise<boolean> {
  const box = await loadBox(character.id);
  const open = box.notes.filter((note) => note.type === 'episode' && !note.rolledUp);
  const levels = [...new Set(open.map((note) => note.level))].sort((a, b) => a - b);
  for (const level of levels) {
    const items = open.filter((note) => note.level === level).sort((a, b) => (a.rangeStart ?? 0) - (b.rangeStart ?? 0));
    if (items.length <= ROLLUP_THRESHOLD) continue;
    const group = items.slice(0, ROLLUP_SIZE);
    const payload = await completeJson(worker, EPISODE_SYSTEM, `把下面几段按时间排列的往事摘要合并成一段更概括的往事（保留最重要的人、事、决定和情绪变化）：\n${group.map((note) => `【${note.title}】${note.content}`).join('\n')}`);
    const summary = text(payload?.summary, 1200);
    if (!summary) throw new Error('往事合并失败');
    const start = group[0].rangeStart ?? group[0].createdAt;
    const end = group[group.length - 1].rangeEnd ?? group[group.length - 1].createdAt;
    const parent = newNote({ owner: character.id, type: 'episode', title: text(payload?.title, 24) || dateTitle(start, end), content: summary, importance: 5, level: level + 1, rangeStart: start, rangeEnd: end, validFrom: start, sourceConversationId: character.conversationId });
    await putNotes(character.id, [parent]);
    await patchNotes(character.id, group.map((note) => ({ id: note.id, patch: { rolledUp: true } })));
    await addLinks(character.id, group.map((note) => ({ source: note.id, target: parent.id, relation: '属于' })));
    void settings;
    return true;
  }
  return false;
}

export const REFLECT_SYSTEM = `你是聊天角色的“反思”过程：从最近的记忆卡片里总结出更高层、以后有用的洞察（用户的状态、在意的事、你们关系的变化、可以主动关心的点）。只输出 JSON：
{"insights":[{"title":"不超过 16 字","content":"一两句","importance":1-10,"sources":["N1","N4"]}]}
最多 3 条，没有新的洞察就返回 {"insights":[]}。不要重复已有的感悟。`;

async function reflect(character: Character, worker: WorkerModel, settings: MemoryBoxSettings): Promise<void> {
  const box = await loadBox(character.id);
  const recent = box.notes.filter((note) => note.type !== 'episode' && note.validTo === null).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 24);
  const { text: listed, labels } = formatLabeled(recent);
  const payload = await completeJson(worker, REFLECT_SYSTEM, `角色：${character.name}\n最近的记忆卡片：\n${listed}`);
  const insights = Array.isArray(payload?.insights) ? payload!.insights.slice(0, 3) : [];
  const notes: MemNote[] = [];
  const links: Array<{ source: string; target: string; relation: string }> = [];
  for (const raw of insights) {
    const item = raw as Record<string, unknown>;
    const title = text(item?.title, 30);
    if (!title || box.notes.some((note) => note.type === 'insight' && note.title === title)) continue;
    const note = newNote({ owner: character.id, type: 'insight', title, content: text(item.content, 400), importance: clampImportance(item.importance, 6) });
    notes.push(note);
    for (const label of Array.isArray(item.sources) ? item.sources.slice(0, 6) : []) {
      const source = typeof label === 'string' ? labels.get(label.trim().toUpperCase()) : undefined;
      if (source) links.push({ source: note.id, target: source.id, relation: '总结' });
    }
  }
  await putNotes(character.id, notes);
  await addLinks(character.id, links);
  await updateCharacter(character.id, { notesSinceReflection: 0 });
  void settings;
}

/** Runs pending work for every character (called at startup). */
export async function catchUpAll(): Promise<void> {
  await removeOrphans().catch(() => undefined);
  const list = await loadCharacters().catch(() => []);
  for (const character of list) void scheduleMemoryWork(character.id);
}

/** Manual “整理” from the canvas: reflect now, whatever the counter says. Runs in the character's queue, never beside it. */
export async function reflectNow(characterId: string): Promise<void> {
  if (!env) throw new Error('应用尚未就绪');
  const settings = await loadMemoryBoxSettings();
  const character = (await loadCharacters()).find((item) => item.id === characterId);
  if (!character) throw new Error('角色已不存在');
  if (!resolveWorker(env.providers(), settings, character, env.chatProvider())) throw new Error('需要一个对话模型来整理记忆');
  const done = new Promise<void>((resolve, reject) => {
    reflections.set(characterId, [...(reflections.get(characterId) ?? []), { resolve, reject }]);
  });
  void scheduleMemoryWork(characterId);
  await done;
}

/** Explicit memory from the chat (tool or user). */
export async function writeMemory(characterId: string, input: { title: string; content: string; type?: string; importance?: number; conversationId?: string | null; messageId?: string | null }): Promise<MemNote> {
  const title = text(input.title, 60);
  if (!title) throw new Error('标题为空');
  if (rejectsMemory(`${title} ${input.content}`)) throw new Error('包含密码、证件或卡号等敏感信息，没有记录');
  const box = await loadBox(characterId);
  const existing = box.notes.find((note) => note.validTo === null && note.title === title && note.type !== 'episode');
  if (existing) return (await updateNote(characterId, existing.id, { content: text(input.content, 600) || existing.content, importance: clampImportance(input.importance, existing.importance) }))!;
  const note = newNote({
    owner: characterId, type: applyTypes(input.type, 'fact'), title, content: text(input.content, 600), importance: clampImportance(input.importance, 7),
    aboutUser: input.type !== 'moment', sourceConversationId: input.conversationId ?? null, sourceMessageId: input.messageId ?? null,
  });
  await putNotes(characterId, [note]);
  const character = (await loadCharacters()).find((item) => item.id === characterId);
  if (character) await updateCharacter(characterId, { notesSinceReflection: character.notesSinceReflection + 1 });
  if (env) {
    const settings = await loadMemoryBoxSettings();
    const provider = embeddingProvider(env.providers(), settings, env.chatProvider());
    const vectors = await embedTexts(provider, embeddingModelOf(provider), [`${note.title}\n${note.content}`]);
    if (vectors) await patchNotes(characterId, [{ id: note.id, patch: { embedding: vectors[0], embeddingModel: embeddingModelOf(provider), updatedAt: note.updatedAt } }]);
  }
  return note;
}
