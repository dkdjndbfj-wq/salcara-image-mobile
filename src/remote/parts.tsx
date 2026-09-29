import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon, type IconName } from '../components/Icon';
import { MotionPressable, useReducedMotion } from '../components/ui';
import { colors, radius } from '../theme';
import type { SessionInfo, SessionStatus } from './client';

export const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

export const CLAUDE = '#D97757';
export const CODEX_BG = '#0E1512';
export const CODEX_FG = '#3DDC97';

export function folderName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

export function relTime(ms: number, now = Date.now()): string {
  const diff = Math.max(0, now - ms);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  if (ms >= start.getTime()) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (ms >= start.getTime() - 86_400_000) return '昨天';
  const date = new Date(ms);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export const toolName = (tool: string) => tool === 'codex' ? 'Codex' : tool === 'claude' ? 'Claude Code' : tool;

/** Codex: black with green prompt. Claude Code: solid orange. Claude Desktop: orange outline. */
export function ToolBadge({ tool, client, size = 36 }: { tool: string; client?: string; size?: number }) {
  const desktop = tool === 'claude' && /desktop/i.test(client ?? '');
  const round = { width: size, height: size, borderRadius: size * 0.3 };
  if (tool === 'codex') {
    return <View style={[styles.badge, round, { backgroundColor: CODEX_BG }]}>
      <Text style={{ color: CODEX_FG, fontFamily: mono, fontWeight: '700', fontSize: size * 0.36, letterSpacing: -0.5 }}>{'>_'}</Text>
    </View>;
  }
  return <View style={[styles.badge, round, desktop ? { backgroundColor: '#FFF6F2', borderWidth: 1.5, borderColor: CLAUDE } : { backgroundColor: CLAUDE }]}>
    <Icon name="sparkle" size={size * 0.52} color={desktop ? CLAUDE : '#FFFFFF'} />
  </View>;
}

export function clientLabel(session: Pick<SessionInfo, 'tool' | 'client'>): string {
  return session.client || toolName(session.tool);
}

const STATUS: Record<SessionStatus, { label: string; fg: string; bg: string }> = {
  running: { label: '运行中', fg: colors.primaryDeep, bg: colors.primarySoft },
  waiting_approval: { label: '等待批准', fg: colors.warningText, bg: colors.warningSurface },
  idle: { label: '空闲', fg: colors.subtle, bg: colors.surfaceStrong },
  failed: { label: '失败', fg: colors.danger, bg: colors.dangerSurface },
};

export function StatusPill({ status }: { status: SessionStatus }) {
  const look = STATUS[status] ?? STATUS.idle;
  return <View style={[styles.pill, { backgroundColor: look.bg }]}>
    {status === 'running' ? <PulseDot color={look.fg} /> : status === 'waiting_approval' ? <View style={[styles.dot, { backgroundColor: look.fg }]} /> : null}
    <Text style={[styles.pillText, { color: look.fg }]}>{look.label}</Text>
  </View>;
}

export function PulseDot({ color = colors.primary, size = 7 }: { color?: string; size?: number }) {
  const reduced = useReducedMotion();
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (reduced) return undefined;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 0.3, duration: 650, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 1, duration: 650, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [pulse, reduced]);
  return <Animated.View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity: pulse }} />;
}

export function OnlineDot({ online }: { online: boolean }) {
  return <View style={[styles.online, { backgroundColor: online ? colors.success : colors.faint }]} />;
}

export function osIcon(os: string): IconName {
  return os === 'windows' ? 'windows' : os === 'darwin' ? 'apple' : 'terminal';
}
export const osName = (os: string) => os === 'windows' ? 'Windows' : os === 'darwin' ? 'macOS' : os === 'linux' ? 'Linux' : os;

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: string; disabled?: boolean }>; onChange: (value: T) => void }) {
  return <View style={styles.segmented}>
    {options.map((option) => {
      const selected = option.value === value;
      return <MotionPressable key={option.value} wrapperStyle={{ flex: 1 }} scaleTo={0.96} disabled={option.disabled} accessibilityRole="button" accessibilityState={{ selected, disabled: option.disabled }}
        onPress={() => onChange(option.value)} style={[styles.segment, selected && styles.segmentOn, option.disabled && { opacity: 0.4 }]}>
        <Text style={[styles.segmentText, selected && styles.segmentTextOn]} numberOfLines={1}>{option.label}</Text>
      </MotionPressable>;
    })}
  </View>;
}

/** Unified diff with +/- colouring; long diffs fold to a fixed height. */
export function DiffView({ diff, maxHeight = 220 }: { diff: string; maxHeight?: number }) {
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState(0);
  const lines = diff.replace(/\n$/, '').split('\n');
  const stats = lines.reduce((acc, line) => {
    if (line.startsWith('+') && !line.startsWith('+++')) acc.add += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) acc.del += 1;
    return acc;
  }, { add: 0, del: 0 });
  const folded = !open && height > maxHeight;
  const files = lines.filter((line) => line.startsWith('+++ ')).length;
  return <View style={styles.diff}>
    <View style={styles.diffHead}>
      <Text style={[styles.diffStat, { color: colors.success }]}>+{stats.add}</Text>
      <Text style={[styles.diffStat, { color: colors.danger }]}>−{stats.del}</Text>
    </View>
    <View style={[{ overflow: 'hidden' }, !open && { maxHeight }]}>
      <View onLayout={(event: { nativeEvent: { layout: { height: number } } }) => setHeight(event.nativeEvent.layout.height)}>
        {lines.map((line, index) => {
          // File headers collapse into one path label; git's own metadata lines are noise on a phone.
          if (/^(diff --git|index |--- |new file mode|deleted file mode|similarity |rename )/.test(line)) return null;
          if (line.startsWith('+++ ')) return files > 1 ? <Text key={index} style={styles.diffFile} numberOfLines={1}>{line.slice(4).replace(/^b\//, '')}</Text> : null;
          const hunk = line.startsWith('@@');
          return <Text key={index} selectable style={[styles.diffLine, line.startsWith('+') && styles.diffAdd, line.startsWith('-') && styles.diffDel, hunk && styles.diffHunk]}>{line || ' '}</Text>;
        })}
      </View>
    </View>
    {(folded || open) && height > maxHeight ? <Pressable accessibilityRole="button" onPress={() => setOpen((value) => !value)} style={styles.diffMore}>
      <Text style={styles.diffMoreText}>{open ? '收起' : '展开全部'}</Text>
      {!open && <Icon name="chevronDown" size={14} color={colors.primaryDeep} />}
    </Pressable> : null}
  </View>;
}

export function EmptyState({ icon, title, detail, children }: { icon: IconName; title: string; detail?: string; children?: React.ReactNode }) {
  return <View style={styles.empty}>
    <View style={styles.emptyIcon}><Icon name={icon} size={26} color={colors.primary} /></View>
    <Text style={styles.emptyTitle}>{title}</Text>
    {detail ? <Text style={styles.emptyDetail}>{detail}</Text> : null}
    {children}
  </View>;
}

const styles = StyleSheet.create({
  badge: { alignItems: 'center', justifyContent: 'center' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 22, paddingHorizontal: 8, borderRadius: radius.pill },
  pillText: { fontSize: 11.5, fontWeight: '600' },
  dot: { width: 6, height: 6, borderRadius: 3 },
  online: { width: 8, height: 8, borderRadius: 4 },
  segmented: { flexDirection: 'row', padding: 3, borderRadius: radius.pill, backgroundColor: colors.surfaceStrong },
  segment: { height: 34, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 },
  segmentOn: { backgroundColor: colors.card, shadowColor: '#1B2150', shadowOpacity: 0.08, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 1 },
  segmentText: { color: colors.textMuted, fontSize: 13.5, fontWeight: '500' },
  segmentTextOn: { color: colors.text, fontWeight: '600' },
  diff: { borderRadius: 12, overflow: 'hidden', backgroundColor: '#FAFBFE', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  diffHead: { flexDirection: 'row', gap: 10, paddingHorizontal: 10, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  diffStat: { fontFamily: mono, fontSize: 12, fontWeight: '600' },
  diffLine: { fontFamily: mono, fontSize: 11.5, lineHeight: 17, color: colors.textSecondary, paddingHorizontal: 10 },
  diffAdd: { backgroundColor: '#E8F8EE', color: '#0B6B35' },
  diffDel: { backgroundColor: '#FDECEE', color: '#B42318' },
  diffHunk: { color: colors.primaryDeep, backgroundColor: colors.primarySoft },
  diffFile: { fontFamily: mono, fontSize: 11.5, fontWeight: '600', color: colors.text, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: colors.surfaceStrong },
  diffMore: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, height: 36, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.card },
  diffMoreText: { color: colors.primaryDeep, fontSize: 13, fontWeight: '600' },
  empty: { alignItems: 'center', paddingVertical: 48, paddingHorizontal: 28, gap: 8 },
  emptyIcon: { width: 56, height: 56, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft, marginBottom: 6 },
  emptyTitle: { color: colors.text, fontSize: 16.5, fontWeight: '600', textAlign: 'center' },
  emptyDetail: { color: colors.subtle, fontSize: 13.5, lineHeight: 20, textAlign: 'center' },
});
