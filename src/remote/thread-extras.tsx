import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Icon } from '../components/Icon';
import { Appear, MotionPressable, showToast } from '../components/ui';
import { colors, desk, themed, useDesk } from '../theme';
import { DiffView, mono } from './parts';
import { formatDuration, formatTokens, quoteFor, type TurnStat } from './thread-stats';

export { clockText, formatDuration, formatTokens, quoteFor, runningSince, searchBlocks, turnStats, type TurnStat } from './thread-stats';

/* Smaller pieces of the remote conversation: message actions, turn stats,
   the jump-to-latest button, long tool output, full-screen diffs, image
   viewing, in-thread search and voice typing. */

export function useClock(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

async function copyText(text: string, done: string) {
  try {
    const clipboard = await import('expo-clipboard');
    await clipboard.setStringAsync(text);
    showToast(done, 'checkCircle');
  } catch (error) { showToast((error as Error).message || '复制失败', 'alert'); }
}

/** Copy / quote under a finished reply, with that turn's time and tokens. */
export function MessageActions({ text, stat, onQuote }: { text: string; stat?: TurnStat; onQuote?: (text: string) => void }) {
  const dk = useDesk();
  const styles = useStyles();
  const meta = [stat?.durationMs !== undefined ? `用时 ${formatDuration(stat.durationMs)}` : '', stat?.tokens ? `${formatTokens(stat.tokens)} tokens` : ''].filter(Boolean).join(' · ');
  return <View style={styles.actions}>
    <Pressable accessibilityRole="button" accessibilityLabel="复制回复" hitSlop={8} onPress={() => void copyText(text, '已复制')} style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
      <Icon name="copy" size={14} color={dk.muted} />
    </Pressable>
    {onQuote ? <Pressable accessibilityRole="button" accessibilityLabel="引用回复" hitSlop={8} onPress={() => onQuote(text)} style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
      <Icon name="chat" size={14} color={dk.muted} />
    </Pressable> : null}
    {meta ? <Text style={styles.meta} numberOfLines={1}>{meta}</Text> : null}
  </View>;
}

export function copyUserMessage(text: string) { void copyText(text, '已复制'); }

export function JumpToLatest({ visible, unseen, onPress }: { visible: boolean; unseen: boolean; onPress: () => void }) {
  const dk = useDesk();
  const styles = useStyles();
  if (!visible) return null;
  return <View pointerEvents="box-none" style={styles.jumpWrap}>
    <Appear distance={8}>
      <MotionPressable accessibilityRole="button" accessibilityLabel={unseen ? '有新消息，回到最新' : '回到最新'} scaleTo={0.9} onPress={onPress} style={styles.jump}>
        <Icon name="arrowDown" size={17} color={dk.text} />
        {unseen ? <View style={styles.jumpDot} /> : null}
      </MotionPressable>
    </Appear>
  </View>;
}

const OUTPUT_TAIL = 120;

/** Tool output with a bounded height; very long output shows its last lines first. */
export function OutputText({ text }: { text: string }) {
  const styles = useStyles();
  const [full, setFull] = useState(false);
  const lines = useMemo(() => text.replace(/\n+$/, '').split('\n'), [text]);
  const clipped = !full && lines.length > OUTPUT_TAIL;
  const shown = clipped ? lines.slice(-OUTPUT_TAIL).join('\n') : lines.join('\n');
  return <View style={{ gap: 6 }}>
    {clipped ? <Pressable accessibilityRole="button" accessibilityLabel={`显示全部 ${lines.length} 行`} onPress={() => setFull(true)} hitSlop={6}>
      <Text style={styles.outputHint}>只显示最后 {OUTPUT_TAIL} 行 · 显示全部 {lines.length} 行</Text>
    </Pressable> : null}
    <ScrollView nestedScrollEnabled style={styles.outputScroll} contentContainerStyle={{ paddingRight: 2 }}>
      <Text selectable style={styles.outputText}>{shown}</Text>
    </ScrollView>
    {lines.length > 8 ? <Pressable accessibilityRole="button" accessibilityLabel="复制输出" hitSlop={6} onPress={() => void copyText(text, '输出已复制')}>
      <Text style={styles.outputHint}>复制全部输出</Text>
    </Pressable> : null}
  </View>;
}

/** A whole file change, full screen. */
export function DiffScreen({ file, onClose }: { file: { path: string; diff?: string; add: number; del: number } | null; onClose: () => void }) {
  const dk = useDesk();
  const styles = useStyles();
  return <Modal visible={Boolean(file)} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
    <View style={styles.screen}>
      <View style={styles.screenHead}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.screenTitle} numberOfLines={1}>{file?.path.split(/[\\/]/).pop() || file?.path}</Text>
          <Text style={styles.screenPath} numberOfLines={1}>{file?.path}</Text>
        </View>
        {file?.add ? <Text style={[styles.stat, { color: dk.ok }]}>+{file.add}</Text> : null}
        {file?.del ? <Text style={[styles.stat, { color: dk.bad }]}>−{file.del}</Text> : null}
        <Pressable accessibilityRole="button" accessibilityLabel="关闭" hitSlop={10} onPress={onClose} style={styles.close}><Icon name="close" size={18} color={dk.text} /></Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 40 }}>
        {file?.diff ? <DiffView diff={file.diff} maxHeight={1_000_000} /> : null}
      </ScrollView>
    </View>
  </Modal>;
}

/** Full-screen zoomable image; the viewer is loaded only when an image is opened. */
export function ImageViewer({ uri, onClose }: { uri: string | null; onClose: () => void }) {
  if (!uri) return null;
  const { ImagePreview } = require('../components/ImagePreview') as typeof import('../components/ImagePreview');
  return <ImagePreview uri={uri} onClose={onClose} />;
}

export function SearchBar({ query, onChange, position, total, onPrev, onNext, onClose }: {
  query: string; onChange: (value: string) => void; position: number; total: number; onPrev: () => void; onNext: () => void; onClose: () => void;
}) {
  const dk = useDesk();
  const styles = useStyles();
  return <View style={styles.search}>
    <Icon name="search" size={15} color={dk.muted} />
    <TextInput value={query} onChangeText={onChange} autoFocus placeholder="搜索这个对话" placeholderTextColor={dk.muted} returnKeyType="search"
      onSubmitEditing={onNext} style={styles.searchInput} accessibilityLabel="搜索这个对话" />
    <Text style={styles.searchCount}>{query.trim() ? total ? `${position + 1}/${total}` : '无结果' : ''}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="上一个" disabled={!total} hitSlop={6} onPress={onPrev} style={[styles.searchButton, { transform: [{ rotate: '180deg' }] }]}><Icon name="chevronDown" size={16} color={total ? dk.text : dk.faint} /></Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="下一个" disabled={!total} hitSlop={6} onPress={onNext} style={styles.searchButton}><Icon name="chevronDown" size={16} color={total ? dk.text : dk.faint} /></Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="关闭搜索" hitSlop={6} onPress={onClose} style={styles.searchButton}><Icon name="close" size={15} color={dk.muted} /></Pressable>
  </View>;
}

export interface VoiceSource { providers: unknown[]; chatProvider: unknown }

/**
 * Voice typing in the remote composer. Rendered only when the app supplies its
 * speech providers; the dictation module is loaded on first render.
 */
export function RemoteDictation({ voice, text, onText, disabled, children }: {
  voice: VoiceSource; text: string; onText: (value: string) => void; disabled?: boolean;
  children: (mic: React.ReactNode) => React.ReactNode;
}) {
  const dk = useDesk();
  const styles = useStyles();
  const { useDictation } = require('../voice/useDictation') as typeof import('../voice/useDictation');
  const { DictationBar } = require('../components/Composer') as typeof import('../components/Composer');
  const dictation = useDictation({
    providers: voice.providers as never, chatProvider: voice.chatProvider as never, onText,
    onError: (error) => showToast((error as Error)?.message || '语音输入没有完成', 'alert'),
  });
  if (dictation.state !== 'idle') {
    return <View style={styles.dictationRow}>
      <DictationBar dictation={{ state: dictation.state, level: dictation.level, startedAt: dictation.startedAt, onStart: () => undefined, onStop: () => { void dictation.stop(); }, onCancel: dictation.cancel }} />
    </View>;
  }
  const mic = <MotionPressable accessibilityRole="button" accessibilityLabel="语音输入" scaleTo={0.86} disabled={disabled} hitSlop={6} onPress={() => { void dictation.start(text); }} style={[styles.mic, disabled && { opacity: 0.4 }]}>
    <Icon name="mic" size={17} color={dk.text2} />
  </MotionPressable>;
  return <>{children(mic)}</>;
}

const useStyles = themed((c, d) => StyleSheet.create({
  actions: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6, marginLeft: -6 },
  action: { width: 30, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  pressed: { backgroundColor: d.surface3 },
  meta: { marginLeft: 6, color: d.faint, fontSize: 11.5, flexShrink: 1, fontVariant: ['tabular-nums'] },
  jumpWrap: { position: 'absolute', right: 14, bottom: 10 },
  jump: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: d.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: d.lineStrong,
    shadowColor: d.shadow, shadowOpacity: 0.12, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 4 },
  jumpDot: { position: 'absolute', top: 6, right: 7, width: 8, height: 8, borderRadius: 4, backgroundColor: d.ink, borderWidth: 1.5, borderColor: d.surface },
  outputScroll: { maxHeight: 280 },
  outputText: { fontFamily: mono, fontSize: 11.5, lineHeight: 17, color: d.codeText },
  outputHint: { color: '#8FA3D9', fontSize: 11.5, fontWeight: '600' },
  screen: { flex: 1, backgroundColor: d.bg, paddingTop: 36 },
  screenHead: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: d.line },
  screenTitle: { color: d.text, fontSize: 15, fontWeight: '600', fontFamily: mono },
  screenPath: { color: d.muted, fontSize: 11.5, marginTop: 2 },
  stat: { fontFamily: mono, fontSize: 12.5, fontWeight: '600' },
  close: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: d.surface3 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 12, marginTop: 6, marginBottom: 2, height: 40, paddingLeft: 12, paddingRight: 4, borderRadius: 20, backgroundColor: d.surface3 },
  searchInput: { flex: 1, color: d.text, fontSize: 14, paddingVertical: 0 },
  searchCount: { color: d.muted, fontSize: 12, fontVariant: ['tabular-nums'] },
  searchButton: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  mic: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  dictationRow: { paddingHorizontal: 2 },
}));
