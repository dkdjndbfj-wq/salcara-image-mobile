import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, TextInput, View } from 'react-native';

import { useApp } from '../state/AppContext';
import { colors, radius } from '../theme';
import { ASR_MODELS, formatBytes, MIRRORS, modelSize, type AsrModel } from '../voice/catalog';
import { cancelInstall, deleteModel, installModel, refreshModels, useModelStatuses, type ModelStatus } from '../voice/models';
import { localEngineAvailable, voiceNative } from '../voice/native';
import { updateVoiceSettings, useVoiceSettings, type VoiceSettings } from '../voice/settings';
import type { SpeechKind } from '../voice/vendors';
import { FunctionPicker, type FunctionChoice } from './FunctionPicker';
import { Icon } from './Icon';
import { MotionPressable } from './MotionPressable';
import { ProviderManager } from './ProviderManager';
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

export function VoiceSettingsSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const settings = useVoiceSettings();
  const statuses = useModelStatuses();
  const [confirm, setConfirm] = React.useState<AsrModel | null>(null);
  const engineReady = localEngineAvailable();
  const hasNative = Boolean(voiceNative());
  const localUsable = Boolean(hasNative && engineReady && settings.localModel && statuses[settings.localModel]?.state === 'installed');
  useEffect(() => { if (visible) void refreshModels().catch(() => undefined); }, [visible]);
  const set = (patch: Partial<VoiceSettings>) => void updateVoiceSettings(patch);
  const [adding, setAdding] = React.useState<SpeechKind | null>(null);
  /** Service, model and voice of one speech function, saved together. */
  const stt: FunctionChoice = { serviceId: settings.transcribeProviderId, model: settings.transcribeModel };
  const tts: FunctionChoice = { serviceId: settings.ttsProviderId, model: settings.ttsModel, voice: settings.ttsVoice };
  const realtime: FunctionChoice = { serviceId: settings.realtimeProviderId, model: settings.realtimeModel, voice: settings.realtimeVoice };
  const pick = (kind: SpeechKind, choice: FunctionChoice) => {
    if (kind === 'stt') set({ transcribeProviderId: choice.serviceId, transcribeModel: choice.model });
    if (kind === 'tts') set({ ttsProviderId: choice.serviceId, ttsModel: choice.model, ttsVoice: choice.voice ?? '' });
    if (kind === 'realtime') set({ realtimeProviderId: choice.serviceId, realtimeModel: choice.model, realtimeVoice: choice.voice ?? '' });
  };

  const download = (model: AsrModel) => {
    void installModel(model.id, settings.mirror).then(() => {
      if (!settings.localModel) set({ localModel: model.id, inputEngine: 'local' });
    });
  };

  return <Sheet visible={visible} title="语音" onClose={onClose} presentation="page">
    <View style={styles.body}>
      <Text style={styles.lead}>云端语音都调用你自己的 API（在“API 管理”里添加一次即可）。识别、合成、实时语音各自先选 API，再选模型和音色。</Text>

      <SectionLabel>语音输入</SectionLabel>
      <Group style={styles.group}>
        <View style={styles.chips}>
          <Chip label="本地模型 · 离线" selected={settings.inputEngine === 'local'} onPress={() => set({ inputEngine: 'local' })} />
          <Chip label="云端识别" selected={settings.inputEngine === 'cloud'} onPress={() => set({ inputEngine: 'cloud' })} />
        </View>
        <Text style={styles.note}>{settings.inputEngine === 'local'
          ? '声音只在手机上识别，不联网、不产生费用。下载一次即可离线使用。'
          : '录音发送给你选择的识别服务转成文字，按该服务商的价格计费。'}</Text>
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
      </> : null}
      {settings.inputEngine === 'cloud' || !localUsable ? <Group style={[styles.group, { marginTop: settings.inputEngine === 'local' ? 10 : 0 }]}>
        {settings.inputEngine === 'local' ? <Text style={styles.note}>本地模型暂不可用，会用这里选择的云端识别。</Text> : null}
        <FunctionPicker kind="stt" value={stt} followChat onChange={(choice) => pick('stt', choice)} onAddService={() => setAdding('stt')} />
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>识别语言</Text>
          <View style={styles.chips}>
            {[['', '自动'], ['zh', '中文'], ['en', '英语'], ['ja', '日语'], ['yue', '粤语']].map(([id, label]) => <Chip key={id || 'auto'} label={label} selected={settings.transcribeLanguage === id} onPress={() => set({ transcribeLanguage: id })} />)}
          </View>
        </View>
      </Group> : null}

      <SectionLabel>语音对话</SectionLabel>
      <Group style={styles.group}>
        <View style={styles.chips}>
          <Chip label="自动" selected={settings.conversationEngine === 'auto'} onPress={() => set({ conversationEngine: 'auto' })} />
          <Chip label="分段语音" selected={settings.conversationEngine === 'cascade'} onPress={() => set({ conversationEngine: 'cascade' })} />
          <Chip label="实时语音模型" selected={settings.conversationEngine === 'realtime'} onPress={() => set({ conversationEngine: 'realtime' })} />
        </View>
        <Text style={styles.note}>{settings.conversationEngine === 'cascade'
          ? '语音识别 API → 你当前的对话模型 → 语音合成 API，三段可以分别用不同服务商；还能在对话里继续画图，内容会保存在对话中。'
          : settings.conversationEngine === 'realtime'
            ? '端到端实时语音模型直接听和说，延迟最低、可随时插话。支持 OpenAI、Azure OpenAI、阿里云 Qwen-Omni、Gemini Live、阶跃星辰等。'
            : '选了实时语音服务商时优先用实时语音模型，连不上会自动改用分段语音；否则直接使用分段语音。'}</Text>
      </Group>

      {settings.conversationEngine !== 'cascade' ? <Group style={styles.group}>
        {/* In auto mode nothing picked means realtime is off, not “the chat provider”. */}
        <FunctionPicker kind="realtime" value={realtime} followChat={settings.conversationEngine === 'realtime'} onChange={(choice) => pick('realtime', choice)} onAddService={() => setAdding('realtime')}
          offLabel={settings.conversationEngine === 'auto' ? '未启用' : undefined} />
      </Group> : null}

      {settings.conversationEngine !== 'realtime' ? <Group style={styles.group}>
        <Text style={styles.fieldLabel}>分段语音 · 朗读回答</Text>
        <View style={styles.chips}>
          <Chip label="语音合成 API" selected={settings.speechOutput === 'cloud'} onPress={() => set({ speechOutput: 'cloud' })} />
          <Chip label="手机系统语音（本地）" selected={settings.speechOutput === 'system'} onPress={() => set({ speechOutput: 'system' })} />
        </View>
        {settings.speechOutput === 'cloud' ? <>
          <FunctionPicker kind="tts" value={tts} followChat hideLabel onChange={(choice) => pick('tts', choice)} onAddService={() => setAdding('tts')} />
        </> : <Text style={styles.note}>用手机自带的语音引擎在本机朗读，不调用任何 API；音色取决于手机。</Text>}
        <Text style={styles.note}>听你说话使用上面“语音输入”的设置；回答由你当前选择的对话模型生成。</Text>
      </Group> : null}

      <View style={styles.privacy}>
        <Icon name="lock" size={14} color={colors.subtle} />
        <Text style={styles.privacyText}>本地模型在手机上处理声音；使用云端时，录音和文字只发送给你为该功能选择的服务商。</Text>
      </View>
    </View>
    <ProviderManager visible={Boolean(adding)} kind={adding} onClose={() => setAdding(null)} />
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
  lead: { color: colors.textMuted, fontSize: 12.5, lineHeight: 18, marginBottom: 10, marginHorizontal: 4 },
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
