import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { Icon } from '../components/Icon';
import { showToast } from '../components/ui';
import { useDesk } from '../theme';
import type { ConversationBlock } from './blocks';
import { appendModelChange, createModelChange, loadModelChanges, type ModelChangeRecord } from './model-change-notices';

export function useModelChangeNotices(scope: string, ownerKey: string, active: boolean, blocks: readonly ConversationBlock[]) {
  const [state, setState] = useState<{ scope: string; records: ModelChangeRecord[] }>({ scope, records: [] });
  const signature = JSON.stringify([scope, ownerKey, active]), owner = useRef({ signature, epoch: 0 });
  if (owner.current.signature !== signature) owner.current = { signature, epoch: owner.current.epoch + 1 };
  const epoch = owner.current.epoch, mounted = useRef(true), currentBlocks = useRef(blocks), currentRecords = useRef(state);
  currentBlocks.current = blocks; currentRecords.current = state;
  const current = () => mounted.current && active && owner.current.epoch === epoch;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!active || !scope) return;
    let live = true;
    void loadModelChanges(scope).then(records => {
      if (!live || !current()) return;
      setState(previous => ({ scope, records: [...new Map([...records, ...(previous.scope === scope ? previous.records : [])].map(item => [item.id, item])).values()].slice(-80) }));
    }).catch(() => { /* A failed read never overwrites stored records. */ });
    return () => { live = false; };
  }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps
  const record = (from: string, to: string) => {
    if (!current() || !scope) return;
    const value = createModelChange(from, to, currentBlocks.current);
    const previous = currentRecords.current.scope === scope ? currentRecords.current.records : [];
    if (!value) return;
    const next = { scope, records: [...previous, value].slice(-80) };
    currentRecords.current = next; setState(next);
    void appendModelChange(scope, value).catch(() => { if (current()) showToast('模型已选择，切换记录暂未保存', 'alert'); });
  };
  return { records: active && state.scope === scope ? state.records : [], record };
}

export function ModelChangeNoticeRow({ record }: { record: ModelChangeRecord }) {
  const d = useDesk(), [details, setDetails] = useState(false), when = new Date(record.ts), today = new Date();
  const sameDay = when.getFullYear() === today.getFullYear() && when.getMonth() === today.getMonth() && when.getDate() === today.getDate();
  const stamp = `${sameDay ? '今天' : `${when.getMonth() + 1}月${when.getDate()}日`} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
  return <View testID="model-change-notice" style={styles.root}>
    <Text style={[styles.time, { color: d.muted }]}>{stamp}</Text>
    <View style={styles.row}><View style={[styles.line, { backgroundColor: d.line }]} />
      <View style={styles.content}>
        <Svg width={15} height={17} viewBox="0 0 20 22" {...(Platform.OS === 'web' ? { 'aria-hidden': true as const } : { accessible: false })}><Path d="m10 1 8 4.5v10L10 20 2 15.5v-10L10 1Zm0 9v10M2 5.5l8 4.5 8-4.5" fill="none" stroke={d.muted} strokeWidth={1.4} strokeLinejoin="round" /></Svg>
        <Text style={[styles.text, { color: d.muted }]}>{`模型已从 ${record.from} 更改为 ${record.to}。`}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="模型切换说明" accessibilityState={{ expanded: details }} hitSlop={6} onPress={() => setDetails(value => !value)} style={styles.info}><Icon name="info" size={13} color={d.muted} /></Pressable>
      </View><View style={[styles.line, { backgroundColor: d.line }]} /></View>
    {details ? <Text style={[styles.detail, { color: d.muted }]}>这是本机对后续消息的模型设置，不影响正在进行的回复。</Text> : null}
  </View>;
}
const styles = StyleSheet.create({
  root: { paddingVertical: 8, gap: 5 }, time: { fontSize: 10, lineHeight: 15, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 }, line: { flex: 1, minWidth: 8, height: StyleSheet.hairlineWidth },
  content: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1, maxWidth: '86%' },
  text: { fontSize: 12, lineHeight: 19, flexShrink: 1, textAlign: 'center' }, info: { minWidth: 24, minHeight: 28, alignItems: 'center', justifyContent: 'center' },
  detail: { paddingHorizontal: 24, fontSize: 11, lineHeight: 17, textAlign: 'center' },
});
