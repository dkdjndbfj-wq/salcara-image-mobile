import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { showToast } from '../components/ui';
import { themed, useDesk } from '../theme';
import { botConnectionId, saveBotConnections, type RemoteConnection } from './connections';
import { bindBotPhone, botBindingEndpoint, confirmPairingHubIdentity, parseBotBindingPackage } from './client';
import { connectionSelection, type ComputerSelection } from './computer-connections';
import { phoneIdentity } from './phone-identity';
import { getRemoteState, reloadSavedConnections, remoteConnectionRevision, useSavedConnection, type RemoteState } from './store';
import { ProgrammingAction, ProgrammingCard, ProgrammingRow, useProgrammingStyles } from './ProgrammingUi';

export function RemoteBotBinding({ remote, onBound }: { remote: RemoteState; onBound: (selection: ComputerSelection) => void }) {
  const p = useProgrammingStyles();
  const dk = useDesk();
  const styles = useStyles();
  const [expanded, setExpanded] = useState(false);
  const [bindingText, setBindingText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gate = useRef(false);
  const mounted = useRef(true);
  const botGroups = useMemo(() => new Set(remote.connections.filter(item => item.botGroupId).map(item => JSON.stringify([item.hubUrl, item.botGroupId]))).size, [remote.connections]);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const importBot = async () => {
    if (gate.current || !bindingText.trim()) return;
    gate.current = true;
    setBusy(true);
    setError(null);
    const revision = remoteConnectionRevision();
    try {
      const binding = parseBotBindingPackage(bindingText);
      const result = await bindBotPhone(binding, await phoneIdentity());
      const hubUrl = botBindingEndpoint(binding);
      const profiles: RemoteConnection[] = result.devices.map(item => ({
          id: botConnectionId(hubUrl, item.deviceId, result.groupId),
          hubUrl,
          deviceId: item.deviceId,
          deviceName: item.name,
          ...(item.computerId ? { computerId: item.computerId } : {}),
          pairedAt: Date.now(),
          botGroupId: result.groupId,
        }));
      await saveBotConnections(profiles, result.botToken);
      await reloadSavedConnections();
      if (!mounted.current || revision !== remoteConnectionRevision()) return;
      await confirmPairingHubIdentity(hubUrl, () => mounted.current && revision === remoteConnectionRevision());
      if (!mounted.current || revision !== remoteConnectionRevision()) return;
      const firstProfile = profiles.find(item => item.id === getRemoteState().connectionId)
        ?? profiles.find(profile => result.devices.some(item => item.deviceId === profile.deviceId && item.online)) ?? profiles[0];
      if (!firstProfile) throw new Error('Bot 组中没有可用电脑');
      await useSavedConnection(firstProfile.id, false, { stillWanted: () => mounted.current });
      if (!mounted.current) return;
      const selected = getRemoteState();
      if (selected.connectionId !== firstProfile.id || selected.selectedHubUrl !== firstProfile.hubUrl
        || selected.signingIn || selected.connection !== 'open'
        || !selected.connections.some(item => item.id === firstProfile.id && item.botGroupId === result.groupId)) {
        throw new Error('Bot 组已保存，请从电脑列表选择要连接的电脑');
      }
      setExpanded(false);
      setBindingText('');
      showToast(`Bot 组已绑定，可切换 ${result.devices.length} 台电脑`, 'check');
      onBound(connectionSelection(firstProfile));
    } catch (reason) {
      if (mounted.current) setError((reason as Error).message);
    } finally {
      gate.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return <ProgrammingCard soft>
    <ProgrammingRow first icon="server" title="Bot 连接" detail={botGroups ? `${botGroups} 个 Bot 组已绑定` : '导入 Bot 绑定信息'}
      onPress={() => { setExpanded(value => !value); setError(null); }}
      trailing={<Text style={styles.disclosure}>{expanded ? '收起' : '展开'}</Text>} />
    {expanded ? <View style={styles.form}>
      <TextInput accessibilityLabel="Bot 绑定 JSON" value={bindingText} onChangeText={setBindingText} multiline numberOfLines={4}
        autoCapitalize="none" autoCorrect={false} placeholder="粘贴 Bot 绑定 JSON" placeholderTextColor={dk.faint} style={styles.input} />
      <ProgrammingAction label={busy ? '正在绑定…' : '导入并绑定'} loading={busy} disabled={busy || !bindingText.trim()}
        onPress={() => void importBot()} style={{ marginTop: 10 }} />
      {error ? <Text accessibilityRole="alert" style={p.error}>{error}</Text> : null}
    </View> : null}
  </ProgrammingCard>;
}

const useStyles = themed((_, d) => StyleSheet.create({
  disclosure: { color: d.muted, fontSize: 12 },
  form: { paddingHorizontal: 12, paddingBottom: 12 },
  input: { minHeight: 96, borderRadius: 11, borderWidth: StyleSheet.hairlineWidth, borderColor: d.lineStrong, backgroundColor: d.surface2, padding: 11, color: d.text, fontSize: 12, lineHeight: 17, textAlignVertical: 'top' },
}));
