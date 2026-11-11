import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { AppDialog, showToast } from '../components/ui';
import { themed, useDesk } from '../theme';
import type { BotGroupState } from './connections';
import type { LegacyBotIdentityPreview } from './bot-group-bindings';
import { parseBotBindingPackage } from './client';
import { connectionSelection, type ComputerSelection } from './computer-connections';
import { confirmRemoteBotIdentity, getRemoteState, importRemoteBotBinding, previewRemoteBotIdentity, refreshRemoteBotGroup, reloadSavedConnections, remoteConnectionRevision, retryRemoteBotGroupBinding, revokeRemoteBotGroup, useSavedConnection, type RemoteState } from './store';
import { ProgrammingAction, ProgrammingCard, ProgrammingRow, useProgrammingStyles } from './ProgrammingUi';

export function RemoteBotBinding({ remote, onBound, visible = true }: { remote: RemoteState; onBound: (selection: ComputerSelection) => void; visible?: boolean }) {
  const p = useProgrammingStyles();
  const dk = useDesk();
  const styles = useStyles();
  const [expanded, setExpanded] = useState(false);
  const [bindingText, setBindingText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gate = useRef(false);
  const mounted = useRef(true);
  const activity = useRef({ visible, revision: 0 });
  if (activity.current.visible !== visible) activity.current = { visible, revision: activity.current.revision + 1 };
  const botGroups = (remote.botGroups ?? []).filter(item => item.status !== 'revoked').length;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const importBot = async () => {
    if (!visible || gate.current || !bindingText.trim()) return;
    const owner = activity.current;
    const stillVisible = () => mounted.current && activity.current === owner && activity.current.visible;
    gate.current = true;
    setBusy(true);
    setError(null);
    const revision = remoteConnectionRevision();
    try {
      const binding = parseBotBindingPackage(bindingText);
      const result = await importRemoteBotBinding(binding);
      const profiles = result.profiles;
      if (!stillVisible() || revision !== remoteConnectionRevision()) return;
      if (!profiles.length) {
        setBindingText('');
        setExpanded(false);
        showToast('Bot 组已绑定，等待电脑加入', 'check');
        return;
      }
      const firstProfile = profiles.find(item => item.id === getRemoteState().connectionId)
        ?? profiles.find(profile => result.devices.some(item => item.deviceId === profile.deviceId && item.online)) ?? profiles[0];
      await useSavedConnection(firstProfile.id, false, { stillWanted: stillVisible });
      if (!stillVisible()) return;
      const selected = getRemoteState();
      if (selected.connectionId !== firstProfile.id || selected.selectedHubUrl !== firstProfile.hubUrl
        || selected.signingIn || selected.connection !== 'open'
        || !selected.connections.some(item => item.id === firstProfile.id && item.botGroupId === result.group.groupId
          && item.botGeneration === firstProfile.botGeneration)) {
        throw new Error('Bot 组已保存，请从电脑列表选择要连接的电脑');
      }
      setExpanded(false);
      setBindingText('');
      showToast(`Bot 组已绑定，可切换 ${result.devices.length} 台电脑`, 'check');
      onBound(connectionSelection(firstProfile));
    } catch (reason) {
      // A failed/unknown POST may still have a durable pending group to show.
      await reloadSavedConnections().catch(() => undefined);
      if (stillVisible()) setError((reason as Error).message);
    } finally {
      gate.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return <><ProgrammingCard soft>
    <ProgrammingRow first icon="server" title="Bot 连接" detail={botGroups ? `${botGroups} 个 Bot 组已保存` : '导入 Bot 绑定信息'}
      onPress={() => { setExpanded(value => !value); setError(null); }}
      trailing={<Text style={styles.disclosure}>{expanded ? '收起' : '展开'}</Text>} />
    {expanded ? <View style={styles.form}>
      <TextInput accessibilityLabel="Bot 绑定 JSON" value={bindingText} onChangeText={setBindingText} multiline numberOfLines={4}
        autoCapitalize="none" autoCorrect={false} placeholder="粘贴 Bot 绑定 JSON" placeholderTextColor={dk.faint} style={styles.input} />
      <ProgrammingAction label={busy ? '正在绑定…' : '导入并绑定'} loading={busy} disabled={busy || !bindingText.trim()}
        onPress={() => void importBot()} style={{ marginTop: 10 }} />
      {error ? <Text accessibilityRole="alert" style={p.error}>{error}</Text> : null}
    </View> : null}
  </ProgrammingCard><RemoteBotGroups remote={remote} visible={visible} /></>;
}

const groupHost = (url: string) => { try { return new URL(url).host; } catch { return '已保存 Bot'; } };

/** Group controls remain reachable even when no computer belongs to the group. */
export function RemoteBotGroups({ remote, visible = true }: { remote: RemoteState; visible?: boolean }) {
  const p = useProgrammingStyles();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<BotGroupState | null>(null);
  const [identity, setIdentity] = useState<{ group: BotGroupState; preview: LegacyBotIdentityPreview; ticket: number; routeRevision: number } | null>(null);
  const identityTicket = useRef(0);
  const gate = useRef(false);
  const alive = useRef(true);
  const activity = useRef({ visible, revision: 0 });
  if (activity.current.visible !== visible) activity.current = { visible, revision: activity.current.revision + 1 };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!visible) { setConfirmation(null); setIdentity(null); identityTicket.current += 1; } }, [visible]);

  const closeIdentity = () => { identityTicket.current += 1; setIdentity(null); };
  const previewIdentity = async (group: BotGroupState) => {
    if (!visible || gate.current) return;
    const owner = activity.current, ticket = ++identityTicket.current, routeRevision = remoteConnectionRevision();
    const current = () => alive.current && owner === activity.current && activity.current.visible && ticket === identityTicket.current;
    gate.current = true; setBusy(group.id);
    try {
      const preview = await previewRemoteBotIdentity(group.id);
      const latest = getRemoteState().botGroups?.find(item => item.id === group.id);
      if (current() && latest?.generation === group.generation && latest.status === 'active' && !latest.pin
        && routeRevision === remoteConnectionRevision()) setIdentity({ group, preview, ticket, routeRevision });
    } catch (error) {
      if (current()) showToast(error instanceof Error ? error.message : '暂时无法读取服务器身份，请稍后重试', 'alert');
    } finally { gate.current = false; if (alive.current) setBusy(null); }
  };
  const confirmIdentity = async () => {
    if (!identity || gate.current) return;
    const snapshot = identity, owner = activity.current;
    const stillWanted = () => {
      const current = getRemoteState().botGroups?.find(item => item.id === snapshot.group.id);
      return alive.current && activity.current === owner && activity.current.visible && identityTicket.current === snapshot.ticket
        && remoteConnectionRevision() === snapshot.routeRevision && current?.generation === snapshot.group.generation && current.status === 'active';
    };
    if (!stillWanted()) { closeIdentity(); showToast('Bot 绑定或页面已改变，请重新核对服务器身份', 'alert'); return; }
    gate.current = true; setBusy(snapshot.group.id);
    try {
      await confirmRemoteBotIdentity(snapshot.group.id, snapshot.preview, stillWanted);
      if (stillWanted()) { closeIdentity(); showToast('服务器身份已确认，原 Bot 绑定已恢复，请选择要连接的电脑', 'check'); }
    } catch (error) {
      if (stillWanted()) showToast(error instanceof Error ? error.message : '服务器身份未确认，原绑定已保留', 'alert');
    } finally { gate.current = false; if (alive.current) setBusy(null); }
  };

  const run = async (group: BotGroupState, action: 'refresh' | 'retry' | 'revoke') => {
    if (!visible || gate.current) return;
    const current = getRemoteState().botGroups?.find(item => item.id === group.id);
    if (!current || current.generation !== group.generation) {
      setConfirmation(null);
      showToast('Bot 绑定已改变，请刷新后重新确认', 'alert');
      return;
    }
    const owner = activity.current;
    const revision = remoteConnectionRevision();
    const stillVisible = () => alive.current && activity.current === owner && activity.current.visible;
    gate.current = true; setBusy(group.id);
    try {
      if (action === 'revoke') {
        await revokeRemoteBotGroup(group.id, group.generation);
        if (stillVisible()) { setConfirmation(null); showToast(group.status === 'revoked' ? '失效记录已清理，请导入管理员的新绑定包' : 'Bot 组已解除，电脑与历史保留', 'check'); }
      } else {
        const result = action === 'retry' ? await retryRemoteBotGroupBinding(group.id)
          : await refreshRemoteBotGroup(group.id, () => stillVisible() && revision === remoteConnectionRevision());
        if (stillVisible()) showToast(result.devices.length ? `Bot 组已刷新，${result.devices.length} 台电脑可在列表选择` : 'Bot 组已绑定，等待电脑加入', 'check');
      }
    } catch (error) {
      if (stillVisible()) showToast(error instanceof Error ? error.message : 'Bot 组操作未完成，请重试', 'alert');
    } finally {
      gate.current = false;
      if (alive.current) setBusy(null);
    }
  };

  const groups = remote.botGroups ?? [];
  return <>
    {groups.map(group => {
      const members = remote.connections.filter(item => item.hubUrl === group.hubUrl && item.botGroupId === group.groupId);
      const legacyIdentity = group.status === 'active' && !group.pin;
      const detail = legacyIdentity ? '安全身份待确认，原绑定凭据保留'
        : group.status === 'pending' ? '绑定结果待确认，恢复信息已安全保存'
        : group.status === 'revoking' ? '解除待确认，已暂停此组远程任务'
          : group.status === 'revoked' ? '绑定已失效，请管理员在原组重置手机并提供新绑定包'
            : members.length ? `已绑定 · ${members.length} 台电脑` : '已绑定，等待电脑加入';
      const loading = busy === group.id;
      return <ProgrammingCard soft key={group.id}>
        <ProgrammingRow first icon="server" title={`Bot 组 ${group.groupId}`} detail={`${groupHost(group.hubUrl)} · ${detail}`} />
        {group.status !== 'revoked' ? <View style={{ paddingHorizontal: 12, paddingBottom: 12, gap: 8 }}>
          {legacyIdentity ? <ProgrammingAction label="确认服务器身份" disabled={Boolean(busy)} loading={loading} onPress={() => void previewIdentity(group)} /> : null}
          {group.status !== 'revoking' && !legacyIdentity ? <ProgrammingAction label={group.status === 'pending' ? '查询绑定状态' : '刷新组电脑'}
            disabled={Boolean(busy)} loading={loading} onPress={() => void run(group, 'refresh')} /> : null}
          {group.status === 'pending' ? <ProgrammingAction label="重试原绑定" disabled={Boolean(busy)} onPress={() => void run(group, 'retry')} /> : null}
          <ProgrammingAction label={group.status === 'revoking' ? '重试解除 Bot 组' : '解除 Bot 组'} tone="danger" disabled={Boolean(busy)}
            onPress={() => setConfirmation(group)} />
          {group.status === 'pending' ? <Text style={p.note}>查询不会重新绑定；重试会沿用已保存的同一次绑定，不创建新组。</Text> : null}
          {legacyIdentity ? <Text style={p.note}>先与管理员核对服务器身份和校验公钥。明确确认并安全保存前，不发送原手机凭据，也不会重新绑定。</Text> : null}
        </View> : <View style={{ paddingHorizontal: 12, paddingBottom: 12 }}>
          <ProgrammingAction label="清理失效记录" disabled={Boolean(busy)} loading={loading} onPress={() => void run(group, 'revoke')} />
        </View>}
      </ProgrammingCard>;
    })}
    <AppDialog visible={Boolean(confirmation) && visible} title="解除这个 Bot 组？" icon="trash"
      message="将解除此手机对整个 Bot 组的控制并作废旧绑定包，电脑与历史会保留。换手机需管理员在原组重置并提供新绑定包。"
      onClose={() => { if (!busy) setConfirmation(null); }}
      actions={[{ label: '取消', tone: 'secondary', disabled: Boolean(busy), onPress: () => setConfirmation(null) },
        { label: busy ? '正在解除…' : '确认解除 Bot 组', tone: 'danger', disabled: Boolean(busy), onPress: () => { if (confirmation) void run(confirmation, 'revoke'); } }]} />
    <AppDialog visible={Boolean(identity) && visible && Boolean(remote.botGroups?.some(group => group.id === identity?.group.id
      && group.generation === identity.group.generation && group.status === 'active'))} title="核对服务器身份" icon="lock"
      message={identity ? `请与管理员页面中的完整信息逐项核对。确认前不会发送手机凭据。\n\n服务地址\n${identity.preview.hubUrl}\n\n连接入口\n${identity.preview.target.endpoint}\n\n服务器身份\n${identity.preview.pin.instanceId}\n\n校验公钥\n${identity.preview.pin.publicKey}` : undefined}
      onClose={closeIdentity} actions={[{ label: '取消', tone: 'secondary', onPress: closeIdentity },
        { label: busy ? '正在安全确认…' : '已核对，确认此身份', disabled: Boolean(busy), onPress: () => void confirmIdentity() }]} />
  </>;
}

const useStyles = themed((_, d) => StyleSheet.create({
  disclosure: { color: d.muted, fontSize: 12 },
  form: { paddingHorizontal: 12, paddingBottom: 12 },
  input: { minHeight: 96, borderRadius: 11, borderWidth: StyleSheet.hairlineWidth, borderColor: d.lineStrong, backgroundColor: d.surface2, padding: 11, color: d.text, fontSize: 12, lineHeight: 17, textAlignVertical: 'top' },
}));
