import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from '../components/Icon';
import type { SessionInfo } from './client';
import { groupSessionsByProject } from './projection';

/** The preview uses the same project identities as the connected directory. */
export function DemoProjectTree({ sessions, selectedKey, query = '', onOpen, openLabel = '打开 ', onNew, onCopy }: {
  sessions: SessionInfo[];
  selectedKey?: string | null;
  query?: string;
  onOpen(session: SessionInfo): void;
  openLabel?: string;
  onNew?: (path: string) => void;
  onCopy?: (session: SessionInfo) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const groups = useMemo(() => groupSessionsByProject(sessions, { caseSensitivePaths: false }), [sessions]);
  const duplicateNames = new Set(groups.filter(group => groups.some(other => other.key !== group.key && other.name === group.name)).map(group=>group.name));
  const search = query.trim().toLocaleLowerCase();
  return <View style={s.tree}>{groups.map(group => {
    const shown = search && !`${group.name} ${group.path}`.toLocaleLowerCase().includes(search)
      ? group.sessions.filter(session => session.title.toLocaleLowerCase().includes(search)) : group.sessions;
    if (!shown.length) return null;
    const expanded = Boolean(search) || !collapsed.has(group.key);
    return <View key={group.key} testID={`demo-project:${group.key}`} style={s.group}>
      <View style={s.projectRow}>
        <Pressable accessibilityRole="button" accessibilityLabel={`${expanded ? '折叠' : '展开'}项目 ${group.name}`} accessibilityState={{ expanded }}
          onPress={() => setCollapsed(current => { const next = new Set(current); if (next.has(group.key)) next.delete(group.key); else next.add(group.key); return next; })} style={s.projectButton}>
          <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12} color="#777777" />
          <Icon name="folder" size={16} color="#555555" />
          <View style={s.projectCopy}><Text numberOfLines={1} style={s.projectName}>{group.name}</Text>{duplicateNames.has(group.name) ? <Text numberOfLines={1} style={s.path}>{group.path}</Text> : null}</View><Text style={s.count}>{group.sessions.length}</Text>
        </Pressable>
        {onNew ? <Pressable accessibilityRole="button" accessibilityLabel={`在项目 ${group.name} 新建任务`} onPress={() => onNew(group.path)} style={s.more}><Icon name="plus" size={15} color="#777777" /></Pressable> : null}
      </View>
      {expanded ? <View style={s.sessions}>{shown.map(session => {
        const selected = selectedKey === session.sessionKey;
        const status = session.status === 'running' ? '运行中' : session.status === 'waiting_approval' ? '等待批准' : session.status === 'failed' ? '失败' : '需在电脑确认';
        return <View key={session.sessionKey}>
          <View style={[s.sessionRow, selected && s.selected]}>
            <Pressable accessibilityRole="button" accessibilityLabel={`${openLabel}${session.title}`} accessibilityState={{ selected }} onPress={() => onOpen(session)} style={s.sessionButton}>
              <Text numberOfLines={1} style={[s.sessionTitle, selected && s.selectedTitle]}>{session.title || '无标题会话'}</Text>
              {session.status !== 'idle' ? <View accessibilityLabel={`${session.title}：${status}`} style={s.status}>
                {session.status === 'running' ? <ActivityIndicator size="small" color="#666666" /> : <Icon name={session.status === 'waiting_approval' ? 'clock' : 'alert'} size={13} color="#888888" />}
              </View> : null}
            </Pressable>
            {onCopy ? <Pressable accessibilityRole="button" accessibilityLabel={`更多：${session.title}`} accessibilityState={{ expanded: menuKey === session.sessionKey }} onPress={() => setMenuKey(current => current === session.sessionKey ? null : session.sessionKey)} style={s.more}><Icon name="more" size={14} color="#888888" /></Pressable> : null}
          </View>
          {onCopy && menuKey === session.sessionKey ? <View style={s.actions}>
            <Pressable accessibilityRole="button" accessibilityLabel={`复制任务名：${session.title}`} onPress={() => { onCopy(session); setMenuKey(null); }} style={s.action}><Text style={s.actionText}>复制任务名</Text></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={`打开任务：${session.title}`} onPress={() => { onOpen(session); setMenuKey(null); }} style={s.action}><Text style={s.actionText}>打开任务</Text></Pressable>
          </View> : null}
        </View>;
      })}</View> : null}
    </View>;
  })}</View>;
}

const s = StyleSheet.create({
  tree: { gap: 12 }, group: { gap: 3 }, projectRow: { flexDirection: 'row', alignItems: 'center' },
  projectButton: { flex: 1, minWidth: 0, minHeight: 35, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 5 },
  projectCopy: { flex: 1, minWidth: 0, gap: 2 }, projectName: { fontSize: 13, color: '#343434', fontWeight: '500' }, path: { fontSize: 10, color: '#999999' }, count: { fontSize: 10, color: '#999999' },
  sessions: { paddingLeft: 20, gap: 2 }, sessionRow: { flexDirection: 'row', alignItems: 'center', borderRadius: 8 }, selected: { backgroundColor: '#ECECEC' },
  sessionButton: { flex: 1, minWidth: 0, minHeight: 35, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 7, paddingRight: 5 },
  sessionTitle: { flex: 1, fontSize: 12, color: '#666666' }, selectedTitle: { color: '#202020', fontWeight: '500' }, meta: { fontSize: 10, color: '#929292' },
  status: { width: 15, height: 18, alignItems: 'center', justifyContent: 'center' }, more: { width: 27, height: 30, alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', gap: 8, paddingLeft: 7, paddingBottom: 5 }, action: { paddingHorizontal: 7, paddingVertical: 5, borderRadius: 5, backgroundColor: '#F3F3F3' }, actionText: { fontSize: 10, color: '#666666' },
});
