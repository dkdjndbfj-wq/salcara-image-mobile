import type { ChatApi } from '../domain';
import { IMAGE_TOOL_DESCRIPTION, IMAGE_TOOL_NAME, IMAGE_TOOL_PARAMETERS } from './image-tool';

/**
 * Every tool the conversation model can use. Specs are protocol-neutral and
 * rendered per protocol; relays that reject function calling get the same
 * tools through a plain-text protocol (see TEXT_TOOL_* below).
 */
export type ToolName =
  | 'generate_image' | 'web_search' | 'read_webpage' | 'remember' | 'forget'
  | 'search_history' | 'phone_action' | 'create_file' | 'update_plan'
  | 'memory_search' | 'recall_conversation' | 'memory_write' | 'core_memory_update';

export interface ToolSpec {
  name: ToolName;
  description: string;
  parameters: Record<string, unknown>;
  /** One-line example for the text protocol. */
  example: string;
}

/** A tool call parsed from any protocol. `input` is null when the arguments were not valid JSON. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown> | null;
  /** Raw argument text, sent back unchanged in the transcript. */
  raw: string;
  /** Provider data that must travel back with the call (Gemini thought signatures). */
  extra?: Record<string, unknown>;
}

const string = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });

export const TOOL_SPECS: Record<ToolName, ToolSpec> = {
  generate_image: {
    name: IMAGE_TOOL_NAME, description: IMAGE_TOOL_DESCRIPTION, parameters: IMAGE_TOOL_PARAMETERS as unknown as Record<string, unknown>,
    example: '{"prompt":"完整作图描述","reference_images":["图1"],"aspect_ratio":"1:1","transparent_background":false}',
  },
  web_search: {
    name: 'web_search',
    description: '联网搜索最新信息。用于新闻、天气、价格、赛事、版本、日期相关的事实，或你不确定、可能过时的知识。用简洁的关键词查询；需要不同角度时可以换关键词再搜。',
    parameters: {
      type: 'object',
      properties: {
        query: string('搜索关键词，用最可能找到答案的语言'),
        recency: string('只要最近的结果时填写', { enum: ['day', 'week', 'month', 'year'] }),
      },
      required: ['query'],
    },
    example: '{"query":"上海 今天 天气"}',
  },
  read_webpage: {
    name: 'read_webpage',
    description: '打开一个网页并读取正文。搜索结果摘要不够、或用户给了链接时使用。',
    parameters: { type: 'object', properties: { url: string('完整的 http(s) 网址') }, required: ['url'] },
    example: '{"url":"https://example.com/article"}',
  },
  remember: {
    name: 'remember',
    description: '把关于用户的长期信息记下来（偏好、身份、正在做的事、以后回答需要知道的背景）。用户说“记住……”时必须调用。不要记录一次性的问题、密码、证件号、银行卡等敏感信息。',
    parameters: { type: 'object', properties: { fact: string('用一句完整的话描述，如“用户是高中数学老师”') }, required: ['fact'] },
    example: '{"fact":"用户喜欢简洁的回答"}',
  },
  forget: {
    name: 'forget',
    description: '删除一条记忆。用户要求忘掉某件事，或记忆已经过时的时候调用。',
    parameters: { type: 'object', properties: { memory_id: string('记忆编号，如 "M3"') }, required: ['memory_id'] },
    example: '{"memory_id":"M3"}',
  },
  search_history: {
    name: 'search_history',
    description: '搜索用户在这台手机上与你的历史对话。用户提到“之前聊过的”“上次说的”等你当前看不到的内容时使用。',
    parameters: { type: 'object', properties: { query: string('关键词') }, required: ['query'] },
    example: '{"query":"装修预算"}',
  },
  phone_action: {
    name: 'phone_action',
    description: '在用户手机上准备一个操作：设闹钟、倒计时、添加日程、写短信或邮件、打电话、地图导航、打开网址、分享文字。不会直接执行，用户会看到一张卡片并亲自点确认。时间一律用用户当地时间。',
    parameters: {
      type: 'object',
      properties: {
        action: string('操作类型', { enum: ['alarm', 'timer', 'calendar', 'sms', 'email', 'call', 'map', 'open_url', 'share_text'] }),
        time: string('alarm：24 小时制 "HH:MM"'),
        days: { type: 'array', items: { type: 'integer' }, description: 'alarm 重复的星期，1=周一……7=周日；不重复则省略' },
        seconds: { type: 'integer', description: 'timer：倒计时秒数' },
        title: string('calendar 的标题，或 alarm/timer 的备注'),
        start: string('calendar 开始时间 "YYYY-MM-DDTHH:MM"，全天日程用 "YYYY-MM-DD"'),
        end: string('calendar 结束时间，格式同 start，可省略'),
        location: string('calendar 地点'),
        to: string('sms/call 的电话号码，或 email 的邮箱地址'),
        subject: string('email 主题'),
        body: string('sms/email 正文，或 calendar 备注'),
        destination: string('map：目的地名称或地址'),
        url: string('open_url 的网址'),
        text: string('share_text 要分享的文字'),
      },
      required: ['action'],
    },
    example: '{"action":"alarm","time":"07:30","title":"晨跑"}',
  },
  create_file: {
    name: 'create_file',
    description: '生成一个可以下载和分享的文件，例如表格(csv)、文档(md)、网页(html)、数据(json)或纯文本(txt)。用户要“导出”“做成表格/文件”时使用。内容要完整，不要省略。',
    parameters: {
      type: 'object',
      properties: {
        filename: string('文件名（含扩展名），如 "旅行预算.csv"'),
        content: string('完整的文件内容'),
      },
      required: ['filename', 'content'],
    },
    example: '{"filename":"清单.md","content":"# 清单\\n- 牛奶"}',
  },
  update_plan: {
    name: 'update_plan',
    description: '深度研究时展示和更新你的研究计划清单。开始时列出 3～6 个步骤，完成一步后再次调用并把它标记为已完成。',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: { type: 'object', properties: { title: { type: 'string' }, done: { type: 'boolean' } }, required: ['title'] },
          description: '完整的计划清单',
        },
      },
      required: ['steps'],
    },
    example: '{"steps":[{"title":"查找官方数据","done":true},{"title":"对比三家评测","done":false}]}',
  },
  memory_search: {
    name: 'memory_search',
    description: '在你的记忆匣里搜索关于用户和你们之间的事（人物、喜好、计划、经历、心情）。当前想起的内容不够、用户问“你还记得……吗”时使用。',
    parameters: { type: 'object', properties: { query: string('要回想的内容，用关键词或一句话') }, required: ['query'] },
    example: '{"query":"她养的猫叫什么"}',
  },
  recall_conversation: {
    name: 'recall_conversation',
    description: '翻看你们以前的聊天原话（摘要里没有细节时使用），可以按关键词查找。',
    parameters: { type: 'object', properties: { query: string('关键词') }, required: ['query'] },
    example: '{"query":"生日 蛋糕"}',
  },
  memory_write: {
    name: 'memory_write',
    description: '把一件重要的事写进记忆匣。用户说“记住”、或聊到以后一定要记得的事时使用。平常的细节会在聊天后自动整理，不必每次都写。',
    parameters: {
      type: 'object',
      properties: {
        title: string('简短标题，如“小满的猫叫团子”'),
        content: string('一两句完整描述'),
        type: string('类别', { enum: ['person', 'preference', 'event', 'fact', 'project', 'moment', 'feeling'] }),
        importance: { type: 'integer', description: '1～10，越重要越大' },
      },
      required: ['title', 'content'],
    },
    example: '{"title":"下周三考驾照","content":"用户下周三科目二考试，有点紧张","type":"event","importance":8}',
  },
  core_memory_update: {
    name: 'core_memory_update',
    description: '改写你的核心记忆（始终放在你脑海里的最重要信息，1000 字以内）。只在关于用户或你们关系的关键事实变化时使用，要传入完整的新内容。',
    parameters: { type: 'object', properties: { content: string('完整的新核心记忆') }, required: ['content'] },
    example: '{"content":"用户叫小满，在杭州读研……"}',
  },
};

/** The protocol-specific function definition. */
/**
 * phone_action as offered on iOS: iPhone lets no app create Clock alarms or timers, so those two
 * actions (and their parameters) are left out instead of producing cards that cannot run.
 */
const IOS_PHONE_ACTION: ToolSpec = (() => {
  const base = TOOL_SPECS.phone_action;
  const parameters = base.parameters as { properties: Record<string, Record<string, unknown>>; required: string[] };
  const properties: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(parameters.properties)) {
    if (key === 'time' || key === 'days' || key === 'seconds') continue;
    properties[key] = value;
  }
  properties.action = { ...properties.action, enum: ['calendar', 'sms', 'email', 'call', 'map', 'open_url', 'share_text'] };
  properties.title = { ...properties.title, description: 'calendar 的标题' };
  return {
    ...base,
    description: '在用户手机上准备一个操作：添加日程、写短信或邮件、打电话、地图导航、打开网址、分享文字。不会直接执行，用户会看到一张卡片并亲自点确认。时间一律用用户当地时间。iPhone 不支持由应用设置闹钟或倒计时：用户要设闹钟时请让他在“时钟”App 里设置，需要提醒可以改为添加日程。',
    parameters: { ...parameters, properties },
    example: '{"action":"calendar","title":"牙医","start":"2026-10-08T14:00"}',
  };
})();

/** The phone_action spec for this platform (iOS without alarm / timer). */
export function phoneActionSpec(os: string): ToolSpec {
  return os === 'ios' ? IOS_PHONE_ACTION : TOOL_SPECS.phone_action;
}

/** Whether an offered phone_action spec can set alarms and timers. */
export function phoneSpecHasClock(spec: ToolSpec | undefined): boolean {
  const action = (spec?.parameters as { properties?: { action?: { enum?: string[] } } } | undefined)?.properties?.action;
  return Boolean(action?.enum?.includes('alarm'));
}

export function toolDefinition(spec: ToolSpec, api: ChatApi): Record<string, unknown> {
  if (api === 'anthropic') return { name: spec.name, description: spec.description, input_schema: spec.parameters };
  if (api === 'responses') return { type: 'function', name: spec.name, description: spec.description, parameters: spec.parameters };
  return { type: 'function', function: { name: spec.name, description: spec.description, parameters: spec.parameters } };
}

export function parseToolInput(raw: unknown): Record<string, unknown> | null {
  let value = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try { value = JSON.parse(trimmed); } catch { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

// ——— Text protocol (relays without function calling) ———

export const TEXT_TOOL_OPEN = '<<<TOOL';
export const LEGACY_IMAGE_OPEN = '<<<IMAGE';
export const SUGGEST_OPEN = '<<<SUGGEST';
const MARKERS = [TEXT_TOOL_OPEN, LEGACY_IMAGE_OPEN, SUGGEST_OPEN];

export function textToolInstructions(specs: ToolSpec[]): string {
  const list = specs.map((spec) => `- ${spec.name}：${spec.description}\n  参数示例：${spec.example}`).join('\n');
  return `当前接口不支持函数调用，请用文字协议使用工具。需要工具时，先用一句话告诉用户你要做什么，然后在回复最后单独输出一行或多行：
${TEXT_TOOL_OPEN} 工具名 {JSON 参数}>>>
输出工具行后立即结束这次回复。工具结果会在下一条“[工具结果]”消息里提供给你，再根据结果继续。不需要工具时绝对不要输出这种行。
可用工具：
${list}`;
}

/** Finds the end of a JSON value that starts at `start` ('{' or '['), respecting strings. */
function jsonEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') { depth -= 1; if (depth === 0) return index + 1; }
  }
  return -1;
}

interface Marker { start: number; end: number; kind: 'tool' | 'image' | 'suggest'; name: string; json: string }

function findMarkers(text: string): Marker[] {
  const markers: Marker[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf('<<<', cursor);
    if (start < 0) break;
    const open = MARKERS.find((marker) => text.startsWith(marker, start));
    if (!open) { cursor = start + 3; continue; }
    const kind = open === TEXT_TOOL_OPEN ? 'tool' : open === LEGACY_IMAGE_OPEN ? 'image' : 'suggest';
    let index = start + open.length;
    let name = kind === 'image' ? 'generate_image' : '';
    if (kind === 'tool') {
      const match = text.slice(index).match(/^\s*([A-Za-z_][A-Za-z0-9_]*)/);
      if (match) { name = match[1]; index += match[0].length; }
    }
    const jsonStart = text.slice(index).search(/[{[]/);
    let end = text.length;
    let json = '';
    if (jsonStart >= 0) {
      const absolute = index + jsonStart;
      const close = jsonEnd(text, absolute);
      if (close > 0) {
        json = text.slice(absolute, close);
        end = close;
        const tail = text.slice(end).match(/^\s*>>>/);
        if (tail) end += tail[0].length;
      }
    }
    markers.push({ start, end, kind, name, json });
    cursor = end;
  }
  return markers;
}

/**
 * Removes every protocol marker from a finished reply. Returns the visible
 * text, text-protocol tool calls and follow-up suggestions.
 */
export function extractMarkers(text: string, idPrefix = 'text'): { text: string; calls: ToolCall[]; suggestions: string[] } {
  const markers = findMarkers(text);
  if (!markers.length) return { text, calls: [], suggestions: [] };
  const calls: ToolCall[] = [];
  let suggestions: string[] = [];
  let visible = '';
  let cursor = 0;
  for (const marker of markers) {
    visible += text.slice(cursor, marker.start);
    cursor = marker.end;
    if (marker.kind === 'suggest') {
      try {
        const parsed: unknown = JSON.parse(marker.json);
        if (Array.isArray(parsed)) suggestions = normalizeSuggestions(parsed);
      } catch { /* ignore malformed suggestions */ }
    } else if (marker.name) {
      calls.push({ id: `${idPrefix}-${calls.length + 1}`, name: marker.name, input: parseToolInput(marker.json), raw: marker.json || '{}' });
    }
  }
  visible += text.slice(cursor);
  return { text: visible.replace(/\n{3,}/g, '\n\n').trim(), calls, suggestions };
}

export function normalizeSuggestions(values: unknown[]): string[] {
  return [...new Set(values.filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().replace(/\s+/g, ' '))
    .filter((item) => item.length > 0 && item.length <= 40))].slice(0, 3);
}

/**
 * While streaming, hide protocol markers (and a marker that is still being
 * typed at the very end), but keep ordinary text such as a bash here-string.
 */
export function visibleStreamingText(text: string): string {
  const markers = findMarkers(text);
  let visible = markers.length ? text.slice(0, markers[0].start) : text;
  const tailStart = visible.lastIndexOf('<');
  if (tailStart >= 0 && tailStart >= visible.length - SUGGEST_OPEN.length) {
    const tail = visible.slice(tailStart - Math.min(2, tailStart));
    const partial = tail.slice(tail.indexOf('<'));
    if (MARKERS.some((marker) => marker.startsWith(partial) && partial.length < marker.length)) return visible.slice(0, visible.length - partial.length).trimEnd();
  }
  return markers.length ? visible.trimEnd() : visible;
}
