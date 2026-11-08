import * as Application from 'expo-application';
import React, { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { useMemories } from '../agent/memory';
import { useAgentSettings } from '../agent/settings';
import { useMemoryBoxSettings } from '../memorybox/settings';
import { recoverRemoteContent, useRemote, type RemoteContentRecoveryStage } from '../remote/store';
import { useApp } from '../state/AppContext';
import { colors, prettyModel, themed } from '../theme';
import { BrandMark } from './Brand';
import { Icon } from './Icon';
import { AppDialog, Group, ListRow, SectionLabel, Sheet, showToast } from './ui';
import { exportBackup, type BackupProgress } from '../storage/backup';
import { APPEARANCE_LABEL, setAppearance, useAppearance } from '../appearance';
import { modelById } from '../voice/catalog';
import { localModelsOffered } from '../voice/native';
import { useVoiceSettings } from '../voice/settings';

export function AppSettingsSheet({ visible, onClose, onOpenProviders, onOpenModels, onOpenNetwork, onOpenAbout, onCheckUpdates, onOpenVoice, onOpenPersonalization, onOpenTools, onOpenAgents, onOpenMemoryBox, onOpenRemote }: {
  visible: boolean; onClose: () => void; onOpenProviders: () => void; onOpenModels: (tab?: 'chat' | 'image') => void; onOpenNetwork: () => void; onOpenAbout: () => void; onCheckUpdates: () => void;
  onOpenVoice: () => void; onOpenPersonalization: () => void; onOpenTools: () => void; onOpenAgents: () => void; onOpenMemoryBox: () => void; onOpenRemote: () => void;
}) {
  const styles = useStyles();
  const remote = useRemote();
  const online = remote.devices.filter((device) => device.online).length;
  const memoryBox = useMemoryBoxSettings();
  const voice = useVoiceSettings();
  const agent = useAgentSettings();
  const memories = useMemories();
  const { providers, chatProvider, imageProvider, restoreBackup } = useApp();
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupWork, setBackupWork] = useState<{ title: string; progress: BackupProgress | null } | null>(null);
  const [backupResult, setBackupResult] = useState<{ title: string; message: string } | null>(null);
  const [remoteRecoveryWork, setRemoteRecoveryWork] = useState<RemoteContentRecoveryStage | null>(null);
  const [remoteRecoveryResult, setRemoteRecoveryResult] = useState<{ title: string; message: string } | null>(null);
  const remoteRecoveryFlight = useRef(false);
  const settingsVisible = useRef(visible); settingsVisible.current = visible;
  const runBackup = (kind: 'export' | 'restore') => {
    setBackupOpen(false);
    setBackupWork({ title: kind === 'export' ? '正在备份' : '正在恢复', progress: null });
    const onProgress = (progress: BackupProgress) => setBackupWork((current) => (current ? { ...current, progress } : current));
    const job = kind === 'export'
      ? exportBackup(onProgress).then(() => { setBackupWork(null); showToast('备份已生成'); })
      : restoreBackup(onProgress).then((result) => {
        setBackupWork(null);
        if (result) setBackupResult({ title: '已恢复', message: `新加入 ${result.conversations} 个对话、${result.messages} 条消息、${result.characters} 个聊天伙伴和 ${result.files} 个图片与文件。这台手机上原有的内容都保留着。\n\nAPI 密钥不在备份里，需要在“API 管理”里重新填写。` });
      });
    void job.catch((error) => { setBackupWork(null); setBackupResult({ title: kind === 'export' ? '备份没有完成' : '恢复没有完成', message: error instanceof Error ? error.message : '请稍后再试' }); });
  };
  const progressText = (progress: BackupProgress | null) => {
    if (!progress) return '准备中…';
    if (progress.stage === 'data') return '正在整理对话和记忆…';
    if (progress.stage === 'writing') return '正在写入文件…';
    return progress.total ? `${Math.min(100, Math.round((progress.done / progress.total) * 100))}%` : '处理中…';
  };
  const recoverRemote = async () => {
    if (remoteRecoveryFlight.current) return;
    remoteRecoveryFlight.current = true;
    setRemoteRecoveryResult(null); setRemoteRecoveryWork('checking');
    try {
      const result = await recoverRemoteContent((stage) => { if (settingsVisible.current) setRemoteRecoveryWork(stage); });
      if (!settingsVisible.current) return;
      const message = result.total === 0
        ? `已刷新 ${result.deviceName} 的会话目录，没有可同步的远程对话。手机本机聊天和 ZIP 备份未修改。`
        : `已同步 ${result.synced}/${result.total} 条最近对话${result.failed ? `，${result.failed} 条读取失败` : ''}${result.directoryFailed ? `，${result.directoryFailed} 个目录读取失败` : ''}。手机本机聊天和 ZIP 备份未修改。`;
      setRemoteRecoveryResult({ title: result.failed || result.directoryFailed ? '同步已完成' : '同步完成', message });
    } catch (error) {
      if (settingsVisible.current) setRemoteRecoveryResult({ title: '同步没有完成', message: error instanceof Error ? error.message : '远程会话暂时不可用' });
    } finally { remoteRecoveryFlight.current = false; setRemoteRecoveryWork(null); }
  };
  // Sub-pages open on top of Settings, so Back returns here instead of to the chat.
  const go = (callback: () => void) => () => { callback(); };
  const leave = (callback: () => void) => () => { onClose(); callback(); };
  const appearance = useAppearance();
  const appearanceShort: Record<'system' | 'light' | 'dark', string> = { system: '自动', light: '浅色', dark: '深色' };
  return <Sheet visible={visible} title="设置" onClose={onClose} presentation="page" background={colors.surface}>
    <View style={styles.body}>
      <View style={styles.appCard}>
        <View style={styles.mark}><BrandMark size={40} /></View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.name}>Salcara</Text>
          <Text style={styles.version}>版本 {Application.nativeApplicationVersion ?? '开发版'}</Text>
        </View>
        <Pressable accessibilityRole="button" onPress={leave(onCheckUpdates)} style={({ pressed }) => [styles.updateButton, pressed && { opacity: 0.7 }]}>
          <Text style={styles.updateText}>检查更新</Text>
        </Pressable>
      </View>

      <SectionLabel>模型与 API</SectionLabel>
      <Group>
        <ListRow first icon="server" title="API 管理" value={providers.length ? `${providers.length} 个` : '未添加'} onPress={go(onOpenProviders)} />
        <ListRow icon="chat" title="对话模型" value={prettyModel(chatProvider?.chatModel) || '未设置'} onPress={go(() => onOpenModels('chat'))} />
        <ListRow icon="image" title="绘图" value={prettyModel(imageProvider?.model) || '未设置'} onPress={go(() => onOpenModels('image'))} />
        <ListRow icon="mic" title="语音" value={voice.inputEngine === 'local' && localModelsOffered() ? (modelById(voice.localModel)?.name ?? '本地模型') : '云端识别'} onPress={go(onOpenVoice)} />
      </Group>

      <SectionLabel>电脑</SectionLabel>
      <Group>
        <ListRow first icon="terminal" title="远程编程"
          value={remote.phase !== 'ready' ? '未设置' : online ? `${online} 台在线` : remote.devices.length ? '电脑离线' : ''} onPress={go(onOpenRemote)} />
      </Group>

      <SectionLabel>个性化</SectionLabel>
      <Group>
        <ListRow first icon="user" title="关于我与回答风格" value={agent.memoryEnabled ? (memories.length ? `${memories.length} 条记忆` : '') : '记忆已关'} onPress={go(onOpenPersonalization)} />
        <ListRow icon="bookmark" title="聊天记忆" value={memoryBox.enabled ? '开' : '关'} onPress={go(onOpenMemoryBox)} />
        <ListRow icon="globe" title="联网与手机操作" value={agent.webSearch === 'off' ? '联网已关' : '联网已开'} onPress={go(onOpenTools)} />
        <ListRow icon="moon" title="外观" right={<View accessibilityRole="radiogroup" accessibilityLabel="外观" style={styles.segment}>
          {(['system', 'light', 'dark'] as const).map((value) => <Pressable key={value} accessibilityRole="radio" accessibilityLabel={APPEARANCE_LABEL[value]}
            accessibilityState={{ selected: value === appearance }} hitSlop={4} onPress={() => void setAppearance(value)}
            style={[styles.segmentItem, value === appearance && styles.segmentActive]}>
            <Text style={[styles.segmentText, value === appearance && styles.segmentTextActive]}>{appearanceShort[value]}</Text>
          </Pressable>)}
        </View>} />
      </Group>

      <SectionLabel>数据与帮助</SectionLabel>
      <Group>
        <ListRow first icon="archive" title="本机备份与恢复" detail="ZIP 文件；不含电脑远程会话" onPress={() => setBackupOpen(true)} />
        <ListRow icon="regenerate" title="同步远程会话" detail="重新读取电脑会话和最近对话内容" onPress={() => void recoverRemote()} />
        <ListRow icon="pulse" title="网络诊断" onPress={go(onOpenNetwork)} />
        <ListRow icon="info" title="关于与反馈" value="QQ 群 881490534" onPress={go(onOpenAbout)} />
      </Group>

      <View style={styles.privacy}>
        <Icon name="lock" size={14} color={colors.subtle} />
        <Text style={styles.privacyText}>对话保存在这台设备上，只在发送时交给你选择的服务。</Text>
      </View>
    </View>
    <AppDialog visible={visible && backupOpen} title="本机备份与恢复" icon="archive" onClose={() => setBackupOpen(false)}
      message={'备份包括所有对话、助手的记忆和智能体、聊天伙伴和它们的记忆匣，以及用到的图片和文件。API 密钥、电脑配对和设置不包括在内。\n\n恢复是合并：手机上已有的内容不会被覆盖或删除。'}
      actions={[
        { label: '生成备份文件', tone: 'primary', onPress: () => runBackup('export') },
        { label: '从备份文件恢复', tone: 'secondary', onPress: () => runBackup('restore') },
        { label: '取消', tone: 'secondary', onPress: () => setBackupOpen(false) },
      ]} />
    <AppDialog visible={visible && Boolean(backupWork)} title={backupWork?.title ?? ''} icon="archive" message={progressText(backupWork?.progress ?? null)}
      actions={[{ label: '请稍等', disabled: true }]} dismissible={false} onClose={() => undefined}><ActivityIndicator color={colors.primary} /></AppDialog>
    <AppDialog visible={visible && Boolean(backupResult)} title={backupResult?.title ?? ''} icon="archive" message={backupResult?.message}
      actions={[{ label: '好', tone: 'primary', onPress: () => setBackupResult(null) }]} onClose={() => setBackupResult(null)} />
    <AppDialog visible={visible && Boolean(remoteRecoveryWork)} title="正在同步远程会话" icon="regenerate"
      message={remoteRecoveryWork === 'checking' ? '正在确认电脑连接…' : remoteRecoveryWork === 'directory' ? '正在刷新 Agent 和会话目录…' : '正在合并最近对话内容…'}
      actions={[{ label: '同步中', disabled: true }]} dismissible={false} onClose={() => undefined}><ActivityIndicator color={colors.primary} /></AppDialog>
    <AppDialog visible={visible && Boolean(remoteRecoveryResult)} title={remoteRecoveryResult?.title ?? ''} icon="regenerate" message={remoteRecoveryResult?.message}
      actions={[{ label: '好', tone: 'primary', onPress: () => setRemoteRecoveryResult(null) }]} onClose={() => setRemoteRecoveryResult(null)} />
  </Sheet>;
}

const useStyles = themed((c, d) => StyleSheet.create({
  body: { paddingHorizontal: 16, paddingBottom: 24, width: '100%', maxWidth: 640, alignSelf: 'center' },
  appCard: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8, padding: 14, borderRadius: 18, backgroundColor: c.card, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  mark: { width: 40, height: 40 },
  name: { color: c.text, fontSize: 16, fontWeight: '600', letterSpacing: -0.2 },
  version: { color: c.textMuted, fontSize: 12.5 },
  updateButton: { height: 32, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
  updateText: { color: c.text, fontSize: 13, fontWeight: '500' },
  segment: { flexDirection: 'row', padding: 2, borderRadius: 9, backgroundColor: c.surfaceStrong },
  segmentItem: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 7 },
  segmentActive: { backgroundColor: c.card, shadowColor: '#0E1325', shadowOpacity: 0.08, shadowRadius: 2, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  segmentText: { color: c.textMuted, fontSize: 12.5 },
  segmentTextActive: { color: c.text, fontWeight: '600' },
  privacy: { flexDirection: 'row', alignItems: 'center', gap: 6, justifyContent: 'center', marginTop: 24, paddingHorizontal: 16 },
  privacyText: { color: colors.subtle, fontSize: 12.5, textAlign: 'center' },
}));
