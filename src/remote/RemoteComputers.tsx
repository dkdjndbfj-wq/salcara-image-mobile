import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Icon } from '../components/Icon';
import { showToast } from '../components/ui';
import { colors, desk, themed, useDesk } from '../theme';
import { remoteDeviceConnected } from './connection-state';
import { useSavedConnection, type RemoteState } from './store';
import { ProgrammingAction, ProgrammingCard, ProgrammingHeading, ProgrammingRow, ProgrammingStatus, useProgrammingStyles } from './ProgrammingUi';

/** Saved pairings stay visible even when a new pairing was cancelled or a computer is offline. */
export function RemoteComputers({ remote, onSelected, onBind }: { remote: RemoteState; onSelected: (deviceId: string) => void; onBind: () => void }) {
  const p = useProgrammingStyles();
  const dk = useDesk();
  const styles = useStyles();
  const [busy, setBusy] = useState<string | null>(null);
  const alive = useRef(true); const gate = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const select = async (id: string, deviceId: string) => {
    if (gate.current) return;
    const currentDevice = remote.devices.find(item => item.deviceId === deviceId);
    if (id === remote.connectionId && remote.phase === 'ready' && remoteDeviceConnected(remote, currentDevice)) { onSelected(deviceId); return; }
    gate.current = true; setBusy(id);
    try { await useSavedConnection(id); if (alive.current) onSelected(deviceId); }
    catch (error) { if (alive.current) showToast((error as Error).message, 'alert'); }
    finally { gate.current = false; if (alive.current) setBusy(null); }
  };
  return <ScrollView contentContainerStyle={p.page} showsVerticalScrollIndicator={false}>
    <ProgrammingHeading title="我的电脑" subtitle="选择一台电脑，继续上面的工作" />
    {remote.connections.length ? <ProgrammingCard>{remote.connections.map((item, index) => {
      const current = item.id === remote.connectionId;
      const device = current ? remote.devices.find(value => value.deviceId === item.deviceId) : undefined;
      let host = ''; try { host = new URL(item.hubUrl).host; } catch { /* ignore invalid legacy metadata */ }
      const online = Boolean(current && remoteDeviceConnected(remote, device));
      return <ProgrammingRow key={item.id} first={index === 0} accessibilityLabel={`选择电脑 ${item.deviceName}`} disabled={Boolean(busy)} onPress={() => void select(item.id, item.deviceId)}
        leading={<View style={[p.glyph, current && styles.glyphCurrent]}><Icon name="laptop" size={19} color={current ? dk.onInk : dk.text2} /></View>}
        title={item.deviceName}
        detail={<ProgrammingStatus tone={online ? 'online' : current && device?.online ? 'pending' : 'offline'} text={`${current ? online ? '当前 · 在线' : '当前 · 未连接' : '已配对'}${host ? ` · ${host}` : ''}`} />}
        trailing={busy === item.id ? <ActivityIndicator size="small" color={dk.muted} /> : current ? 'check' : 'chevron'} />;
    })}</ProgrammingCard> : <ProgrammingCard soft><View style={styles.empty}><View style={p.glyph}><Icon name="laptop" size={20} color={dk.text2} /></View>
      <Text style={p.name}>还没有绑定电脑</Text><Text style={[p.detail, { textAlign: 'center' }]}>在电脑上安装 Salcara 电脑端，然后在这里扫码绑定</Text></View></ProgrammingCard>}
    <ProgrammingAction label="绑定新电脑" icon="plus" tone={remote.connections.length ? 'secondary' : 'primary'} disabled={Boolean(busy) || Boolean(remote.signingIn)} onPress={onBind} style={{ marginTop: 16 }} />
    <Text style={p.note}>每台电脑独立配对；切换不会解除其它电脑的绑定。</Text>
  </ScrollView>;
}
const useStyles = themed((c, d) => StyleSheet.create({ glyphCurrent: { backgroundColor: d.ink }, empty: { paddingVertical: 28, paddingHorizontal: 24, alignItems: 'center', gap: 10 } }));
