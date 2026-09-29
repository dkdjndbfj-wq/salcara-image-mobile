import type { AspectRatio, ChatApi } from '../domain';
import { normalizeRatio } from '../image-sizes';

/** What the conversation model decided to draw. */
export interface ImageToolCall {
  prompt: string;
  /** Labels such as “图2”, resolved locally to files. First item is the main image. */
  referenceImages: string[];
  aspectRatio: AspectRatio | null;
  transparent: boolean;
}

export const IMAGE_TOOL_NAME = 'generate_image';

export const IMAGE_TOOL_DESCRIPTION = '生成或编辑一张图片。用户想得到一张图片时调用：画、生成、设计海报/头像/壁纸/插画/封面，或修改、编辑、换背景、换风格、扩图、上色、抠图、"把刚才那张改成……"。只是讨论、分析图片或文件、询问怎么作图、让你写提示词时不要调用。';

export const IMAGE_TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description: '交给图片模型的作图要求，按系统说明书写（默认是用户原话，不扩写）。画面中需要出现的文字用引号保留原文。'
    },
    reference_images: {
      type: 'array',
      items: { type: 'string' },
      description: '要编辑或参考的图片编号，例如 ["图2"]。第一个是主图。修改已有图片、参考用户上传的图片时必须填写；全新创作留空数组。',
    },
    aspect_ratio: {
      type: 'string',
      description: '画幅，格式“宽:高”，范围 1:3 到 3:1，例如 1:1、3:4、4:3、2:3、9:16、16:9、21:9、3:1。仅在用户明确要求比例或用途（竖版/横版/手机壁纸/电脑壁纸/海报/横幅/长图等）时按用途选最合适的比例；否则省略，使用用户的默认设置。',
    },
    transparent_background: {
      type: 'boolean',
      description: '用户要求透明背景、PNG 贴纸、抠图等时为 true。',
    },
  },
  required: ['prompt'],
} as const;

export function imageToolDefinition(api: ChatApi): Record<string, unknown> {
  if (api === 'anthropic') return { name: IMAGE_TOOL_NAME, description: IMAGE_TOOL_DESCRIPTION, input_schema: IMAGE_TOOL_PARAMETERS };
  if (api === 'responses') return { type: 'function', name: IMAGE_TOOL_NAME, description: IMAGE_TOOL_DESCRIPTION, parameters: IMAGE_TOOL_PARAMETERS };
  return { type: 'function', function: { name: IMAGE_TOOL_NAME, description: IMAGE_TOOL_DESCRIPTION, parameters: IMAGE_TOOL_PARAMETERS } };
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
    aspectRatio: ratio && ratio !== 'auto' ? normalizeRatio(ratio) : null,
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
