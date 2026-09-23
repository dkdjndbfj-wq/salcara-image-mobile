import type { ComposerMode, DocumentAttachment, ReferenceImage } from './domain';

export type RequestIntent = 'chat' | 'generate' | 'edit';

// Keep this deliberately conservative. In auto mode a false positive can
// spend money, while a false negative only produces an ordinary chat answer
// that the user can follow with an explicit “生成/修改图片” request.
const IMAGE_VERBS = [
  // “生成” alone is intentionally not enough: “生成一段文字” is chat.
  '生成(?:一张|一幅|图片|图像|图|海报|宣传图|封面|插画|头像|壁纸)',
  '生成[^。！？,，]{0,32}(?:图片|图像|海报|宣传图|封面|插画|头像|壁纸)',
  '生图',
  '出图',
  '来(?:一张|一幅|一个)?[^。！？,，]{0,32}(?:图片|图|海报|宣传图|封面|插画|头像|壁纸)',
  '弄(?:一张|一幅|一个)?[^。！？,，]{0,32}(?:图片|图|海报|宣传图|封面|插画|头像|壁纸)',
  '画(?:一张|一幅|个|一个|一只|图片|图|海报|插画|头像|壁纸)',
  '绘制(?:一张|一幅|个|一个|图片|图|海报|插画|头像|壁纸)',
  '制作(?:一张|一幅|个|一个)?(?:图片|图|海报|宣传图|封面|插画|头像|壁纸|logo)',
  '做(?:一张|一幅|个|一个)?(?:图片|图|海报|宣传图|封面|插画)',
  '创作(?:一张|一幅|图片|图|画面|海报|宣传图|封面|插画)',
  '设计(?:一张|一幅|个|一个)?(?:图片|图|海报|宣传图|封面|插画)',
  '改图',
  '修改图片',
  '编辑图片',
  '重绘',
  '换背景',
  '换[^。！？,，]*背景',
  '背景[^。！？,，]*换',
  '改[^。！？,，]*背景',
  '替换背景',
  '扩图',
  '修复图片',
  '上色',
  '抠图',
  'remove background',
  'change the background',
  'edit (?:this|the)? image',
  'generate (?:an? )?(?:image|picture|poster|illustration)',
  'create (?:an? )?(?:image|picture|poster|illustration)',
  'draw ',
];

const ANALYSIS_ONLY = /分析|识别|总结|概括|解释|读取|提取|描述|看看|是什么|判断|审阅|校对|归纳|analy[sz]e|summari[sz]e|describe|extract|read|what is|review/i;

/** Whether the prompt explicitly asks for a paid image operation. */
export function hasImageIntent(prompt: string): boolean {
  const value = prompt.trim();
  if (!value) return false;
  const directImageRequest = /(?:生图|出图|绘制|画(?:一张|一幅|个|一个|一只|图片|图|海报|插画|头像|壁纸)|生成|制作|做|创作|设计)\s*[^。！？,，]{0,32}(?:图片|图像|图片|图|海报|宣传图|封面|插画|头像|壁纸|画面|logo)|(?:修改|编辑|重绘|换|改|替换|扩|修复|上色|抠)\s*[^。！？,，]*?(?:图片|图|背景|画面|照片)/i;
  // A how-to question can contain the same words as an imperative. Treat it
  // as chat even when it mentions “生成图片”, because charging for an answer
  // about image generation would be surprising.
  if (/(?:请(?:告诉我|问)|如何|怎么|能否|是否|这个模型)[^。！？]*?生成[^。！？]*(?:图片|图|海报|插画)?/i.test(value)) return false;
  // Questions about what a model can do are ordinary chat, even though they
  // contain the word “生成”. An imperative such as “生成一张…” remains an
  // unambiguous paid-image request.
  if (/(?:生成|create|draw|edit)[^。！？]*?(?:吗|什么|如何|怎么|能否|可以|是否|what|how|can)/i.test(value) && !directImageRequest.test(value)) return false;
  return directImageRequest.test(value) || IMAGE_VERBS.some((pattern) => new RegExp(pattern, 'i').test(value));
}

/**
 * Route one composer submission without making the user choose a separate
 * “chat” or “image” screen. Manual modes remain available as a safety valve.
 */
export function inferRequestIntent(
  prompt: string,
  references: ReferenceImage[] = [],
  documents: DocumentAttachment[] = [],
  mode: ComposerMode = 'auto',
): RequestIntent {
  if (mode === 'chat') return 'chat';
  if (mode === 'image') return references.length > 0 ? 'edit' : 'generate';

  const referenceCreation = references.length > 0 && /(?:参考|根据|按照|基于|用|以)[^。！？,，]{0,36}(?:创作|生成|制作|设计|修改|编辑|重绘|换背景|改成)/i.test(prompt);
  const explicitImage = hasImageIntent(prompt) || referenceCreation;
  if (references.length > 0 && explicitImage) return 'edit';
  if (explicitImage) return 'generate';

  // An attachment by itself is a request for understanding, not a paid image
  // call. This is the important “upload PDF, analyse it first” default.
  if (documents.length > 0 || references.length > 0) return 'chat';
  // Keep the helper useful to callers that want to explain why a plain prompt
  // stayed in chat mode; the regex above is intentionally the only charge gate.
  void ANALYSIS_ONLY;
  return 'chat';
}

/** Used by the UI to show a less alarming hint for an analysis-only prompt. */
export function isAnalysisPrompt(prompt: string): boolean {
  return ANALYSIS_ONLY.test(prompt) && !hasImageIntent(prompt);
}
