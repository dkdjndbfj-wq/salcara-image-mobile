import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from '../components/Icon';
import { themed, useDesk } from '../theme';
import { syncRemoteConnections, type RemoteState } from './store';

/** Partial station failure never hides a successfully paired computer. */
export function RemoteConnectionSyncNotice({ remote, deviceId }: { remote: RemoteState; deviceId?: string | null }) {
  const dk = useDesk();
  const styles = useStyles();
  const sync = remote.connectionSync;
  if (!sync || sync.connectionId !== remote.connectionId) return null;
  const current = remote.connections.find(item => item.id === remote.connectionId);
  if (current?.deviceId !== deviceId) return null;
  if (!sync.loading && !sync.error && !sync.failed.length) return null;
  const online = remote.connection === 'open' && !remote.connectionError && remote.devices.some(item => item.deviceId === deviceId && item.online);
  return <View style={styles.notice} accessibilityLiveRegion="polite">
    {sync.loading ? <ActivityIndicator size="small" color={dk.muted} /> : <Icon name="link" size={17} color={dk.muted} />}
    <Text style={styles.text}>{sync.loading ? '正在同步电脑上的连接…' : sync.failed.length
      ? `${sync.failed.length} 个连接暂未同步，已绑定的电脑仍可使用` : '连接同步未完成，已保留当前绑定'}</Text>
    {!sync.loading ? <Pressable accessibilityRole="button" accessibilityLabel="重试同步电脑连接" disabled={!online}
      style={[styles.retry, !online && styles.disabled]} onPress={() => void syncRemoteConnections(true)}>
      <Text style={styles.retryText}>重试</Text></Pressable> : null}
  </View>;
}

const useStyles = themed((c, d) => StyleSheet.create({
  notice: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, marginBottom: 12 },
  text: { flex: 1, minWidth: 0, color: d.muted, fontSize: 12, lineHeight: 18 },
  retry: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 9, backgroundColor: d.surface2 },
  retryText: { color: d.text2, fontSize: 12, fontWeight: '600' },
  disabled: { opacity: 0.4 },
}));
