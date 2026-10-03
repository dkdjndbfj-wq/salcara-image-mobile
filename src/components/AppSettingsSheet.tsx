import * as Application from 'expo-application';
import React, { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { useMemories } from '../agent/memory';
import { useAgentSettings } from '../agent/settings';
import { useMemoryBoxSettings } from '../memorybox/settings';
import { useRemote } from '../remote/store';
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
  // Sub-pages open on top of Settings, so Back returns here instead of to the chat.
  const go = (callback: () => void) => () => { callback(); };
  const leave = (callback: () => void) => () => { onClose(); callback(); };
  const appearance = useAppearance();
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const pick = (next: 'system' | 'light' | 'dark') => () => { setAppearanceOpen(false); void setAppearance(next); };
  return <Sheet visible={visible} title="设置" onClose={onClose} presentation="page">
    <View style={styles.body}>
      <View style={styles.hero}>
        <View style={styles.mark}><BrandMark size={76} /></View>
        <Text style={styles.name}>Salcara</Text>
        <Text style={styles.version}>版本 {Application.nativeApplicationVersion ?? '开发版'}</Text>
      </View>

      <SectionLabel>模型与 API</SectionLabel>
      <Group>
        <ListRow first icon="chat" title="对话模型" detail="助手和聊天通用" value={prettyModel(chatProvider?.chatModel) || '未设置'} onPress={go(() => onOpenModels('chat'))} />
        <ListRow icon="palette" title="绘图" detail="模型、画幅、作图描述" value={prettyModel(imageProvider?.model) || '未设置'} onPress={go(() => onOpenModels('image'))} />
        <ListRow icon="mic" title="语音" value={voice.inputEngine === 'local' && localModelsOffered() ? (modelById(voice.localModel)?.name ?? '本地模型') : '云端识别'} onPress={go(onOpenVoice)} />
        <ListRow icon="server" title="API 管理" detail="各平台的地址和密钥" value={providers.length ? `${providers.length} 个` : '未添加'} onPress={go(onOpenProviders)} />
      </Group>

      <SectionLabel>电脑</SectionLabel>
      <Group>
        <ListRow first icon="code" title="远程编程" detail="在手机上用电脑里的 Codex 和 Claude Code"
          value={remote.phase !== 'ready' ? '未设置' : online ? `${online} 台在线` : remote.devices.length ? '电脑离线' : ''} onPress={go(onOpenRemote)} />
      </Group>

      <SectionLabel>个性化</SectionLabel>
      <Group>
        <ListRow first icon="user" title="关于我与回答风格" detail="助手的记忆也在这里" value={agent.memoryEnabled ? (memories.length ? `${memories.length} 条记忆` : '') : '记忆已关'} onPress={go(onOpenPersonalization)} />
        <ListRow icon="bookmark" title="聊天记忆" detail="聊天空间的角色记得你说过的事" value={memoryBox.enabled ? '开' : '关'} onPress={go(onOpenMemoryBox)} />
        <ListRow icon="globe" title="联网与手机操作" value={agent.webSearch === 'off' ? '联网已关' : '联网已开'} onPress={go(onOpenTools)} />
        <ListRow icon="moon" title="外观" detail="深色模式可以跟随系统自动切换" value={APPEARANCE_LABEL[appearance]} onPress={() => setAppearanceOpen(true)} />
      </Group>

      <SectionLabel>其他</SectionLabel>
      <Group>
        <ListRow first icon="cloudDown" title="检查更新" onPress={leave(onCheckUpdates)} />
        <ListRow icon="info" title="关于与反馈" value="QQ 群 881490534" onPress={go(onOpenAbout)} />
        <ListRow icon="pulse" title="网络诊断" detail="连不上 API 时用" onPress={go(onOpenNetwork)} />
        <ListRow icon="archive" title="备份与恢复" detail="对话、记忆、聊天伙伴和图片打包成一个文件" onPress={() => setBackupOpen(true)} />
      </Group>

      <View style={styles.privacy}>
        <Icon name="lock" size={14} color={colors.subtle} />
        <Text style={styles.privacyText}>对话保存在这台设备上，只在发送时交给你选择的服务。</Text>
      </View>
    </View>
    <AppDialog visible={visible && appearanceOpen} title="外观" icon="moon" onClose={() => setAppearanceOpen(false)}
      message="跟随系统时，手机切到深色模式，Salcara 也会一起变成深色。"
      actions={(['system', 'light', 'dark'] as const).map((value) => ({ label: `${APPEARANCE_LABEL[value]}${value === appearance ? ' ✓' : ''}`,
        tone: value === appearance ? 'primary' as const : 'secondary' as const, onPress: pick(value) }))} />
    <AppDialog visible={visible && backupOpen} title="备份与恢复" icon="archive" onClose={() => setBackupOpen(false)}
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
  </Sheet>;
}

const useStyles = themed((c, d) => StyleSheet.create({
  body: { paddingHorizontal: 16, paddingBottom: 24 },
  hero: { alignItems: 'center', paddingTop: 18, paddingBottom: 6, gap: 6 },
  mark: { width: 76, height: 76, marginBottom: 8 },
  name: { color: colors.text, fontSize: 22, fontWeight: '700', letterSpacing: -0.5 },
  version: { color: colors.subtle, fontSize: 13 },
  privacy: { flexDirection: 'row', alignItems: 'center', gap: 6, justifyContent: 'center', marginTop: 30, paddingHorizontal: 16 },
  privacyText: { color: colors.subtle, fontSize: 12.5, textAlign: 'center' },
}));
