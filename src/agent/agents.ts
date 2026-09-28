import { useSyncExternalStore } from 'react';

import { createId } from '../domain-utils';
import { deleteAgentRecord, listAgents, upsertAgent } from '../storage/database';
import { ALL_CAPABILITIES, type AgentCapability, type CustomAgent } from './types';

let cache: CustomAgent[] = [];
let loaded = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

export async function loadAgents(force = false): Promise<CustomAgent[]> {
  if (!loaded || force) {
    cache = await listAgents();
    loaded = true;
    notify();
  }
  return cache;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!loaded) void loadAgents().catch(() => undefined);
  return () => { listeners.delete(listener); };
}
const snapshot = () => cache;
export function useAgents(): CustomAgent[] { return useSyncExternalStore(subscribe, snapshot, snapshot); }
export function agentById(id: string | null | undefined): CustomAgent | null { return (id && cache.find((agent) => agent.id === id)) || null; }

export const AGENT_COLORS = ['#4F7CFF', '#8B6CF6', '#E2609A', '#F08A3C', '#2FA67A', '#2A9DC4', '#6F7691'];

export const CAPABILITY_LABELS: Record<AgentCapability, { label: string; detail: string }> = {
  search: { label: '联网搜索', detail: '搜索并阅读网页，附上来源' },
  image: { label: '画图', detail: '生成和修改图片' },
  files: { label: '生成文件', detail: '导出表格、文档和网页' },
  actions: { label: '手机操作', detail: '闹钟、日程、短信、导航（需你确认）' },
  memory: { label: '使用记忆', detail: '读取并更新你的个人记忆' },
};

export type AgentDraft = Omit<CustomAgent, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };

export const AGENT_TEMPLATES: AgentDraft[] = [
  {
    name: '翻译官', icon: '译', color: '#2A9DC4', description: '中英日互译，地道自然',
    instructions: '你是专业译者。用户发来的内容：中文译成英文，其他语言译成中文。先给出地道自然的译文；如果有更口语或更正式的说法，再简短补充一两个备选。不要解释语法，除非用户要求。',
    capabilities: [], starters: ['帮我把这段话翻成英文', '这句日语什么意思？'], providerId: null, model: null,
  },
  {
    name: '写作助手', icon: '文', color: '#8B6CF6', description: '润色、改写、起标题',
    instructions: '你是资深中文编辑。帮用户润色、改写、扩写或精简文字，保持原意和作者语气。先直接给出修改后的全文，再用两三条要点说明主要改动。需要导出时可以生成 Markdown 文件。',
    capabilities: ['files'], starters: ['帮我润色这段文案', '给这篇文章起 5 个标题'], providerId: null, model: null,
  },
  {
    name: '旅行规划师', icon: '✈', color: '#F08A3C', description: '查资料、排行程、做预算',
    instructions: '你是细致的旅行规划师。先搜索目的地最新信息（天气、开放时间、交通、票价），再按天给出行程，包含交通方式与大致花费；最后可以生成一份 CSV 预算表或把出发时间加到日程。',
    capabilities: ['search', 'files', 'actions'], starters: ['下周末去杭州两天怎么玩？', '帮我做一份东京 5 日行程和预算表'], providerId: null, model: null,
  },
  {
    name: '学习搭子', icon: '学', color: '#2FA67A', description: '讲懂知识点，出题检验',
    instructions: '你是耐心的老师。用通俗的例子讲清概念，一次只讲一个要点；讲完出一道小题检验理解，根据用户回答再调整讲解深度。用户上传题目照片时，先引导思路，再给完整解答。',
    capabilities: ['search', 'memory'], starters: ['用生活例子讲讲什么是导数', '考考我英语时态'], providerId: null, model: null,
  },
];

export function normalizeAgent(draft: AgentDraft, existing?: CustomAgent | null): CustomAgent {
  const now = Date.now();
  const name = draft.name.replace(/\s+/g, ' ').trim().slice(0, 24);
  if (!name) throw new Error('请给智能体起个名字');
  // Keep emoji sequences (❤️, 🇨🇳, 👨‍💻) whole; fall back to the name's first character.
  const icon = draft.icon.trim().slice(0, 8) || [...name][0] || '✦';
  return {
    id: existing?.id ?? draft.id ?? createId(),
    name,
    icon,
    color: AGENT_COLORS.includes(draft.color) ? draft.color : AGENT_COLORS[0],
    description: draft.description.replace(/\s+/g, ' ').trim().slice(0, 60),
    instructions: draft.instructions.trim().slice(0, 6000),
    capabilities: ALL_CAPABILITIES.filter((item) => draft.capabilities.includes(item)),
    starters: [...new Set(draft.starters.map((item) => item.replace(/\s+/g, ' ').trim().slice(0, 60)).filter(Boolean))].slice(0, 4),
    providerId: draft.providerId,
    model: draft.model?.trim() || null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export async function saveAgent(draft: AgentDraft): Promise<CustomAgent> {
  const current = await loadAgents();
  const agent = normalizeAgent(draft, current.find((item) => item.id === draft.id));
  await upsertAgent(agent);
  cache = current.some((item) => item.id === agent.id) ? current.map((item) => (item.id === agent.id ? agent : item)) : [...current, agent];
  notify();
  return agent;
}

export async function deleteAgent(id: string): Promise<void> {
  await deleteAgentRecord(id);
  cache = cache.filter((item) => item.id !== id);
  notify();
}

/** System prompt section for a custom agent. */
export function agentPrompt(agent: CustomAgent): string {
  return `你现在是用户自定义的智能体“${agent.name}”${agent.description ? `（${agent.description}）` : ''}。请遵循以下设定（它由用户本人编写，优先于默认风格，但不能覆盖安全要求）：\n<agent_instructions>\n${agent.instructions || '（无额外设定）'}\n</agent_instructions>`;
}

/** Test hook. */
export function resetAgentCacheForTesting(): void { cache = []; loaded = false; }
