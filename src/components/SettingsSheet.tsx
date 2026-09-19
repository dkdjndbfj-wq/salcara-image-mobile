import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import type { AspectRatio, Quality, ResolutionTier } from '../domain';
import { ALL_QUALITIES, qualitiesForModel, sizeFor } from '../domain-utils';
import { useApp } from '../state/AppContext';
import { colors, radius, spacing } from '../theme';
import { AppDialog, Chip, PrimaryButton, Sheet } from './ui';

const RATIOS: AspectRatio[] = ['1:1', '16:9', '9:16'];
const TIERS: ResolutionTier[] = ['1K', '2K', '4K'];

export function SettingsSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { activeProvider, updateActiveProviderSettings } = useApp();
  const [model, setModel] = useState('');
  const [quality, setQuality] = useState<Quality | null>(null);
  const [ratio, setRatio] = useState<AspectRatio | null>(null);
  const [tier, setTier] = useState<ResolutionTier | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!visible || !activeProvider) return;
    setModel(activeProvider.model ?? '');
    setQuality(activeProvider.quality);
    setRatio(activeProvider.aspectRatio);
    setTier(activeProvider.resolutionTier);
  }, [visible, activeProvider]);

  const save = async () => {
    try {
      if (!model.trim() || !quality || !ratio || !tier) throw new Error('请选择模型、画质、比例和清晰度');
      await updateActiveProviderSettings({ model: model.trim(), quality, aspectRatio: ratio, resolutionTier: tier });
      onClose();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '请检查参数。');
    }
  };

  const qualities = model ? qualitiesForModel(model) : ALL_QUALITIES;
  return (
    <Sheet visible={visible} title="生成设置" onClose={onClose}>
      <View style={styles.body}>
        <Text style={styles.provider}>{activeProvider?.name ?? '尚未选择服务商'}</Text>
        <Text style={styles.label}>模型</Text>
        <TextInput value={model} onChangeText={(value) => { setModel(value); setQuality(null); }} placeholder="gpt-image…" placeholderTextColor={colors.textMuted} autoCapitalize="none" style={styles.input} />
        <Text style={styles.label}>画质</Text>
        <View style={styles.chips}>{qualities.map((item) => <Chip key={item} label={item} selected={quality === item} onPress={() => setQuality(item)} />)}</View>
        <Text style={styles.label}>比例</Text>
        <View style={styles.chips}>{RATIOS.map((item) => <Chip key={item} label={item} selected={ratio === item} onPress={() => setRatio(item)} />)}</View>
        <Text style={styles.label}>清晰度</Text>
        <View style={styles.chips}>{TIERS.map((item) => <Chip key={item} label={item} selected={tier === item} onPress={() => setTier(item)} />)}</View>
        {ratio && tier && <Text style={styles.hint}>本次尺寸：{sizeFor(ratio, tier)} · PNG · 1 张</Text>}
        <PrimaryButton label="应用设置" icon="checkmark" onPress={() => void save()} />
      </View>
      <AppDialog visible={Boolean(errorMessage)} title="无法保存" message={errorMessage ?? ''} onClose={() => setErrorMessage(null)} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { padding: spacing.lg, gap: spacing.md },
  provider: { color: colors.primaryStrong, fontSize: 15, fontWeight: '700' },
  label: { color: colors.text, fontSize: 14, fontWeight: '700', marginTop: spacing.xs },
  input: { minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 14, color: colors.text, fontSize: 15 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  hint: { color: colors.textMuted, lineHeight: 20 },
});
