import type { AspectRatio, ResolutionTier } from './domain';

/**
 * Picture sizes per image model. GPT Image 2 takes any WIDTHxHEIGHT (both multiples of 16, long:short
 * at most 3:1, longest edge ≤ 3840, 655,360–8,294,400 pixels), so any ratio works; older GPT Image and
 * DALL·E models only accept a few fixed sizes, and other models get a close size in 64-pixel steps.
 */

export interface RatioPreset { value: AspectRatio; label: string; hint?: string }

/** Common ratios shown as chips; anything else can be typed in as “宽:高”. */
export const RATIO_PRESETS: RatioPreset[] = [
  { value: 'auto', label: '自动', hint: '按内容决定' },
  { value: '1:1', label: '1:1', hint: '头像' },
  { value: '3:4', label: '3:4', hint: '小红书' },
  { value: '4:3', label: '4:3', hint: '横图' },
  { value: '2:3', label: '2:3', hint: '海报' },
  { value: '3:2', label: '3:2', hint: '相机横拍' },
  { value: '9:16', label: '9:16', hint: '手机壁纸' },
  { value: '16:9', label: '16:9', hint: '电脑壁纸' },
  { value: '4:5', label: '4:5', hint: 'Instagram' },
  { value: '21:9', label: '21:9', hint: '电影感' },
  { value: '1:2', label: '1:2', hint: '长图' },
  { value: '3:1', label: '3:1', hint: '横幅' },
];

export const MIN_RATIO = 1 / 3;
export const MAX_RATIO = 3;

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/**
 * “16:9”, “16x9”, “16/9”, “16：9”, “1.5” or “2.39:1” → a reduced “W:H” within 1:3–3:1 (clamped), or null.
 * “auto” stays “auto”.
 */
export function normalizeRatio(input: string | null | undefined): AspectRatio | null {
  const text = (input ?? '').trim().toLowerCase();
  if (!text) return null;
  if (text === 'auto' || text === '自动') return 'auto';
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(?:[:：x×*/]\s*(\d+(?:\.\d+)?))?$/);
  if (!match) return null;
  let w = Number(match[1]);
  let h = match[2] === undefined ? 1 : Number(match[2]);
  if (!(w > 0 && h > 0)) return null;
  let value = w / h;
  if (value < MIN_RATIO) { w = 1; h = 3; value = MIN_RATIO; } else if (value > MAX_RATIO) { w = 3; h = 1; value = MAX_RATIO; }
  // Decimals (2.39:1) become whole numbers.
  const scale = Number.isInteger(w) && Number.isInteger(h) ? 1 : 100;
  w = Math.round(w * scale); h = Math.round(h * scale);
  const divisor = gcd(w, h) || 1;
  w /= divisor; h /= divisor;
  // Keep the text short: 239:100 is fine, 4000:1679 is not.
  if (w > 100 || h > 100) { h = 100; w = Math.round(value * 100); const again = gcd(w, h) || 1; w /= again; h /= again; }
  return `${w}:${h}` as AspectRatio;
}

export function ratioValue(ratio: AspectRatio | null | undefined): number {
  const normalized = normalizeRatio(ratio ?? '');
  if (!normalized || normalized === 'auto') return 1;
  const [w, h] = normalized.split(':').map(Number);
  return w / h;
}

export type SizeRule = 'free' | 'gpt-presets' | 'dall-e-3' | 'dall-e-2' | 'generic';

export function sizeRuleFor(model: string | null | undefined): SizeRule {
  const name = (model ?? '').toLowerCase();
  if (/gpt-image-(\d{2,}|[2-9])/.test(name)) return 'free';
  if (/gpt-image|chatgpt-image/.test(name)) return 'gpt-presets';
  if (/dall-e-3/.test(name)) return 'dall-e-3';
  if (/dall-e-2/.test(name)) return 'dall-e-2';
  return 'generic';
}

/** Whether the model accepts `size: "auto"`. */
export const supportsAutoSize = (model: string | null | undefined) => {
  const rule = sizeRuleFor(model);
  return rule === 'free' || rule === 'gpt-presets';
};

/** Target pixel counts for 1K / 2K / 4K. */
const TIER_PIXELS: Record<ResolutionTier, number> = { '1K': 1024 * 1024, '2K': 2048 * 2048, '4K': 3840 * 2160 };

function fit(value: number, tier: ResolutionTier, step: number, maxEdge: number, minPixels: number, maxPixels: number): [number, number] {
  const pixels = Math.min(maxPixels, Math.max(minPixels, TIER_PIXELS[tier]));
  let w = Math.sqrt(pixels * value);
  let h = w / value;
  const over = Math.max(w, h) / maxEdge;
  if (over > 1) { w /= over; h /= over; }
  let width = Math.max(step, Math.round(w / step) * step);
  let height = Math.max(step, Math.round(h / step) * step);
  while (width * height > maxPixels || width > maxEdge || height > maxEdge) {
    if (width / height >= value) width -= step; else height -= step;
  }
  while (width * height < minPixels) {
    if (width / height <= value && width + step <= maxEdge) width += step; else if (height + step <= maxEdge) height += step; else break;
  }
  return [width, height];
}

function nearest(value: number, options: string[]): string {
  let best = options[0];
  let distance = Infinity;
  for (const option of options) {
    const [w, h] = option.split('x').map(Number);
    const gap = Math.abs(Math.log((w / h) / value));
    if (gap < distance) { best = option; distance = gap; }
  }
  return best;
}

const GPT_PRESETS = ['1024x1024', '1536x1024', '1024x1536'];
const DALLE3_PRESETS = ['1024x1024', '1792x1024', '1024x1792'];

/** The `size` sent to the image API for this model, ratio and clarity. */
export function sizeFor(ratio: AspectRatio | null | undefined, tier: ResolutionTier | null | undefined, model?: string | null): string {
  const rule = sizeRuleFor(model);
  const clarity = tier ?? '1K';
  if (ratio === 'auto' && supportsAutoSize(model)) return 'auto';
  const value = ratioValue(ratio);
  switch (rule) {
    case 'free': {
      const [w, h] = fit(value, clarity, 16, 3840, 655_360, 8_294_400);
      return `${w}x${h}`;
    }
    case 'gpt-presets': return nearest(value, GPT_PRESETS);
    case 'dall-e-3': return nearest(value, DALLE3_PRESETS);
    case 'dall-e-2': return '1024x1024';
    default: {
      const [w, h] = fit(value, clarity, 64, 4096, 262_144, 16_777_216);
      return `${w}x${h}`;
    }
  }
}

/** A short line under the ratio picker explaining what will actually be sent. */
export function sizeNote(ratio: AspectRatio | null | undefined, tier: ResolutionTier | null | undefined, model?: string | null): string {
  const size = sizeFor(ratio, tier, model);
  if (size === 'auto') return '尺寸由模型根据内容自动决定';
  const pixels = size.replace('x', ' × ');
  const rule = sizeRuleFor(model);
  if (rule === 'gpt-presets') return `${pixels}（此模型只支持 3 种尺寸，已按最接近的比例出图；GPT Image 2 支持任意比例）`;
  if (rule === 'dall-e-3' || rule === 'dall-e-2') return `${pixels}（此模型只支持固定尺寸，已按最接近的比例出图）`;
  return pixels;
}

/** Whether the clarity (1K/2K/4K) choice changes anything for this model. */
export const supportsClarity = (model: string | null | undefined) => {
  const rule = sizeRuleFor(model);
  return rule === 'free' || rule === 'generic';
};
