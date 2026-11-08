import React, { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, G, Path } from 'react-native-svg';
import { useDesk } from '../theme';
import { relTime } from './parts';

export type SubagentGroup = 'running' | 'ended' | 'failed' | 'unconfirmed';
export interface SubagentListItem {
  id: string;
  title: string;
  group: SubagentGroup;
  updatedAt?: number;
  busy?: boolean;
  detail?: React.ReactNode;
}

/** A stable decorative marker, not an upstream profile photo. */
function SubagentAvatar({ identity, size }: { identity: string; size: number }) {
  const hash = Array.from(identity).reduce((value, letter) => (value * 31 + letter.charCodeAt(0)) >>> 0, 0);
  const colors = ['#8BD76A', '#F18BBF', '#A893E7', '#7CBCE6', '#E8B56B'];
  const color = colors[hash % colors.length];
  return <Svg width={size} height={size} viewBox="0 0 32 32">
    {Array.from({ length: 8 }, (_, index) => <G key={index} transform={`rotate(${index * 45} 16 16)`}>
      {hash % 2 ? <Circle cx="16" cy="7" r="5" fill={color} opacity={0.62 + (index % 3) * 0.16} />
        : <Path d="M16 3 L25 8 L18 15 L16 15 Z" fill={color} opacity={0.62 + (index % 3) * 0.16} />}
    </G>)}
    <Circle cx="16" cy="16" r="4" fill={color} />
  </Svg>;
}

export function SubagentList({ items, onOpen, onActions, onManage, management }: {
  items: SubagentListItem[];
  onOpen: (id: string) => void;
  onActions?: (id: string) => void;
  onManage?: () => void;
  management?: React.ReactNode;
}) {
  const d = useDesk();
  const [width, setWidth] = useState(390);
  const wide = width >= 600;
  const muted = d.surface === '#FFFFFF' ? '#999999' : d.muted;
  const groups: { id: SubagentGroup; title: string; empty?: string }[] = [
    { id: 'running', title: '已开启', empty: '没有已开启的子代理' },
    { id: 'ended', title: '完成' },
    { id: 'failed', title: '未完成' },
    { id: 'unconfirmed', title: '状态未确认' },
  ];
  return <ScrollView onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ flex: 1, backgroundColor: d.surface }} contentContainerStyle={[styles.list, wide && styles.listWide]}>
    {groups.map(group => {
      const rows = items.filter(item => item.group === group.id);
      if (!rows.length && group.id !== 'running') return null;
      return <View key={group.id} testID={`subagent-group-${group.id}`} style={styles.group}>
        {group.id === 'running' && onManage
          ? <Pressable accessibilityRole="button" accessibilityLabel="子智能体管理操作" accessibilityHint="刷新状态或管理正在运行的子智能体" onPress={onManage} style={[styles.groupHeading, wide && styles.groupHeadingWide]}>
            <Text style={[styles.groupTitle, wide && styles.groupTitleWide, { color: muted }]}>{group.title} · {rows.length}</Text>
          </Pressable>
          : <View style={[styles.groupHeading, wide && styles.groupHeadingWide]}><Text style={[styles.groupTitle, wide && styles.groupTitleWide, { color: muted }]}>{group.title} · {rows.length}</Text></View>}
        {group.id === 'running' ? management : null}
        {!rows.length && group.empty ? <Text style={[styles.empty, wide && styles.emptyWide, { color: muted }]}>{group.empty}</Text> : null}
        {rows.map(item => <View key={item.id} testID={`subagent-row:${item.id}`}>
          <Pressable accessibilityRole="button" accessibilityLabel={`打开${item.title}`}
            accessibilityHint={onActions ? '点按打开会话，长按显示操作' : undefined}
            onPress={() => onOpen(item.id)} onLongPress={onActions ? () => onActions(item.id) : undefined}
            {...(Platform.OS === 'web' && onActions ? { onContextMenu: (event: { preventDefault(): void }) => { event.preventDefault(); onActions(item.id); } } : {})}
            style={({ pressed }) => [styles.row, wide && styles.rowWide, pressed && { backgroundColor: d.surface2 }]}>
            <SubagentAvatar identity={item.id} size={wide ? 32 : 26} />
            <Text numberOfLines={1} style={[styles.title, wide && styles.titleWide, { color: d.text }]}>{item.title}</Text>
            {item.busy ? <ActivityIndicator size="small" color={muted} />
              : item.updatedAt && Number.isFinite(item.updatedAt) ? <Text style={[styles.time, wide && styles.timeWide, { color: muted }]}>{relTime(item.updatedAt).replace(/ /g, '')}</Text> : null}
          </Pressable>
          {item.detail}
        </View>)}
      </View>;
    })}
  </ScrollView>;
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: 24, paddingTop: 23, paddingBottom: 24, gap: 29 },
  listWide: { paddingHorizontal: 30, paddingTop: 30, gap: 36 },
  group: { gap: 2 }, groupHeading: { minHeight: 28, justifyContent: 'center', alignSelf: 'flex-start' },
  groupHeadingWide: { minHeight: 38 }, groupTitleWide: { fontSize: 20, lineHeight: 30 },
  groupTitle: { fontSize: 15, lineHeight: 23, fontWeight: '400' },
  empty: { fontSize: 15, lineHeight: 24, paddingTop: 5 },
  emptyWide: { fontSize: 20, lineHeight: 32, paddingTop: 6 },
  row: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 16, borderRadius: 7 },
  title: { flex: 1, minWidth: 0, fontSize: 16, lineHeight: 23, fontWeight: '400' },
  rowWide: { minHeight: 66, gap: 22 }, titleWide: { fontSize: 20, lineHeight: 29 },
  time: { fontSize: 13, lineHeight: 20 },
  timeWide: { fontSize: 18, lineHeight: 26 },
});
