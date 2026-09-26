import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { fetchChatModels } from '../api/chat-api';
import type { AspectRatio, ProviderProfile, Quality, ResolutionTier } from '../domain';
import { ALL_QUALITIES, qualitiesForModel, sizeFor } from '../domain-utils';
import { useApp } from '../state/AppContext';
import { getProviderKey } from '../storage/secure-keys';
import { colors, radius } from '../theme';
import { ModelSelect } from './ModelSelect';
import { AppDialog, Chip, PrimaryButton, Sheet } from './ui';

type Capability = 'chat' | 'image';
type Draft = { chatModel: string; model: string; quality: Quality | null; aspectRatio: AspectRatio | null; resolutionTier: ResolutionTier | null };
const RATIOS: AspectRatio[] = ['1:1', '16:9', '9:16'];
const TIERS: ResolutionTier[] = ['1K', '2K', '4K'];

export function SettingsSheet({ visible, onClose, onOpenProviders, initialCapability }: { visible: boolean; onClose: () => void; onOpenProviders?: (providerId?: string) => void; initialCapability?: Capability }) {
  const { activeProvider, providers, composerMode, generating, updateProviderSettings } = useApp();
  const [capability, setCapability] = useState<Capability>('chat');
  const [chatProviderId, setChatProviderId] = useState<string | null>(null);
  const [imageProviderId, setImageProviderId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [changed, setChanged] = useState({ chat: false, image: false });
  const [providerPicker, setProviderPicker] = useState(false);
  const [modelPicker, setModelPicker] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const loadId = useRef(0);
  const saveLock = useRef(false);

  useEffect(() => {
    if (!visible) { loadId.current += 1; setModelPicker(false); setProviderPicker(false); return; }
    const chat = providers.find((provider) => provider.id === activeProvider?.analysisProviderId && provider.chatModel)
      ?? (activeProvider?.chatModel ? activeProvider : providers.find((provider) => provider.chatModel));
    const image = providers.find((provider) => provider.id === activeProvider?.imageProviderId && provider.model)
      ?? (activeProvider?.model ? activeProvider : providers.find((provider) => provider.model));
    setChatProviderId(chat?.id ?? null); setImageProviderId(image?.id ?? null);
    setDrafts(Object.fromEntries(providers.map((provider) => [provider.id, {
      chatModel: provider.chatModel ?? '', model: provider.model ?? '', quality: provider.quality,
      aspectRatio: provider.aspectRatio, resolutionTier: provider.resolutionTier,
    }])));
    setChanged({ chat: false, image: false }); setCapability(initialCapability ?? (composerMode === 'image' ? 'image' : 'chat')); setError(null);
    // Snapshot on opening. Saving one provider must not erase unsaved choices on the other tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, activeProvider?.id, initialCapability]);

  const providerId = capability === 'chat' ? chatProviderId : imageProviderId;
  const provider = providers.find((item) => item.id === providerId);
  const draft = providerId ? drafts[providerId] : undefined;
  const currentModel = capability === 'chat' ? draft?.chatModel ?? '' : draft?.model ?? '';
  const availableProviders = providers.filter((item) => capability === 'chat' ? Boolean(item.chatModel) : Boolean(item.model));
  const patchDraft = (patch: Partial<Draft>) => {
    if (!providerId) return;
    setDrafts((current) => ({ ...current, [providerId]: { ...current[providerId], ...patch } }));
    setChanged((current) => ({ ...current, [capability]: true }));
  };
  const loadModels = async () => {
    const requestId = ++loadId.current;
    setModels([]); setModelsError(null);
    if (!provider) { setLoading(false); return; }
    setLoading(true);
    try {
      const key = await getProviderKey(provider.id);
      if (!key) throw new Error('此服务商尚未保存密钥，请在设置中补充。');
      const result = await fetchChatModels(provider.baseUrl, key, capability === 'image' ? 'chat-completions' : provider.chatApi);
      if (requestId === loadId.current) { setModels(result); if (!result.length) setModelsError('服务商未返回模型列表，可手动添加模型 ID。'); }
    } catch (reason) { if (requestId === loadId.current) setModelsError(reason instanceof Error ? reason.message : '暂未读取到模型列表'); }
    finally { if (requestId === loadId.current) setLoading(false); }
  };
  useEffect(() => {
    if (visible) void loadModels();
    // Model lists depend on the selected capability and service, not text entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, provider?.id, capability]);

  const save = async () => {
    if (!activeProvider || generating || saveLock.current) return;
    saveLock.current = true; setSaving(true);
    try {
      // Merge by provider first: two capabilities can share one service, and an
      // extra mapping write must not overwrite the model saved moments earlier.
      const updates = new Map<string, Parameters<typeof updateProviderSettings>[1]>();
      const merge = (id: string, patch: Parameters<typeof updateProviderSettings>[1]) => updates.set(id, { ...updates.get(id), ...patch });
      if (changed.chat || capability === 'chat') {
        const chat = chatProviderId ? drafts[chatProviderId] : undefined;
        if (!chatProviderId || !chat?.chatModel.trim()) throw new Error('请先添加对话服务商并选择模型');
        merge(chatProviderId, { chatModel: chat.chatModel.trim() });
      }
      if (changed.image || capability === 'image') {
        const image = imageProviderId ? drafts[imageProviderId] : undefined;
        if (!imageProviderId || !image?.model.trim()) throw new Error('请先添加图片服务商并选择模型');
        if (!image.quality || !image.aspectRatio || !image.resolutionTier) throw new Error('请选择画质、比例和清晰度');
        if (!qualitiesForModel(image.model).includes(image.quality)) throw new Error('此模型不支持所选画质，请重新选择');
        merge(imageProviderId, { model: image.model.trim(), quality: image.quality, aspectRatio: image.aspectRatio, resolutionTier: image.resolutionTier });
      }
      merge(activeProvider.id, {
        analysisProviderId: chatProviderId && chatProviderId !== activeProvider.id ? chatProviderId : null,
        imageProviderId: imageProviderId && imageProviderId !== activeProvider.id ? imageProviderId : null,
      });
      for (const [id, patch] of updates) await updateProviderSettings(id, patch);
      onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '暂时无法应用设置'); }
    finally { saveLock.current = false; setSaving(false); }
  };
  const openProviders = () => { onClose(); onOpenProviders?.(); };
  const qualities = draft?.model ? qualitiesForModel(draft.model) : ALL_QUALITIES;
  const filteredModels = models.filter((model) => capability === 'chat' ? !/image|dall-e|flux/i.test(model) : /image|dall-e|flux/i.test(model));

  return <Sheet visible={visible} title="模型与创作参数" onClose={onClose} footer={<PrimaryButton label="应用" onPress={() => void save()} disabled={generating || !provider} loading={saving} />}>
    <View style={styles.body}>
      <View style={styles.tabs}>{([{ id: 'chat', label: '对话模型', icon: 'chatbubble-outline' }, { id: 'image', label: '图片创作', icon: 'image-outline' }] as const).map((tab) => <Pressable key={tab.id} accessibilityRole="tab" accessibilityState={{ selected: capability === tab.id }} onPress={() => setCapability(tab.id)} style={[styles.tab, capability === tab.id && styles.activeTab]}><Ionicons name={tab.icon} size={18} color={capability === tab.id ? colors.text : colors.textMuted} /><Text style={[styles.tabText, capability === tab.id && styles.activeTabText]}>{tab.label}</Text></Pressable>)}</View>
      {provider && draft ? <>
        <Pressable accessibilityRole="button" accessibilityLabel={`选择${capability === 'chat' ? '对话' : '图片'}服务商`} style={styles.row} onPress={() => setProviderPicker(true)}><Text style={styles.rowLabel}>服务商</Text><Text style={styles.value} numberOfLines={1}>{provider.name}</Text><Ionicons name="chevron-down" size={17} color={colors.textMuted} /></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`选择${capability === 'chat' ? '对话' : '图片'}模型`} style={styles.modelRow} onPress={() => setModelPicker(true)}><View style={styles.modelCopy}><Text style={styles.label}>模型</Text><Text style={styles.modelName} numberOfLines={2}>{currentModel || '选择模型'}</Text></View><Ionicons name="chevron-forward" size={19} color={colors.textMuted} /></Pressable>
        {capability === 'image' ? <>
          <View style={styles.group}><Text style={styles.label}>画质</Text><View style={styles.chips}>{qualities.map((quality) => <Chip key={quality} label={quality} selected={draft.quality === quality} onPress={() => patchDraft({ quality })} />)}</View></View>
          <View style={styles.group}><Text style={styles.label}>比例</Text><View style={styles.ratios}>{RATIOS.map((ratio) => <Pressable key={ratio} accessibilityRole="radio" accessibilityState={{ selected: draft.aspectRatio === ratio }} style={[styles.ratio, draft.aspectRatio === ratio && styles.selectedRatio]} onPress={() => patchDraft({ aspectRatio: ratio })}><View style={[styles.ratioShape, { width: ratio === '9:16' ? 14 : 21, height: ratio === '16:9' ? 14 : 21 }, draft.aspectRatio === ratio && styles.selectedShape]} /><Text style={[styles.ratioText, draft.aspectRatio === ratio && styles.selectedText]}>{ratio}</Text></Pressable>)}</View></View>
          <View style={styles.group}><View style={styles.groupHeader}><Text style={styles.label}>清晰度</Text>{draft.aspectRatio && draft.resolutionTier && <Text style={styles.pixelSize}>{sizeFor(draft.aspectRatio, draft.resolutionTier)}</Text>}</View><View style={styles.chips}>{TIERS.map((tier) => <Chip key={tier} label={tier} selected={draft.resolutionTier === tier} onPress={() => patchDraft({ resolutionTier: tier })} />)}</View></View>
          <Text style={styles.note}>图片请求使用此处选定的服务商和参数。</Text>
        </> : <Text style={styles.note}>普通问答、图片识别和文件分析使用此模型。切换模型会保留当前会话。</Text>}
      </> : <View style={styles.empty}><Ionicons name={capability === 'chat' ? 'chatbubbles-outline' : 'image-outline'} size={30} color={colors.textMuted} /><Text style={styles.emptyTitle}>还没有{capability === 'chat' ? '对话' : '图片'}服务商</Text><Text style={styles.emptyHint}>先在设置中连接对应的 API，即可选择模型。</Text><Pressable style={styles.addButton} onPress={openProviders}><Ionicons name="add" size={18} color={colors.primaryStrong} /><Text style={styles.link}>添加服务商</Text></Pressable></View>}
    </View>
    <Sheet visible={providerPicker} title={`选择${capability === 'chat' ? '对话' : '图片'}服务商`} onClose={() => setProviderPicker(false)}><View style={styles.providerList}>{availableProviders.map((item) => <Pressable key={item.id} accessibilityRole="button" accessibilityState={{ selected: item.id === providerId }} style={[styles.providerOption, item.id === providerId && styles.selectedOption]} onPress={() => { if (capability === 'chat') setChatProviderId(item.id); else setImageProviderId(item.id); setChanged((current) => ({ ...current, [capability]: true })); setProviderPicker(false); }}><View style={styles.providerCopy}><Text style={styles.providerName}>{item.name}</Text><Text style={styles.providerModel} numberOfLines={1}>{capability === 'chat' ? item.chatModel : item.model}</Text></View>{item.id === providerId && <Ionicons name="checkmark" size={20} color={colors.primaryStrong} />}</Pressable>)}{onOpenProviders && <Pressable style={styles.addButton} onPress={openProviders}><Ionicons name="add" size={18} color={colors.primaryStrong} /><Text style={styles.link}>管理服务商</Text></Pressable>}</View></Sheet>
    <ModelSelect visible={modelPicker} title={`选择${capability === 'chat' ? '对话' : '图片'}模型`} value={currentModel} models={filteredModels} loading={loading} error={modelsError} onClose={() => setModelPicker(false)} onRefresh={() => void loadModels()} onSelect={(model) => { if (capability === 'chat') patchDraft({ chatModel: model }); else patchDraft({ model, quality: draft?.quality && qualitiesForModel(model).includes(draft.quality) ? draft.quality : null }); }} />
    <AppDialog visible={Boolean(error)} title="无法应用设置" message={error ?? ''} onClose={() => setError(null)} />
  </Sheet>;
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 20, paddingBottom: 12 },
  tabs: { flexDirection: 'row', gap: 4, padding: 4, backgroundColor: colors.surface, borderRadius: radius.md, marginBottom: 16 },
  tab: { flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: radius.sm }, activeTab: { backgroundColor: colors.background }, tabText: { fontSize: 14, color: colors.textMuted, fontWeight: '500' }, activeTabText: { color: colors.text, fontWeight: '600' },
  row: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border }, rowLabel: { flex: 1, color: colors.textMuted, fontSize: 13 }, value: { maxWidth: '68%', fontSize: 14, color: colors.text, fontWeight: '500' },
  modelRow: { minHeight: 82, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border }, modelCopy: { flex: 1, gap: 7 }, label: { color: colors.text, fontSize: 13, fontWeight: '600' }, modelName: { color: colors.text, fontSize: 15, lineHeight: 22 },
  group: { marginTop: 23, gap: 12 }, groupHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 }, ratios: { flexDirection: 'row', gap: 8 }, ratio: { flex: 1, minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md }, selectedRatio: { backgroundColor: colors.blueSurface, borderColor: '#BBDFFF' }, ratioShape: { borderWidth: 1.5, borderColor: colors.textMuted, borderRadius: 3 }, selectedShape: { borderColor: colors.primaryStrong }, ratioText: { color: colors.text, fontSize: 13 }, selectedText: { color: colors.primaryStrong, fontWeight: '600' }, pixelSize: { color: colors.textMuted, fontSize: 12 },
  note: { color: colors.textMuted, fontSize: 12, lineHeight: 20, marginTop: 20 },
  empty: { alignItems: 'center', paddingVertical: 28, gap: 12 }, emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '600' }, emptyHint: { color: colors.textMuted, fontSize: 12, textAlign: 'center', lineHeight: 20 }, addButton: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 12 }, link: { color: colors.primaryStrong, fontSize: 13, fontWeight: '600' },
  providerList: { paddingHorizontal: 20, paddingBottom: 12, gap: 4 }, providerOption: { minHeight: 68, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, borderRadius: radius.md }, selectedOption: { backgroundColor: colors.blueSurface }, providerCopy: { flex: 1, gap: 6 }, providerName: { color: colors.text, fontSize: 15, fontWeight: '500' }, providerModel: { color: colors.textMuted, fontSize: 12 },
});
