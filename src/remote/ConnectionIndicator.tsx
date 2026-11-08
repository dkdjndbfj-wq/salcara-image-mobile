import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { themed, useDesk } from '../theme';
import type { DeviceStatus } from './client';
import { remoteConnectionState } from './connection-state';
import type { RemoteState } from './store';
import { RemoteConnectionDiagnostics } from './RemoteConnectionDiagnostics';

/** One status light in the header; tap for the reason. */
export function ConnectionIndicator({ remote, device, onPress }: { remote: RemoteState; device?: DeviceStatus; onPress?: () => void }) {
  const dk = useDesk();
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const state = remoteConnectionState(remote, device);
  const color = state.tone === 'connected' ? dk.ok : state.tone === 'error' ? dk.bad
    : state.tone === 'pending' ? dk.warn : dk.faint;
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel={`连接状态：${state.label}，点击查看详情`} onPress={onPress ?? (() => setOpen(true))} style={styles.button} hitSlop={6}>
      <View style={[styles.halo, { backgroundColor: `${color}22` }]}><View style={[styles.dot, { backgroundColor: color }]} /></View>
    </Pressable>
    {!onPress && open ? <RemoteConnectionDiagnostics visible remote={remote} device={device} onClose={() => setOpen(false)} /> : null}
  </>;
}

const useStyles = themed((c, d) => StyleSheet.create({
  button: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  halo: { width: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4 },
}));
