import { validSelection, type MessageSelectionHighlight, type SelectionSnapshot } from './message-text-selection';

export type DomSelection = Omit<SelectionSnapshot, 'action'> & { left: number; top: number };
const selectableSelector = '[data-message-selectable], [data-testid="message-selectable-text"]';

/** Select only message-body Text roots. Toolbars, skill labels and citations outside them are excluded. */
export function readMessageDOMSelection(root: HTMLElement, selection: Selection | null): DomSelection | null {
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const blocks = Array.from(root.querySelectorAll<HTMLElement>(selectableSelector));
  const blockIndex = blocks.findIndex(block => block.contains(range.startContainer) && block.contains(range.endContainer));
  if (blockIndex < 0) return null;
  const block = blocks[blockIndex], prefix = range.cloneRange();
  prefix.selectNodeContents(block);
  prefix.setEnd(range.startContainer, range.startOffset);
  const text = range.toString(), start = prefix.toString().length, end = start + text.length;
  const renderedText = block.textContent ?? '';
  if (!text.trim() || renderedText.slice(start, end) !== text) return null;
  const rect = range.getBoundingClientRect();
  return { text, start, end, renderedText, blockIndex, left: Math.max(8, rect.left), top: Math.max(8, rect.top - 42) };
}
export function selectionToolbarLeft(selectionLeft: number, viewportWidth: number, toolbarWidth: number): number {
  return Math.max(8, Math.min(selectionLeft, Math.max(8, viewportWidth - toolbarWidth - 8)));
}

export function messageHighlightRange(root: HTMLElement, highlight: MessageSelectionHighlight): Range | null {
  const block = root.querySelectorAll<HTMLElement>(selectableSelector)[highlight.blockIndex ?? 0];
  if (!block) return null;
  const renderedText = block.textContent ?? '';
  if (!validSelection({ ...highlight, blockIndex: highlight.blockIndex ?? 0, action: 'add', renderedText }, renderedText, 'rendered', false)) return null;
  const walker = block.ownerDocument.createTreeWalker(block, 4);
  const range = block.ownerDocument.createRange();
  let node: Node | null, offset = 0, started = false;
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0;
    if (!started && highlight.start <= offset + length) { range.setStart(node, highlight.start - offset); started = true; }
    if (started && highlight.end <= offset + length) { range.setEnd(node, highlight.end - offset); return range; }
    offset += length;
  }
  return null;
}

export function scrollMessageRangeIntoView(range: Range): void {
  const start = range.cloneRange(); start.collapse(true);
  let parent = range.startContainer.parentElement;
  while (parent) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) {
      const point = start.getBoundingClientRect(), viewport = parent.getBoundingClientRect();
      if (point.top < viewport.top || point.bottom > viewport.bottom) parent.scrollTop += point.top - viewport.top - Math.min(80, parent.clientHeight / 4);
    }
    parent = parent.parentElement;
  }
}
