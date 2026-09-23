import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { fetchChatModels } from '../api/chat-api';
import type { AspectRatio, ChatApi, Quality, ResolutionTier } from '../domain';
import { ALL_QUALITIES, qualitiesForModel, sizeFor } from '../domain-utils';
import { getProviderKey } from '../storage/secure-keys';
import { useApp } from '../state/AppContext';
import { colors, radius, spacing } from '../theme';
import { AppDialog, Chip, PrimaryButton, Sheet } from './ui';

const RATIOS: AspectRatio[] = ['1:1', '16:9', '9:16'];
const TIERS: ResolutionTier[] = ['1K', '2K', '4K'];

export function SettingsSheet({ visible, onClose, onOpenProviders }: { visible: boolean; onClose: () => void; onOpenProviders?: (providerId?: string) => void }) {
  const { activeProvider, providers, composerMode, generating, updateActiveProviderSettings } = useApp();
  // Auto mode edits the conversation model here; image defaults remain on the
  // image provider and are shown as a summary below. The route itself is
  // selected per message, not by this sheet.
  const isAuto = composerMode === 'auto';
  const isChat = composerMode !== 'image';
  const imageProvider = activeProvider?.model ? activeProvider : providers.find((item) => Boolean(item.model));
  const [chatApi, setChatApi] = useState<ChatApi>('chat-completions');
  const [analysisProviderId, setAnalysisProviderId] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const [quality, setQuality] = useState<Quality | null>(null);
  const [ratio, setRatio] = useState<AspectRatio | null>(null);
  const [tier, setTier] = useState<ResolutionTier | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [manualModelOpen, setManualModelOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const chatProviders = useMemo(() => providers.filter((item) => Boolean(item.chatModel)), [providers]);

  useEffect(() => {
    if (!visible || !activeProvider) return;
    const initialAnalysisId = isChat && !activeProvider.chatModel
      ? activeProvider.analysisProviderId ?? chatProviders[0]?.id ?? null
      : activeProvider.analysisProviderId ?? null;
    const initialModelProvider = initialAnalysisId ? providers.find((item) => item.id === initialAnalysisId) : activeProvider;
    setModel((isChat ? initialModelProvider?.chatModel : activeProvider.model) ?? '');
    setChatApi(activeProvider.chatApi ?? 'chat-completions');
    setAnalysisProviderId(initialAnalysisId);
    setQuality(activeProvider.quality); setRatio(activeProvider.aspectRatio); setTier(activeProvider.resolutionTier);
    setManualModelOpen(false); setModelsError(null);
  }, [visible, activeProvider, isChat, chatProviders, providers]);

  const modelProvider = useMemo(() => {
    if (!activeProvider) return null;
    if (isChat && analysisProviderId) return providers.find((item) => item.id === analysisProviderId) ?? activeProvider;
    return activeProvider;
  }, [activeProvider, analysisProviderId, isChat, providers]);

  const loadModels = async () => {
    if (!modelProvider) return;
    try {
      setModelsLoading(true); setModelsError(null);
      const key = await getProviderKey(modelProvider.id);
      if (!key) throw new Error('该服务商没有保存密钥，请先在服务商管理中补充');
      const next = await fetchChatModels(modelProvider.baseUrl, key, modelProvider.chatApi);
      setModels(next);
      if (!next.length) setModelsError('服务商没有返回模型列表，可以展开“手动填写模型 ID”');
    } catch (error) {
      setModelsError(error instanceof Error ? error.message : '模型列表读取失败，可手动填写模型 ID');
    } finally { setModelsLoading(false); }
  };

  useEffect(() => {
    if (visible && modelProvider) void loadModels();
    // Loading is intentionally tied to the selected service, not every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, modelProvider?.id, isChat]);

  const save = async () => {
    try {
      if (isChat) {
        if (analysisProviderId && analysisProviderId !== activeProvider?.id) {
          if (!providers.find((item) => item.id === analysisProviderId)?.chatModel) throw new Error('请先为该服务商配置对话模型');
          await updateActiveProviderSettings({ analysisProviderId }); onClose(); return;
        }
        if (!model.trim()) throw new Error('请选择一个对话模型');
        await updateActiveProviderSettings({ chatModel: model.trim(), chatApi, analysisProviderId: null }); onClose(); return;
      }
      if (!model.trim() || !quality || !ratio || !tier) throw new Error('请选择模型、画质、比例和清晰度');
      if (!qualitiesForModel(model.trim()).includes(quality)) throw new Error('此模型不支持所选画质');
      await updateActiveProviderSettings({ model: model.trim(), quality, aspectRatio: ratio, resolutionTier: tier, analysisProviderId }); onClose();
    } catch (error) { setErrorMessage(error instanceof Error ? error.message : '请检查参数。'); }
  };

  const qualities = model ? qualitiesForModel(model) : ALL_QUALITIES;
  const selectableModels = useMemo(() => {
    const filtered = models.filter((item) => isChat ? !/image|dall-e|flux/i.test(item) : /image|dall-e|flux/i.test(item));
    return [...new Set([model, ...filtered].filter(Boolean))];
  }, [isChat, model, models]);

  return <Sheet visible={visible} title={isAuto ? '自动模式设置' : isChat ? '对话设置' : '图片设置'} onClose={onClose}>
    <View style={styles.body}>
      <View style={styles.contextCard}><Ionicons name={isAuto ? 'sparkles-outline' : isChat ? 'chatbubbles-outline' : 'image-outline'} size={20} color={colors.primaryStrong} /><View style={styles.contextCopy}><Text style={styles.contextTitle}>{isAuto ? '自动路由 · 对话与图片' : isChat ? '对话与文件' : '图片创作'}</Text><Text style={styles.contextHint}>{activeProvider?.name ?? '尚未选择服务商'}</Text></View></View>
      {isAuto && <View style={styles.autoCard}><Text style={styles.autoTitle}>按消息自动选择</Text><Text style={styles.hint}>普通问题、PDF/Word 分析和图片识别只使用对话 API。提示词明确要求“生成、绘制、修改图片”时，会先由对话 API 检查并整理要求，再调用图片 API；图片附件本身不会触发生图。</Text></View>}
      {isAuto && <View style={styles.imageSummary}><View style={styles.summaryHeading}><View><Text style={styles.label}>图片创作默认参数</Text><Text style={styles.summaryProvider}>{imageProvider?.name ?? '尚未配置图片服务商'}</Text></View><Ionicons name="image-outline" size={20} color={colors.primaryStrong} /></View>{imageProvider?.model ? <><Text style={styles.summaryModel} numberOfLines={1}>{imageProvider.model}</Text><Text style={styles.hint}>{[imageProvider.quality, imageProvider.aspectRatio, imageProvider.resolutionTier].filter(Boolean).join(' · ') || '尚未完成图片参数设置'}</Text></> : <Text style={styles.hint}>自动生图前必须先配置图片模型、画质、比例和清晰度。</Text>}{onOpenProviders && <Pressable style={styles.manageButton} onPress={() => { onClose(); onOpenProviders(imageProvider?.id); }}><Ionicons name="options-outline" size={16} color={colors.primaryStrong} /><Text style={styles.manageText}>调整图片模型和参数</Text></Pressable>}</View>}
      {isChat && <View style={styles.group}><Text style={styles.label}>使用哪个对话服务商？</Text><View style={styles.chips}>{activeProvider?.chatModel && <Chip label="使用当前服务商" selected={!analysisProviderId} onPress={() => { setAnalysisProviderId(null); setModel(activeProvider.chatModel ?? ''); }} />}{chatProviders.filter((item) => item.id !== activeProvider?.id).map((item) => <Chip key={item.id} label={item.name} selected={analysisProviderId === item.id} onPress={() => { setAnalysisProviderId(item.id); setModel(item.chatModel ?? ''); }} />)}</View>{analysisProviderId && <Text style={styles.hint}>{`当前会话保持不变，内容发给 ${providers.find((item) => item.id === analysisProviderId)?.name ?? '所选服务商'} 的对话模型。`}</Text>}{!activeProvider?.chatModel && !chatProviders.length && <Text style={styles.hint}>当前没有对话服务商，请先在服务商管理中添加独立的对话 API。</Text>}</View>}
      {(!isChat || !analysisProviderId) && <>
        <View style={styles.group}><ModelPicker label={isChat ? '对话模型' : '图片模型'} models={selectableModels} value={model} loading={modelsLoading} error={modelsError} manualOpen={manualModelOpen} onRefresh={() => void loadModels()} onToggleManual={() => setManualModelOpen((value) => !value)} onChange={(value) => { setModel(value); if (!isChat) setQuality(null); }} placeholder={isChat ? '手动填写对话模型 ID' : '手动填写图片模型 ID'} /></View>
        {isChat ? <View style={styles.group}><Text style={styles.label}>接口协议</Text><View style={styles.chips}>{(['chat-completions', 'responses', 'anthropic'] as ChatApi[]).map((api) => <Chip key={api} label={api === 'chat-completions' ? 'Chat Completions' : api === 'responses' ? 'Responses' : 'Claude Messages'} selected={chatApi === api} onPress={() => setChatApi(api)} />)}</View><Text style={styles.hint}>文件会按模型能力使用本地提取、PDF 页面图片或兼容文件块发送。</Text></View> : <>
          <View style={styles.group}><Text style={styles.label}>画质</Text><View style={styles.chips}>{qualities.map((item) => <Chip key={item} label={item} selected={quality === item} onPress={() => setQuality(item)} />)}</View></View>
          <View style={styles.group}><Text style={styles.label}>比例</Text><View style={styles.chips}>{RATIOS.map((item) => <Chip key={item} label={item} selected={ratio === item} onPress={() => setRatio(item)} />)}</View></View>
          <View style={styles.group}><Text style={styles.label}>清晰度</Text><View style={styles.chips}>{TIERS.map((item) => <Chip key={item} label={item} selected={tier === item} onPress={() => setTier(item)} />)}</View>{ratio && tier && <Text style={styles.hint}>本次尺寸：{sizeFor(ratio, tier)} · PNG · 1 张</Text>}</View>
          <View style={styles.group}><Text style={styles.label}>文件解析服务商</Text><View style={styles.chips}><Chip label="当前服务商" selected={!analysisProviderId} onPress={() => setAnalysisProviderId(null)} />{providers.filter((item) => item.chatModel && item.id !== activeProvider?.id).map((item) => <Chip key={item.id} label={item.name} selected={analysisProviderId === item.id} onPress={() => setAnalysisProviderId(item.id)} />)}</View><Text style={styles.hint}>文件辅助生图会先解析，再调用图片模型，两次请求分别计费。</Text></View>
        </>}
      </>}
      <PrimaryButton label="应用设置" icon="checkmark" disabled={generating} onPress={() => void save()} />
    </View>
    <AppDialog visible={Boolean(errorMessage)} title="无法保存" message={errorMessage ?? ''} onClose={() => setErrorMessage(null)} />
  </Sheet>;
}

function ModelPicker({ label, models, value, loading, error, manualOpen, onRefresh, onToggleManual, onChange, placeholder }: { label: string; models: string[]; value: string; loading: boolean; error: string | null; manualOpen: boolean; onRefresh: () => void; onToggleManual: () => void; onChange: (value: string) => void; placeholder: string }) {
  return <View style={styles.modelPicker}><View style={styles.modelHeader}><Text style={styles.label}>{label}</Text><Pressable style={styles.refresh} onPress={onRefresh}><Ionicons name="refresh-outline" size={15} color={colors.primaryStrong} /><Text style={styles.refreshText}>{loading ? '读取中' : '刷新列表'}</Text></Pressable></View>{loading && <ActivityIndicator color={colors.primaryStrong} />}{models.length > 0 && <View style={styles.chips}>{models.map((item) => <Chip key={item} label={item} selected={value === item} onPress={() => onChange(item)} />)}</View>}{error && <Text style={styles.hint}>{error}</Text>}<Pressable style={styles.manualToggle} onPress={onToggleManual}><Ionicons name={manualOpen ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textMuted} /><Text style={styles.manualText}>{manualOpen ? '收起手动填写' : '手动填写模型 ID'}</Text></Pressable>{manualOpen && <TextInput value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={colors.textMuted} autoCapitalize="none" autoCorrect={false} style={styles.input} />}</View>;
}

const styles = StyleSheet.create({
  body: { padding: spacing.lg, gap: spacing.md },
  contextCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, borderRadius: radius.lg, backgroundColor: colors.blueSurface },
  contextCopy: { gap: 2 },
  contextTitle: { color: colors.text, fontSize: 14, fontWeight: '800' },
  contextHint: { color: colors.textMuted, fontSize: 12 },
  autoCard: { padding: spacing.md, gap: spacing.xs, borderRadius: radius.lg, backgroundColor: colors.blueSurface, borderWidth: 1, borderColor: '#CFE5FF' },
  autoTitle: { color: colors.primaryStrong, fontSize: 13, fontWeight: '800' },
  imageSummary: { padding: spacing.md, gap: spacing.xs, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  summaryHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  summaryProvider: { color: colors.textMuted, fontSize: 11, marginTop: 3 },
  summaryModel: { color: colors.text, fontSize: 13, fontWeight: '700' },
  manageButton: { minHeight: 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: spacing.xs, borderRadius: radius.md, backgroundColor: colors.blueSurface },
  manageText: { color: colors.primaryStrong, fontSize: 12, fontWeight: '700' },
  group: { gap: spacing.sm },
  label: { color: colors.text, fontSize: 12, fontWeight: '700' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  hint: { color: colors.textMuted, lineHeight: 18, fontSize: 12 },
  modelPicker: { gap: spacing.sm },
  modelHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  refresh: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 3 },
  refreshText: { color: colors.primaryStrong, fontSize: 12, fontWeight: '700' },
  manualToggle: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', paddingVertical: 3 },
  manualText: { color: colors.textMuted, fontSize: 12 },
  input: { minHeight: 46, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 13, color: colors.text, backgroundColor: colors.surface, fontSize: 14 },
});
