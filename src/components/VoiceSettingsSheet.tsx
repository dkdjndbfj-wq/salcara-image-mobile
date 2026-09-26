import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, TextInput, View } from 'react-native';

import { useApp } from '../state/AppContext';
import { colors, radius } from '../theme';
import { ASR_MODELS, formatBytes, MIRRORS, modelSize, type AsrModel } from '../voice/catalog';
import { cancelInstall, deleteModel, installModel, refreshModels, useModelStatuses, type ModelStatus } from '../voice/models';
import { localEngineAvailable, voiceNative } from '../voice/native';
import { supportsSpeechApi } from '../voice/providers';
import { updateVoiceSettings, useVoiceSettings, VOICES, type VoiceSettings } from '../voice/settings';
import { Icon } from './Icon';
import { MotionPressable } from './MotionPressable';
import { AppDialog, Chip, Group, SectionLabel, Sheet } from './ui';

const TIER_COLORS: Record<AsrModel['tier'], string> = { 极速: '#12A150', 均衡: colors.primary, 精准: '#8B5CF6' };

function Progress({ fraction }: { fraction: number }) {
  const value = useRef(new Animated.Value(fraction)).current;
  useEffect(() => { Animated.timing(value, { toValue: fraction, duration: 300, easing: Easing.out(Easing.quad), useNativeDriver: false }).start(); }, [fraction, value]);
  return <View style={styles.track}>
    <Animated.View style={[styles.fill, { width: value.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }]} />
  </View>;
}

function ModelCard({ model, status, selected, onUse, onDownload, onCancel, onDelete }: {
  model: AsrModel; status: ModelStatus; selected: boolean;
  onUse: () => void; onDownload: () => void; onCancel: () => void; onDelete: () => void;
}) {
  const installed = status.state === 'installed';
  const tint = TIER_COLORS[model.tier];
  return <MotionPressable accessibilityRole="button" accessibilityLabel={model.name} accessibilityState={{ selected }} scaleTo={0.985}
    disabled={!installed} onPress={onUse} style={[styles.model, selected && styles.modelSelected]}>
    <View style={styles.modelHead}>
      <View style={[styles.tier, { backgroundColor: `${tint}1A` }]}><Text style={[styles.tierText, { color: tint }]}>{model.tier}{model.recommended ? ' · 推荐' : ''}</Text></View>
      <Text style={styles.modelName} numberOfLines={1}>{model.name}</Text>
      {selected && installed ? <View style={styles.inUse}><Icon name="check" size={13} color="#FFFFFF" strokeWidth={2.6} /><Text style={styles.inUseText}>使用中</Text></View> : null}
    </View>
    <Text style={styles.modelMeta}>{model.languages} · {model.streaming ? '流式实时' : '整句实时刷新'} · {formatBytes(modelSize(model))}</Text>
    <Text style={styles.modelSummary}>{model.summary}</Text>
    {status.state === 'downloading' ? <View style={styles.downloading}>
      <Progress fraction={status.total ? status.received / status.total : 0} />
      <View style={styles.downloadRow}>
        <Text style={styles.downloadText}>{Math.floor((status.received / Math.max(1, status.total)) * 100)}% · {formatBytes(status.received)} / {formatBytes(status.total)}</Text>
        <MotionPressable accessibilityRole="button" accessibilityLabel={`取消下载 ${model.name}`} onPress={onCancel} style={styles.textButton}><Text style={styles.textButtonLabel}>取消</Text></MotionPressable>
      </View>
    </View> : <View style={styles.modelActions}>
      {status.state === 'error' ? <Text style={styles.error} numberOfLines={2}>{status.error}</Text> : <View style={{ flex: 1 }} />}
      {installed ? <>
        {!selected ? <MotionPressable accessibilityRole="button" accessibilityLabel={`使用 ${model.name}`} onPress={onUse} style={styles.smallPrimary}><Text style={styles.smallPrimaryText}>使用</Text></MotionPressable> : null}
        <MotionPressable accessibilityRole="button" accessibilityLabel={`删除 ${model.name}`} onPress={onDelete} style={styles.textButton}><Text style={[styles.textButtonLabel, { color: colors.danger }]}>删除</Text></MotionPressable>
      </> : <MotionPressable accessibilityRole="button" accessibilityLabel={`下载 ${model.name}`} onPress={onDownload} style={styles.smallPrimary}>
        <Icon name="download" size={14} color="#FFFFFF" strokeWidth={2.2} />
        <Text style={styles.smallPrimaryText}>{status.state === 'error' ? '重试' : '下载'}</Text>
      </MotionPressable>}
    </View>}
  </MotionPressable>;
}

function Field({ label, value, onChange, suggestions }: { label: string; value: string; onChange: (value: string) => void; suggestions: string[] }) {
  return <View style={styles.field}>
    <Text style={styles.fieldLabel}>{label}</Text>
    <TextInput value={value} onChangeText={onChange} autoCapitalize="none" autoCorrect={false} style={styles.input} placeholderTextColor={colors.subtle} />
    <View style={styles.chips}>{suggestions.map((item) => <Chip key={item} label={item} selected={item === value} onPress={() => onChange(item)} />)}</View>
  </View>;
}

function ProviderChips({ label, value, onChange, allowNone }: { label: string; value: string | null; onChange: (id: string | null) => void; allowNone?: string }) {
  const { providers, chatProvider } = useApp();
  const usable = providers.filter((item) => supportsSpeechApi(item));
  const fallback = supportsSpeechApi(chatProvider) ? chatProvider.id : usable[0]?.id ?? null;
  const current = value ?? (allowNone ? null : fallback);
  return <View style={styles.field}>
    <Text style={styles.fieldLabel}>{label}</Text>
    {usable.length ? <View style={styles.chips}>
      {allowNone ? <Chip label={allowNone} selected={current === null} onPress={() => onChange(null)} /> : null}
      {usable.map((item) => <Chip key={item.id} label={item.name} selected={current === item.id} onPress={() => onChange(item.id)} />)}
    </View> : <Text style={styles.note}>没有 OpenAI 兼容的服务商（Claude 原生接口不提供语音接口）。</Text>}
  </View>;
}

export function VoiceSettingsSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const settings = useVoiceSettings();
  const statuses = useModelStatuses();
  const [confirm, setConfirm] = React.useState<AsrModel | null>(null);
  const engineReady = localEngineAvailable();
  const hasNative = Boolean(voiceNative());
  useEffect(() => { if (visible) void refreshModels().catch(() => undefined); }, [visible]);
  const set = (patch: Partial<VoiceSettings>) => void updateVoiceSettings(patch);

  const download = (model: AsrModel) => {
    void installModel(model.id, settings.mirror).then(() => {
      if (!settings.localModel) set({ localModel: model.id, inputEngine: 'local' });
    });
  };

  return <Sheet visible={visible} title="语音" onClose={onClose} presentation="page">
    <View style={styles.body}>
      <SectionLabel>语音输入</SectionLabel>
      <Group style={styles.group}>
        <View style={styles.chips}>
          <Chip label="本地模型 · 离线" selected={settings.inputEngine === 'local'} onPress={() => set({ inputEngine: 'local' })} />
          <Chip label="云端识别" selected={settings.inputEngine === 'cloud'} onPress={() => set({ inputEngine: 'cloud' })} />
        </View>
        <Text style={styles.note}>{settings.inputEngine === 'local'
          ? '声音只在手机上识别，不联网、不产生费用。下载一次即可离线使用。'
          : '录音发送给服务商转成文字，无需下载模型；按服务商的语音识别计费。'}</Text>
      </Group>

      {settings.inputEngine === 'local' ? <>
        {!hasNative || !engineReady ? <View style={styles.warning}>
          <Icon name="alert" size={18} color={colors.warningText} />
          <Text style={styles.warningText}>{hasNative ? '这台手机不是 64 位 ARM 处理器，无法运行本地模型，请使用云端识别。' : '当前安装包没有语音组件，请安装最新完整 APK。'}</Text>
        </View> : null}
        <View style={{ height: 10 }} />
        {ASR_MODELS.map((model) => <ModelCard key={model.id} model={model} status={statuses[model.id]} selected={settings.localModel === model.id}
          onUse={() => set({ localModel: model.id })} onDownload={() => download(model)} onCancel={() => void cancelInstall(model.id)} onDelete={() => setConfirm(model)} />)}
        <Group style={styles.group}>
          <Text style={styles.fieldLabel}>下载线路</Text>
          <View style={styles.chips}>
            {(Object.keys(MIRRORS) as Array<keyof typeof MIRRORS>).map((key) => <Chip key={key} label={MIRRORS[key].label} selected={settings.mirror === key} onPress={() => set({ mirror: key })} />)}
          </View>
          <Text style={styles.note}>国内网络建议用“国内镜像”；下载中断后重试会从已完成的文件继续。</Text>
        </Group>
      </> : <Group style={styles.group}>
        <ProviderChips label="识别服务商" value={settings.transcribeProviderId} onChange={(id) => set({ transcribeProviderId: id })} />
        <Field label="识别模型" value={settings.transcribeModel} onChange={(value) => set({ transcribeModel: value })} suggestions={['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1']} />
      </Group>}

      <SectionLabel>语音对话</SectionLabel>
      <Group style={styles.group}>
        <View style={styles.chips}>
          <Chip label="自动" selected={settings.conversationEngine === 'auto'} onPress={() => set({ conversationEngine: 'auto' })} />
          <Chip label="分段语音" selected={settings.conversationEngine === 'cascade'} onPress={() => set({ conversationEngine: 'cascade' })} />
          <Chip label="实时语音模型" selected={settings.conversationEngine === 'realtime'} onPress={() => set({ conversationEngine: 'realtime' })} />
        </View>
        <Text style={styles.note}>{settings.conversationEngine === 'cascade'
          ? '语音识别 → 你当前的对话模型 → 语音合成。任何服务商都能用，还能在对话里继续画图，内容会保存在对话中。'
          : settings.conversationEngine === 'realtime'
            ? '端到端语音模型（如 GPT Realtime）直接听和说，延迟最低、可随时插话。需要服务商支持 Realtime 接口。'
            : '选了实时语音服务商时优先用实时语音模型，连不上会自动改用分段语音；否则直接使用分段语音。'}</Text>
      </Group>

      {settings.conversationEngine !== 'cascade' ? <Group style={styles.group}>
        <ProviderChips label="实时语音服务商" value={settings.realtimeProviderId} onChange={(id) => set({ realtimeProviderId: id })}
          allowNone={settings.conversationEngine === 'auto' ? '不使用' : undefined} />
        {settings.conversationEngine === 'realtime' || settings.realtimeProviderId ? <>
          <Field label="实时语音模型" value={settings.realtimeModel} onChange={(value) => set({ realtimeModel: value })} suggestions={['gpt-realtime-2.1', 'gpt-realtime', 'gpt-realtime-mini']} />
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>声音</Text>
            <View style={styles.chips}>{VOICES.map((voice) => <Chip key={voice.id} label={voice.label} selected={settings.realtimeVoice === voice.id} onPress={() => set({ realtimeVoice: voice.id })} />)}</View>
          </View>
        </> : null}
      </Group> : null}

      {settings.conversationEngine !== 'realtime' ? <Group style={styles.group}>
        <Text style={styles.fieldLabel}>分段语音 · 朗读回答</Text>
        <View style={styles.chips}>
          <Chip label="云端语音合成" selected={settings.speechOutput === 'cloud'} onPress={() => set({ speechOutput: 'cloud' })} />
          <Chip label="手机系统语音" selected={settings.speechOutput === 'system'} onPress={() => set({ speechOutput: 'system' })} />
        </View>
        {settings.speechOutput === 'cloud' ? <>
          <ProviderChips label="合成服务商" value={settings.ttsProviderId} onChange={(id) => set({ ttsProviderId: id })} />
          <Field label="合成模型" value={settings.ttsModel} onChange={(value) => set({ ttsModel: value })} suggestions={['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd']} />
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>声音</Text>
            <View style={styles.chips}>{VOICES.map((voice) => <Chip key={voice.id} label={voice.label} selected={settings.ttsVoice === voice.id} onPress={() => set({ ttsVoice: voice.id })} />)}</View>
          </View>
        </> : <Text style={styles.note}>免费、离线，音色取决于手机自带的语音引擎。</Text>}
        <Text style={styles.note}>听你说话使用上面“语音输入”的设置；云端合成失败时会自动改用手机系统语音。</Text>
      </Group> : null}

      <View style={styles.privacy}>
        <Icon name="lock" size={14} color={colors.subtle} />
        <Text style={styles.privacyText}>本地模型在手机上处理声音；使用云端时，录音只发送给你选择的服务商。</Text>
      </View>
    </View>
    <AppDialog visible={Boolean(confirm)} title="删除语音模型？" message={confirm ? `将释放 ${formatBytes(modelSize(confirm))} 空间，之后可以随时重新下载。` : ''} icon="trash"
      onClose={() => setConfirm(null)} actions={[
        { label: '取消', tone: 'secondary', onPress: () => setConfirm(null) },
        { label: '删除', tone: 'danger', onPress: () => {
          const model = confirm;
          setConfirm(null);
          if (!model) return;
          void deleteModel(model.id).then(() => { if (settings.localModel === model.id) set({ localModel: null }); });
        } },
      ]} />
  </Sheet>;
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 16, paddingBottom: 28 },
  group: { padding: 14, gap: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  note: { color: colors.textMuted, fontSize: 12.5, lineHeight: 18 },
  warning: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', padding: 12, borderRadius: radius.md, backgroundColor: colors.warningSurface, marginBottom: 10 },
  warningText: { flex: 1, color: colors.warningText, fontSize: 13, lineHeight: 19 },
  model: { borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, padding: 14, gap: 6, marginBottom: 10 },
  modelSelected: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  modelHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tier: { paddingHorizontal: 8, height: 22, borderRadius: 11, justifyContent: 'center' },
  tierText: { fontSize: 11.5, fontWeight: '700' },
  modelName: { flex: 1, color: colors.text, fontSize: 15.5, fontWeight: '600' },
  inUse: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, height: 22, borderRadius: 11, backgroundColor: colors.primary },
  inUseText: { color: '#FFFFFF', fontSize: 11.5, fontWeight: '600' },
  modelMeta: { color: colors.textMuted, fontSize: 12.5 },
  modelSummary: { color: colors.textSecondary, fontSize: 13.5, lineHeight: 20 },
  modelActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  downloading: { gap: 6, marginTop: 6 },
  downloadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  downloadText: { color: colors.textMuted, fontSize: 12.5, fontVariant: ['tabular-nums'] },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.surfaceStrong, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3, backgroundColor: colors.primary },
  smallPrimary: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 32, paddingHorizontal: 14, borderRadius: 16, backgroundColor: colors.primary },
  smallPrimaryText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
  textButton: { height: 32, paddingHorizontal: 10, justifyContent: 'center' },
  textButtonLabel: { color: colors.textSecondary, fontSize: 13, fontWeight: '500' },
  error: { flex: 1, color: colors.danger, fontSize: 12.5 },
  field: { gap: 8 },
  fieldLabel: { color: colors.text, fontSize: 13.5, fontWeight: '600' },
  input: { height: 42, borderRadius: 12, paddingHorizontal: 12, backgroundColor: colors.surface, color: colors.text, fontSize: 14.5 },
  privacy: { flexDirection: 'row', alignItems: 'center', gap: 6, justifyContent: 'center', marginTop: 24, paddingHorizontal: 12 },
  privacyText: { flexShrink: 1, color: colors.subtle, fontSize: 12.5, textAlign: 'center' },
});
