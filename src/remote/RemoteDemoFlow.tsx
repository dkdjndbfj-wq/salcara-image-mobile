import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Icon } from '../components/Icon';
import { themed, useDesk } from '../theme';
import type { AgentId, AgentProfile, DeviceStatus, SessionInfo, WorkspaceMode } from './client';
import { sessionAgent } from './RemoteHome';
import { sessionWorkspaceMode } from './projection';
import { ToolBadge } from './parts';
import { RemoteDemoWorkspace } from './RemoteDemoWorkspace';
import { DemoProjectTree } from './DemoProjectTree';
import { AGENT_CHOICES } from './agent-catalog';

type DemoStage = 'agents' | 'directory' | 'thread';

type Props = {
  visible?: boolean;
  computerName?: string;
  computer?: DeviceStatus;
  agents: AgentProfile[];
  sessions: SessionInfo[];
  initialAgentId?: AgentId;
  initialWorkspaceMode?: WorkspaceMode;
  onBack: () => void;
  onRegisterBack?: (handler: (() => void) | null) => void;
  onOpenWorkspace?: (selection: { agent: AgentProfile; session: SessionInfo; workspaceMode: WorkspaceMode }) => void;
};

/**
 * Development-only, but deliberately realistic, remote flow.  It keeps the
 * selection state visible so the preview follows the same order as the real
 * product: computer -> agent -> Code/Work directory -> conversation.
 */
export function RemoteDemoFlow({ computerName: providedComputerName, computer, agents, sessions, initialAgentId, initialWorkspaceMode = 'code', onBack, onRegisterBack, onOpenWorkspace }: Props) {
  const d = useDesk();
  const styles = useStyles();
  const computerName = providedComputerName ?? computer?.name ?? '远程电脑';
  const [stage, setStage] = useState<DemoStage>(initialAgentId ? 'directory' : 'agents');
  const [agentId, setAgentId] = useState<AgentId | null>(initialAgentId ?? null);
  const workspaceMode = initialWorkspaceMode;
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  useEffect(() => {
    if (!onRegisterBack) return undefined;
    const handler = () => {
      if (stage === 'agents') { onBack(); return; }
      if (stage === 'directory') { setSelectedSession(null); setStage('agents'); return; }
      setSelectedSession(null); setStage('directory');
    };
    onRegisterBack(handler);
    return () => onRegisterBack(null);
  }, [onBack, onRegisterBack, stage]);
  const selectedAgent = agents.find((item) => item.id === agentId) ?? null;
  const directory = useMemo(() => sessions
    .filter((session) => (!selectedAgent || sessionAgent(session, agents) === selectedAgent.id))
    .filter((session) => sessionWorkspaceMode(session) === workspaceMode)
    .filter((session) => !session.parentSessionKey && !session.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt), [agents, selectedAgent, sessions, workspaceMode]);

  if (stage === 'thread' && selectedSession && selectedAgent) {
    return <RemoteDemoWorkspace computerName={computerName} agentName={selectedAgent.name} agentId={selectedAgent.id}
      sessionKey={selectedSession.sessionKey} projectPath={selectedSession.cwd} sessions={directory} sessionTitle={selectedSession.title} workspaceMode={workspaceMode}
      onBack={() => { setStage('directory'); setSelectedSession(null); }} />;
  }

  const title = stage === 'agents' ? '选择 Agent' : `${workspaceMode === 'code' ? 'Code' : 'Work'} 项目`;
  const subtitle = stage === 'agents' ? `${computerName} · 选择要继续的运行环境` : `${selectedAgent?.name ?? 'Agent'} · 选择项目中的会话`;
  const chooseAgent = (id: AgentId) => { setAgentId(id); setSelectedSession(null); setStage('directory'); };
  const chooseSession = (session: SessionInfo) => {
    if (selectedAgent && onOpenWorkspace) { onOpenWorkspace({ agent: selectedAgent, session, workspaceMode }); return; }
    setSelectedSession(session); setStage('thread');
  };

  return <ScrollView contentContainerStyle={styles.page} showsVerticalScrollIndicator={false}>
    <View style={styles.headerRow}>
      <Pressable accessibilityRole="button" accessibilityLabel="返回" onPress={stage === 'agents' ? onBack : () => setStage('agents')} style={styles.backButton}>
        <Icon name="chevronLeft" size={18} color={d.text2} />
      </Pressable>
      <View style={styles.headerCopy}><Text style={styles.eyebrow}>远程电脑 · {computerName}</Text><Text style={styles.title}>{title}</Text><Text style={styles.subtitle}>{subtitle}</Text></View>
    </View>

    <View style={styles.steps}>
      {(['电脑', 'Agent', '项目', '会话'] as const).map((label, index) => {
        const stepIndex = stage === 'agents' ? 1 : 2;
        const active = index === stepIndex;
        const done = index < stepIndex;
        return <React.Fragment key={label}><View style={[styles.step, active && styles.stepActive, done && styles.stepDone]}><Text style={[styles.stepText, (active || done) && styles.stepTextActive]}>{label}</Text></View>{index < 3 ? <View style={[styles.stepLine, done && styles.stepLineDone]} /> : null}</React.Fragment>;
      })}
    </View>

    {stage === 'agents' ? <View style={styles.agentList}>{agents.map((agent) => <Pressable key={agent.id} accessibilityRole="button" accessibilityLabel={`选择 ${agent.name}`} onPress={() => chooseAgent(agent.id)} style={({ pressed }) => [styles.agentCard, pressed && styles.pressed]}>
      <ToolBadge tool={agent.tool} client={agent.id === 'claude-desktop' ? 'Claude Desktop' : agent.name} size={34} />
      <View style={styles.cardCopy}><Text style={styles.cardTitle}>{agent.name}</Text><Text style={styles.cardDetail}>{AGENT_CHOICES.find(choice => choice.id === agent.id)?.detail || '项目与会话'}</Text><Text style={styles.cardMeta}>{agent.api.model} · {agent.available ? '已连接' : '不可用'}</Text></View>
      <Icon name="chevronRight" size={17} color={d.faint} />
    </Pressable>)}</View> : <>
      <View style={styles.directoryHeader}><Text style={styles.directoryHint}>{directory.length ? `${directory.length} 条会话 · ${computerName} · ${selectedAgent?.name}` : '这个 Agent 暂无此类会话'}</Text></View>
      {directory.length ? <DemoProjectTree key={`${selectedAgent?.id}:${workspaceMode}`} sessions={directory} onOpen={chooseSession} /> : <View style={styles.empty}><Icon name={workspaceMode === 'code' ? 'code' : 'listCheck'} size={22} color={d.faint} /><Text style={styles.emptyTitle}>还没有 {workspaceMode === 'code' ? 'Code' : 'Work'} 会话</Text><Text style={styles.emptyCopy}>可以在电脑上创建新会话；如需切换 Code 或 Work，请返回首页。</Text></View>}
    </>}
  </ScrollView>;
}

const useStyles = themed((_c, t) => StyleSheet.create({
  page: { flexGrow: 1, paddingHorizontal: 20, paddingTop: 8, paddingBottom: 28, backgroundColor: t.bg, gap: 14 },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 }, backButton: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: t.surface2 }, headerCopy: { flex: 1, gap: 2 }, eyebrow: { color: t.muted, fontSize: 11 }, title: { color: t.text, fontSize: 24, lineHeight: 30, fontWeight: '700' }, subtitle: { color: t.muted, fontSize: 12, lineHeight: 17 },
  steps: { flexDirection: 'row', alignItems: 'center', paddingVertical: 3 }, step: { minWidth: 52, height: 27, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: t.surface2 }, stepActive: { backgroundColor: t.accentSoft }, stepDone: { backgroundColor: t.surface3 }, stepText: { color: t.muted, fontSize: 11, fontWeight: '600' }, stepTextActive: { color: t.accentText }, stepLine: { flex: 1, height: 1, marginHorizontal: 5, backgroundColor: t.line }, stepLineDone: { backgroundColor: t.accent },
  agentList: { gap: 9 }, agentCard: { minHeight: 82, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 13, paddingVertical: 12, borderRadius: 15, backgroundColor: t.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: t.line }, cardCopy: { flex: 1, minWidth: 0, gap: 3 }, cardTitle: { color: t.text, fontSize: 14, fontWeight: '600' }, cardDetail: { color: t.text2, fontSize: 11, lineHeight: 15 }, cardMeta: { color: t.muted, fontSize: 10 }, pressed: { backgroundColor: t.press },
  modeCard: { padding: 13, borderRadius: 15, backgroundColor: t.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: t.line, gap: 10 }, sectionLabel: { color: t.text, fontSize: 13, fontWeight: '600' }, modeGrid: { flexDirection: 'row', gap: 8 }, modeOption: { flex: 1, minHeight: 82, flexDirection: 'column', alignItems: 'flex-start', gap: 6, padding: 11, borderRadius: 12, borderWidth: 1, borderColor: t.line, backgroundColor: t.bg }, modeOptionSelected: { borderColor: t.accent, backgroundColor: t.accentSoft }, modeCopy: { gap: 1 }, modeTitle: { color: t.text2, fontSize: 13, fontWeight: '700' }, modeTitleSelected: { color: t.accentText }, modeDetail: { color: t.muted, fontSize: 10, lineHeight: 14 }, modeCount: { position: 'absolute', top: 10, right: 11, color: t.muted, fontSize: 11, fontWeight: '600' },
  directoryHeader: { paddingTop: 2, gap: 2 }, directoryHint: { color: t.muted, fontSize: 11, marginTop: 2 }, sessionList: { overflow: 'hidden', borderRadius: 15, backgroundColor: t.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: t.line }, sessionRow: { minHeight: 66, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: t.line }, sessionGlyph: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: t.surface2 }, sessionTitle: { color: t.text, fontSize: 13, fontWeight: '600' }, sessionMeta: { color: t.muted, fontSize: 10, marginTop: 2 }, empty: { minHeight: 150, alignItems: 'center', justifyContent: 'center', gap: 7, paddingHorizontal: 24 }, emptyTitle: { color: t.text, fontSize: 13, fontWeight: '600' }, emptyCopy: { color: t.muted, fontSize: 11, lineHeight: 16, textAlign: 'center' },
}));
