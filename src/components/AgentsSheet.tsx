import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { AGENT_COLORS, AGENT_TEMPLATES, CAPABILITY_LABELS, deleteAgent, saveAgent, useAgents, type AgentDraft } from '../agent/agents';
import { ALL_CAPABILITIES, type AgentCapability, type CustomAgent } from '../agent/types';
import { useApp } from '../state/AppContext';
import { colors, prettyModel, radius, themed } from '../theme';
import { Icon } from './Icon';
import { ToggleRow } from './SettingsParts';
import { AppDialog, Chip, Group, MotionPressable, PrimaryButton, SectionLabel, Sheet, showToast } from './ui';

export function AgentAvatar({ agent, size = 36 }: { agent: Pick<CustomAgent, 'icon' | 'color'>; size?: number }) {
  const styles = useStyles();
  return <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: `${agent.color}1F` }]}>
    <Text numberOfLines={1} adjustsFontSizeToFit style={[styles.avatarText, { color: agent.color, fontSize: size * 0.46 }]}>{agent.icon}</Text>
  </View>;
}

const EMPTY: AgentDraft = { name: '', icon: '', color: AGENT_COLORS[0], description: '', instructions: '', capabilities: ['search', 'image', 'files'], starters: [], providerId: null, model: null };

/** 智能体: custom assistants with their own instructions and tools. */
export function AgentsSheet({ visible, onClose, onStart }: { visible: boolean; onClose: () => void; onStart: (agent: CustomAgent) => void }) {
  const styles = useStyles();
  const agents = useAgents();
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [menu, setMenu] = useState<CustomAgent | null>(null);
  const [confirm, setConfirm] = useState<CustomAgent | null>(null);
  return <Sheet visible={visible} title="智能体" onClose={onClose} presentation="page">
    <View style={styles.body}>
      <Text style={styles.lead}>把常用的角色、指令和工具存成一个智能体，一键开始专属对话。</Text>
      {agents.length ? <>
        <SectionLabel>我的智能体</SectionLabel>
        <Group>
          {agents.map((agent, index) => <Pressable key={agent.id} accessibilityRole="button" accessibilityLabel={`和 ${agent.name} 对话`}
            onPress={() => { onClose(); onStart(agent); }} onLongPress={() => setMenu(agent)} delayLongPress={320}
            style={({ pressed }) => [styles.row, index > 0 && styles.divider, pressed && { backgroundColor: colors.surfaceStrong }]}>
            <AgentAvatar agent={agent} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle} numberOfLines={1}>{agent.name}</Text>
              <Text style={styles.rowDetail} numberOfLines={1}>{agent.description || agent.capabilities.map((item) => CAPABILITY_LABELS[item].label).join(' · ') || '纯对话'}</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel={`编辑 ${agent.name}`} hitSlop={8} onPress={() => setDraft({ ...agent })} style={styles.edit}>
              <Icon name="edit" size={17} color={colors.subtle} />
            </Pressable>
          </Pressable>)}
        </Group>
      </> : null}
      <PrimaryButton label="新建智能体" icon="plus" onPress={() => setDraft({ ...EMPTY })} style={{ marginTop: 18 }} />

      <SectionLabel>从模板开始</SectionLabel>
      <View style={styles.templates}>
        {AGENT_TEMPLATES.map((template) => <MotionPressable key={template.name} scaleTo={0.97} wrapperStyle={styles.templateWrap} accessibilityRole="button" accessibilityLabel={`用模板 ${template.name}`}
          onPress={() => setDraft({ ...template })} style={styles.template}>
          <AgentAvatar agent={template} size={32} />
          <Text style={styles.templateName}>{template.name}</Text>
          <Text style={styles.templateDetail} numberOfLines={2}>{template.description}</Text>
        </MotionPressable>)}
      </View>
    </View>

    <AgentEditor draft={draft} onClose={() => setDraft(null)} />
    <AppDialog visible={Boolean(menu)} title={menu?.name ?? ''} icon="bot" onClose={() => setMenu(null)} actions={[
      { label: '编辑', tone: 'secondary', onPress: () => { const agent = menu; setMenu(null); if (agent) setDraft({ ...agent }); } },
      { label: '删除', tone: 'danger', onPress: () => { const agent = menu; setMenu(null); if (agent) setConfirm(agent); } },
    ]} />
    <AppDialog visible={Boolean(confirm)} title={`删除“${confirm?.name ?? ''}”？`} message="用它进行过的对话会保留，之后改由默认助手回答。" icon="trash" onClose={() => setConfirm(null)} actions={[
      { label: '取消', tone: 'secondary', onPress: () => setConfirm(null) },
      { label: '删除', tone: 'danger', onPress: () => { const agent = confirm; setConfirm(null); if (agent) void deleteAgent(agent.id).then(() => showToast('已删除')); } },
    ]} />
  </Sheet>;
}

function AgentEditor({ draft, onClose }: { draft: AgentDraft | null; onClose: () => void }) {
  const styles = useStyles();
  const { providers } = useApp();
  const [value, setValue] = useState<AgentDraft>(EMPTY);
  const [starters, setStarters] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!draft) return;
    setValue(draft);
    setStarters(draft.starters.join('\n'));
  }, [draft]);
  const set = (patch: Partial<AgentDraft>) => setValue((current) => ({ ...current, ...patch }));
  const toggle = (capability: AgentCapability, on: boolean) => set({ capabilities: on ? [...value.capabilities, capability] : value.capabilities.filter((item) => item !== capability) });
  const chatProviders = providers.filter((item) => item.chatModel);
  const save = async () => {
    setSaving(true);
    try {
      await saveAgent({ ...value, starters: starters.split('\n') });
      showToast(draft?.id ? '已保存' : '已创建');
      onClose();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存失败', 'alert');
    } finally {
      setSaving(false);
    }
  };
  return <Sheet visible={Boolean(draft)} title={draft?.id ? '编辑智能体' : '新建智能体'} onClose={onClose} presentation="page"
    footer={<PrimaryButton label={draft?.id ? '保存' : '创建'} loading={saving} disabled={!value.name.trim()} onPress={() => void save()} />}>
    <View style={styles.body}>
      <View style={styles.identity}>
        <AgentAvatar agent={{ icon: value.icon.trim() || [...value.name.trim()][0] || '✦', color: value.color }} size={64} />
        <View style={{ flex: 1, gap: 8 }}>
          <TextInput value={value.name} onChangeText={(name) => set({ name })} placeholder="名字，如“英语陪练”" placeholderTextColor={colors.subtle} maxLength={24} style={styles.nameInput} />
          <View style={styles.inline}>
            <TextInput value={value.icon} onChangeText={(icon) => set({ icon })} maxLength={8} placeholder="图标" placeholderTextColor={colors.subtle} style={styles.iconInput} />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.colors}>
              {AGENT_COLORS.map((color) => <Pressable key={color} accessibilityRole="radio" accessibilityState={{ selected: value.color === color }} accessibilityLabel="颜色"
                hitSlop={8} onPress={() => set({ color })} style={[styles.swatch, { backgroundColor: color }, value.color === color && styles.swatchOn]} />)}
            </ScrollView>
          </View>
        </View>
      </View>

      <SectionLabel>简介</SectionLabel>
      <TextInput value={value.description} onChangeText={(description) => set({ description })} placeholder="一句话说明它擅长什么" placeholderTextColor={colors.subtle} maxLength={60} style={styles.input} />

      <SectionLabel>指令</SectionLabel>
      <TextInput value={value.instructions} onChangeText={(instructions) => set({ instructions })} multiline textAlignVertical="top" maxLength={6000}
        placeholder="告诉它扮演谁、怎么回答、要注意什么。例如：你是雅思口语考官，每次只问一个问题，听完回答后给出评分和改进建议。"
        placeholderTextColor={colors.subtle} style={[styles.input, styles.multiline]} />

      <SectionLabel>能力</SectionLabel>
      <Group>
        {ALL_CAPABILITIES.map((capability, index) => <ToggleRow key={capability} first={index === 0} title={CAPABILITY_LABELS[capability].label} detail={CAPABILITY_LABELS[capability].detail}
          value={value.capabilities.includes(capability)} onChange={(on) => toggle(capability, on)} />)}
      </Group>

      <SectionLabel>开场问题（每行一个，最多 4 个）</SectionLabel>
      <TextInput value={starters} onChangeText={setStarters} multiline textAlignVertical="top" placeholder={'帮我练习面试自我介绍\n纠正我这段英文'} placeholderTextColor={colors.subtle} style={[styles.input, styles.multilineSmall]} />

      <SectionLabel>对话模型</SectionLabel>
      <View style={styles.chips}>
        <Chip label="跟随当前选择" selected={!value.providerId} onPress={() => set({ providerId: null, model: null })} />
        {chatProviders.map((provider) => <Chip key={provider.id} label={`${provider.name} · ${prettyModel(provider.chatModel)}`} selected={value.providerId === provider.id}
          onPress={() => set({ providerId: provider.id, model: provider.chatModel ?? null })} />)}
      </View>
      {value.providerId ? <TextInput value={value.model ?? ''} onChangeText={(model) => set({ model })} placeholder="模型 ID（可改成该服务商的其他模型）" placeholderTextColor={colors.subtle}
        autoCapitalize="none" autoCorrect={false} style={[styles.input, { marginTop: 10 }]} /> : null}
    </View>
  </Sheet>;
}

const useStyles = themed((c, d) => StyleSheet.create({
  body: { paddingHorizontal: 16, paddingBottom: 28 },
  lead: { color: colors.textMuted, fontSize: 14, lineHeight: 21, marginTop: 6, marginHorizontal: 4 },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  rowTitle: { color: colors.text, fontSize: 15.5, fontWeight: '500' },
  rowDetail: { color: colors.subtle, fontSize: 12.5, marginTop: 2 },
  edit: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  templates: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  templateWrap: { width: '48%', flexGrow: 1 },
  template: { padding: 14, borderRadius: 20, backgroundColor: colors.surface, gap: 6, minHeight: 118 },
  templateName: { color: colors.text, fontSize: 15, fontWeight: '600', marginTop: 4 },
  templateDetail: { color: colors.subtle, fontSize: 12.5, lineHeight: 17 },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 14 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  nameInput: { height: 46, borderRadius: 14, paddingHorizontal: 14, backgroundColor: colors.surface, color: colors.text, fontSize: 16, fontWeight: '600' },
  iconInput: { width: 54, height: 38, borderRadius: 12, textAlign: 'center', backgroundColor: colors.surface, color: colors.text, fontSize: 17 },
  colors: { gap: 8, alignItems: 'center', paddingRight: 8 },
  swatch: { width: 26, height: 26, borderRadius: 13 },
  swatchOn: { borderWidth: 2.5, borderColor: colors.text },
  input: { minHeight: 46, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 11, backgroundColor: colors.surface, color: colors.text, fontSize: 15 },
  multiline: { minHeight: 150, lineHeight: 21 },
  multilineSmall: { minHeight: 84, lineHeight: 21 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
}));
