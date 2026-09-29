import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { updateAgentSettings, useAgentSettings, type ImageCheck, type ImagePromptMode } from '../agent/settings';
import { refreshServiceModels, useServiceModels } from '../api/services';
import { modelsFor, vendorForService } from '../api/vendors';

import type { AspectRatio, ProviderProfile, Quality, ResolutionTier } from '../domain';
import { qualitiesForModel } from '../domain-utils';
import { normalizeRatio, RATIO_PRESETS, ratioValue, sizeNote, supportsAutoSize, supportsClarity } from '../image-sizes';
import { useApp } from '../state/AppContext';
import { colors, prettyModel, radius } from '../theme';
import { Icon } from './Icon';
import { serviceLabel, servicesFor, VendorBadge } from './FunctionPicker';
import { MotionPressable } from './MotionPressable';
import { ProviderManager } from './ProviderManager';
import { AppDialog, Chip, Sheet, showToast } from './ui';

const TIERS: ResolutionTier[] = ['1K', '2K', '4K'];

type Tab = 'chat' | 'image';

/**
 * Switching models, from the chat title or settings. Two steps, always in this order:
 * ① which API (a service = one address + key; a vendor may have several), ② which of its models.
 * Chat models are shared by the assistant and the chat space.
 */
export function ModelSwitcher({ visible, onClose, onManageProviders, initialTab = 'chat' }: { visible: boolean; onClose: () => void; onManageProviders: () => void; initialTab?: Tab }) {
  const { providers, chatProvider, imageProvider, selectChatProvider, selectImageProvider } = useApp();
  const agent = useAgentSettings();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [custom, setCustom] = useState<string | null>(null);
  const [adding, setAdding] = useState<Tab | null>(null);
  useEffect(() => { if (visible) { setTab(initialTab); setPendingId(null); } }, [visible, initialTab]);

  const current = tab === 'chat' ? chatProvider : imageProvider;
  const currentModel = (tab === 'chat' ? chatProvider?.chatModel : imageProvider?.model) ?? '';
  const options = servicesFor(tab, providers);
  const service = providers.find((item) => item.id === pendingId) ?? current ?? options[0] ?? null;
  const run = (task: Promise<unknown>) => task.catch((reason) => { setError(reason instanceof Error ? reason.message : '暂时无法保存'); throw reason; });
  const patchImage = (patch: { quality?: Quality; aspectRatio?: AspectRatio; resolutionTier?: ResolutionTier }) => {
    if (imageProvider) void run(selectImageProvider(imageProvider.id, patch)).catch(() => undefined);
  };
  const qualities = imageProvider?.model ? qualitiesForModel(imageProvider.model) : [];

  const choose = (model: string) => {
    if (!service) return;
    if (tab === 'chat') {
      void run(selectChatProvider(service.id, model)).then(() => { showToast(`对话已切换到 ${prettyModel(model)}`); onClose(); }).catch(() => undefined);
    } else {
      const quality = imageProvider?.quality && qualitiesForModel(model).includes(imageProvider.quality) ? imageProvider.quality : 'auto';
      void run(selectImageProvider(service.id, { model, quality, aspectRatio: imageProvider?.aspectRatio ?? '1:1', resolutionTier: imageProvider?.resolutionTier ?? '1K' }))
        .then(() => { showToast(`绘图已切换到 ${prettyModel(model)}`); setPendingId(null); }).catch(() => undefined);
    }
  };

  return <Sheet visible={visible} title="切换模型" onClose={onClose}>
    <View style={styles.body}>
      <View style={styles.segment}>
        {(['chat', 'image'] as Tab[]).map((item) => <Pressable key={item} accessibilityRole="tab" accessibilityState={{ selected: tab === item }} onPress={() => { setTab(item); setPendingId(null); }}
          style={[styles.segmentItem, tab === item && styles.segmentOn]}>
          <Icon name={item === 'chat' ? 'chat' : 'palette'} size={16} color={tab === item ? colors.primaryDeep : colors.textMuted} />
          <Text style={[styles.segmentText, tab === item && styles.segmentTextOn]}>{item === 'chat' ? '对话' : '绘图'}</Text>
        </Pressable>)}
      </View>
      <View style={styles.now}>
        <Text style={styles.nowLabel}>{tab === 'chat' ? '正在使用（助手和聊天通用）' : '正在使用'}</Text>
        <Text style={styles.nowValue} numberOfLines={1}>{current && currentModel ? `${prettyModel(currentModel)}` : '还没有选择'}</Text>
        {current ? <Text style={styles.nowService} numberOfLines={1}>{serviceLabel(current, providers)} · {currentModel}</Text> : null}
      </View>

      <Text style={styles.step}>① 选择 API</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.services} keyboardShouldPersistTaps="handled">
        {options.map((item) => {
          const selected = item.id === service?.id;
          return <MotionPressable key={item.id} accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={item.name} scaleTo={0.96}
            onPress={() => setPendingId(item.id)} style={[styles.serviceCard, selected && styles.serviceCardOn]}>
            <VendorBadge vendor={vendorForService(item)} size={30} />
            <Text style={[styles.serviceName, selected && { color: colors.primaryDeep }]} numberOfLines={1}>{serviceLabel(item, options)}</Text>
            <Text style={styles.serviceHost} numberOfLines={1}>{item.id === current?.id ? '使用中' : vendorForService(item).name}</Text>
          </MotionPressable>;
        })}
        <MotionPressable accessibilityRole="button" accessibilityLabel="添加 API" scaleTo={0.96} onPress={() => setAdding(tab)} style={[styles.serviceCard, styles.addCard]}>
          <View style={styles.addIcon}><Icon name="plus" size={18} color={colors.primary} /></View>
          <Text style={[styles.serviceName, { color: colors.primary }]}>添加 API</Text>
          <Text style={styles.serviceHost}>地址 + 密钥</Text>
        </MotionPressable>
      </ScrollView>

      {service ? <>
        <Text style={styles.step}>② 选择 {service.name} 的模型</Text>
        <ModelList key={`${tab}:${service.id}`} kind={tab} service={service} value={service.id === current?.id ? currentModel : (tab === 'chat' ? service.chatModel : service.model) ?? ''} onSelect={choose} />
      </> : <Text style={styles.empty}>还没有能{tab === 'chat' ? '对话' : '绘图'}的 API，点“添加 API”选一家平台，填上地址和密钥即可。</Text>}

      {tab === 'image' && imageProvider?.model ? <>
        <Text style={styles.step}>③ 出图设置</Text>
        <Text style={styles.groupTitle}>作图描述</Text>
        <View style={styles.promptModes}>
          {PROMPT_MODES.map((item) => {
            const selected = agent.imagePrompt === item.id;
            return <Pressable key={item.id} accessibilityRole="radio" accessibilityState={{ selected }} onPress={() => void updateAgentSettings({ imagePrompt: item.id })}
              style={[styles.promptMode, selected && styles.promptModeOn]}>
              <View style={[styles.radio, selected && styles.radioOn]}>{selected ? <View style={styles.radioDot} /> : null}</View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.promptTitle, selected && { color: colors.primaryDeep }]}>{item.title}</Text>
                <Text style={styles.promptDetail}>{item.detail}</Text>
              </View>
            </Pressable>;
          })}
        </View>
        <Text style={styles.groupTitle}>默认画幅</Text>
        {(() => {
          const ratioNow = imageProvider.aspectRatio ?? '1:1';
          const presets = RATIO_PRESETS.filter((ratio) => ratio.value !== 'auto' || supportsAutoSize(imageProvider.model));
          const isCustom = !presets.some((ratio) => ratio.value === ratioNow);
          return <View style={styles.ratios}>
            {presets.map((ratio) => <RatioTile key={ratio.value} value={ratio.value} label={ratio.label} hint={ratio.hint} selected={ratioNow === ratio.value} onPress={() => patchImage({ aspectRatio: ratio.value })} />)}
            <RatioTile value={isCustom ? ratioNow : null} label={isCustom ? ratioNow : '自定义'} hint={isCustom ? '自定义' : '任意 宽:高'} selected={isCustom} onPress={() => setCustom(isCustom ? ratioNow : '')} />
          </View>;
        })()}
        <Text style={styles.sizeNote}>{sizeNote(imageProvider.aspectRatio ?? '1:1', imageProvider.resolutionTier ?? '1K', imageProvider.model)}</Text>
        {supportsClarity(imageProvider.model) && <>
          <Text style={styles.groupTitle}>清晰度</Text>
          <View style={styles.chips}>{TIERS.map((tier) => <Chip key={tier} label={TIER_LABEL[tier]} selected={(imageProvider.resolutionTier ?? '1K') === tier} onPress={() => patchImage({ resolutionTier: tier })} />)}</View>
        </>}
        <Text style={styles.groupTitle}>画质</Text>
        <View style={styles.chips}>{qualities.map((quality) => <Chip key={quality} label={QUALITY_LABEL[quality] ?? quality} selected={(imageProvider.quality ?? 'auto') === quality} onPress={() => patchImage({ quality })} />)}</View>
        <Text style={styles.groupTitle}>画完后</Text>
        <View style={styles.chips}>{IMAGE_CHECKS.map((item) => <Chip key={item.id} label={item.title} selected={agent.imageCheck === item.id} onPress={() => void updateAgentSettings({ imageCheck: item.id })} />)}</View>
        <Text style={styles.sizeNote}>{IMAGE_CHECKS.find((item) => item.id === agent.imageCheck)?.detail}</Text>
        <View style={styles.tip}><Icon name="sparkles" size={16} color={colors.primary} /><Text style={styles.note}>对话里说“做成手机壁纸”“21:9 电影感”“横幅”或“透明背景”，Salcara 会自动调整那一张。</Text></View>
      </> : null}
      <Text style={styles.manage} onPress={() => { onClose(); onManageProviders(); }}>API 管理（地址和密钥）</Text>
    </View>
    <ProviderManager visible={Boolean(adding)} kind={adding} onClose={() => setAdding(null)} />
    <AppDialog visible={custom !== null} title="自定义画幅" message="输入宽:高，例如 5:4、2.39:1、1080x1920。范围 1:3 到 3:1，超出会自动取最接近的比例。" icon="image"
      onClose={() => setCustom(null)}
      actions={[{ label: '取消', tone: 'secondary', onPress: () => setCustom(null) }, { label: '使用', disabled: !normalizeRatio(custom) || normalizeRatio(custom) === 'auto', onPress: () => {
        const ratio = normalizeRatio(custom);
        if (ratio && ratio !== 'auto') patchImage({ aspectRatio: ratio });
        setCustom(null);
      } }]}>
      <TextInput value={custom ?? ''} onChangeText={setCustom} placeholder="宽:高" placeholderTextColor={colors.subtle} autoFocus keyboardType="numbers-and-punctuation" style={styles.customInput} />
      {custom && normalizeRatio(custom) && normalizeRatio(custom) !== 'auto'
        ? <Text style={styles.customPreview}>{`将使用 ${normalizeRatio(custom)} · ${sizeNote(normalizeRatio(custom), imageProvider?.resolutionTier ?? '1K', imageProvider?.model)}`}</Text>
        : null}
    </AppDialog>
    <AppDialog visible={Boolean(error)} title="无法保存" message={error ?? ''} icon="alert" onClose={() => setError(null)} />
  </Sheet>;
}

/** Step ②: the service's models, inline — search, tap to use, refresh, or type an ID. */
function ModelList({ kind, service, value, onSelect }: { kind: Tab; service: ProviderProfile; value: string; onSelect: (model: string) => void }) {
  const vendor = vendorForService(service);
  const listed = useServiceModels(service.id);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [typed, setTyped] = useState('');
  const [all, setAll] = useState(false);
  const refresh = async () => {
    setLoading(true); setProblem(null);
    try {
      const list = await refreshServiceModels(service);
      if (!list.length) setProblem('这个 API 没有返回模型列表，可以在下面手动填写模型 ID');
    } catch (reason) { setProblem(reason instanceof Error ? reason.message : '读取模型失败'); } finally { setLoading(false); }
  };
  useEffect(() => { if (vendor.lists && !listed.length) void refresh(); /* first open of this API */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service.id]);
  const fitting = modelsFor(vendor, kind, listed);
  // Chat lists can be long: fitting models first; “显示全部” also shows the rest (a relay may name things oddly).
  const pool = all ? [...new Set([...fitting, ...listed])] : fitting;
  const options = [...new Set([value, ...pool].filter(Boolean))].filter((item) => item.toLowerCase().includes(query.trim().toLowerCase()));
  return <View style={styles.modelBox}>
    <View style={styles.search}>
      <Icon name="search" size={16} color={colors.subtle} />
      <TextInput accessibilityLabel="搜索模型" placeholder={`搜索 ${listed.length || fitting.length} 个模型`} value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false} placeholderTextColor={colors.subtle} style={styles.searchInput} />
      <Pressable accessibilityLabel="重新读取模型列表" hitSlop={8} onPress={() => void refresh()} disabled={loading}>
        {loading ? <ActivityIndicator size="small" color={colors.primary} /> : <Icon name="regenerate" size={17} color={colors.textMuted} />}
      </Pressable>
    </View>
    {problem ? <Text style={styles.problem}>{problem}</Text> : null}
    {options.slice(0, 60).map((item) => {
      const selected = item === value;
      return <Pressable key={item} accessibilityRole="button" accessibilityState={{ selected }} onPress={() => onSelect(item)}
        style={({ pressed }) => [styles.option, selected && styles.optionOn, pressed && { backgroundColor: colors.surfaceStrong }]}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.optionTitle, selected && { color: colors.primaryDeep }]} numberOfLines={1}>{prettyModel(item)}</Text>
          <Text style={styles.optionId} numberOfLines={1}>{item}</Text>
        </View>
        {selected ? <Icon name="checkCircle" size={20} color={colors.primary} /> : null}
      </Pressable>;
    })}
    {!options.length && !loading ? <Text style={styles.emptyList}>{query ? '没有匹配的模型' : '暂时没有可选的模型'}</Text> : null}
    {listed.length > fitting.length && !all ? <Text style={styles.more} onPress={() => setAll(true)}>显示这个 API 的全部 {listed.length} 个模型</Text> : null}
    <View style={styles.typedRow}>
      <TextInput accessibilityLabel="手动填写模型 ID" value={typed} onChangeText={setTyped} placeholder="手动填写模型 ID" placeholderTextColor={colors.subtle} autoCapitalize="none" autoCorrect={false} style={styles.typedInput} />
      <Pressable accessibilityRole="button" disabled={!typed.trim()} onPress={() => onSelect(typed.trim())} style={[styles.typedButton, !typed.trim() && { opacity: 0.4 }]}>
        <Text style={styles.typedButtonText}>使用</Text>
      </Pressable>
    </View>
  </View>;
}

/** A ratio chip with a small frame drawn to that shape. */
function RatioTile({ value, label, hint, selected, onPress }: { value: AspectRatio | null; label: string; hint?: string; selected: boolean; onPress: () => void }) {
  const ratio = value && value !== 'auto' ? ratioValue(value) : 1;
  const box = 22;
  const width = value === null ? 18 : ratio >= 1 ? box : Math.max(8, box * ratio);
  const height = value === null ? 18 : ratio >= 1 ? Math.max(8, box / ratio) : box;
  return <Pressable accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={`${label}${hint ? `，${hint}` : ''}`} onPress={onPress}
    style={({ pressed }) => [styles.ratio, selected && styles.ratioOn, pressed && { transform: [{ scale: 0.97 }] }]}>
    <View style={styles.shapeBox}>
      {value === 'auto'
        ? <Icon name="sparkles" size={18} color={selected ? colors.primary : colors.subtle} />
        : value === null
          ? <Icon name="plus" size={18} color={selected ? colors.primary : colors.subtle} />
          : <View style={[styles.shape, { width, height }, selected && styles.shapeOn]} />}
    </View>
    <Text style={[styles.ratioText, selected && styles.ratioTextOn]} numberOfLines={1}>{label}</Text>
    {hint ? <Text style={styles.ratioHint} numberOfLines={1}>{hint}</Text> : null}
  </Pressable>;
}

const PROMPT_MODES: Array<{ id: ImagePromptMode; title: string; detail: string }> = [
  { id: 'original', title: '用我的原话（推荐）', detail: '你怎么说就怎么交给绘图模型，GPT Image 等会自己思考补全；只有提到“刚才的方案”“按附件”等前文时才补上必要内容。改图不会被擅自加戏。' },
  { id: 'enhance', title: '让 AI 帮我扩写', detail: '对话模型补全主体、构图、风格、光线等细节后再画，适合不会自己思考的绘图模型。' },
];
const IMAGE_CHECKS: Array<{ id: ImageCheck; title: string; detail: string }> = [
  { id: 'off', title: '直接给我', detail: '画完直接给你，最快、最省。' },
  { id: 'check', title: '看一眼再给我', detail: '对话模型查看成图并指出问题（多一次对话请求）。' },
  { id: 'redraw', title: '不满意自动重画', detail: '明显不符合要求时自动重画一次（最多多一张图的费用）。' },
];
const TIER_LABEL: Record<ResolutionTier, string> = { '1K': '1K 标准', '2K': '2K 高清', '4K': '4K 超清' };
const QUALITY_LABEL: Record<string, string> = { auto: '自动', low: '快速', medium: '标准', high: '精细', xhigh: '超精细', max: '极致' };

const styles = StyleSheet.create({
  body: { paddingHorizontal: 16, paddingBottom: 12 },
  manage: { color: colors.primary, fontSize: 13.5, fontWeight: '600', marginTop: 22, marginLeft: 8, alignSelf: 'flex-start' },
  segment: { flexDirection: 'row', padding: 4, borderRadius: radius.pill, backgroundColor: colors.surfaceStrong, gap: 4, marginTop: 4 },
  segmentItem: { flex: 1, height: 40, borderRadius: radius.pill, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  segmentOn: { backgroundColor: colors.card, shadowColor: '#1B2150', shadowOpacity: 0.08, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
  segmentText: { color: colors.textMuted, fontSize: 14.5, fontWeight: '500' },
  segmentTextOn: { color: colors.primaryDeep, fontWeight: '700' },
  now: { marginTop: 14, padding: 14, borderRadius: 18, backgroundColor: colors.blueSurface },
  nowLabel: { color: colors.primaryDeep, fontSize: 11.5, fontWeight: '700', letterSpacing: 0.3 },
  nowValue: { color: colors.text, fontSize: 18, fontWeight: '700', marginTop: 4 },
  nowService: { color: colors.textMuted, fontSize: 12.5, marginTop: 2 },
  step: { color: colors.text, fontSize: 14, fontWeight: '700', marginTop: 22, marginBottom: 10, marginLeft: 4 },
  services: { gap: 8, paddingRight: 8 },
  serviceCard: { width: 112, padding: 12, gap: 6, borderRadius: 18, backgroundColor: colors.surface, borderWidth: 1.5, borderColor: 'transparent' },
  serviceCardOn: { borderColor: colors.primary, backgroundColor: colors.blueSurface },
  serviceName: { color: colors.text, fontSize: 13.5, fontWeight: '600' },
  serviceHost: { color: colors.subtle, fontSize: 11.5 },
  addCard: { borderStyle: 'dashed', borderColor: 'rgba(61,123,250,0.35)', backgroundColor: colors.background },
  addIcon: { width: 30, height: 30, borderRadius: 10, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  empty: { color: colors.textMuted, fontSize: 13.5, lineHeight: 20, marginTop: 16, marginHorizontal: 4 },
  modelBox: { gap: 4 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 44, paddingHorizontal: 14, borderRadius: radius.pill, backgroundColor: colors.surfaceStrong, marginBottom: 6 },
  searchInput: { flex: 1, height: 44, color: colors.text, fontSize: 15, padding: 0 },
  problem: { color: colors.warningText, fontSize: 12.5, lineHeight: 18, marginHorizontal: 6, marginBottom: 4 },
  option: { minHeight: 54, paddingVertical: 8, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 14 },
  optionOn: { backgroundColor: colors.blueSurface },
  optionTitle: { color: colors.text, fontSize: 15, fontWeight: '500' },
  optionId: { color: colors.subtle, fontSize: 11.5, marginTop: 1 },
  emptyList: { color: colors.subtle, fontSize: 13.5, textAlign: 'center', paddingVertical: 20 },
  more: { color: colors.primary, fontSize: 13.5, fontWeight: '600', paddingVertical: 10, paddingHorizontal: 14 },
  typedRow: { flexDirection: 'row', gap: 8, marginTop: 6 },
  typedInput: { flex: 1, height: 44, borderRadius: 14, backgroundColor: colors.surface, paddingHorizontal: 14, color: colors.text, fontSize: 14.5, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  typedButton: { height: 44, paddingHorizontal: 16, borderRadius: 14, backgroundColor: colors.primary, justifyContent: 'center' },
  typedButtonText: { color: colors.onPrimary, fontSize: 14, fontWeight: '600' },
  groupTitle: { color: colors.subtle, fontSize: 12.5, fontWeight: '500', marginTop: 24, marginBottom: 10, marginLeft: 16 },
  ratios: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  ratio: { width: '22.9%', minHeight: 82, paddingVertical: 8, paddingHorizontal: 4, borderRadius: 18, backgroundColor: colors.surface, borderWidth: 1.5, borderColor: 'transparent', alignItems: 'center', justifyContent: 'center', gap: 4 },
  shapeBox: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
  ratioHint: { color: colors.subtle, fontSize: 10.5 },
  sizeNote: { color: colors.subtle, fontSize: 12, lineHeight: 17, marginTop: 10, marginHorizontal: 8 },
  customInput: { height: 48, borderRadius: 14, backgroundColor: colors.surface, paddingHorizontal: 14, fontSize: 17, color: colors.text, marginTop: 14, textAlign: 'center', letterSpacing: 1 },
  customPreview: { color: colors.textMuted, fontSize: 12.5, marginTop: 8, textAlign: 'center', lineHeight: 18 },
  ratioOn: { borderColor: colors.primary, backgroundColor: colors.blueSurface },
  shape: { borderWidth: 1.6, borderColor: colors.subtle, borderRadius: 4 },
  shapeOn: { borderColor: colors.primary, backgroundColor: 'rgba(47,123,245,0.12)' },
  ratioText: { color: colors.textSecondary, fontSize: 13.5, fontWeight: '500' },
  ratioTextOn: { color: colors.primaryDeep, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  promptModes: { gap: 8 },
  promptMode: { flexDirection: 'row', gap: 12, padding: 14, borderRadius: 18, backgroundColor: colors.surface, borderWidth: 1.5, borderColor: 'transparent' },
  promptModeOn: { borderColor: colors.primary, backgroundColor: colors.blueSurface },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.8, borderColor: colors.subtle, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  radioOn: { borderColor: colors.primary },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.primary },
  promptTitle: { color: colors.text, fontSize: 14.5, fontWeight: '600' },
  promptDetail: { color: colors.textMuted, fontSize: 12.5, lineHeight: 18, marginTop: 3 },
  tip: { flexDirection: 'row', gap: 8, marginTop: 24, marginHorizontal: 8 },
  note: { flex: 1, color: colors.textMuted, fontSize: 12.5, lineHeight: 19 },
});
