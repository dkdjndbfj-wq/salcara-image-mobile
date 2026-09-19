import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { fetchImageModels } from '../api/image-api';
import type { AspectRatio, ProviderProfile, Quality, ResolutionTier } from '../domain';
import { ALL_QUALITIES, createId, normalizeBaseUrl, qualitiesForModel } from '../domain-utils';
import { useApp } from '../state/AppContext';
import { upsertProvider } from '../storage/database';
import { getProviderKey, saveProviderKey } from '../storage/secure-keys';
import { colors, radius, spacing } from '../theme';
import { Chip, PrimaryButton, Sheet } from './ui';

const RATIOS: AspectRatio[] = ['1:1', '16:9', '9:16'];
const TIERS: ResolutionTier[] = ['1K', '2K', '4K'];

type FormState = {
  id: string | null;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  quality: Quality | null;
  aspectRatio: AspectRatio | null;
  resolutionTier: ResolutionTier | null;
  createdAt: number;
};

function emptyForm(): FormState {
  return { id: null, name: '', baseUrl: '', apiKey: '', model: '', quality: null, aspectRatio: null, resolutionTier: null, createdAt: Date.now() };
}

export function ProviderManager({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { providers, activeProvider, reloadProviders, activateProvider, removeProvider } = useApp();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [tested, setTested] = useState(false);

  useEffect(() => {
    if (!visible) {
      setForm(emptyForm());
      setModels([]);
      setTested(false);
    }
  }, [visible]);

  const editProvider = async (provider: ProviderProfile) => {
    setForm({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: '',
      model: provider.model ?? '',
      quality: provider.quality,
      aspectRatio: provider.aspectRatio,
      resolutionTier: provider.resolutionTier,
      createdAt: provider.createdAt,
    });
    setModels(provider.model ? [provider.model] : []);
    setTested(false);
  };

  const testConnection = async () => {
    try {
      setBusy(true);
      const baseUrl = normalizeBaseUrl(form.baseUrl);
      const key = form.apiKey.trim() || (form.id ? await getProviderKey(form.id) : null);
      if (!key) throw new Error('请输入 API 密钥');
      const nextModels = await fetchImageModels(baseUrl, key);
      setModels(nextModels);
      setTested(true);
      Alert.alert('连接成功', nextModels.length ? `找到 ${nextModels.length} 个图片模型` : '接口可用，但没有返回 gpt-image 模型，请手动填写模型 ID');
    } catch (error) {
      setTested(false);
      Alert.alert('连接失败', error instanceof Error ? error.message : '请检查地址和密钥，也可以继续手动填写模型 ID');
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    try {
      const name = form.name.trim();
      const baseUrl = normalizeBaseUrl(form.baseUrl);
      const model = form.model.trim();
      const key = form.apiKey.trim() || (form.id ? await getProviderKey(form.id) : null);
      if (!name) throw new Error('请输入服务商名称');
      if (!key) throw new Error('请输入 API 密钥');
      if (!model || !form.quality || !form.aspectRatio || !form.resolutionTier) {
        throw new Error('首次使用必须选择模型、画质、比例和清晰度');
      }
      const id = form.id ?? createId();
      const now = Date.now();
      await upsertProvider({
        id,
        name,
        baseUrl,
        model,
        quality: form.quality,
        aspectRatio: form.aspectRatio,
        resolutionTier: form.resolutionTier,
        createdAt: form.id ? form.createdAt : now,
        updatedAt: now,
      });
      if (form.apiKey.trim() || !form.id) await saveProviderKey(id, key);
      await reloadProviders();
      await activateProvider(id);
      setForm(emptyForm());
      setModels([]);
      setTested(false);
      onClose();
    } catch (error) {
      Alert.alert('无法保存', error instanceof Error ? error.message : '请检查配置');
    }
  };

  const allowedQualities = form.model ? qualitiesForModel(form.model) : ALL_QUALITIES;

  return (
    <Sheet visible={visible} title="服务商" onClose={onClose}>
      <View style={styles.body}>
        {providers.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.label}>已保存</Text>
            {providers.map((provider) => (
              <Pressable
                key={provider.id}
                onPress={() => void activateProvider(provider.id)}
                style={[styles.providerRow, provider.id === activeProvider?.id && styles.providerActive]}
              >
                <View style={styles.providerInfo}>
                  <Text style={styles.providerName}>{provider.name}</Text>
                  <Text style={styles.providerMeta} numberOfLines={1}>{provider.model ?? '尚未选择模型'} · {provider.baseUrl}</Text>
                </View>
                <Pressable accessibilityLabel="编辑服务商" onPress={() => void editProvider(provider)} style={styles.rowAction}>
                  <Ionicons name="create-outline" size={20} color={colors.textMuted} />
                </Pressable>
                <Pressable
                  accessibilityLabel="删除服务商"
                  onPress={() => Alert.alert('删除服务商？', `将同时删除“${provider.name}”的会话和本地图片。`, [
                    { text: '取消', style: 'cancel' },
                    { text: '删除', style: 'destructive', onPress: () => void removeProvider(provider.id) },
                  ])}
                  style={styles.rowAction}
                >
                  <Ionicons name="trash-outline" size={20} color={colors.danger} />
                </Pressable>
              </Pressable>
            ))}
          </View>
        )}

        <View style={styles.section}>
          <View style={styles.formHeading}>
            <Text style={styles.heading}>{form.id ? '编辑服务商' : '添加服务商'}</Text>
            {form.id && <Pressable onPress={() => setForm(emptyForm())}><Text style={styles.link}>新建</Text></Pressable>}
          </View>
          <Field label="名称" value={form.name} placeholder="例如：Salcara" onChangeText={(name) => setForm({ ...form, name })} />
          <Field label="API 地址" value={form.baseUrl} placeholder="https://example.com 或 /v1" autoCapitalize="none" keyboardType="url" onChangeText={(baseUrl) => setForm({ ...form, baseUrl })} />
          <Field label="API 密钥" value={form.apiKey} placeholder={form.id ? '留空则保留原密钥' : 'sk-…'} secureTextEntry autoCapitalize="none" onChangeText={(apiKey) => setForm({ ...form, apiKey })} />
          <PrimaryButton label={tested ? '重新测试并读取模型' : '测试连接并读取模型'} icon="pulse-outline" loading={busy} onPress={() => void testConnection()} />

          <Text style={styles.label}>模型</Text>
          {models.length > 0 && <View style={styles.chips}>{models.map((model) => <Chip key={model} label={model} selected={form.model === model} onPress={() => setForm({ ...form, model, quality: null })} />)}</View>}
          <TextInput value={form.model} onChangeText={(model) => setForm({ ...form, model, quality: null })} placeholder="也可手动填写模型 ID" placeholderTextColor={colors.textMuted} autoCapitalize="none" style={styles.input} />

          <Text style={styles.label}>画质</Text>
          <View style={styles.chips}>{allowedQualities.map((quality) => <Chip key={quality} label={quality} selected={form.quality === quality} onPress={() => setForm({ ...form, quality })} />)}</View>
          <Text style={styles.label}>比例</Text>
          <View style={styles.chips}>{RATIOS.map((aspectRatio) => <Chip key={aspectRatio} label={aspectRatio} selected={form.aspectRatio === aspectRatio} onPress={() => setForm({ ...form, aspectRatio })} />)}</View>
          <Text style={styles.label}>清晰度</Text>
          <View style={styles.chips}>{TIERS.map((resolutionTier) => <Chip key={resolutionTier} label={resolutionTier} selected={form.resolutionTier === resolutionTier} onPress={() => setForm({ ...form, resolutionTier })} />)}</View>
          <Text style={styles.hint}>每个服务商分别记住上次选择。密钥只保存在 Android 安全存储中。</Text>
          <PrimaryButton label="保存并使用" icon="checkmark" onPress={() => void save()} />
        </View>
      </View>
    </Sheet>
  );
}

function Field(props: React.ComponentProps<typeof TextInput> & { label: string }) {
  const { label, ...inputProps } = props;
  return <View><Text style={styles.label}>{label}</Text><TextInput {...inputProps} placeholderTextColor={colors.textMuted} style={styles.input} /></View>;
}

const styles = StyleSheet.create({
  body: { padding: spacing.lg, gap: spacing.xl },
  section: { gap: spacing.md },
  heading: { fontSize: 18, color: colors.text, fontWeight: '700' },
  formHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  link: { color: colors.primaryStrong, fontWeight: '700' },
  label: { color: colors.text, fontSize: 14, fontWeight: '700', marginTop: spacing.xs },
  hint: { color: colors.textMuted, lineHeight: 20, fontSize: 13 },
  input: { minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 14, color: colors.text, backgroundColor: colors.background, fontSize: 15 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  providerRow: { minHeight: 64, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingLeft: spacing.md, backgroundColor: colors.background },
  providerActive: { borderColor: colors.primary, backgroundColor: colors.blueSurface },
  providerInfo: { flex: 1, gap: 4 },
  providerName: { color: colors.text, fontWeight: '700', fontSize: 15 },
  providerMeta: { color: colors.textMuted, fontSize: 12 },
  rowAction: { width: 42, height: 48, alignItems: 'center', justifyContent: 'center' },
});
