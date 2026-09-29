import type { AgentToolkit, ToolExecution } from '../api/chat-api';
import { createToolbox, type DrawResult } from '../agent/toolbox';
import type { AgentSettings } from '../agent/settings';
import { TOOL_SPECS, type ToolCall } from '../agent/tools';
import type { AgentTrace } from '../agent/types';
import type { ChatApi, ProviderProfile } from '../domain';
import { createId } from '../domain-utils';
import type { ImageToolCall } from '../agent/image-tool';
import { searchMessages } from '../storage/database';
import { formatNote } from './context';
import { writeMemory } from './pipeline';
import { retrieve } from './search';
import { embeddingModelOf, embedTexts, type MemoryBoxSettings } from './settings';
import { loadBox, updateCharacter } from './store';
import type { Character } from './types';

/**
 * Tools of a chat character: drawing and web search (reusing the assistant's
 * executors) plus its memory box — search, look back at old messages, write
 * a memory, rewrite the core memory.
 */
export async function createCompanionToolbox(options: {
  character: Character; conversationId: string; api: ChatApi; baseUrl: string; settings: AgentSettings; boxSettings: MemoryBoxSettings;
  imageAvailable: boolean; voice: boolean; embeddings: ProviderProfile | null;
  drawImage: (call: ImageToolCall, options: { preview: boolean }) => Promise<DrawResult>;
  updateTrace: (update: (trace: AgentTrace) => AgentTrace) => void;
}): Promise<{ toolkit: AgentToolkit; instructions: string[] }> {
  const { character } = options;
  const base = await createToolbox({
    api: options.api, baseUrl: options.baseUrl, conversationId: options.conversationId, imageAvailable: options.imageAvailable, voice: options.voice,
    research: false, agent: null, memories: [], drawImage: options.drawImage, updateTrace: options.updateTrace,
    capabilities: [...(character.canDraw ? ['image' as const] : []), ...(character.canSearch ? ['search' as const] : [])],
    // The character has its own memory and style; only the user's self-description carries over.
    settings: { ...options.settings, memoryEnabled: false, historySearch: false, phoneActions: false, responseStyle: '', imageCheck: 'off' },
  });
  const memoryOn = options.boxSettings.enabled && character.memoryMode !== 'off';
  const specs = [...base.toolkit.specs];
  if (options.boxSettings.enabled) specs.push(TOOL_SPECS.memory_search, TOOL_SPECS.recall_conversation);
  if (memoryOn) specs.push(TOOL_SPECS.memory_write, TOOL_SPECS.core_memory_update);

  const step = (kind: 'recall' | 'history' | 'memory', title: string, detail: string, status: 'done' | 'error' = 'done') => {
    options.updateTrace((trace) => ({ ...trace, steps: [...trace.steps, { id: createId(), kind, title, detail, status, startedAt: Date.now(), endedAt: Date.now(), ...(status === 'error' ? { error: detail } : {}) }] }));
  };
  const addRecalled = (items: Array<{ id: string; title: string }>) => {
    options.updateTrace((trace) => {
      const current = trace.recalled ?? [];
      const merged = [...current, ...items.filter((item) => !current.some((existing) => existing.id === item.id))].slice(0, 30);
      return { ...trace, recalled: merged };
    });
  };
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

  const execute = async (call: ToolCall, context: Parameters<AgentToolkit['execute']>[1]): Promise<ToolExecution> => {
    const input = call.input;
    switch (call.name) {
      case 'memory_search': {
        if (!input) return { content: '参数不是有效的 JSON。' };
        const query = text(input.query);
        const box = await loadBox(character.id);
        const vectors = await embedTexts(options.embeddings, embeddingModelOf(options.embeddings), [query], context.signal);
        const hits = retrieve(box.notes, box.links, { query, queryEmbedding: vectors?.[0], embeddingModel: embeddingModelOf(options.embeddings), limit: 8, includeEpisodes: true, includeOutdated: true });
        step('recall', `回想：${query.slice(0, 24)}`, hits.length ? `想起 ${hits.length} 件事` : '没有找到');
        addRecalled(hits.map((hit) => ({ id: hit.note.id, title: hit.note.title })));
        return { content: hits.length ? hits.map((hit) => formatNote(hit.note)).join('\n') : '记忆匣里没有找到相关的事。' };
      }
      case 'recall_conversation': {
        if (!input) return { content: '参数不是有效的 JSON。' };
        const query = text(input.query);
        const hits = await searchMessages(query, { conversationId: options.conversationId, limit: 10 }).catch(() => []);
        step('history', `翻看聊天记录：${query.slice(0, 20)}`, hits.length ? `找到 ${hits.length} 处` : '没有找到');
        return { content: hits.length
          ? hits.map((hit) => `${new Date(hit.createdAt).toLocaleString()} ${hit.role === 'user' ? '用户' : character.name}：${hit.snippet}`).join('\n')
          : '以前的聊天里没有找到。' };
      }
      case 'memory_write': {
        if (!memoryOn || !input) return { content: '现在不能写入记忆。' };
        try {
          const note = await writeMemory(character.id, {
            title: text(input.title), content: text(input.content), type: text(input.type), importance: typeof input.importance === 'number' ? input.importance : undefined,
            conversationId: options.conversationId,
          });
          step('memory', `记住：${note.title}`, '已写入记忆匣');
          addRecalled([{ id: note.id, title: note.title }]);
          return { content: `已记住“${note.title}”。` };
        } catch (error) {
          const message = error instanceof Error ? error.message : '没有记录';
          step('memory', '记忆没有写入', message, 'error');
          return { content: `没有记录：${message}` };
        }
      }
      case 'core_memory_update': {
        if (!memoryOn || !input) return { content: '现在不能修改核心记忆。' };
        const content = text(input.content).slice(0, 1500);
        if (!content) return { content: '内容为空。' };
        if (/(密码|password|验证码|身份证号|银行卡号|cvv)/i.test(content)) return { content: '核心记忆不能包含密码、证件或卡号。' };
        await updateCharacter(character.id, { coreMemory: content });
        step('memory', '更新了核心记忆', `${content.length} 字`);
        return { content: '核心记忆已更新。' };
      }
      default:
        return base.toolkit.execute(call, context);
    }
  };
  return {
    toolkit: { ...base.toolkit, specs, execute, maxSteps: 6 },
    // The assistant-side instructions carry over (image defaults, “关于我”); memory tools are explained in the persona.
    instructions: base.instructions,
  };
}
