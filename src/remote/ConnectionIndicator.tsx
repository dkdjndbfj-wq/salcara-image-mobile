import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppDialog, showToast } from '../components/ui';
import { colors, desk, themed, useDesk } from '../theme';
import type { DeviceStatus } from './client';
import { remoteConnectionState, remoteDeviceConnected } from './connection-state';
import { refreshDevices, type RemoteState } from './store';

/** One status light in the header; tap for the reason. */
export function ConnectionIndicator({ remote, device }: { remote: RemoteState; device?: DeviceStatus }) {
  const dk = useDesk();
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const state = remoteConnectionState(remote, device);
  const color = state.tone === 'connected' ? dk.ok : state.tone === 'error' ? dk.bad
    : state.tone === 'pending' ? dk.warn : dk.faint;
  const connected = remoteDeviceConnected(remote, device);
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel={`连接状态：${state.label}，点击查看详情`} onPress={() => setOpen(true)} style={styles.button} hitSlop={6}>
      <View style={[styles.halo, { backgroundColor: `${color}22` }]}><View style={[styles.dot, { backgroundColor: color }]} /></View>
    </Pressable>
    <AppDialog visible={open} title={state.label} message={state.detail} icon="laptop" onClose={() => setOpen(false)} actions={[
      { label: '关闭', tone: 'secondary', onPress: () => setOpen(false) },
      ...(!connected ? [{ label: '重新检查', tone: 'primary' as const, disabled: Boolean(remote.signingIn), onPress: () => {
        setOpen(false);
        void refreshDevices().catch((error: Error) => showToast(error.message, 'alert'));
      } }] : []),
    ]} />
  </>;
}

const useStyles = themed((c, d) => StyleSheet.create({
  button: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  halo: { width: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4 },
}));
