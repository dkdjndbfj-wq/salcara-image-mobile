import { useSyncExternalStore } from 'react';

import { createId } from '../domain-utils';
import { clearMemoryRecords, deleteMemoryRecord, insertMemory, listMemories, updateMemoryContent } from '../storage/database';
import type { Memory } from './types';

/** Upper bounds that keep the system prompt small. */
export const MAX_MEMORIES = 80;
const MAX_MEMORY_CHARACTERS = 300;
const MAX_PROMPT_CHARACTERS = 5000;

let cache: Memory[] = [];
let loaded = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

export async function loadMemories(force = false): Promise<Memory[]> {
  if (!loaded || force) {
    cache = await listMemories();
    loaded = true;
    notify();
  }
  return cache;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!loaded) void loadMemories().catch(() => undefined);
  return () => { listeners.delete(listener); };
}
const snapshot = () => cache;
export function useMemories(): Memory[] { return useSyncExternalStore(subscribe, snapshot, snapshot); }

/** Things that must never be stored, whatever the model decides. */
export function rejectsMemory(content: string): string | null {
  if (/\b\d{15,19}\b/.test(content.replace(/[\s-]/g, ''))) return '看起来包含卡号或证件号，没有记录';
  if (/(密码|password|passcode|api[\s_-]?key|密钥|token|验证码|cvv|身份证号|银行卡号)/i.test(content)) return '包含密码、密钥或证件等敏感信息，没有记录';
  return null;
}

export function normalizeMemory(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, MAX_MEMORY_CHARACTERS);
}

export async function addMemory(content: string, conversationId: string | null = null): Promise<{ memory: Memory | null; message: string }> {
  const clean = normalizeMemory(content);
  if (!clean) return { memory: null, message: '内容为空，没有记录' };
  const rejected = rejectsMemory(clean);
  if (rejected) return { memory: null, message: rejected };
  const current = await loadMemories();
  const duplicate = current.find((item) => item.content === clean);
  if (duplicate) return { memory: duplicate, message: '这条已经记住了' };
  if (current.length >= MAX_MEMORIES) return { memory: null, message: `记忆已满（最多 ${MAX_MEMORIES} 条），请让用户在“设置 → 个性化”里清理后再记` };
  const now = Date.now();
  const memory: Memory = { id: createId(), content: clean, conversationId, createdAt: now, updatedAt: now };
  await insertMemory(memory);
  cache = [...current, memory];
  notify();
  return { memory, message: '已记住' };
}

export async function editMemory(id: string, content: string): Promise<void> {
  const clean = normalizeMemory(content);
  if (!clean) { await removeMemory(id); return; }
  await updateMemoryContent(id, clean);
  cache = cache.map((item) => (item.id === id ? { ...item, content: clean, updatedAt: Date.now() } : item));
  notify();
}

export async function removeMemory(id: string): Promise<boolean> {
  const exists = (await loadMemories()).some((item) => item.id === id);
  if (!exists) return false;
  await deleteMemoryRecord(id);
  cache = cache.filter((item) => item.id !== id);
  notify();
  return true;
}

export async function clearMemories(): Promise<void> {
  await clearMemoryRecords();
  cache = [];
  notify();
}

/** Labels (M1, M2…) the model uses to refer to memories in this turn. */
export function memoryLabels(memories: Memory[]): Map<string, string> {
  return new Map(memories.map((memory, index) => [`M${index + 1}`, memory.id]));
}

/** The memory section of the system prompt, newest kept when over budget. */
export function memoryPrompt(memories: Memory[]): string {
  if (!memories.length) return '';
  const lines: string[] = [];
  let total = 0;
  for (let index = memories.length - 1; index >= 0; index -= 1) {
    const line = `M${index + 1}. ${memories[index].content}`;
    if (total + line.length > MAX_PROMPT_CHARACTERS) break;
    lines.unshift(line);
    total += line.length;
  }
  return `你记得的关于用户的信息（来自以往对话，可能过时；只在相关时自然地使用，不要逐条复述）：\n${lines.join('\n')}`;
}

/** Test hook. */
export function resetMemoryCacheForTesting(): void { cache = []; loaded = false; }
