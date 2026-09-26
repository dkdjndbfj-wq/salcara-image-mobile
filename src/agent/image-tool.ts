import type { AspectRatio, ChatApi } from '../domain';

/** What the conversation model decided to draw. */
export interface ImageToolCall {
  prompt: string;
  /** Labels such as “图2”, resolved locally to files. First item is the main image. */
  referenceImages: string[];
  aspectRatio: AspectRatio | null;
  transparent: boolean;
}

export const IMAGE_TOOL_NAME = 'generate_image';
const RATIOS: AspectRatio[] = ['1:1', '16:9', '9:16'];

const DESCRIPTION = '生成或编辑一张图片。用户想得到一张图片时调用：画、生成、设计海报/头像/壁纸/插画/封面，或修改、编辑、换背景、换风格、扩图、上色、抠图、"把刚才那张改成……"。只是讨论、分析图片或文件、询问怎么作图、让你写提示词时不要调用。';

const PARAMETERS = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description: '交给图片模型的完整作图描述：主体、构图、风格、光线、配色、画面中需要出现的文字（原文放在引号里）。编辑图片时写清楚改什么、保留什么。可以结合对话和附件资料补全细节。',
    },
    reference_images: {
      type: 'array',
      items: { type: 'string' },
      description: '要编辑或参考的图片编号，例如 ["图2"]。第一个是主图。修改已有图片、参考用户上传的图片时必须填写；全新创作留空数组。',
    },
    aspect_ratio: {
      type: 'string',
      enum: RATIOS,
      description: '仅在用户明确要求横版(16:9)、竖版(9:16)或方形(1:1)时填写，否则省略以使用用户默认设置。',
    },
    transparent_background: {
      type: 'boolean',
      description: '用户要求透明背景、PNG 贴纸、抠图等时为 true。',
    },
  },
  required: ['prompt'],
} as const;

export function imageToolDefinition(api: ChatApi): Record<string, unknown> {
  if (api === 'anthropic') return { name: IMAGE_TOOL_NAME, description: DESCRIPTION, input_schema: PARAMETERS };
  if (api === 'responses') return { type: 'function', name: IMAGE_TOOL_NAME, description: DESCRIPTION, parameters: PARAMETERS };
  return { type: 'function', function: { name: IMAGE_TOOL_NAME, description: DESCRIPTION, parameters: PARAMETERS } };
}

/** Accepts either a JSON string (OpenAI) or an object (Claude). */
export function parseImageToolArguments(raw: unknown): ImageToolCall | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try { value = JSON.parse(trimmed); } catch { return null; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : '';
  if (!prompt) return null;
  const rawRefs = record.reference_images ?? record.referenceImages ?? record.references;
  const referenceImages = Array.isArray(rawRefs)
    ? rawRefs.map((item) => normalizeImageLabel(String(item))).filter((item): item is string => Boolean(item))
    : typeof rawRefs === 'string' && normalizeImageLabel(rawRefs) ? [normalizeImageLabel(rawRefs)!] : [];
  const ratio = typeof record.aspect_ratio === 'string' ? record.aspect_ratio.trim() : '';
  return {
    prompt: prompt.slice(0, 16_000),
    referenceImages: [...new Set(referenceImages)].slice(0, 4),
    aspectRatio: (RATIOS as string[]).includes(ratio) ? ratio as AspectRatio : null,
    transparent: record.transparent_background === true || record.transparent === true,
  };
}

/** “图 2”, “2”, “image 2”, “#2” → “图2”. */
export function normalizeImageLabel(value: string): string | null {
  const match = value.trim().match(/(\d{1,3})/);
  return match ? `图${Number(match[1])}` : null;
}

/**
 * Fallback for relays that reject native tool definitions: the model is asked
 * to append one marker line instead. The marker never reaches the UI.
 */
export const TEXT_TOOL_OPEN = '<<<IMAGE';
export const TEXT_TOOL_INSTRUCTIONS = `当前接口不支持函数调用。需要作图时，先用一句话告诉用户你要画什么，然后在回复最后单独输出一行：
${TEXT_TOOL_OPEN} {"prompt":"完整作图描述","reference_images":["图1"],"aspect_ratio":"1:1","transparent_background":false}>>>
不需要作图时绝对不要输出这一行。`;

export function extractTextToolCall(text: string): { text: string; call: ImageToolCall | null } {
  const start = text.indexOf(TEXT_TOOL_OPEN);
  if (start < 0) return { text, call: null };
  const rest = text.slice(start + TEXT_TOOL_OPEN.length);
  const end = rest.lastIndexOf('>>>');
  const json = (end >= 0 ? rest.slice(0, end) : rest).trim();
  const first = json.indexOf('{');
  const last = json.lastIndexOf('}');
  const call = first >= 0 && last > first ? parseImageToolArguments(json.slice(first, last + 1)) : null;
  return { text: text.slice(0, start).trimEnd(), call };
}

/** While streaming, hide a partially written marker. */
export function visibleStreamingText(text: string): string {
  const start = text.indexOf('<<<');
  return start >= 0 ? text.slice(0, start).trimEnd() : text;
}
