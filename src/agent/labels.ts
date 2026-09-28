import type { ChatMessage, ReferenceImage } from '../domain';

/** A conversation image that the model can refer to by label (图1, 图2…). */
export interface LabeledImage { label: string; uri: string; name: string; mimeType: ReferenceImage['mimeType']; size: number; width?: number; height?: number }

/**
 * Completed user/assistant turns of a history. There is no fixed round cap: callers size the history
 * to the model first (see context-window.ts), and older turns live on in the rolling summary.
 */
export function selectedHistoryPairs(history: ChatMessage[] = [], limit = Infinity): Array<[ChatMessage, ChatMessage]> {
  const selectedPairs: Array<[ChatMessage, ChatMessage]> = [];
  for (let index = 0; index + 1 < history.length; index += 1) {
    const user = history[index];
    const assistant = history[index + 1];
    if (user.role === 'user' && assistant.role === 'assistant' && user.status === 'complete'
      && (assistant.status === 'complete' || (assistant.text && assistant.status !== 'pending'))) {
      selectedPairs.push([user, assistant]);
      index += 1;
    }
  }
  return Number.isFinite(limit) ? selectedPairs.slice(-limit) : selectedPairs;
}

/**
 * Assigns stable labels to every image the model can see. The same
 * function is used to resolve labels in the tool call, so “图2” always means
 * the same file on both sides.
 */
export function labelConversationImages(history: ChatMessage[] = [], current: ReferenceImage[] = []): LabeledImage[] {
  const labeled: LabeledImage[] = [];
  const add = (image: Omit<LabeledImage, 'label'>) => labeled.push({ ...image, label: `图${labeled.length + 1}` });
  for (const [user, assistant] of selectedHistoryPairs(history)) {
    user.references.forEach((reference) => add(reference));
    if (assistant.imageUri) add({ uri: assistant.imageUri, name: `生成图片-${assistant.id.slice(0, 6)}.png`, mimeType: 'image/png', size: 0 });
  }
  current.forEach((reference) => add(reference));
  return labeled;
}

