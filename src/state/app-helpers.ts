import { deleteGeneratedFile } from '../agent/files';
import { traceFileUris } from '../agent/types';
import type { ChatMessage, ProviderProfile } from '../domain';
import { deleteLocalFile } from '../storage/files';

export function pickChat(providers: ProviderProfile[], id: string | null): ProviderProfile | null {
  return providers.find((item) => item.id === id && item.chatModel) ?? providers.find((item) => item.chatModel) ?? null;
}
export function pickImage(providers: ProviderProfile[], id: string | null): ProviderProfile | null {
  return providers.find((item) => item.id === id && item.model) ?? providers.find((item) => item.model) ?? null;
}

/**
 * “用我的原话”: the image model gets the user's own words, so a model that reasons by itself (GPT Image)
 * isn't steered by a rewritten prompt. The chat model's version is only used when the words lean on
 * earlier context (“按刚才的方案”“再来一张”“按附件”) or say nothing drawable (“好”“画吧”).
 */
export function faithfulPrompt(userText: string, modelPrompt: string): string {
  const own = userText.trim();
  const drafted = modelPrompt.trim();
  if (!own) return drafted;
  const leansOnContext = /刚才|上面|前面|之前|上一张|上张|那张|这个方案|那个方案|方案|同样|一样的|照着|按照|根据|参考|这段|那段|文案|附件|文件|文档|再来|再画|重画|再生成|继续|按这个|就这样|上述/.test(own);
  const saysNothing = own.replace(/[\s，。！？、,.!?~～]/g, '').length < 5 || /^(好|好的|可以|行|画吧|画一下|开始|生成吧|来吧|嗯|ok)$/i.test(own.replace(/[\s，。！？、,.!?~～]/g, ''));
  if (!drafted || (!leansOnContext && !saysNothing)) return own;
  if (saysNothing) return drafted;
  // Context was needed: the user's words stay first and unchanged, the gathered context follows.
  return drafted.includes(own) ? drafted : `${own}\n\n补充（来自前面的对话）：${drafted}`;
}

export function describeImageDefaults(provider: ProviderProfile | null): string {
  if (!provider) return '';
  return [`模型 ${provider.model}`, provider.aspectRatio && `比例 ${provider.aspectRatio === 'auto' ? '自动' : provider.aspectRatio}`, provider.resolutionTier && `清晰度 ${provider.resolutionTier}`, provider.quality && `画质 ${provider.quality}`].filter(Boolean).join('，');
}

/** Deletes the files removed messages used, except those in `keep` (carried over into an edited message). */
export function deleteMessageFiles(removed: ChatMessage[], keep: Set<string | null | undefined> = new Set()) {
  const drop = (uri: string | null | undefined) => { if (uri && !keep.has(uri)) deleteLocalFile(uri); };
  for (const message of removed) {
    traceFileUris(message.agent).forEach((uri) => { if (!keep.has(uri)) { deleteGeneratedFile(uri); deleteLocalFile(uri); } });
    drop(message.imageUri); drop(message.maskUri);
    message.references.forEach((reference) => drop(reference.uri));
    message.documents?.forEach((document) => drop(document.uri));
  }
}
