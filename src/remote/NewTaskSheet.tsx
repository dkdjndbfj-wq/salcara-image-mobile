import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Icon } from '../components/Icon';
import { Chip, PrimaryButton, Sheet, showToast } from '../components/ui';
import { colors, prettyModel, radius } from '../theme';
import type { ApprovalMode, DeviceStatus, Project, ToolId } from './client';
import { Segmented } from './parts';
import { listModels, listProjects, startSession } from './store';

const MODES: Array<{ value: ApprovalMode; title: string; detail: string }> = [
  { value: 'ask', title: '每一步都问我', detail: '运行命令和改文件前都要你在手机上点允许' },
  { value: 'auto_edits', title: '自动改文件，命令问我', detail: '项目里的文件直接改，运行命令前问你' },
  { value: 'auto_all', title: '全部自动', detail: '命令和改文件都不再询问，只在你信任这个项目时用' },
];

export function NewTaskSheet({ device, visible, initialTool, onClose, onStarted }: {
  device: DeviceStatus | undefined; visible: boolean; initialTool?: ToolId; onClose: () => void; onStarted: (sessionKey: string) => void;
}) {
  const available = (id: string) => Boolean(device?.tools.find((tool) => tool.id === id)?.available);
  const [tool, setTool] = useState<ToolId>('codex');
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [cwd, setCwd] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [mode, setMode] = useState<ApprovalMode>('ask');
  const [prompt, setPrompt] = useState('');
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!visible || !device) return;
    const first: ToolId = initialTool && available(initialTool) ? initialTool : available('codex') ? 'codex' : 'claude';
    setTool(first); setPrompt(''); setModel(''); setMode('ask');
    setProjects(device.projects ?? []);
    setCwd((current) => current && device.projects?.some((item) => item.path === current) ? current : device.projects?.[0]?.path ?? '');
    setLoadingProjects(true);
    let alive = true;
    listProjects(device.deviceId).then((list) => {
      if (!alive || !list.length) return;
      setProjects(list);
      setCwd((current) => list.some((item) => item.path === current) ? current : list[0].path);
    }).catch(() => undefined).finally(() => { if (alive) setLoadingProjects(false); });
    return () => { alive = false; };
  }, [visible, device?.deviceId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!visible || !device) return;
    let alive = true;
    setModels([]);
    void listModels(device.deviceId, tool).then((list) => { if (alive) setModels(list.slice(0, 8)); });
    return () => { alive = false; };
  }, [visible, device?.deviceId, tool]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    if (!device) return;
    setStarting(true);
    try {
      const sessionKey = await startSession(device.deviceId, { tool, cwd, prompt: prompt.trim(), model, approval: mode });
      onStarted(sessionKey);
    } catch (error) {
      showToast((error as Error).message, 'alert');
    } finally { setStarting(false); }
  };

  const ready = Boolean(cwd && prompt.trim() && available(tool) && device?.online);
  return <Sheet visible={visible} title="新任务" subtitle={device ? `在 ${device.name} 上运行` : undefined} onClose={onClose}
    footer={<PrimaryButton label={device?.online === false ? '电脑不在线' : '开始'} icon="arrowUp" loading={starting} disabled={!ready} onPress={() => void start()} />}>
    <View style={styles.body}>
      <Segmented value={tool} onChange={setTool} options={[
        { value: 'codex', label: available('codex') ? 'Codex' : 'Codex（未安装）', disabled: !available('codex') },
        { value: 'claude', label: available('claude') ? 'Claude Code' : 'Claude Code（未安装）', disabled: !available('claude') },
      ]} />

      <Text style={styles.label}>项目</Text>
      {projects.length ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} keyboardShouldPersistTaps="handled">
        {projects.map((project) => <Chip key={project.path} label={project.name} icon="archive" selected={project.path === cwd} onPress={() => setCwd(project.path)} />)}
        {loadingProjects ? <ActivityIndicator color={colors.faint} /> : null}
      </ScrollView> : loadingProjects ? <ActivityIndicator color={colors.primary} style={{ alignSelf: 'flex-start', marginLeft: 4 }} />
        : <Text style={styles.hint}>电脑上还没有允许远程操作的项目文件夹，请在电脑端 SalcaraBridge 里添加。</Text>}
      {cwd ? <Text style={styles.path} numberOfLines={1}>{cwd}</Text> : null}

      <Text style={styles.label}>要做什么</Text>
      <TextInput value={prompt} onChangeText={setPrompt} multiline placeholder="例如：修复登录页在小屏上的布局问题，然后跑一下测试" placeholderTextColor={colors.subtle} style={styles.prompt} accessibilityLabel="任务描述" />

      <Text style={styles.label}>模型 <Text style={styles.optional}>可选</Text></Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} keyboardShouldPersistTaps="handled">
        <Chip label="默认" selected={!model} onPress={() => setModel('')} />
        {models.map((item) => <Chip key={item} label={prettyModel(item)} selected={model === item} onPress={() => setModel(item)} />)}
      </ScrollView>
      <TextInput value={model} onChangeText={setModel} autoCapitalize="none" autoCorrect={false} placeholder="或输入模型名，留空用电脑上的默认设置" placeholderTextColor={colors.subtle} style={styles.modelInput} />

      <Text style={styles.label}>需要我批准吗</Text>
      <View style={styles.modes}>
        {MODES.map((item, index) => {
          const selected = item.value === mode;
          const danger = item.value === 'auto_all';
          return <Pressable key={item.value} accessibilityRole="radio" accessibilityState={{ checked: selected }} onPress={() => setMode(item.value)}
            style={[styles.mode, index > 0 && styles.modeDivider, selected && (danger ? styles.modeDanger : styles.modeOn)]}>
            <View style={[styles.radio, selected && { borderColor: danger ? colors.danger : colors.primary }]}>{selected ? <View style={[styles.radioDot, danger && { backgroundColor: colors.danger }]} /> : null}</View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[styles.modeTitle, danger && selected && { color: colors.danger }]}>{item.title}</Text>
              <Text style={[styles.modeDetail, danger && selected && { color: colors.danger }]}>{item.detail}</Text>
            </View>
          </Pressable>;
        })}
      </View>
      {mode === 'auto_all' ? <View style={styles.warning}>
        <Icon name="alert" size={16} color={colors.danger} />
        <Text style={styles.warningText}>它可以不经确认运行任何命令、删除或改写项目里的文件。</Text>
      </View> : null}
    </View>
  </Sheet>;
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 8 },
  label: { color: colors.text, fontSize: 14, fontWeight: '600', marginTop: 20, marginBottom: 8 },
  optional: { color: colors.subtle, fontSize: 12.5, fontWeight: '400' },
  hint: { color: colors.subtle, fontSize: 13, lineHeight: 19 },
  chips: { gap: 8, paddingRight: 8, alignItems: 'center' },
  path: { color: colors.subtle, fontSize: 12, marginTop: 6, marginLeft: 4 },
  prompt: { minHeight: 110, maxHeight: 220, borderRadius: 16, backgroundColor: colors.surfaceStrong, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12, color: colors.text, fontSize: 15.5, lineHeight: 22, textAlignVertical: 'top' },
  modelInput: { height: 42, borderRadius: 12, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, paddingHorizontal: 12, color: colors.text, fontSize: 14, marginTop: 8 },
  modes: { borderRadius: radius.md, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surface },
  mode: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  modeDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  modeOn: { backgroundColor: colors.primarySoft },
  modeDanger: { backgroundColor: colors.dangerSurface },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, borderColor: colors.faint, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.primary },
  modeTitle: { color: colors.text, fontSize: 15, fontWeight: '500' },
  modeDetail: { color: colors.subtle, fontSize: 12.5, lineHeight: 17 },
  warning: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 10, padding: 12, borderRadius: 12, backgroundColor: colors.dangerSurface },
  warningText: { flex: 1, color: colors.danger, fontSize: 13, lineHeight: 19, fontWeight: '500' },
});
