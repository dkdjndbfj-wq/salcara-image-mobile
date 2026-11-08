import React, { type RefObject } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from '../components/Icon';
import { themed, useDesk } from '../theme';
import type { AgentProfile } from './client';
import { AgentBrand } from './AgentBrand';

/** Presentational only: the configuration page owns switching and verification. */
export function AgentApiCard({ agent, size, status, shared, unconfirmed, disabled, syncing, switching, expanded, anchorRef, onAnchorLayout, onChoose }: {
  agent: AgentProfile; size: number; status: string; shared: string[]; unconfirmed: boolean;
  disabled: boolean; syncing: boolean; switching: boolean; expanded: boolean;
  anchorRef?: RefObject<View | null>; onAnchorLayout?: () => void; onChoose: () => void;
}) {
  const styles = useStyles(), d = useDesk();
  const apiName = agent.api.name.trim() || '选择 API';
  return <View testID={`agent-api-card-${agent.id}`} style={[styles.card, { width: size, height: size }, expanded && styles.cardOpen]}>
    <Pressable accessibilityRole="button" accessibilityLabel={`更换 ${agent.name} 的 API`}
      accessibilityHint={[apiName, status, shared.length ? `与 ${shared.join('、')} 共用 API` : ''].filter(Boolean).join('，')}
      accessibilityState={{ disabled, expanded, busy: switching || syncing }} disabled={disabled} onPress={onChoose}
      style={({ pressed }) => [styles.selector, pressed && styles.pressed, disabled && styles.disabled]}>
      <View style={styles.identity}>
        <AgentBrand tool={agent.id} client={agent.name} size={32} />
        <Text style={styles.name} numberOfLines={2}>{agent.name}</Text>
      </View>
      <View style={styles.apiSection}>
        <View ref={anchorRef} onLayout={onAnchorLayout} testID={`agent-api-selector-${agent.id}`} style={[styles.apiField, expanded && styles.apiFieldOpen]}>
          <Text style={styles.apiName} numberOfLines={1}>{apiName}</Text>
          {switching ? <ActivityIndicator size="small" color={d.muted} /> : <Icon name="chevronDown" size={12} color={d.muted} strokeWidth={1.6} />}
        </View>
        {status ? <View style={styles.statusRow} accessibilityLiveRegion="polite">
          <View style={[styles.statusDot, { backgroundColor: unconfirmed ? d.warn : status === '已生效' ? d.ok : d.faint }]} />
          <Text style={[styles.status, unconfirmed && styles.attention]} numberOfLines={1}>{status}</Text>
        </View> : null}
      </View>
    </Pressable>
  </View>;
}

const useStyles = themed((_c, d) => StyleSheet.create({
  card: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: d.line, backgroundColor: d.surface, overflow: 'hidden' },
  cardOpen: { borderColor: d.faint },
  name: { alignSelf: 'stretch', fontSize: 13, lineHeight: 18, fontWeight: '600', textAlign: 'center', color: d.text },
  statusRow: { alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  statusDot: { width: 4, height: 4, borderRadius: 2, flexShrink: 0 },
  status: { flexShrink: 1, color: d.muted, fontSize: 10, lineHeight: 14, textAlign: 'center' },
  attention: { color: d.warn },
  selector: { flex: 1, minHeight: 44, alignItems: 'center', paddingHorizontal: 8, paddingTop: 8 },
  identity: { flex: 1, flexBasis: 0, flexShrink: 0, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'flex-end', gap: 4 },
  apiSection: { flex: 1, flexBasis: 0, flexShrink: 0, alignSelf: 'stretch', justifyContent: 'center', gap: 4, paddingVertical: 4 },
  apiField: { alignSelf: 'stretch', minHeight: 26, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, paddingVertical: 3, borderWidth: StyleSheet.hairlineWidth, borderColor: d.line, borderRadius: 7, backgroundColor: d.surface2 },
  apiFieldOpen: { borderColor: d.faint },
  pressed: { backgroundColor: d.surface2 }, disabled: { opacity: 0.45 },
  apiName: { flex: 1, minWidth: 0, color: d.text2, fontSize: 11, lineHeight: 16 },
}));
