import { Platform } from 'react-native';

import type { AgentToolkit, ToolExecution } from '../api/chat-api';
import type { ChatApi } from '../domain';
import { createId } from '../domain-utils';
import { searchMessages } from '../storage/database';
import { ActionInputError, createPhoneAction } from './actions';
import { agentPrompt } from './agents';
import { writeGeneratedFile } from './files';
import { parseImageToolArguments, type ImageToolCall } from './image-tool';
import { addMemory, memoryLabels, memoryPrompt, removeMemory } from './memory';
import { getSearchKey, type AgentSettings } from './settings';
import { phoneActionSpec, TOOL_SPECS, type ToolCall, type ToolSpec } from './tools';
import type { AgentCapability, AgentStep, AgentTrace, CustomAgent, Memory, PlanItem, Source, StepKind } from './types';
import { hostOf, readWebpage, webSearch, type Recency, type SearchConfig } from './web';

export const NORMAL_LIMITS = { steps: 8, searches: 5, reads: 5, files: 3, actions: 3, memories: 5, history: 3 };
export const RESEARCH_LIMITS = { steps: 24, searches: 16, reads: 16, files: 3, actions: 3, memories: 5, history: 3 };

export const RESEARCH_INSTRUCTIONS = `这是一次深度研究：
1. 先调用 update_plan 列出 3～6 个研究步骤。
2. 按计划多轮搜索（换不同关键词、不同语言、找一手来源），用 read_webpage 阅读最有价值的原文，不要只看摘要；每完成一步就更新计划。
3. 资料之间有冲突时，比较来源可信度并在报告里说明。
4. 最后写一份结构清晰的研究报告：开头是结论摘要，然后分节展开，关键事实都用 [编号] 标注来源，结尾列出仍不确定的地方。`;

export interface DrawResult {
  /** Label of the new image, e.g. “图5”. */
  label: string;
  /** Downscaled copy for the model to check, when requested. */
  preview?: string;
}

export interface ToolboxOptions {
  api: ChatApi;
  baseUrl: string;
  settings: AgentSettings;
  conversationId: string;
  imageAvailable: boolean;
  voice: boolean;
  research: boolean;
  agent: CustomAgent | null;
  memories: Memory[];
  /** Runs the paid image request and saves it on the message. Throws on failure (the turn ends as a retryable error). */
  drawImage: (call: ImageToolCall, options: { preview: boolean }) => Promise<DrawResult>;
  /** Applies a change to the message's trace (and shows it). */
  updateTrace: (update: (trace: AgentTrace) => AgentTrace) => void;
  /** Overrides the capabilities (chat characters); the agent prompt is then not added. */
  capabilities?: AgentCapability[];
  /** Platform the phone actions are prepared for (default: this phone). iOS has no alarms / timers. */
  platform?: string;
}

const OFFICIAL_SEARCH_HOSTS: Partial<Record<ChatApi, RegExp>> = { responses: /(^|\.)api\.openai\.com$/i, anthropic: /(^|\.)api\.anthropic\.com$/i };

/** Which search runs this turn: the provider's own, a configured service, or none. */
export async function resolveSearch(settings: AgentSettings, api: ChatApi, baseUrl: string): Promise<{ native: boolean; config: SearchConfig | null }> {
  if (settings.webSearch === 'off') return { native: false, config: null };
  const nativeCapable = api === 'responses' || api === 'anthropic';
  const official = Boolean(OFFICIAL_SEARCH_HOSTS[api]?.test(hostOf(baseUrl)));
  const fallback = async (): Promise<SearchConfig> => {
    const tavily = await getSearchKey('tavily');
    if (tavily) return { engine: 'tavily', key: tavily };
    const brave = await getSearchKey('brave');
    if (brave) return { engine: 'brave', key: brave };
    if (settings.searxngUrl.trim()) return { engine: 'searxng', searxngUrl: settings.searxngUrl };
    return { engine: 'builtin' };
  };
  switch (settings.webSearch) {
    case 'native': return { native: nativeCapable, config: await fallback() };
    case 'tavily': { const key = await getSearchKey('tavily'); return { native: false, config: key ? { engine: 'tavily', key } : await fallback() }; }
    case 'brave': { const key = await getSearchKey('brave'); return { native: false, config: key ? { engine: 'brave', key } : await fallback() }; }
    case 'searxng': return { native: false, config: settings.searxngUrl.trim() ? { engine: 'searxng', searxngUrl: settings.searxngUrl } : await fallback() };
    case 'builtin': return { native: false, config: { engine: 'builtin' } };
    default: return { native: official && nativeCapable, config: await fallback() };
  }
}

export function capabilitiesFor(agent: CustomAgent | null): Set<AgentCapability> {
  return new Set(agent ? agent.capabilities : ['search', 'image', 'files', 'actions', 'memory']);
}

const excerpt = (text: string, max = 28) => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > max ? `${flat.slice(0, max)}…` : flat; };
const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/**
 * Builds the tools for one turn and the matching extra instructions. Every
 * tool records a step in the message's trace so the user sees what happened.
 */
export async function createToolbox(options: ToolboxOptions): Promise<{ toolkit: AgentToolkit; instructions: string[] }> {
  const { settings } = options;
  const capabilities = options.capabilities ? new Set(options.capabilities) : capabilitiesFor(options.agent);
  const limits = options.research ? RESEARCH_LIMITS : NORMAL_LIMITS;
  const search = capabilities.has('search') ? await resolveSearch(settings, options.api, options.baseUrl) : { native: false, config: null };
  const imageLimit = settings.imageCheck === 'redraw' ? 2 : 1;
  const memoryOn = settings.memoryEnabled && capabilities.has('memory');
  const labels = memoryLabels(options.memories);
  const platform = options.platform ?? Platform.OS;
  const phoneSpec = phoneActionSpec(platform);

  const specs: ToolSpec[] = [];
  if (options.imageAvailable && capabilities.has('image')) specs.push(TOOL_SPECS.generate_image);
  if (search.config || search.native) specs.push(TOOL_SPECS.web_search);
  if (search.config) specs.push(TOOL_SPECS.read_webpage);
  if (options.research && (search.config || search.native)) specs.push(TOOL_SPECS.update_plan);
  if (memoryOn) specs.push(TOOL_SPECS.remember, ...(options.memories.length ? [TOOL_SPECS.forget] : []));
  // Past conversations are personal context: custom agents only see them when allowed to use memory.
  if (settings.historySearch && capabilities.has('memory') && !options.voice) specs.push(TOOL_SPECS.search_history);
  if (settings.phoneActions && capabilities.has('actions') && !options.voice) specs.push(phoneSpec);
  if (capabilities.has('files') && !options.voice) specs.push(TOOL_SPECS.create_file);

  const instructions: string[] = [];
  if (options.agent) instructions.push(agentPrompt(options.agent));
  if (settings.aboutMe.trim() && capabilities.has('memory')) instructions.push(`用户希望你了解的关于他/她的信息（用户本人填写）：\n${settings.aboutMe.trim()}`);
  if (settings.responseStyle.trim()) instructions.push(`用户希望的回答方式（用户本人填写，除非与当前要求冲突，请遵守）：\n${settings.responseStyle.trim()}`);
  if (memoryOn && options.memories.length) instructions.push(memoryPrompt(options.memories));
  if (options.research) {
    instructions.push(search.config || search.native
      ? RESEARCH_INSTRUCTIONS
      : '用户开启了深度研究，但联网搜索已关闭（或当前智能体不能联网）。请基于已有知识写一份结构清晰的报告：开头是结论摘要，然后分节展开，并在开头提醒用户这次没有联网、信息可能不是最新的。');
  }
  if (options.imageAvailable && capabilities.has('image') && settings.imageCheck !== 'off') {
    instructions.push(settings.imageCheck === 'redraw'
      ? '画完后你会看到生成的图片。检查它是否符合用户要求（主体、数量、文字是否正确、比例、明显瑕疵）。只有明显不符合时，才用改进后的提示词再调用一次 generate_image（本轮最多重画一次）；然后用一两句话告诉用户结果。'
      : '画完后你会看到生成的图片。简单检查它是否符合用户要求，用一两句话告诉用户结果，指出明显的问题并建议怎么改（不要自己重画）。');
  }

  const counts: Record<string, number> = {};
  const bump = (name: string) => { counts[name] = (counts[name] ?? 0) + 1; return counts[name]; };
  let pendingNote = '';
  let imagesDrawn = 0;

  const addStep = (kind: StepKind, title: string, extra: Partial<AgentStep> = {}): string => {
    const id = createId();
    const note = pendingNote;
    pendingNote = '';
    options.updateTrace((trace) => ({ ...trace, steps: [...trace.steps, { id, kind, title, status: 'running', startedAt: Date.now(), ...(note ? { note } : {}), ...extra }] }));
    return id;
  };
  const finishStep = (id: string, patch: Partial<AgentStep>) => {
    options.updateTrace((trace) => ({ ...trace, steps: trace.steps.map((step) => (step.id === id ? { ...step, status: 'done', endedAt: Date.now(), ...patch } : step)) }));
  };
  const failStep = (id: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    finishStep(id, { status: 'error', error: message });
    return message;
  };
  /** Adds sources to the trace and returns their citation numbers. */
  let sourceList: Source[] = [];
  const cite = (items: Source[]): number[] => {
    const numbers: number[] = [];
    const next = [...sourceList];
    for (const item of items) {
      let index = next.findIndex((source) => source.url === item.url);
      if (index < 0) { next.push({ title: item.title, url: item.url, ...(item.snippet ? { snippet: item.snippet.slice(0, 200) } : {}) }); index = next.length - 1; }
      numbers.push(index + 1);
    }
    sourceList = next;
    options.updateTrace((trace) => ({ ...trace, sources: next }));
    return numbers;
  };
  const overLimit = (name: string, limit: number, label: string): ToolExecution | null =>
    bump(name) > limit ? { content: `本轮${label}次数已用完（上限 ${limit} 次），请根据已有信息继续。` } : null;

  const execute = async (call: ToolCall, context: { signal?: AbortSignal }): Promise<ToolExecution> => {
    const input = call.input;
    if (!input) return { content: `工具 ${call.name} 的参数不是有效的 JSON，请重新调用。` };
    switch (call.name) {
      case 'generate_image': {
        if (!specs.includes(TOOL_SPECS.generate_image)) return { content: '当前不能作图。' };
        if (imagesDrawn >= imageLimit) return { content: '本轮作图次数已用完，不要再画，请直接回复用户。' };
        const parsed = parseImageToolArguments(input);
        if (!parsed) return { content: 'generate_image 需要 prompt 参数。' };
        pendingNote = '';
        const redraw = imagesDrawn > 0;
        const id = addStep('image', `${redraw ? '重新画图' : '画图'}：${excerpt(parsed.prompt, 30)}`);
        imagesDrawn += 1;
        const wantsCheck = settings.imageCheck !== 'off' && imagesDrawn < imageLimit + (settings.imageCheck === 'check' ? 1 : 0);
        let result: DrawResult;
        try {
          result = await options.drawImage(parsed, { preview: wantsCheck });
        } catch (error) {
          failStep(id, error);
          throw error;
        }
        finishStep(id, { detail: `已生成 ${result.label}` });
        if (wantsCheck && result.preview) {
          const checkId = addStep('check', '检查画面是否符合要求');
          finishStep(checkId, {});
          return { content: `已生成 ${result.label}，用户已经看到了。下面是这张图，请检查。`, images: [result.preview], keepText: true };
        }
        return { content: `已生成 ${result.label}，用户已经看到了。`, terminal: true, keepText: true };
      }
      case 'web_search': {
        if (!search.config) return { content: '联网搜索不可用。' };
        const limited = overLimit('web_search', limits.searches, '搜索');
        if (limited) return limited;
        const query = str(input.query);
        const id = addStep('search', `搜索：${excerpt(query, 30)}`);
        try {
          const recency = ['day', 'week', 'month', 'year'].includes(str(input.recency)) ? str(input.recency) as Recency : undefined;
          const response = await webSearch(query, search.config, { recency, count: options.research ? 8 : 6, signal: context.signal });
          const numbers = cite(response.results);
          finishStep(id, { detail: response.results.length ? `${response.results.length} 条结果 · ${response.engine}` : '没有找到结果', sources: response.results.slice(0, 8) });
          if (!response.results.length) return { content: '没有找到结果。可以换个关键词再搜一次。' };
          return { content: response.results.map((item, index) => `[${numbers[index]}] ${item.title}\n${item.url}${item.published ? `\n发布时间：${item.published}` : ''}\n${item.snippet ?? ''}`.trim()).join('\n\n') };
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') throw error;
          return { content: `搜索失败：${failStep(id, error)}` };
        }
      }
      case 'read_webpage': {
        if (!search.config) return { content: '读取网页不可用。' };
        const limited = overLimit('read_webpage', limits.reads, '读取网页');
        if (limited) return limited;
        const url = str(input.url);
        const id = addStep('read', `阅读：${hostOf(url)}`);
        try {
          const page = await readWebpage(url, context.signal);
          const [number] = cite([{ title: page.title, url: page.url }]);
          finishStep(id, { title: `阅读：${excerpt(page.title, 30)}`, detail: `${page.text.length} 字`, sources: [{ title: page.title, url: page.url }] });
          return { content: `来源 [${number}] ${page.title}\n${page.url}\n\n${page.text}` };
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') throw error;
          return { content: `无法读取这个网页：${failStep(id, error)}` };
        }
      }
      case 'update_plan': {
        const steps = Array.isArray(input.steps) ? input.steps : [];
        const plan: PlanItem[] = steps.map((item) => {
          const record = item && typeof item === 'object' ? item as Record<string, unknown> : { title: String(item) };
          return { title: excerpt(str(record.title), 60), done: record.done === true };
        }).filter((item) => item.title).slice(0, 10);
        if (!plan.length) return { content: 'update_plan 需要 steps。' };
        pendingNote = '';
        options.updateTrace((trace) => ({ ...trace, plan }));
        return { content: `计划已更新（${plan.filter((item) => item.done).length}/${plan.length} 完成）。继续执行下一步。` };
      }
      case 'remember': {
        if (!memoryOn) return { content: '记忆功能已关闭。' };
        const limited = overLimit('remember', limits.memories, '记忆');
        if (limited) return limited;
        const fact = str(input.fact);
        const id = addStep('memory', `记住：${excerpt(fact, 30)}`);
        try {
          const { memory, message } = await addMemory(fact, options.conversationId);
          finishStep(id, memory ? { detail: message } : { status: 'error', error: message });
          return { content: memory ? `${message}。` : `没有记录：${message}` };
        } catch (error) {
          return { content: `没有记录：${failStep(id, error)}` };
        }
      }
      case 'forget': {
        if (!memoryOn) return { content: '记忆功能已关闭。' };
        const label = str(input.memory_id).toUpperCase().replace(/^(\d+)$/, 'M$1');
        const memoryId = labels.get(label);
        const memory = options.memories.find((item) => item.id === memoryId);
        const id = addStep('memory', `忘记：${memory ? excerpt(memory.content, 30) : label || '未知记忆'}`);
        if (!memoryId || !(await removeMemory(memoryId).catch(() => false))) {
          finishStep(id, { status: 'error', error: '没有找到这条记忆' });
          return { content: `没有找到记忆 ${label}。` };
        }
        finishStep(id, { detail: '已删除' });
        return { content: `已删除记忆 ${label}。` };
      }
      case 'search_history': {
        const limited = overLimit('search_history', limits.history, '搜索历史');
        if (limited) return limited;
        const query = str(input.query);
        const id = addStep('history', `查找历史对话：${excerpt(query, 24)}`);
        try {
          const hits = await searchMessages(query, { limit: 12, excludeConversationId: options.conversationId });
          finishStep(id, { detail: hits.length ? `找到 ${hits.length} 条` : '没有找到' });
          if (!hits.length) return { content: '历史对话里没有找到相关内容。' };
          return { content: hits.map((hit) => `《${hit.title}》${new Date(hit.createdAt).toLocaleDateString()} ${hit.role === 'user' ? '用户' : '你'}：${hit.snippet}`).join('\n') };
        } catch (error) {
          return { content: `搜索历史失败：${failStep(id, error)}` };
        }
      }
      case 'phone_action': {
        if (!specs.includes(phoneSpec)) return { content: '当前不能准备手机操作。' };
        const limited = overLimit('phone_action', limits.actions, '手机操作');
        if (limited) return limited;
        try {
          const action = createPhoneAction(input, new Date(), platform);
          const id = addStep('action', `准备：${action.summary}`);
          finishStep(id, { detail: '等待你确认' });
          options.updateTrace((trace) => ({ ...trace, actions: [...(trace.actions ?? []), action] }));
          return { content: `已生成确认卡片：“${action.summary}”。用户点卡片上的按钮后才会打开系统应用执行。` };
        } catch (error) {
          if (error instanceof ActionInputError) return { content: `参数有误：${error.message}` };
          throw error;
        }
      }
      case 'create_file': {
        if (!specs.includes(TOOL_SPECS.create_file)) return { content: '当前不能生成文件。' };
        const limited = overLimit('create_file', limits.files, '生成文件');
        if (limited) return limited;
        const id = addStep('file', `生成文件：${excerpt(str(input.filename) || '文件', 30)}`);
        try {
          const file = writeGeneratedFile(str(input.filename), typeof input.content === 'string' ? input.content : '');
          finishStep(id, { title: `生成文件：${file.name}`, detail: `${Math.max(1, Math.round(file.size / 1024))} KB` });
          options.updateTrace((trace) => ({ ...trace, files: [...(trace.files ?? []), file] }));
          return { content: `文件“${file.name}”已生成，用户可以打开或分享。不要在回答里重复全部内容，简单说明即可。`, keepText: true };
        } catch (error) {
          return { content: `生成文件失败：${failStep(id, error)}` };
        }
      }
      default:
        return { content: `没有名为 ${call.name} 的工具。` };
    }
  };

  const toolkit: AgentToolkit = {
    specs,
    nativeSearch: search.native,
    maxSteps: limits.steps,
    execute: (call, context) => execute(call, context),
    onModelStep: ({ text, calls, searches, sources }) => {
      // What the model said before using tools becomes a note on the next step.
      pendingNote = calls.length && !calls.some((call) => call.name === 'generate_image') ? text.trim().slice(0, 400) : '';
      if (searches.length || sources.length) {
        const numbers = sources.length ? cite(sources) : [];
        const step: AgentStep = {
          id: createId(), kind: 'search', status: 'done', startedAt: Date.now(), endedAt: Date.now(),
          title: searches.length ? `搜索：${excerpt(searches.join('、'), 30)}` : '联网查找资料',
          detail: sources.length ? `引用 ${numbers.length} 个来源 · 服务商搜索` : '服务商搜索',
          ...(sources.length ? { sources: sources.slice(0, 8) } : {}),
        };
        options.updateTrace((trace) => ({ ...trace, steps: [...trace.steps, step] }));
      }
    },
  };
  return { toolkit, instructions };
}
