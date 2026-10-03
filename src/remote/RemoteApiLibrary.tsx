import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/ui';
import { colors, desk, themed, useDesk } from '../theme';
import { remoteDeviceConnected } from './connection-state';
import { openPromo, PROMO, usesOfficialRelay } from '../promo';
import { loadAgentProfiles, useRemote } from './store';
import { ProgrammingCard, ProgrammingRow, ProgrammingSheet, useProgrammingStyles } from './ProgrammingUi';

/** The programming API directory is the computer's vault metadata, never a phone key store. */
export function RemoteApiLibrary({ visible, onClose, deviceId }: {
  visible: boolean; onClose: () => void; deviceId?: string | null;
}) {
  const p = useProgrammingStyles();
  const dk = useDesk();
  const styles = useStyles();
  const remote = useRemote();
  const computer = deviceId ? remote.agents[deviceId] : undefined;
  const device = remote.devices.find((item) => item.deviceId === deviceId);
  const online = remoteDeviceConnected(remote, device);
  const scope = JSON.stringify([remote.connectionId, remote.selectedHubUrl, remote.serviceId]);
  const offlineText = remote.connection === 'open' && !remote.connectionError ? '电脑当前离线' : '当前未连接';
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(0);
  const request = useRef<object | null>(null);
  const generation = useRef({ visible, deviceId, scope });
  if (generation.current.visible !== visible || generation.current.deviceId !== deviceId || generation.current.scope !== scope) generation.current = { visible, deviceId, scope };
  const rendered = generation.current;
  const current = useRef({ visible, deviceId, scope, online, loading: computer?.loading }); current.current = { visible, deviceId, scope, online, loading: computer?.loading };
  useEffect(() => () => { current.current.visible = false; generation.current = { ...generation.current, visible: false }; }, []);

  const refresh = async () => {
    if (generation.current !== rendered || !current.current.visible || !deviceId || current.current.deviceId !== deviceId || current.current.scope !== scope || !current.current.online || current.current.loading || request.current) return;
    const owned = revision.current;
    const token = {};
    request.current = token;
    setReading(true); setError(null);
    const stillHere = () => generation.current === rendered && current.current.visible && current.current.deviceId === deviceId && current.current.scope === scope && revision.current === owned;
    try { await loadAgentProfiles(deviceId); } catch {
      if (stillHere()) setError('暂时无法读取，请重试');
    } finally {
      if (request.current === token) request.current = null;
      if (stillHere()) setReading(false);
    }
  };

  useEffect(() => {
    revision.current += 1;
    request.current = null; setReading(false); setError(null);
    // One demand read per open/switch. Cached catalogues need no repeated request.
    if (visible && online && !computer?.loaded && !computer?.loading && !computer?.error) void refresh();
    return () => { revision.current += 1; request.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, deviceId, scope]);

  const loading = reading || computer?.loading === true;
  const failed = Boolean(error || computer?.error);
  const emptyText = !deviceId ? '绑定电脑后查看 API'
    : loading ? '正在读取…'
    : failed ? error ?? '暂时无法读取，请重试'
    : !online ? offlineText
    : computer?.loaded ? '在电脑端添加 API'
    : '刷新读取 API';

  const close = () => { current.current.visible = false; generation.current = { ...generation.current, visible: false }; onClose(); };
  return <ProgrammingSheet visible={visible} title="API 密钥" subtitle={device?.name ? `${device.name} · 电脑密钥库` : undefined} onClose={close}
    headerRight={deviceId ? <IconButton icon="regenerate" label="刷新 API" size={36}
      disabled={!online || loading} onPress={() => void refresh()} /> : undefined}>
    {computer?.apis.length ? <ProgrammingCard>{computer.apis.map((api, index) => {
      // Display-only: which Agent cards currently name this API. Never a credential.
      const users = (computer.list ?? []).filter(agent => agent.api.source !== 'tool' && agent.api.name === api.name).map(agent => agent.name);
      return <ProgrammingRow key={api.id} first={index === 0} icon="key" title={api.name}
        detail={[api.models.length ? `${api.models.length} 个模型` : '', users.length ? `${users.join('、')} 正在使用` : ''].filter(Boolean).join(' · ') || '电脑密钥库'} />;
    })}</ProgrammingCard> : <ProgrammingCard soft><View style={styles.empty}>
      {loading ? <ActivityIndicator size="small" color={dk.muted} /> : <Icon name={deviceId ? 'key' : 'laptop'} size={22} color={dk.faint} />}
      <Text accessibilityRole={failed ? 'alert' : undefined} style={styles.emptyText}>{emptyText}</Text>
    </View></ProgrammingCard>}
    {computer?.apis.length && loading ? <View style={styles.refreshing}><ActivityIndicator size="small" color={dk.muted} /></View> : null}
    {computer?.apis.length && !failed && online ? <Text style={p.note}>密钥保存在电脑上，手机只读取名称。新增或修改请在电脑端进行。</Text> : null}
    {computer?.apis.length && failed ? <Text accessibilityRole="alert" style={p.error}>{error ?? '暂时无法读取，请重试'}</Text>
      : computer?.apis.length && !online ? <Text style={p.note}>{offlineText}</Text> : null}
    {PROMO.enabled && deviceId && !usesOfficialRelay((computer?.apis ?? []).map(api => api.name)) ? <Pressable accessibilityRole="link" accessibilityLabel={`获取 API：${PROMO.name}`} onPress={() => void openPromo('remote-api')} style={styles.promo}>
      <Text style={styles.promoText}>{computer?.apis.length ? '想要更稳定的 API？' : '还没有 API？'}<Text style={styles.promoLink}>到 {PROMO.host} 获取 ›</Text></Text>
    </Pressable> : null}
  </ProgrammingSheet>;
}

const useStyles = themed((c, d) => StyleSheet.create({
  empty: { minHeight: 150, alignItems: 'center', justifyContent: 'center', gap: 12 },
  emptyText: { fontSize: 12.5, color: d.muted },
  refreshing: { paddingTop: 18, alignItems: 'center' },
  promo: { marginTop: 18, minHeight: 32, justifyContent: 'center' }, promoText: { fontSize: 11.5, color: d.muted }, promoLink: { color: d.accentText, fontWeight: '500' },
}));
