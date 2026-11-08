import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, findNodeHandle, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useDesk } from '../theme';
import { Sheet } from './ui';
import { nativeMessageSelection } from './message-selection-native';
import { selectionOwnerToken, validSelection, type MessageSelectionSurfaceProps, type MessageTextSelection, type MessageSelectionHighlight } from './message-text-selection';

export type { MessageSelectionSurfaceProps, MessageTextSelection, MessageSelectionHighlight } from './message-text-selection';

export function MessageSelectionSurface({ children, sourceText, scopeKey, onSelectText, allowAsk = false, textBasis = 'rendered', showSelectionEntry = true, highlight }: MessageSelectionSurfaceProps) {
  const dk = useDesk();
  const root = useRef<View>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const token = useMemo(selectionOwnerToken, [sourceText, scopeKey, textBasis, allowAsk, Boolean(onSelectText)]);
  const current = useRef({ token, onSelectText, sourceText, textBasis, allowAsk });
  current.current = { token, onSelectText, sourceText, textBasis, allowAsk };
  const pendingHighlight = useRef(highlight); pendingHighlight.current = highlight;
  const appliedHighlight = useRef<{ token: string; nonce: number } | undefined>(undefined);
  const [openToken, setOpenToken] = useState<string | null>(null);
  const attach = useCallback(() => {
    const native = nativeMessageSelection;
    if (!native || !alive.current || !current.current.onSelectText || current.current.token !== token) return;
    const tag = findNodeHandle(root.current);
    if (tag !== null) return native.attach(tag, token, allowAsk).then(() => {
      if (!alive.current || current.current.token !== token) { void native.detach(token).catch(() => undefined); return; }
      const selected = pendingHighlight.current;
      if (selected && selected.textBasis === textBasis && !(selected.textBasis === 'source' && showSelectionEntry)
        && (appliedHighlight.current?.token !== token || appliedHighlight.current.nonce !== selected.nonce)) {
        void native.highlight(token, selected.blockIndex ?? 0, selected.start, selected.end, selected.text).then(applied => {
          if (applied && alive.current && current.current.token === token) appliedHighlight.current = { token, nonce: selected.nonce };
        }).catch(() => undefined);
      }
    }).catch(() => undefined);
  }, [token, allowAsk, textBasis, showSelectionEntry]);
  useEffect(() => {
    if (!highlight || !onSelectText) return;
    if (highlight.textBasis === 'source' && showSelectionEntry) {
      if (validSelection({ ...highlight, action: 'add', blockIndex: 0, renderedText: sourceText }, sourceText, 'source', false)) setOpenToken(token);
      return;
    }
    if (highlight.textBasis !== textBasis) return;
    void attach();
  }, [token, highlight?.nonce, attach]);
  useEffect(() => {
    const native = nativeMessageSelection;
    if (!native || !onSelectText) return;
    let active = true;
    const subscription = native.addListener('onSelectionAction', event => {
      const owner = current.current;
      if (!active || event.token !== token || owner.token !== token || AppState.currentState !== 'active'
        || !owner.onSelectText || !validSelection(event, owner.sourceText, owner.textBasis, owner.allowAsk)) return;
      owner.onSelectText({ action: event.action, text: event.text, start: event.start, end: event.end,
        blockIndex: event.blockIndex, textBasis: owner.textBasis, sourceText: owner.sourceText });
    });
    const frame = requestAnimationFrame(attach);
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      subscription.remove();
      void native.detach(token).catch(() => undefined);
    };
  }, [token, attach, Boolean(onSelectText)]);
  if (!onSelectText) return <>{children}</>;
  return <>
    <View ref={root} collapsable={false} onLayout={attach} testID="message-selection-surface">{children}</View>
    {showSelectionEntry ? <>
      <Pressable accessibilityRole="button" accessibilityLabel="选择文本" onPress={() => setOpenToken(token)} style={styles.entry}>
        <Text style={[styles.entryText, { color: dk.muted }]}>选择文本</Text>
      </Pressable>
      <Sheet visible={openToken === token} title="选择文本" subtitle="长按文字并拖动选择手柄，可跨段落选择" onClose={() => setOpenToken(null)}>
        {openToken === token ? nativeMessageSelection
          ? <MessageSelectionSurface sourceText={sourceText} scopeKey={scopeKey + ':full-text'} textBasis="source" allowAsk={allowAsk} showSelectionEntry={false}
            highlight={highlight?.textBasis === 'source' ? highlight : undefined}
            onSelectText={selection => { if (current.current.token === token) { setOpenToken(null); current.current.onSelectText?.(selection); } }}>
            <Text selectable style={[styles.source, { color: dk.text }]}>{sourceText}</Text>
          </MessageSelectionSurface>
          : <SourceSelectionFallback key={token} sourceText={sourceText} allowAsk={allowAsk} highlight={highlight?.textBasis === 'source' ? highlight : undefined}
            onSelectText={selection => { if (current.current.token === token) { setOpenToken(null); current.current.onSelectText?.(selection); } }} />
          : null}
      </Sheet>
    </> : null}
  </>;
}

/** Older clients/iOS still use real character selection, with actions below it. */
function SourceSelectionFallback({ sourceText, allowAsk, onSelectText, highlight }: { sourceText: string; allowAsk: boolean; onSelectText: (selection: MessageTextSelection) => void; highlight?: MessageSelectionHighlight }) {
  const dk = useDesk();
  const [range, setRange] = useState({ start: 0, end: 0 });
  const [highlightRange, setHighlightRange] = useState<{ start: number; end: number }>();
  const highlightActive = useRef<number | null>(null);
  useEffect(() => {
    if (!highlight || !validSelection({ ...highlight, action: 'add', blockIndex: 0, renderedText: sourceText }, sourceText, 'source', false)) return;
    highlightActive.current = highlight.nonce;
    setHighlightRange({ start: highlight.start, end: highlight.end });
    const timer = setTimeout(() => {
      if (highlightActive.current === highlight.nonce) {
        highlightActive.current = null;
        setHighlightRange({ start: highlight.end, end: highlight.end });
        setRange({ start: 0, end: 0 });
      }
    }, 2600);
    return () => { highlightActive.current = null; clearTimeout(timer); };
  }, [sourceText, highlight?.nonce]);
  const selected = sourceText.slice(range.start, range.end);
  const choose = (action: 'add' | 'ask') => {
    const snapshot = { action, text: selected, ...range, renderedText: sourceText, blockIndex: 0 };
    if (validSelection(snapshot, sourceText, 'source', allowAsk)) onSelectText({ action, text: selected, ...range, blockIndex: 0, textBasis: 'source', sourceText });
  };
  return <View>
    <TextInput accessibilityLabel="选择消息正文" multiline value={sourceText} showSoftInputOnFocus={false}
      selection={highlightRange}
      autoCorrect={false} spellCheck={false} onChangeText={() => setRange({ start: 0, end: 0 })} style={[styles.source, { color: dk.text }]}
      onSelectionChange={event => {
        const next = event.nativeEvent.selection;
        if (highlightActive.current !== null && next.start === highlightRange?.start && next.end === highlightRange.end) return;
        highlightActive.current = null; setHighlightRange(undefined);
        setRange({ start: Math.min(next.start, next.end), end: Math.max(next.start, next.end) });
      }} />
    {selected.trim() ? <View style={styles.actions}>
      <Pressable accessibilityRole="button" onPress={() => choose('add')}><Text style={[styles.entryText, { color: dk.muted }]}>添加到对话</Text></Pressable>
      {allowAsk ? <Pressable accessibilityRole="button" onPress={() => choose('ask')}><Text style={[styles.entryText, { color: dk.muted }]}>在侧边聊天中提问</Text></Pressable> : null}
    </View> : null}
  </View>;
}
const styles = StyleSheet.create({
  entry: { alignSelf: 'flex-start', paddingVertical: 6, paddingHorizontal: 2 },
  entryText: { fontSize: 12 },
  source: { fontSize: 16, lineHeight: 26, padding: 0 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 18, paddingVertical: 12 },
});
