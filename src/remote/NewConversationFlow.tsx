import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { IconButton } from '../components/ui';
import { useDesk } from '../theme';
import type { AgentProfile, Project, WorkspaceMode } from './client';
import { AgentGrid } from './AgentGrid';
import { ProgrammingCard, ProgrammingHeading, ProgrammingRow, ProgrammingSection, ProgrammingStatus } from './ProgrammingUi';
import { agentApiLabel, agentSupports } from './projection';
import { ProjectBrowser } from './ProjectBrowser';
import { projectBrowserRequest, type ProjectRequest } from './project-browser';
import { useBackAction, useChildBackAction, type RegisterBackAction } from './useBackAction';

export type NewConversationSelection = { agent: AgentProfile; cwd: string; project?: Project; projectless?: true };

/** The global entry owns Agent → location → name. Project-level entry points
 * bypass this flow and keep their exact current Agent and cwd. */
export function NewConversationFlow({ scopeKey, deviceId, deviceName, transport, agents, mode, loading = false, error, online,
  explorerAvailable, projectlessAvailable, onRefresh, onClose, onComplete, onRegisterBack, requestForAgent }: {
  scopeKey: string; deviceId: string; deviceName?: string; transport: 'remote' | 'direct'; agents: AgentProfile[]; mode: WorkspaceMode;
  loading?: boolean; error?: string; online: boolean; explorerAvailable: boolean; projectlessAvailable: boolean;
  onRefresh: () => void; onClose: () => void; onComplete: (selection: NewConversationSelection) => void; onRegisterBack?: RegisterBackAction;
  requestForAgent?: (agent: AgentProfile) => ProjectRequest;
}) {
  const d = useDesk();
  const [agentId, setAgentId] = useState<string>();
  const owner = useMemo(() => ({ active: true }), [scopeKey, deviceId, mode, transport]);
  const current = useRef(owner); current.current = owner;
  const state = useRef({ online, agents, explorerAvailable, projectlessAvailable }); state.current = { online, agents, explorerAvailable, projectlessAvailable };
  useEffect(() => { owner.active = true; setAgentId(undefined); return () => { owner.active = false; }; }, [owner]);
  const active = () => current.current === owner && owner.active;
  const close = () => { if (active()) { owner.active = false; onClose(); } };
  const selected = agents.find(agent => agent.id === agentId);
  const browserBack = useChildBackAction();
  useBackAction(() => {
    if (!active()) return false;
    if (selected) { if (!browserBack.handle()) setAgentId(undefined); } else close();
    return true;
  }, onRegisterBack);
  const ready = (agent: AgentProfile) => agent.available && agent.id !== 'claude-desktop' && agent.remoteSendSupported && agentSupports(agent, agent.id, 'send');
  const selectionScope = JSON.stringify([scopeKey, deviceId, mode, selected?.id, selected?.tool, selected?.api.accountId, selected?.api.pending]);
  const request = useMemo(() => selected ? requestForAgent?.(selected) ?? projectBrowserRequest(transport, deviceId, selected.tool, mode, true) : undefined, [selectionScope, requestForAgent]);
  const finish = (project?: Project) => {
    const now = state.current.agents.find(agent => agent.id === selected?.id);
    if (!active() || !state.current.online || !selected || !now || !ready(now) || now.tool !== selected.tool || now.api.accountId !== selected.api.accountId
      || !(project ? state.current.explorerAvailable : state.current.projectlessAvailable)) return;
    owner.active = false;
    onComplete({ agent: now, cwd: project?.path ?? '', ...(project ? { project } : { projectless: true }) });
  };
  if (selected && ready(selected) && request) return <ProjectBrowser key={selectionScope} scopeKey={selectionScope} tool={selected.tool} agentName={selected.name} mode={mode}
    explorer request={request} onRegisterBack={browserBack.register} onClose={close} onBack={() => { if (active()) setAgentId(undefined); }}
    browseUnavailable={!online ? '电脑暂时离线，连接恢复后刷新即可。' : !explorerAvailable ? '请更新电脑端和中转站后浏览电脑磁盘。已有项目仍可直接新建会话。' : undefined}
    projectlessUnavailable={!online ? '电脑暂时离线，请连接后重试。' : !projectlessAvailable ? '此电脑或中转站尚不支持不关联文件夹，请更新后重试。' : undefined}
    onProjectless={() => finish()} onSelect={finish} />;
  return <View testID="global-new-conversation" style={[styles.screen, { backgroundColor: d.bg }]}>
    <View style={styles.header}>
      <IconButton icon="chevronLeft" label="取消新建会话" onPress={close} color={d.text2} />
      <View style={styles.spacer} />
      <IconButton icon="regenerate" label="刷新 Agent 列表" disabled={loading} onPress={() => { if (active()) onRefresh(); }} color={d.text2} iconSize={19} />
    </View>
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <ProgrammingHeading title="新会话" subtitle="选择这次使用的 Agent" step="1 / 3" />
      <ProgrammingCard><ProgrammingRow first icon="laptop" title={deviceName || '这台电脑'}
        detail={<ProgrammingStatus tone={online ? 'online' : 'offline'} text={`${online ? '已连接' : '未连接'} · ${mode === 'code' ? 'Code' : 'Work'}`} />} /></ProgrammingCard>
      <ProgrammingSection title="AGENT" hint="选择后继续" />
      <AgentGrid items={agents.map(agent => {
        const enabled = online && ready(agent);
        const detail = !agent.available ? '尚未安装或未就绪' : agent.id === 'claude-desktop' ? '仅查看桌面会话' : !agent.remoteSendSupported || !agentSupports(agent, agent.id, 'send') ? '暂不支持远程新建' : agentApiLabel(agent);
        return { id: agent.id, name: agent.name, tool: agent.tool, client: agent.id === 'claude-desktop' ? 'Claude Desktop' : undefined,
          detail, disabled: !enabled, accessibilityLabel: `选择 ${agent.name}` };
      })} onSelect={id => { if (active() && state.current.online) setAgentId(id); }} />
      {loading ? <ActivityIndicator accessibilityLabel="正在读取 Agent" style={styles.loading} color={d.accentText} /> : null}
      {!loading && (!agents.length || error || !online) ? <Text accessibilityRole="alert" style={[styles.notice, { color: d.muted }]}>{error || (!online ? '电脑暂时离线，连接后再选择。' : '这台电脑还没有可用的 Agent。')}</Text> : null}
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, minHeight: 0, width: '100%', maxWidth: 680, alignSelf: 'center' },
  header: { height: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 }, spacer: { flex: 1 },
  content: { paddingHorizontal: 18, paddingBottom: 28 },
  loading: { marginTop: 24 }, notice: { fontSize: 12.5, lineHeight: 19, paddingVertical: 20 },
});
