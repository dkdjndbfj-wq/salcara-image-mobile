import type { ReactNode } from 'react';

export interface MessageTextSelection {
  action: 'add' | 'ask';
  text: string;
  start: number;
  end: number;
  blockIndex: number;
  textBasis: 'rendered' | 'source';
  sourceText: string;
}
export interface MessageSelectionSurfaceProps {
  sourceText: string;
  scopeKey: string;
  onSelectText?: (selection: MessageTextSelection) => void;
  allowAsk?: boolean;
  children: ReactNode;
  textBasis?: 'rendered' | 'source';
  showSelectionEntry?: boolean;
  highlight?: MessageSelectionHighlight;
}
export interface MessageSelectionHighlight {
  nonce: number;
  textBasis: 'rendered' | 'source';
  blockIndex?: number;
  start: number;
  end: number;
  text: string;
}
export interface SelectionSnapshot {
  action: 'add' | 'ask';
  text: string;
  start: number;
  end: number;
  blockIndex: number;
  renderedText: string;
}
const boundary = (text: string, offset: number) => !(offset > 0 && offset < text.length
  && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]));

/** Offsets are UTF-16 within this exact rendered block, never guessed in Markdown. */
export function validSelection(snapshot: SelectionSnapshot, sourceText: string, basis: 'rendered' | 'source', allowAsk: boolean): boolean {
  return (snapshot.action === 'add' || snapshot.action === 'ask' && allowAsk)
    && typeof snapshot.text === 'string' && Boolean(snapshot.text.trim())
    && typeof snapshot.renderedText === 'string'
    && Number.isInteger(snapshot.start) && Number.isInteger(snapshot.end)
    && snapshot.start >= 0 && snapshot.end > snapshot.start && snapshot.end <= snapshot.renderedText.length
    && Number.isInteger(snapshot.blockIndex) && snapshot.blockIndex >= 0
    && boundary(snapshot.renderedText, snapshot.start) && boundary(snapshot.renderedText, snapshot.end)
    && snapshot.renderedText.slice(snapshot.start, snapshot.end) === snapshot.text
    && (basis !== 'source' || snapshot.renderedText === sourceText && snapshot.blockIndex === 0);
}
let nextOwner = 0;
export function selectionOwnerToken(): string { nextOwner += 1; return `message-selection-${nextOwner}`; }
