import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useDesk } from '../theme';
import { conversationFontFamily } from './conversation-typography';
import { previewLogLocation, previewLogsDraft, type PreviewLogEntry } from './preview-logs';

export interface PreviewLogPanelProps {
  scopeKey: string; entries: readonly PreviewLogEntry[]; origin: string; active?: boolean;
  supported?: boolean; unavailableReason?: string; initiallyOpen?: boolean;
  onCompose?: (text: string) => boolean | void;
}
/** This surface never sends a turn or focuses the composer. Owners validate the target draft. */
export function PreviewLogPanel(props: PreviewLogPanelProps) { return <LogSession key={props.scopeKey} {...props} />; }
function LogSession({ scopeKey, entries, origin, active = true, supported = true, unavailableReason, initiallyOpen = false, onCompose }: PreviewLogPanelProps) {
  const d = useDesk(), [open, setOpen] = useState(initiallyOpen), [selected, setSelected] = useState<Set<string>>(() => new Set()), [notice, setNotice] = useState('');
  const owner = useMemo(() => ({}), [scopeKey, active, supported, onCompose]), current = useRef(owner), alive = useRef(true);
  current.current = owner;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const valid = () => alive.current && current.current === owner && active && supported;
  const chosen = entries.filter(entry => selected.has(entry.id));
  const append = (batch: readonly PreviewLogEntry[]) => {
    if (!valid() || !onCompose || !batch.length) return;
    try {
      if (onCompose(previewLogsDraft(batch, origin)) === false) { setNotice('当前对话草稿尚未就绪，日志已保留'); return; }
      if (valid()) { setSelected(new Set()); setNotice(`已将 ${batch.length} 条日志加入草稿`); }
    } catch (error) { if (valid()) setNotice(error instanceof Error ? error.message : '日志未加入草稿，请重试'); }
  };
  return <View testID="preview-log-panel" style={{ borderTopWidth: 1, borderColor: d.line, backgroundColor: d.surface, flexShrink: 0 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, minHeight: 44 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={open ? '收起预览日志' : '展开预览日志'} accessibilityState={{ expanded: open }} disabled={!active} onPress={() => { if (alive.current && current.current === owner && active) setOpen(value => !value); }} style={{ flex: 1, minHeight: 44, justifyContent: 'center' }}>
        <Text style={{ fontFamily: conversationFontFamily, color: d.text2, fontSize: 12 }}>日志{supported ? ` · ${entries.length}` : ' · 不可用'}{entries.some(entry => entry.level === 'error') ? ' · 有错误' : ''}</Text>
      </Pressable>
      {supported && open ? <Pressable accessibilityRole="button" accessibilityLabel="将所选预览日志加入对话" disabled={!active || !onCompose || !chosen.length} onPress={() => append(chosen)} style={{ minHeight: 44, justifyContent: 'center', opacity: active && onCompose && chosen.length ? 1 : 0.4 }}><Text style={{ fontFamily: conversationFontFamily, color: d.accentText, fontSize: 12 }}>加入所选{chosen.length ? ` (${chosen.length})` : ''}</Text></Pressable> : null}
    </View>
    {open ? !supported ? <Text style={{ fontFamily: conversationFontFamily, padding: 12, color: d.muted, fontSize: 12 }}>{unavailableReason ?? '当前预览未提供运行日志'}</Text> : <>
      {notice ? <Text accessibilityLiveRegion="polite" style={{ fontFamily: conversationFontFamily, paddingHorizontal: 12, paddingBottom: 6, color: d.muted, fontSize: 12 }}>{notice}</Text> : null}
      <ScrollView nestedScrollEnabled style={{ maxHeight: 220 }} keyboardShouldPersistTaps="handled">
        {!entries.length ? <Text style={{ fontFamily: conversationFontFamily, padding: 12, color: d.muted, fontSize: 12 }}>暂无运行日志</Text> : entries.map(entry => <View key={entry.id} style={{ paddingHorizontal: 12, paddingVertical: 6, borderTopWidth: 1, borderColor: d.line, gap: 3 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Pressable accessibilityRole="checkbox" accessibilityLabel={`选择日志 ${entry.id}`} accessibilityState={{ checked: selected.has(entry.id) }} disabled={!active} onPress={() => { if (valid()) setSelected(values => { const next = new Set(values); if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id); return next; }); }} style={{ minHeight: 44, flex: 1, justifyContent: 'center' }}><Text style={{ fontFamily: conversationFontFamily, fontSize: 12, color: entry.level === 'error' ? d.bad : d.text2 }}>{selected.has(entry.id) ? '☑' : '☐'} {entry.level.toUpperCase()}</Text></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={`将日志 ${entry.id} 加入对话`} disabled={!active || !onCompose} onPress={() => append([entry])} style={{ minHeight: 44, justifyContent: 'center', opacity: active && onCompose ? 1 : 0.4 }}><Text style={{ fontFamily: conversationFontFamily, color: d.accentText, fontSize: 12 }}>加入对话</Text></Pressable>
          </View>
          <Text selectable style={{ fontFamily: conversationFontFamily, color: d.text2, fontSize: 12, lineHeight: 18 }}>{entry.message}</Text>
          {previewLogLocation(entry) ? <Text selectable style={{ fontFamily: conversationFontFamily, color: d.muted, fontSize: 11 }}>{previewLogLocation(entry)}</Text> : null}
          {entry.truncated ? <Text style={{ fontFamily: conversationFontFamily, color: d.muted, fontSize: 11 }}>本条日志过长，内容已截断</Text> : null}
        </View>)}
      </ScrollView>
    </> : null}
  </View>;
}
