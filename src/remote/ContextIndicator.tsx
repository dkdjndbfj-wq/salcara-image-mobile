import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { Icon } from '../components/Icon';
import { useDesk } from '../theme';
import { ComposerPopover } from './ComposerPopover';
import { contextStateLabel, type SessionContext } from './session-context';

export interface ContextIndicatorProps {
  scopeKey: string;
  active?: boolean;
  value?: SessionContext;
  loading?: boolean;
  submitting?: boolean;
  error?: string;
  unavailableReason?: string;
  canCompact?: boolean;
  compactDisabled?: boolean;
  refreshDisabled?: boolean;
  onRefresh?: () => void;
  onCompact?: () => void;
}

/** An unknown capacity stays an empty ring, never an invented percentage. */
export function ContextIndicator(props: ContextIndicatorProps) {
  const { scopeKey, active = true, value, loading = false, submitting = false, error, unavailableReason,
    canCompact = false, compactDisabled = false, refreshDisabled = false, onRefresh, onCompact } = props;
  const dk = useDesk(), anchor = useRef<View>(null);
  const owner = useRef({ scopeKey, active });
  if (owner.current.scopeKey !== scopeKey || owner.current.active !== active) owner.current = { scopeKey, active };
  const renderedOwner = owner.current;
  type Opened = { owner: typeof renderedOwner };
  const [open, setOpen] = useState<Opened>();
  const opened = useRef<Opened | undefined>(undefined), mounted = useRef(true);
  const latest = useRef(props); latest.current = props;
  const canInteract = () => active && mounted.current && owner.current === renderedOwner && AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
  const close = () => { opened.current = undefined; setOpen(undefined); };
  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', state => { if (state !== 'active') close(); });
    return () => { mounted.current = false; opened.current = undefined; subscription.remove(); };
  }, []);
  const visible = Boolean(active && open && open.owner === renderedOwner);
  const menuCurrent = () => canInteract() && visible && opened.current === open;
  const snapshot = value?.snapshot;
  const used = snapshot && Number.isFinite(snapshot.usedTokens) && snapshot.usedTokens >= 0 ? snapshot.usedTokens : undefined;
  const capacity = snapshot?.windowTokens && Number.isFinite(snapshot.windowTokens) && snapshot.windowTokens > 0 ? snapshot.windowTokens : undefined;
  const fraction = used !== undefined && capacity !== undefined ? used / capacity : undefined;
  const percentage = fraction === undefined ? undefined : Math.round(fraction * 100);
  const progress = fraction === undefined ? 0 : Math.min(1, Math.max(0, fraction));
  const circumference = 2 * Math.PI * 7.25;
  const estimated = Boolean(snapshot?.estimated);
  const usage = percentage === undefined ? '用量未知' : `${estimated ? '约 ' : ''}${percentage}% 已用`;
  const caption = submitting ? '正在提交' : contextStateLabel(value);
  const detail = used === undefined ? unavailableReason || value?.unavailableReason || '尚无上下文用量'
    : `${used.toLocaleString()}${capacity ? ` / ${capacity.toLocaleString()}` : ''} tokens`;
  const warning = Boolean(error || value?.compaction?.state === 'failed' || value?.compaction?.state === 'unconfirmed');
  const ringColor = warning || fraction !== undefined && fraction >= .9 ? dk.warn : dk.muted;
  const busy = loading || submitting || value?.compaction?.state === 'running';
  return <View testID="remote-context-indicator" style={styles.root}>
    <Pressable ref={anchor} collapsable={false} testID="context-indicator-button" accessibilityRole="button"
      accessibilityLabel={`上下文状态，${usage}${caption ? `，${caption}` : ''}`} accessibilityHint="查看上下文用量"
      accessibilityState={{ expanded: visible, busy, disabled: !active }} disabled={!active}
      onPress={() => { if (!canInteract()) return; const token = { owner: renderedOwner }; opened.current = token; setOpen(token); }}
      style={({ pressed }) => [styles.trigger, pressed && { backgroundColor: dk.surface2 }]}>
      <Svg width={18} height={18} viewBox="0 0 18 18" {...(Platform.OS === 'web' ? { 'aria-hidden': true as const } : { accessible: false })}>
        <Circle cx={9} cy={9} r={7.25} fill="none" stroke={dk.line} strokeWidth={2.5} />
        {progress > 0 ? <Circle testID="context-usage-arc" cx={9} cy={9} r={7.25} fill="none" stroke={ringColor} strokeWidth={2.5}
          strokeDasharray={`${circumference} ${circumference}`} strokeDashoffset={circumference * (1 - progress)}
          strokeLinecap="round" transform="rotate(-90 9 9)" /> : null}
      </Svg>
    </Pressable>
    <ComposerPopover visible={visible} anchorRef={anchor} anchorRevision={scopeKey} onClose={() => { if (menuCurrent()) close(); }}
      width={240} align="end" testID="context-usage-popover" accessibilityLabel="上下文详情">
      <View style={styles.details}>
        <View style={styles.heading}><Text style={[styles.title, { color: dk.text }]}>上下文</Text>
          <Text testID="context-usage-percent" style={[styles.percent, { color: ringColor }]}>{percentage === undefined ? '—' : `${estimated ? '≈ ' : ''}${percentage}%`}</Text></View>
        <Text style={[styles.detail, { color: dk.muted }]}>{detail}</Text>
        {used !== undefined && capacity === undefined ? <Text style={[styles.detail, { color: dk.muted }]}>窗口大小未知</Text> : null}
        {busy || caption ? <View style={styles.status} accessibilityLiveRegion="polite">
          {busy ? <ActivityIndicator size={12} color={dk.muted} /> : null}
          <Text style={[styles.detail, { color: warning ? dk.warn : dk.muted }]}>{caption || '正在读取…'}</Text>
        </View> : null}
        {error ? <Text accessibilityRole="alert" style={[styles.detail, { color: dk.bad }]}>{error}</Text> : null}
      </View>
      {onRefresh || canCompact && onCompact ? <View style={[styles.actions, { borderTopColor: dk.line }]}>
        {onRefresh ? <Pressable accessibilityRole="button" accessibilityLabel="刷新上下文" accessibilityState={{ disabled: refreshDisabled || loading }}
          disabled={refreshDisabled || loading} style={[styles.action, (refreshDisabled || loading) && styles.disabled]}
          onPress={() => { if (menuCurrent() && !latest.current.refreshDisabled && !latest.current.loading) latest.current.onRefresh?.(); }}>
          <Icon name="regenerate" size={14} color={dk.muted} /><Text style={[styles.actionText, { color: dk.text2 }]}>刷新</Text>
        </Pressable> : null}
        {canCompact && onCompact ? <Pressable accessibilityRole="button" accessibilityLabel="压缩上下文" accessibilityState={{ disabled: compactDisabled }}
          disabled={compactDisabled} style={[styles.action, compactDisabled && styles.disabled]}
          onPress={() => { if (menuCurrent() && latest.current.canCompact && !latest.current.compactDisabled) latest.current.onCompact?.(); }}>
          <Text style={[styles.actionText, { color: dk.text2 }]}>压缩上下文</Text>
        </Pressable> : null}
      </View> : null}
    </ComposerPopover>
  </View>;
}

const styles = StyleSheet.create({
  root: { width: 44, height: 44, flexShrink: 0 },
  trigger: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  details: { paddingHorizontal: 12, paddingVertical: 10, gap: 6 },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  title: { fontSize: 13, lineHeight: 20, fontWeight: '600' }, percent: { fontSize: 13, lineHeight: 20, fontWeight: '500' },
  detail: { fontSize: 12, lineHeight: 18 }, status: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  actions: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 4, flexDirection: 'row', alignItems: 'center', gap: 4 },
  action: { minHeight: 44, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 6, justifyContent: 'center', flex: 1 },
  actionText: { fontSize: 12, lineHeight: 18 }, disabled: { opacity: .4 },
});
