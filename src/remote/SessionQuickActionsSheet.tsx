import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, AppState, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { showToast } from '../components/ui';
import { Icon, type IconName } from '../components/Icon';
import { useDesk } from '../theme';
import type { AgentProfile, SessionInfo } from './client';
import { agentSupports, sessionKeyAgentId } from './projection';
import { hubSupportsSessionActions } from './store';
import { SessionActionsSheet } from './SessionActionsSheet';
import { sessionDeepLink, sessionInfoText, sessionMarkdown, sessionShareAgentId, sessionWorkingDirectory } from './session-share';
import { conversationFontFamily } from './conversation-typography';
import { MotionPressable, useReducedMotion } from '../components/MotionPressable';
import { useSessionMenuMotion } from './useSessionMenuMotion';

export interface SessionQuickActionsSheetProps {
  visible: boolean;
  deviceId: string;
  connectionId?: string | null;
  deviceName?: string;
  agent: AgentProfile;
  session: SessionInfo;
  onClose: () => void;
  onOpenSession?: (sessionKey: string) => void;
  onOpenFork?: (sessionKey: string) => void;
  onArchive?: () => void;
}

/** The phone equivalent of the desktop row context menu. */
export function SessionQuickActionsSheet({ visible, deviceId, connectionId, deviceName, agent, session, onClose, onOpenSession, onOpenFork, onArchive }: SessionQuickActionsSheetProps) {
  const dk = useDesk(), reduced = useReducedMotion();
  const [management, setManagement] = useState(false);
  const context = useMemo(() => ({ deviceId, connectionId: connectionId ?? undefined, agentId: sessionShareAgentId(session) ?? sessionKeyAgentId(session.sessionKey) ?? agent.id,
    deviceName, agentName: session.client || agent.name }), [deviceId, connectionId, session.sessionKey, session.client, agent.id, agent.name, deviceName]);
  const deepLink = sessionDeepLink(session, context);
  const canManage = Boolean(!session.archived && session.controllable && session.controlSurface !== 'desktop' && session.controlSurface !== 'read-only'
    && session.tool === agent.tool && sessionKeyAgentId(session.sessionKey) === session.tool
    && typeof hubSupportsSessionActions === 'function' && hubSupportsSessionActions()
    && agentSupports(agent, session.tool, 'sessionActions'));
  const identity = JSON.stringify([visible, deviceId, connectionId, agent.id, session, canManage]);
  const motion = useSessionMenuMotion(visible && !management, identity, reduced);
  const owner = useRef({ identity, epoch: 0, retired: false });
  if (owner.current.identity !== identity) owner.current = { identity, epoch: owner.current.epoch + 1, retired: false };
  const epoch = owner.current.epoch, mounted = useRef(true), latestClose = useRef(onClose);
  latestClose.current = onClose;
  const current = () => mounted.current && visible && owner.current.epoch === epoch;
  const active = () => current() && !management && !owner.current.retired && AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
  const dismiss = () => { if (active()) { owner.current.retired = true; motion.close(() => { if (current()) latestClose.current(); }); } };
  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active' && !owner.current.retired) { owner.current.retired = true; latestClose.current(); }
    });
    return () => { mounted.current = false; subscription.remove(); };
  }, []);
  const copy = (value: string, message: string) => {
    void Clipboard.setStringAsync(value).then(() => showToast(message, 'checkCircle')).catch(() => showToast('复制失败', 'alert'));
  };
  const closeManagement = () => { if (current()) { setManagement(false); onClose(); } };
  const openFork = (key: string) => { if (current()) { setManagement(false); onClose(); (onOpenFork ?? onOpenSession)?.(key); } };
  const archive = () => { if (current()) { setManagement(false); onClose(); onArchive?.(); showToast('对话已归档', 'checkCircle'); } };
  const actions: { label: string; icon: IconName; disabled?: boolean; immediate?: () => void; onPress: () => void }[] = [
    { label: '打开对话', icon: 'arrowRight', disabled: !onOpenSession, onPress: () => { onClose(); onOpenSession?.(session.sessionKey); } },
    { label: '复制会话信息', icon: 'copy', immediate: () => copy(sessionInfoText(session, context), '会话信息已复制'), onPress: onClose },
    { label: '复制深度链接', icon: 'link', disabled: !deepLink, immediate: () => { if (deepLink) copy(deepLink, '深度链接已复制'); }, onPress: onClose },
    { label: '复制 Markdown', icon: 'code', immediate: () => copy(sessionMarkdown(session, context), 'Markdown 已复制'), onPress: onClose },
    { label: '复制工作目录', icon: 'folder', disabled: !sessionWorkingDirectory(session), immediate: () => copy(sessionWorkingDirectory(session), '工作目录已复制'), onPress: onClose },
    ...(canManage ? [{ label: '管理会话', icon: 'settings' as const, onPress: () => setManagement(true) }] : []),
  ];
  return <>
    <Modal visible={visible && !management} transparent animationType="none" onRequestClose={dismiss}>
      <View style={styles.overlay} accessibilityViewIsModal>
        <Pressable testID="session-quick-actions-backdrop" accessibilityRole="button" accessibilityLabel="关闭会话操作" onPress={dismiss} style={StyleSheet.absoluteFill}/>
        <Animated.View testID="session-quick-actions" accessibilityLabel="会话操作" pointerEvents={motion.closing ? 'none' : 'auto'}
          style={[styles.panel, { backgroundColor: dk.surface, borderColor: dk.line }, motion.style]}>
          <Text style={[styles.title, { color: dk.muted }]} numberOfLines={1}>{session.title?.trim() || '无标题对话'}</Text>
          <ScrollView bounces={false} keyboardShouldPersistTaps="always" style={styles.scroll}>
            {actions.map(action => <MotionPressable key={action.label} scaleTo={reduced ? 1 : .985} accessibilityRole="button" accessibilityLabel={action.label}
              accessibilityState={{ disabled: Boolean(action.disabled || motion.closing) }} disabled={action.disabled || motion.closing}
              onPress={() => { if (active() && !action.disabled) { owner.current.retired = true; action.immediate?.(); motion.close(() => { if (current()) action.onPress(); }); } }}
              style={({ pressed }) => [styles.action, pressed && { backgroundColor: dk.surface2 }, action.disabled && styles.disabled]}>
              <Icon name={action.icon} size={16} color={dk.text2} strokeWidth={1.6}/>
              <Text style={[styles.label, { color: dk.text }]} numberOfLines={1}>{action.label}</Text>
            </MotionPressable>)}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
    {visible && management ? <SessionActionsSheet visible deviceId={deviceId} sessionKey={session.sessionKey} onClose={closeManagement} onFork={openFork} onArchive={archive} onComplete={closeManagement} /> : null}
  </>;
}

const styles = StyleSheet.create({
  overlay: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  panel: { width: 232, maxWidth: '100%', maxHeight: '80%', padding: 5, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000', shadowOpacity: .1, shadowRadius: 18, shadowOffset: { width: 0, height: 5 }, elevation: 12 },
  title: { fontFamily: conversationFontFamily, fontSize: 11, lineHeight: 17, paddingHorizontal: 9, paddingTop: 5, paddingBottom: 7 },
  scroll: { minHeight: 0, flexShrink: 1 },
  action: { minHeight: 38, flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 9, borderRadius: 8 },
  label: { flex: 1, fontFamily: conversationFontFamily, fontSize: 13, lineHeight: 19 },
  disabled: { opacity: .4 },
});
