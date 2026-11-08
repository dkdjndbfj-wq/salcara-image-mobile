import type { Block, ConversationBlock, FileEdit } from './blocks';

/** Last turn is bounded by the last loaded user message. Preserve every edit in
 * order; duplicate paths can be different versions and must not keep an older
 * historical diff by accident. With no loaded boundary we cannot claim a turn. */
export function lastTurnFiles(blocks: readonly (Block | ConversationBlock)[]): FileEdit[] {
  let start = -1;
  for (let index = blocks.length - 1; index >= 0; index--) if (blocks[index].type === 'user') { start = index; break; }
  if (start < 0) return [];
  return blocks.slice(start + 1).flatMap(block => block.type === 'activity' || block.type === 'work' ? block.files : []);
}
