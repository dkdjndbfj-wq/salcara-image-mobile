import type { RemoteImage } from './attachment-chunks';
import { joinPastedText, namedTextAttachment, splitPastedText, type PastedText } from './pasted-text';

export interface ComposerFiles { texts: PastedText[]; images: RemoteImage[] }
export type ComposerFilesAppender = (files: ComposerFiles) => Promise<boolean>;
const textExtensions='txt md markdown log csv tsv json jsonl yaml yml xml htm html css scss less js mjs cjs jsx ts tsx py go rs java kt swift dart c h cpp hpp cs rb php sql sh bash zsh ps1 bat ini cfg conf toml env vue svelte astro tex srt vtt gitignore'.split(' ');
export const COMPOSER_FILE_ACCEPT=['image/png','image/jpeg','image/webp','text/*',...textExtensions.map(value=>`.${value}`)].join(',');
export function composerFileKind(name: string, mime: string): 'image' | 'text' {
  if (['image/png', 'image/jpeg', 'image/webp'].includes(mime.toLowerCase()) || /\.(png|jpe?g|webp)$/i.test(name)) return 'image';
  if (mime.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript'].includes(mime) || textExtensions.includes(name.split('.').pop()?.toLowerCase()??'') || /^(?:Dockerfile|Makefile|LICENSE|\.gitignore)$/i.test(name)) return 'text';
  throw new Error(`暂不支持“${name}”。可添加 PNG/JPEG/WebP 图片、UTF-8 文本和代码文件；其他文件请先放到电脑项目中再引用。`);
}
export function appendComposerFiles<T extends { text: string; images: RemoteImage[]; missingImages?: boolean }>(current: T, files: ComposerFiles, maxLength = 40_000): T {
  if (current.missingImages) throw new Error('请先恢复或移除当前草稿缺失的图片');
  const value = splitPastedText(current.text), texts = [...value.attachments];
  for (const item of files.texts) {
    if (!item.text || item.text.includes('\0')) throw new Error('文本文件为空或包含无法读取的二进制内容');
    texts.push(namedTextAttachment(item.name, item.text, texts));
  }
  if (texts.length > 8) throw new Error('文本附件最多 8 个，请先处理当前草稿');
  const images = [...current.images];
  for (const image of files.images) {
    if (!image.base64) throw new Error('图片未完整读取，原草稿已保留');
    if (!images.some(item => item.uri === image.uri && item.base64 === image.base64)) images.push(image);
  }
  if (images.length > 4) throw new Error('图片最多 4 张，请先处理当前草稿');
  const text = joinPastedText(value.prompt, texts);
  if (text.length > maxLength) throw new Error(`文件与草稿合计超过 ${maxLength.toLocaleString()} 字符，原草稿已保留`);
  return { ...current, text, images, imageCount: images.length, missingImages: false };
}
