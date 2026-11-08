import type { ChatMessage, GeneratedImage } from './domain';

export const MAX_GENERATED_IMAGES = 10;

/** Validate before submitting a paid request; silently clamping changes its price. */
export function validateImageCount(value: unknown = 1): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_GENERATED_IMAGES) {
    throw new Error(`一次可生成 1 到 ${MAX_GENERATED_IMAGES} 张图片`);
  }
  return value;
}

function imageUri(value: unknown, remoteOnly = false): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > 16_384) return null;
  return (remoteOnly ? /^https?:\/\//i : /^(?:file:\/\/|content:\/\/|\/(?!\/)|[a-z]:[\\/])/i).test(text) ? text : null;
}

function legacyImageUri(value: unknown): string | null {
  const local = imageUri(value);
  if (local || typeof value !== 'string') return local;
  const text = value.trim();
  // Older database rows also store paths relative to the app's image folder.
  // A relative path is neither a remote delivery nor a traversal outside it.
  if (!text || text.length > 16_384 || /^[a-z][a-z\d+.-]*:|^[\\/]|[\x00-\x1f]/i.test(text) || text.split(/[\\/]/).includes('..')) return null;
  return text;
}

/** Read persisted JSON defensively and strip fields outside the image contract. */
export function normalizeGeneratedImages(raw: unknown): GeneratedImage[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>();
  const results: GeneratedImage[] = [];
  for (const value of raw.slice(0, MAX_GENERATED_IMAGES)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim().slice(0, 200) : '';
    if (!id || ids.has(id) || typeof record.status !== 'string' || !['pending', 'complete', 'error'].includes(record.status)) continue;
    ids.add(id);
    const uri = imageUri(record.uri);
    const remoteUrl = imageUri(record.remoteUrl, true) ?? imageUri(record.uri, true);
    const status = record.status === 'complete' && !uri ? 'error' : record.status as GeneratedImage['status'];
    const error = typeof record.error === 'string' ? record.error.slice(0, 2_000) : null;
    results.push({ id, uri, remoteUrl, status, error: status === 'complete' ? null : error });
  }
  return results;
}

type ImageMessage = Pick<ChatMessage, 'id' | 'imageUri' | 'remoteImageUrl' | 'status'> & Partial<Pick<ChatMessage, 'generatedImages' | 'error'>>;

/** New batches and pre-migration single images share one rendering contract. */
export function messageGeneratedImages(message: ImageMessage): GeneratedImage[] {
  const images = normalizeGeneratedImages(message.generatedImages);
  if (images.length) return images;
  const uri = legacyImageUri(message.imageUri);
  const remoteUrl = imageUri(message.remoteImageUrl, true) ?? imageUri(message.imageUri, true);
  if (!uri && !remoteUrl) return [];
  return [{
    id: `${message.id}-image-1`,
    uri,
    remoteUrl,
    status: uri ? 'complete' : message.status === 'pending' ? 'pending' : 'error',
    error: uri ? null : message.error ?? null,
  }];
}

/** Gallery positions include failed slots; tool labels only address delivered files. */
export function generatedImageSlotMapping(images: readonly GeneratedImage[], labelFor: (uri: string) => string | null | undefined): string {
  const batch = images.slice(0, MAX_GENERATED_IMAGES);
  if (!batch.length) return '';
  const slots = batch.map((image, index) => {
    let result: string;
    if (image.status === 'complete' && image.uri) {
      const label = labelFor(image.uri);
      result = label && /^图[1-9]\d*$/.test(label) ? label : '文件不可用，不可引用';
    } else if (image.status === 'pending') result = '尚未完成，不可引用';
    else result = image.remoteUrl ? '未下载，不可引用' : '生成失败，不可引用';
    return `第${index + 1}张：${result}`;
  });
  return `本组图片位置（共${batch.length}张，失败或未完成项保留原位）：${slots.join('；')}。`;
}
