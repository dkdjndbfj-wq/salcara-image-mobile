import { prepareRemoteImage } from './attachments';
import { attachmentBytes, attachmentMagic } from './attachment-ref';
import { composerFileKind, type ComposerFiles } from './composer-files';

export async function readComposerFiles(files: readonly File[], current: () => boolean): Promise<ComposerFiles> {
  const guard = () => { if (!current()) throw new Error('电脑、对话或输入已变化，文件未加入草稿'); };
  guard();
  if (!files.length || files.length > 8) throw new Error('每次请选择 1 至 8 个文件');
  const entries = files.map(file => ({ file, kind: composerFileKind(file.name, file.type) }));
  if (entries.filter(item => item.kind === 'image').length > 4) throw new Error('每次最多添加 4 张图片');
  for (const { file, kind } of entries) if (!file.size || file.size > (kind === 'image' ? 8 * 1024 * 1024 : 1024 * 1024)) throw new Error(`“${file.name}”为空或过大，图片上限 8 MB，文本上限 1 MB`);
  const result: ComposerFiles = { texts: [], images: [] };
  for (const { file, kind } of entries) {
    guard();
    if (kind === 'text') {
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
      catch { throw new Error(`“${file.name}”不是有效的 UTF-8 文本，请转换编码后添加`); }
      guard();
      if (!text || text.includes('\0') || text.length > 40_000) throw new Error(`“${file.name}”为空、含二进制内容或超过 40,000 字符`);
      result.texts.push({ name: file.name, text });
    } else {
      const uri = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error(`无法读取“${file.name}”`)); reader.readAsDataURL(file); });
      guard();
      const base64 = uri.slice(uri.indexOf(',') + 1), bytes = attachmentBytes(base64);
      const mime = (['image/png', 'image/jpeg', 'image/webp'] as const).find(type => attachmentMagic(bytes, type));
      if (!mime) throw new Error(`“${file.name}”的图片内容无效`);
      result.images.push(await prepareRemoteImage({ uri: `data:${mime};base64,${base64}` })); guard();
    }
  }
  return result;
}
