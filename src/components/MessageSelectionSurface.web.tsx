import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text } from 'react-native';
import { useDesk } from '../theme';
import { Sheet } from './ui';
import { selectionOwnerToken, validSelection, type MessageSelectionSurfaceProps, type MessageTextSelection } from './message-text-selection';
import { readMessageDOMSelection, selectionToolbarLeft, messageHighlightRange, scrollMessageRangeIntoView, type DomSelection } from './message-selection-dom';

export type { MessageSelectionSurfaceProps, MessageTextSelection, MessageSelectionHighlight } from './message-text-selection';

export function MessageSelectionSurface({ children, sourceText, scopeKey, onSelectText, allowAsk = false, textBasis = 'rendered', showSelectionEntry = true, highlight }: MessageSelectionSurfaceProps) {
  const dk = useDesk();
  const root = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const [toolbarWidth, setToolbarWidth] = useState(0);
  const token = useMemo(selectionOwnerToken, [sourceText, scopeKey, textBasis, allowAsk, Boolean(onSelectText)]);
  const current = useRef({ token, sourceText, textBasis, onSelectText, allowAsk });
  current.current = { token, sourceText, textBasis, onSelectText, allowAsk };
  const selectionEpoch = useRef(0);
  const highlightSelection = useRef<Range | null>(null);
  const [selection, setSelection] = useState<(DomSelection & { token: string; epoch: number }) | null>(null);
  const [openToken, setOpenToken] = useState<string | null>(null);
  const update = useCallback(() => {
    if (current.current.token !== token || !root.current || !current.current.onSelectText) return;
    selectionEpoch.current += 1;
    if (document.visibilityState !== 'visible' || !document.hasFocus()) { setSelection(null); return; }
    const next = readMessageDOMSelection(root.current, window.getSelection());
    if (highlightSelection.current) {
      const range = window.getSelection()?.rangeCount === 1 ? window.getSelection()!.getRangeAt(0) : null;
      if (range && range.compareBoundaryPoints(Range.START_TO_START, highlightSelection.current) === 0 && range.compareBoundaryPoints(Range.END_TO_END, highlightSelection.current) === 0) return;
      highlightSelection.current = null;
    }
    setSelection(next ? { ...next, token, epoch: selectionEpoch.current } : null);
  }, [token]);
  useEffect(() => {
    if (!onSelectText) return;
    document.addEventListener('selectionchange', update);
    document.addEventListener('mouseup', update);
    document.addEventListener('keyup', update);
    const clear = () => { selectionEpoch.current += 1; setSelection(null); };
    window.addEventListener('blur', clear);
    window.addEventListener('resize', update);
    document.addEventListener('visibilitychange', clear);
    return () => {
      selectionEpoch.current += 1;
      document.removeEventListener('selectionchange', update);
      document.removeEventListener('mouseup', update);
      document.removeEventListener('keyup', update);
      window.removeEventListener('blur', clear);
      window.removeEventListener('resize', update);
      document.removeEventListener('visibilitychange', clear);
    };
  }, [token, update, Boolean(onSelectText)]);
  useLayoutEffect(() => {
    if (toolbar.current) setToolbarWidth(toolbar.current.getBoundingClientRect().width);
  }, [selection?.token, allowAsk, dk]);
  useEffect(() => {
    if (!highlight || !onSelectText) return;
    if (highlight.textBasis === 'source' && showSelectionEntry) {
      if (validSelection({ ...highlight, action: 'add', blockIndex: 0, renderedText: sourceText }, sourceText, 'source', false)) setOpenToken(token);
      return;
    }
    if (highlight.textBasis !== textBasis || !root.current) return;
    const range = messageHighlightRange(root.current, highlight);
    if (!range) return;
    const api = globalThis as unknown as { Highlight?: new (range: Range) => unknown; CSS?: { highlights?: Map<string, unknown> } };
    const name = token + '-highlight', registry = api.CSS?.highlights;
    const style = document.createElement('style');
    style.textContent = '::highlight(' + name + ') { background-color: rgba(255,196,71,.4); }';
    if (api.Highlight && registry) { document.head.appendChild(style); registry.set(name, new api.Highlight(range)); }
    else { highlightSelection.current = range; window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range); }
    scrollMessageRangeIntoView(range);
    const clear = () => {
      registry?.delete(name); style.remove();
      if (highlightSelection.current === range) { highlightSelection.current = null; window.getSelection()?.removeAllRanges(); }
    };
    const timer = setTimeout(clear, 2600);
    return () => { clearTimeout(timer); clear(); };
  }, [token, highlight?.nonce]);
  const choose = (action: 'add' | 'ask') => {
    const owner = current.current, fresh = root.current && readMessageDOMSelection(root.current, window.getSelection());
    if (!selection || selection.epoch !== selectionEpoch.current || selection.token !== token || owner.token !== token || !fresh || !owner.onSelectText || document.visibilityState !== 'visible' || !document.hasFocus()
      || fresh.start !== selection.start || fresh.end !== selection.end || fresh.blockIndex !== selection.blockIndex || fresh.renderedText !== selection.renderedText
      || !validSelection({ ...fresh, action }, owner.sourceText, owner.textBasis, owner.allowAsk)) { setSelection(null); return; }
    owner.onSelectText({ action, text: fresh.text, start: fresh.start, end: fresh.end, blockIndex: fresh.blockIndex, textBasis: owner.textBasis, sourceText: owner.sourceText });
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  };
  if (!onSelectText) return <>{children}</>;
  const visible = selection?.token === token && openToken !== token ? selection : null;
  const actionStyle: React.CSSProperties = { border: 0, borderRadius: 5, padding: '7px 10px', background: 'transparent', color: 'inherit', fontFamily: 'inherit', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' };
  return <>
    <div ref={root} data-testid="message-selection-surface" style={{ userSelect: 'text', minWidth: 0 }}>{children}</div>
    {visible ? <div ref={toolbar} role="toolbar" aria-label="所选文字" style={{ position: 'fixed', left: selectionToolbarLeft(visible.left, window.innerWidth, toolbarWidth || (allowAsk ? 300 : 120)), top: visible.top, zIndex: 10000,
      display: 'flex', flexWrap: 'wrap', gap: 4, maxWidth: 'calc(100vw - 16px)', boxSizing: 'border-box', borderRadius: 8, padding: 4, background: dk.surface, color: dk.text, boxShadow: '0 2px 16px #0003' }}
      onPointerDown={event => event.preventDefault()}>
      <button type="button" style={actionStyle} onClick={() => choose('add')}>添加到对话</button>
      {allowAsk ? <button type="button" style={actionStyle} onClick={() => choose('ask')}>在侧边聊天中提问</button> : null}
    </div> : null}
    {showSelectionEntry ? <>
      <Pressable accessibilityRole="button" accessibilityLabel="选择文本" onPress={() => { window.getSelection()?.removeAllRanges(); setOpenToken(token); }} style={{ alignSelf: 'flex-start', paddingVertical: 6 }}>
        <Text style={{ fontSize: 12, color: dk.muted }}>选择文本</Text>
      </Pressable>
      <Sheet visible={openToken === token} title="选择文本" subtitle="拖选文字，可跨段落选择" onClose={() => setOpenToken(null)}>
        {openToken === token ? <MessageSelectionSurface sourceText={sourceText} scopeKey={scopeKey + ':full-text'} textBasis="source" showSelectionEntry={false} allowAsk={allowAsk} highlight={highlight?.textBasis === 'source' ? highlight : undefined}
          onSelectText={value => { if (current.current.token === token) { setOpenToken(null); current.current.onSelectText?.(value); } }}>
          <div data-message-selectable="source" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 16, lineHeight: '26px', color: dk.text }}>{sourceText}</div>
        </MessageSelectionSurface> : null}
      </Sheet>
    </> : null}
  </>;
}
