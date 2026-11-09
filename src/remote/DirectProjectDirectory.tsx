import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from '../components/Icon';
import { useDesk } from '../theme';
import { useReducedMotion } from '../components/MotionPressable';
import type { AgentProfile, SessionInfo, WorkspaceMode } from './client';
import { agentSessions, groupSessionsByProject, sessionWorkspaceMode } from './projection';
import { directorySessionActivities } from './directory-session-activity';
import { DirectorySessionStatus } from './DirectorySessionStatus';
import {useConversationResultIndex} from './ConversationUnread';

interface DirectProjectDirectoryProps {
  readScope?:string;
  scopeKey: string;
  agent: AgentProfile;
  workspaceMode: WorkspaceMode;
  sessions: SessionInfo[];
  disabled?: boolean;
  onOpen: (session: SessionInfo) => void;
  onNew?: (cwd: string) => void;
}

/** A project is only a folder in the directory; opening it never opens a conversation. */
export function DirectProjectDirectory({ scopeKey, readScope, agent, workspaceMode, sessions, disabled, onOpen, onNew }: DirectProjectDirectoryProps) {
  const d = useDesk();
  const reduced = useReducedMotion();
  const identity = JSON.stringify([scopeKey, agent.id, workspaceMode]);
  const owner = useMemo(() => ({ identity, active: true }), [identity]);
  const active = useRef(owner); active.current = owner;
  useEffect(() => { owner.active = true; return () => { owner.active = false; }; }, [owner]);
  const [folders, setFolders] = useState<{ identity: string; collapsed: Record<string, boolean> }>({ identity, collapsed: {} });
  useEffect(() => { setFolders({ identity, collapsed: {} }); }, [identity]);
  const collapsed = folders.identity === identity ? folders.collapsed : {};
  const activities = useMemo(() => directorySessionActivities(sessions, agent, workspaceMode), [sessions, agent.id, agent.tool, workspaceMode]);
  const groups = useMemo(() => {
    const directory = agentSessions(sessions, agent).filter(item => !item.parentSessionKey && sessionWorkspaceMode(item) === workspaceMode);
    const windowsPaths = directory.some(item => /^(?:[a-z]:[\\/]|\\\\)/i.test(item.cwd ?? ''));
    return groupSessionsByProject(directory, { caseSensitivePaths: !windowsPaths });
  }, [sessions, agent.id, agent.tool, workspaceMode]);
  useConversationResultIndex(groups.flatMap(group=>group.sessions.map(session=>({scope:readScope??'',session,active:!disabled}))));
  return <View testID="direct-project-directory" style={styles.directory}>
    {groups.map(group => {
      const closed = collapsed[group.key] === true;
      return <View key={group.key} style={styles.project}>
        <Pressable accessibilityRole="button" accessibilityLabel={`${closed ? '展开' : '折叠'} ${group.name} 对话`}
          accessibilityState={{ expanded: !closed, disabled: Boolean(disabled) }} disabled={disabled}
          onPress={() => {
            if (disabled || active.current !== owner || !owner.active) return;
            setFolders(current => {
              const values = current.identity === identity ? current.collapsed : {};
              return { identity, collapsed: { ...values, [group.key]: !values[group.key] } };
            });
          }} style={styles.folder}>
          <Icon name={closed ? 'chevronRight' : 'chevronDown'} size={14} color={d.muted}/>
          <Icon name={group.key === '__temporary' ? 'chat' : 'folder'} size={17} color={d.muted}/>
          <View style={styles.copy}>
            <Text numberOfLines={1} style={[styles.name, { color: d.text }]}>{group.name}</Text>
            {group.path && groups.some(other => other.key !== group.key && other.name === group.name)
              ? <Text numberOfLines={1} style={[styles.detail, { color: d.muted }]}>{group.path}</Text> : null}
          </View>
          <Text style={[styles.count, { color: d.muted }]}>{group.sessions.length}</Text>
        </Pressable>
        {group.path && onNew ? <Pressable accessibilityRole="button" accessibilityLabel={`在 ${group.name} 中新建 ${workspaceMode === 'code' ? 'Code' : 'Work'} 对话`} disabled={disabled} onPress={() => { if (!disabled && active.current === owner && owner.active) onNew(group.path); }} style={styles.session}><Text style={{color:d.accentText}}>新建会话</Text></Pressable> : null}
        {!closed ? <View style={[styles.children, { borderLeftColor: d.line }]}>
          {group.sessions.map(session => <Pressable key={session.sessionKey} accessibilityRole="button"
            accessibilityLabel={`打开对话 ${session.title || '无标题对话'}`} disabled={disabled}
            accessibilityState={{ disabled: Boolean(disabled) }} onPress={() => {
              if (!disabled && active.current === owner && owner.active) onOpen(session);
            }} style={({ pressed }) => [styles.session, pressed && { backgroundColor: d.surface2 }]}>
            <Text numberOfLines={1} style={[styles.sessionTitle, { color: d.text2 }]}>{session.title || '无标题对话'}</Text>
            <DirectorySessionStatus activity={activities.get(session.sessionKey) ?? {status:session.status,includesChildren:false}} title={session.title || '无标题对话'} active={!disabled} reduced={reduced} result={readScope?{scope:readScope,session,active:!disabled}:undefined}/>
          </Pressable>)}
        </View> : null}
      </View>;
    })}
  </View>;
}

const styles = StyleSheet.create({
  directory: { gap: 12, paddingVertical: 4 },
  project: { gap: 2 },
  folder: { minHeight: 42, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 4 },
  copy: { flex: 1, minWidth: 0, gap: 2 },
  name: { fontSize: 13, fontWeight: '600' },
  count: { fontSize: 11, paddingHorizontal: 8 },
  detail: { fontSize: 10.5 },
  children: { marginLeft: 12, borderLeftWidth: StyleSheet.hairlineWidth, paddingLeft: 12 },
  session: { minHeight: 42, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, borderRadius: 7 },
  sessionTitle: { flex: 1, minWidth: 0, fontSize: 13 },
});
