import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { fetchChatModels } from '../api/chat-api';
import type { AspectRatio, ChatApi, ProviderProfile, Quality, ResolutionTier } from '../domain';
import { ALL_QUALITIES, createId, normalizeBaseUrl, qualitiesForModel } from '../domain-utils';
import { useApp } from '../state/AppContext';
import { upsertProvider } from '../storage/database';
import { getProviderKey, saveProviderKey } from '../storage/secure-keys';
import { colors, radius, spacing } from '../theme';
import { AppDialog, Chip, PrimaryButton, Sheet, type DialogAction } from './ui';

const TIERS: ResolutionTier[] = ['1K', '2K', '4K'];

type FormState = {
  id: string | null;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  chatModel: string;
  chatApi: ChatApi;
  analysisProviderId: string | null;
  quality: Quality | null;
  aspectRatio: AspectRatio | null;
  resolutionTier: ResolutionTier | null;
  createdAt: number;
};

function emptyForm(): FormState {
  return { id: null, name: '', baseUrl: '', apiKey: '', model: '', chatModel: '', chatApi: 'chat-completions', analysisProviderId: null, quality: null, aspectRatio: null, resolutionTier: null, createdAt: Date.now() };
}

export function ProviderManager({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { providers, activeProvider, reloadProviders, activateProvider, removeProvider, generating } = useApp();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const saveLock = useRef(false);
  const [tested, setTested] = useState(false);
  const [dialog, setDialog] = useState<{ title: string; message: string; actions?: DialogAction[] } | null>(null);

  useEffect(() => {
    if (!visible) {
      setForm(emptyForm()); setModels([]); setTested(false); setEditorOpen(false); setAdvancedOpen(false);
      return;
    }
    if (providers.length === 0) setEditorOpen(true);
  }, [visible, providers.length]);

  const openNew = () => { setForm(emptyForm()); setModels([]); setTested(false); setAdvancedOpen(false); setEditorOpen(true); };
  const editProvider = (provider: ProviderProfile) => {
    setForm({
      id: provider.id, name: provider.name, baseUrl: provider.baseUrl, apiKey: '', model: provider.model ?? '', chatModel: provider.chatModel ?? '',
      chatApi: provider.chatApi ?? 'chat-completions', analysisProviderId: provider.analysisProviderId ?? null,
      quality: provider.quality, aspectRatio: provider.aspectRatio, resolutionTier: provider.resolutionTier, createdAt: provider.createdAt,
    });
    setModels([provider.model, provider.chatModel].filter((value): value is string => Boolean(value)));
    setTested(false); setAdvancedOpen(false); setEditorOpen(true);
  };

  const testConnection = async () => {
    try {
      setBusy(true);
      const baseUrl = normalizeBaseUrl(form.baseUrl);
      const key = form.apiKey.trim() || (form.id ? await getProviderKey(form.id) : null);
      if (!key) throw new Error('请输入 API 密钥');
      const nextModels = await fetchChatModels(baseUrl, key, form.chatApi);
      setModels(nextModels); setTested(true);
      setDialog({ title: '连接成功', message: nextModels.length ? `发现 ${nextModels.length} 个模型。请选择需要的能力；模型是否支持视觉和文件输入以服务商实际能力为准。` : '接口可用，但没有返回模型，请手动填写模型 ID。' });
    } catch (error) {
      setTested(false);
      setDialog({ title: '连接失败', message: error instanceof Error ? error.message : '请检查地址和密钥，也可以手动填写模型 ID。' });
    } finally { setBusy(false); }
  };

  const save = async () => {
    if (saveLock.current) return;
    saveLock.current = true; setSaving(true);
    try {
      if (generating) throw new Error('请先等待或取消当前请求，再修改服务商');
      const name = form.name.trim();
      const baseUrl = normalizeBaseUrl(form.baseUrl);
      const model = form.model.trim();
      const chatModel = form.chatModel.trim();
      const key = form.apiKey.trim() || (form.id ? await getProviderKey(form.id) : null);
      if (!name) throw new Error('请输入服务商名称');
      if (!key) throw new Error('请输入 API 密钥');
      if (!model && !chatModel) throw new Error('至少填写一个对话模型或图片模型');
      if (model && (!form.quality || !form.resolutionTier || !form.aspectRatio)) throw new Error('图片创作需要选择画质、比例和清晰度');
      if (model && form.quality && !qualitiesForModel(model).includes(form.quality)) throw new Error('此模型不支持所选画质');
      const id = form.id ?? createId();
      const now = Date.now();
      await upsertProvider({ id, name, baseUrl, model: model || null, chatModel: chatModel || null, chatApi: form.chatApi, analysisProviderId: form.analysisProviderId, quality: form.quality, aspectRatio: form.aspectRatio, resolutionTier: form.resolutionTier, createdAt: form.id ? form.createdAt : now, updatedAt: now });
      if (form.apiKey.trim() || !form.id) await saveProviderKey(id, key);
      await reloadProviders(); await activateProvider(id);
      setForm(emptyForm()); setModels([]); setTested(false); setEditorOpen(false); onClose();
    } catch (error) {
      setDialog({ title: '无法保存', message: error instanceof Error ? error.message : '请检查配置。' });
    } finally { saveLock.current = false; setSaving(false); }
  };

  const allowedQualities = form.model ? qualitiesForModel(form.model) : ALL_QUALITIES;
  const imageModels = models.filter((model) => /image|dall-e|flux/i.test(model));
  const chatModels = models.filter((model) => !/image|dall-e|flux/i.test(model));

  return (
    <Sheet visible={visible} title={editorOpen ? (form.id ? '编辑服务商' : '添加服务商') : '服务商'} onClose={onClose}>
      {!editorOpen ? (
        <View style={styles.page}>
          <View style={styles.introCard}>
            <View style={styles.introIcon}><Ionicons name="sparkles-outline" size={22} color={colors.primaryStrong} /></View>
            <View style={styles.introCopy}><Text style={styles.introTitle}>连接你自己的 AI 服务</Text><Text style={styles.introHint}>对话、文件分析和图片创作可以使用同一个服务商，也可以分开配置。</Text></View>
          </View>
          <PrimaryButton label="添加服务商" icon="add" onPress={openNew} />
          {providers.length > 0 && <Text style={styles.sectionTitle}>已保存的服务商</Text>}
          <View style={styles.providerList}>
            {providers.map((provider) => <ProviderCard key={provider.id} provider={provider} active={provider.id === activeProvider?.id} onSelect={() => void activateProvider(provider.id).then(onClose).catch((error) => setDialog({ title: '无法切换', message: error.message }))} onEdit={() => editProvider(provider)} onDelete={() => setDialog({ title: '删除服务商？', message: `将同时删除“${provider.name}”的会话、本地文件和密钥，此操作无法撤销。`, actions: [{ label: '取消', tone: 'secondary', onPress: () => setDialog(null) }, { label: '删除', tone: 'danger', onPress: () => { setDialog(null); void removeProvider(provider.id).catch((error) => setDialog({ title: '无法删除', message: error.message })); } }] })} />)}
          </View>
          <Text style={styles.footerHint}>密钥只保存到 Android 安全存储，不会写入 SQLite 或日志。</Text>
        </View>
      ) : (
        <View style={styles.page}>
          {providers.length > 0 && <Pressable style={styles.backRow} onPress={() => setEditorOpen(false)}><Ionicons name="arrow-back" size={19} color={colors.primaryStrong} /><Text style={styles.backText}>返回服务商列表</Text></Pressable>}
          <SectionCard title="基本信息" subtitle="地址支持根域名或带 /v1 的地址">
            <Field label="名称" value={form.name} placeholder="例如：Salcara 对话" onChangeText={(name) => setForm({ ...form, name })} />
            <Field label="API 地址" value={form.baseUrl} placeholder="https://example.com 或 https://example.com/v1" autoCapitalize="none" keyboardType="url" onChangeText={(baseUrl) => setForm({ ...form, baseUrl })} />
            <Field label="API 密钥" value={form.apiKey} placeholder={form.id ? '留空则保留原密钥' : 'sk-…'} secureTextEntry autoCapitalize="none" onChangeText={(apiKey) => setForm({ ...form, apiKey })} />
            <PrimaryButton label={tested ? '重新测试连接' : '测试连接并读取模型'} icon="pulse-outline" loading={busy} onPress={() => void testConnection()} />
          </SectionCard>

          <SectionCard title="对话能力" subtitle="推荐先配置；默认首页会使用这里的模型">
            <ModelChooser label="对话模型" value={form.chatModel} models={chatModels} placeholder="填写支持对话 / 视觉 / 文件的模型 ID" onChange={(chatModel) => setForm({ ...form, chatModel })} />
            <Text style={styles.label}>接口协议</Text>
            <View style={styles.chips}>{(['chat-completions', 'responses', 'anthropic'] as ChatApi[]).map((api) => <Chip key={api} label={api === 'chat-completions' ? 'Chat Completions' : api === 'responses' ? 'Responses' : 'Claude Messages'} selected={form.chatApi === api} onPress={() => setForm({ ...form, chatApi: api })} />)}</View>
            <Text style={styles.hint}>图片、PDF、Word、表格和代码的实际解析能力由模型决定；应用会优先做安全的本地提取。</Text>
          </SectionCard>

          <SectionCard title="图片创作（可选）" subtitle="只有需要生图时才填写；比例和画质会在图片模式中调整">
            <ModelChooser label="图片模型" value={form.model} models={imageModels} placeholder="例如：gpt-image-2.5-sunburst" onChange={(model) => setForm({ ...form, model, quality: null })} />
            {Boolean(form.model) && <>
              <Text style={styles.label}>默认画质</Text><View style={styles.chips}>{allowedQualities.map((quality) => <Chip key={quality} label={quality} selected={form.quality === quality} onPress={() => setForm({ ...form, quality })} />)}</View>
              <Text style={styles.label}>默认比例</Text><View style={styles.chips}>{(['1:1', '16:9', '9:16'] as AspectRatio[]).map((aspectRatio) => <Chip key={aspectRatio} label={aspectRatio} selected={form.aspectRatio === aspectRatio} onPress={() => setForm({ ...form, aspectRatio })} />)}</View>
              <Text style={styles.label}>默认清晰度</Text><View style={styles.chips}>{TIERS.map((resolutionTier) => <Chip key={resolutionTier} label={resolutionTier} selected={form.resolutionTier === resolutionTier} onPress={() => setForm({ ...form, resolutionTier })} />)}</View>
            </>}
          </SectionCard>

          <Pressable style={styles.advancedHeader} onPress={() => setAdvancedOpen((value) => !value)}><View><Text style={styles.advancedTitle}>高级选项</Text><Text style={styles.advancedHint}>图片解析服务商关联</Text></View><Ionicons name={advancedOpen ? 'chevron-up' : 'chevron-down'} size={20} color={colors.textMuted} /></Pressable>
          {advancedOpen && <View style={styles.advancedBody}><Text style={styles.label}>图片文件解析服务商</Text><View style={styles.chips}><Chip label="使用当前服务商" selected={!form.analysisProviderId} onPress={() => setForm({ ...form, analysisProviderId: null })} />{providers.filter((item) => item.id !== form.id && item.chatModel).map((item) => <Chip key={item.id} label={item.name} selected={form.analysisProviderId === item.id} onPress={() => setForm({ ...form, analysisProviderId: item.id })} />)}</View><Text style={styles.hint}>图片模式遇到文件时，会先向这里选择的对话服务商发起一次解析，再调用图片模型；两次请求分别计费。</Text></View>}
          <PrimaryButton label="保存并使用" icon="checkmark" loading={saving} disabled={generating || busy} onPress={() => void save()} />
        </View>
      )}
      <AppDialog visible={Boolean(dialog)} title={dialog?.title ?? ''} message={dialog?.message} actions={dialog?.actions} onClose={() => setDialog(null)} />
    </Sheet>
  );
}

function ProviderCard({ provider, active, onSelect, onEdit, onDelete }: { provider: ProviderProfile; active: boolean; onSelect: () => void; onEdit: () => void; onDelete: () => void }) {
  return <View style={[styles.providerCard, active && styles.providerCardActive]}>
    <Pressable style={styles.providerMain} onPress={onSelect}><View style={[styles.providerBadge, active && styles.providerBadgeActive]}><Ionicons name={active ? 'checkmark' : 'server-outline'} size={20} color={active ? colors.primaryStrong : colors.textMuted} /></View><View style={styles.providerCopy}><Text style={styles.providerName} numberOfLines={1}>{provider.name}</Text><Text style={styles.providerUrl} numberOfLines={1}>{provider.baseUrl}</Text><View style={styles.capabilityRow}>{provider.chatModel && <Capability label="对话" />} {provider.model && <Capability label="图片" />}</View></View></Pressable><View style={styles.cardActions}><Pressable accessibilityLabel="编辑服务商" onPress={onEdit} style={styles.smallAction}><Ionicons name="create-outline" size={19} color={colors.textMuted} /></Pressable><Pressable accessibilityLabel="删除服务商" onPress={onDelete} style={styles.smallAction}><Ionicons name="trash-outline" size={19} color={colors.danger} /></Pressable></View>
  </View>;
}

function Capability({ label }: { label: string }) { return <View style={styles.capability}><Ionicons name="checkmark-circle" size={12} color={colors.primaryStrong} /><Text style={styles.capabilityText}>{label}</Text></View>; }

function SectionCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return <View style={styles.sectionCard}><View style={styles.sectionHeading}><Text style={styles.sectionTitle}>{title}</Text><Text style={styles.sectionSubtitle}>{subtitle}</Text></View>{children}</View>;
}

function ModelChooser({ label, value, models, placeholder, onChange }: { label: string; value: string; models: string[]; placeholder: string; onChange: (value: string) => void }) {
  return <><Text style={styles.label}>{label}</Text>{models.length > 0 && <View style={styles.chips}>{models.slice(0, 16).map((model) => <Chip key={model} label={model} selected={value === model} onPress={() => onChange(model)} />)}</View>}<TextInput value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={colors.textMuted} autoCapitalize="none" autoCorrect={false} style={styles.input} /></>;
}

function Field(props: React.ComponentProps<typeof TextInput> & { label: string }) {
  const { label, ...inputProps } = props;
  return <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput {...inputProps} placeholderTextColor={colors.textMuted} style={styles.input} /></View>;
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, gap: spacing.md },
  introCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, borderRadius: radius.lg, backgroundColor: colors.blueSurface, borderWidth: 1, borderColor: '#CFE5FF' },
  introIcon: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  introCopy: { flex: 1, gap: 4 },
  introTitle: { color: colors.text, fontSize: 15, fontWeight: '800' },
  introHint: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  sectionTitle: { color: colors.text, fontSize: 14, fontWeight: '800', marginTop: spacing.sm },
  providerList: { gap: spacing.sm },
  providerCard: { minHeight: 86, flexDirection: 'row', alignItems: 'center', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background, padding: spacing.sm },
  providerCardActive: { borderColor: colors.primary, backgroundColor: colors.blueSurface },
  providerMain: { flex: 1, minHeight: 68, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.xs },
  providerBadge: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  providerBadgeActive: { backgroundColor: colors.background },
  providerCopy: { flex: 1, gap: 4 },
  providerName: { color: colors.text, fontSize: 15, fontWeight: '800' },
  providerUrl: { color: colors.textMuted, fontSize: 11 },
  capabilityRow: { flexDirection: 'row', gap: spacing.sm },
  capability: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  capabilityText: { color: colors.primaryStrong, fontSize: 10, fontWeight: '700' },
  cardActions: { flexDirection: 'row' },
  smallAction: { width: 38, height: 42, alignItems: 'center', justifyContent: 'center' },
  footerHint: { color: colors.textMuted, fontSize: 11, lineHeight: 17, textAlign: 'center', paddingVertical: spacing.sm },
  backRow: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 34 },
  backText: { color: colors.primaryStrong, fontWeight: '700', fontSize: 13 },
  sectionCard: { gap: spacing.md, padding: spacing.md, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  sectionHeading: { gap: 3 },
  sectionSubtitle: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  field: { gap: 5 },
  label: { color: colors.text, fontSize: 13, fontWeight: '700' },
  input: { minHeight: 46, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 13, color: colors.text, backgroundColor: colors.surface, fontSize: 14 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  hint: { color: colors.textMuted, lineHeight: 18, fontSize: 12 },
  advancedHeader: { minHeight: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.md, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  advancedTitle: { color: colors.text, fontSize: 14, fontWeight: '800' },
  advancedHint: { color: colors.textMuted, fontSize: 11, marginTop: 3 },
  advancedBody: { gap: spacing.md, padding: spacing.md, borderRadius: radius.lg, backgroundColor: colors.blueSurface },
});
