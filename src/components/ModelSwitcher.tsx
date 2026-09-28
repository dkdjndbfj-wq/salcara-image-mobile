import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { fetchChatModels } from '../api/chat-api';
import type { AspectRatio, ProviderProfile, Quality, ResolutionTier } from '../domain';
import { qualitiesForModel } from '../domain-utils';
import { normalizeRatio, RATIO_PRESETS, ratioValue, sizeNote, supportsAutoSize, supportsClarity } from '../image-sizes';
import { useApp } from '../state/AppContext';
import { getProviderKey } from '../storage/secure-keys';
import { colors, prettyModel } from '../theme';
import { Icon } from './Icon';
import { ModelSelect } from './ModelSelect';
import { AppDialog, Chip, Group, ListRow, SectionLabel, Sheet } from './ui';

const TIERS: ResolutionTier[] = ['1K', '2K', '4K'];
const IMAGE_MODEL = /image|dall-e|flux|imagen|seedream|midjourney|sd-|stable/i;

/** Quick switcher opened from the title: everything the user tweaks mid-conversation. */
export function ModelSwitcher({ visible, onClose, onManageProviders }: { visible: boolean; onClose: () => void; onManageProviders: () => void }) {
  const { providers, chatProvider, imageProvider, selectChatProvider, selectImageProvider } = useApp();
  const [picker, setPicker] = useState<{ capability: 'chat' | 'image'; provider: ProviderProfile } | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [custom, setCustom] = useState<string | null>(null);
  const chatProviders = providers.filter((item) => item.chatModel);
  const imageProviders = providers.filter((item) => item.model);

  const load = async (provider: ProviderProfile, capability: 'chat' | 'image') => {
    setModels([]); setLoadError(null); setLoading(true);
    try {
      const key = await getProviderKey(provider.id);
      if (!key) throw new Error('这个服务商没有保存密钥');
      const list = await fetchChatModels(provider.baseUrl, key, capability === 'chat' ? provider.chatApi : 'chat-completions');
      setModels(list);
      if (!list.length) setLoadError('服务商没有返回模型列表，可以手动添加模型 ID');
    } catch (reason) { setLoadError(reason instanceof Error ? reason.message : '读取模型失败'); }
    finally { setLoading(false); }
  };
  const openPicker = (provider: ProviderProfile, capability: 'chat' | 'image') => { setPicker({ provider, capability }); void load(provider, capability); };
  const run = (task: Promise<unknown>) => void task.catch((reason) => setError(reason instanceof Error ? reason.message : '暂时无法保存'));
  const patchImage = (patch: { quality?: Quality; aspectRatio?: AspectRatio; resolutionTier?: ResolutionTier }) => {
    if (imageProvider) run(selectImageProvider(imageProvider.id, patch));
  };
  const qualities = imageProvider?.model ? qualitiesForModel(imageProvider.model) : [];

  return <Sheet visible={visible} title="模型" onClose={onClose}>
    <View style={styles.body}>
      <SectionLabel>对话</SectionLabel>
      {chatProviders.length ? <Group>
        {chatProviders.map((provider, index) => <Option key={provider.id} first={index === 0} title={prettyModel(provider.chatModel)} detail={provider.name}
          selected={provider.id === chatProvider?.id} onPress={() => run(selectChatProvider(provider.id))} />)}
        {chatProvider && <ListRow icon="settings" title="更换对话模型" onPress={() => openPicker(chatProvider, 'chat')} />}
      </Group> : <Empty text="添加对话服务" onPress={() => { onClose(); onManageProviders(); }} />}

      <SectionLabel>绘图</SectionLabel>
      {imageProviders.length && imageProvider ? <>
        <Group>
          {imageProviders.map((provider, index) => <Option key={provider.id} first={index === 0} title={prettyModel(provider.model)} detail={provider.name}
            selected={provider.id === imageProvider.id} onPress={() => run(selectImageProvider(provider.id))} />)}
          <ListRow icon="settings" title="更换绘图模型" onPress={() => openPicker(imageProvider, 'image')} />
        </Group>
        <Text style={styles.groupTitle}>默认画幅</Text>
        {(() => {
          const current = imageProvider.aspectRatio ?? '1:1';
          const presets = RATIO_PRESETS.filter((ratio) => ratio.value !== 'auto' || supportsAutoSize(imageProvider.model));
          const isCustom = !presets.some((ratio) => ratio.value === current);
          return <View style={styles.ratios}>
            {presets.map((ratio) => <RatioTile key={ratio.value} value={ratio.value} label={ratio.label} hint={ratio.hint} selected={current === ratio.value} onPress={() => patchImage({ aspectRatio: ratio.value })} />)}
            <RatioTile value={isCustom ? current : null} label={isCustom ? current : '自定义'} hint={isCustom ? '自定义' : '任意 宽:高'} selected={isCustom} onPress={() => setCustom(isCustom ? current : '')} />
          </View>;
        })()}
        <Text style={styles.sizeNote}>{sizeNote(imageProvider.aspectRatio ?? '1:1', imageProvider.resolutionTier ?? '1K', imageProvider.model)}</Text>
        {supportsClarity(imageProvider.model) && <>
          <Text style={styles.groupTitle}>清晰度</Text>
          <View style={styles.chips}>{TIERS.map((tier) => <Chip key={tier} label={TIER_LABEL[tier]} selected={(imageProvider.resolutionTier ?? '1K') === tier} onPress={() => patchImage({ resolutionTier: tier })} />)}</View>
        </>}
        <Text style={styles.groupTitle}>画质</Text>
        <View style={styles.chips}>{qualities.map((quality) => <Chip key={quality} label={QUALITY_LABEL[quality] ?? quality} selected={(imageProvider.quality ?? 'auto') === quality} onPress={() => patchImage({ quality })} />)}</View>
        <View style={styles.tip}><Icon name="sparkles" size={16} color={colors.primary} /><Text style={styles.note}>对话里说“做成手机壁纸”“21:9 电影感”“横幅”或“透明背景”，Salcara 会自动调整那一张。</Text></View>
      </> : <Empty text="添加绘图服务" onPress={() => { onClose(); onManageProviders(); }} />}
    </View>
    <ModelSelect visible={Boolean(picker)} title={picker?.capability === 'image' ? '选择绘图模型' : '选择对话模型'}
      value={(picker?.capability === 'image' ? picker.provider.model : picker?.provider.chatModel) ?? ''}
      models={models.filter((model) => picker?.capability === 'image' ? IMAGE_MODEL.test(model) : !IMAGE_MODEL.test(model))}
      loading={loading} error={loadError} onClose={() => setPicker(null)} onRefresh={() => picker && void load(picker.provider, picker.capability)}
      onSelect={(model) => {
        if (!picker) return;
        if (picker.capability === 'chat') run(selectChatProvider(picker.provider.id, model));
        else run(selectImageProvider(picker.provider.id, { model, quality: picker.provider.quality && qualitiesForModel(model).includes(picker.provider.quality) ? picker.provider.quality : 'auto' }));
      }} />
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

function Option({ title, detail, selected, first, onPress }: { title: string; detail: string; selected: boolean; first: boolean; onPress: () => void }) {
  return <ListRow first={first} title={title} detail={detail} onPress={onPress} right={selected ? <Icon name="check" size={20} color={colors.primary} strokeWidth={2.2} /> : <View style={{ width: 20 }} />} />;
}

function Empty({ text, onPress }: { text: string; onPress: () => void }) {
  return <Group><ListRow first icon="plus" title={text} onPress={onPress} /></Group>;
}

const TIER_LABEL: Record<ResolutionTier, string> = { '1K': '1K 标准', '2K': '2K 高清', '4K': '4K 超清' };
const QUALITY_LABEL: Record<string, string> = { auto: '自动', low: '快速', medium: '标准', high: '精细', xhigh: '超精细', max: '极致' };

const styles = StyleSheet.create({
  body: { paddingHorizontal: 16, paddingBottom: 8 },
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
  tip: { flexDirection: 'row', gap: 8, marginTop: 24, marginHorizontal: 8 },
  note: { flex: 1, color: colors.textMuted, fontSize: 12.5, lineHeight: 19 },
});
