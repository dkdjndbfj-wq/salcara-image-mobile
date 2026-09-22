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
  const saveLock = useRef(false);
  const [tested, setTested] = useState(false);
  const [dialog, setDialog] = useState<{ title: string; message: string; actions?: DialogAction[] } | null>(null);

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
      chatModel: provider.chatModel ?? '',
      chatApi: provider.chatApi ?? 'chat-completions',
      analysisProviderId: provider.analysisProviderId ?? null,
      quality: provider.quality,
      aspectRatio: provider.aspectRatio,
      resolutionTier: provider.resolutionTier,
      createdAt: provider.createdAt,
    });
    setModels([provider.model, provider.chatModel].filter((value): value is string => Boolean(value)));
    setTested(false);
  };

  const testConnection = async () => {
    try {
      setBusy(true);
      const baseUrl = normalizeBaseUrl(form.baseUrl);
      const key = form.apiKey.trim() || (form.id ? await getProviderKey(form.id) : null);
      if (!key) throw new Error('请输入 API 密钥');
      const nextModels = await fetchChatModels(baseUrl, key, form.chatApi);
      setModels(nextModels);
      setTested(true);
      setDialog({ title: '连接成功', message: nextModels.length ? `读取到 ${nextModels.length} 个模型。请选择生图或对话模型；图片／PDF 理解能力以服务商实际支持为准。` : '接口可用，但没有返回模型，请手动填写模型 ID。' });
    } catch (error) {
      setTested(false);
      setDialog({ title: '连接失败', message: error instanceof Error ? error.message : '请检查地址和密钥，也可以继续手动填写模型 ID。' });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (saveLock.current) return;
    saveLock.current = true;
    setSaving(true);
    try {
      if (generating) throw new Error('请先等待或取消当前请求，再修改服务商');
      const name = form.name.trim();
      const baseUrl = normalizeBaseUrl(form.baseUrl);
      const model = form.model.trim();
      const chatModel = form.chatModel.trim();
      const key = form.apiKey.trim() || (form.id ? await getProviderKey(form.id) : null);
      if (!name) throw new Error('请输入服务商名称');
      if (!key) throw new Error('请输入 API 密钥');
      if (!model && !chatModel) throw new Error('至少填写一个生图模型或对话模型');
      if (model && (!form.quality || !form.resolutionTier)) {
        throw new Error('使用生图功能时必须选择画质和清晰度');
      }
      if (model && form.quality && !qualitiesForModel(model).includes(form.quality)) throw new Error('此模型不支持所选画质');
      const id = form.id ?? createId();
      const now = Date.now();
      await upsertProvider({
        id,
        name,
        baseUrl,
        model: model || null,
        chatModel: chatModel || null,
        chatApi: form.chatApi,
        analysisProviderId: form.analysisProviderId,
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
      setDialog({ title: '无法保存', message: error instanceof Error ? error.message : '请检查配置。' });
    } finally {
      saveLock.current = false;
      setSaving(false);
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
                disabled={generating}
                onPress={() => void activateProvider(provider.id).then(onClose).catch((error) => setDialog({ title: '无法切换', message: error.message }))}
                style={[styles.providerRow, provider.id === activeProvider?.id && styles.providerActive]}
              >
                <View style={styles.providerInfo}>
                  <Text style={styles.providerName}>{provider.name}</Text>
                  <Text style={styles.providerMeta} numberOfLines={1}>{[provider.model && '生图', provider.chatModel && '对话'].filter(Boolean).join(' / ')} · {provider.baseUrl}</Text>
                </View>
                <Pressable accessibilityLabel="编辑服务商" onPress={() => void editProvider(provider)} style={styles.rowAction}>
                  <Ionicons name="create-outline" size={20} color={colors.textMuted} />
                </Pressable>
                <Pressable
                  accessibilityLabel="删除服务商"
                  onPress={() => setDialog({
                    title: '删除服务商？',
                    message: `将同时删除“${provider.name}”的会话、本地图片、文档和已保存密钥，此操作无法撤销。`,
                    actions: [
                      { label: '取消', tone: 'secondary', onPress: () => setDialog(null) },
                      { label: '删除', tone: 'danger', onPress: () => { setDialog(null); void removeProvider(provider.id).catch((error) => setDialog({ title: '无法删除', message: error.message })); } },
                    ],
                  })}
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
          <Text style={styles.label}>对话接口类型</Text>
          <View style={styles.chips}>
            <Chip label="Chat Completions" selected={form.chatApi === 'chat-completions'} onPress={() => setForm({ ...form, chatApi: 'chat-completions' })} />
            <Chip label="Responses" selected={form.chatApi === 'responses'} onPress={() => setForm({ ...form, chatApi: 'responses' })} />
            <Chip label="Claude Messages" selected={form.chatApi === 'anthropic'} onPress={() => setForm({ ...form, chatApi: 'anthropic' })} />
          </View>
          <Text style={styles.hint}>生图接口不受此项影响。Claude 可使用原生 Messages；生图与对话可分别添加独立地址和密钥。PDF 会在手机上逐页转成图片，需选择支持识图的模型。</Text>
          <PrimaryButton label={tested ? '重新测试并读取模型' : '测试连接并读取模型'} icon="pulse-outline" loading={busy} onPress={() => void testConnection()} />

          <Text style={styles.label}>生图模型（可留空）</Text>
          <View style={styles.chips}>{models.filter((model) => /image|dall-e|flux/i.test(model)).map((model) => <Chip key={model} label={model} selected={form.model === model} onPress={() => setForm({ ...form, model, quality: null })} />)}</View>
          <TextInput value={form.model} onChangeText={(model) => setForm({ ...form, model, quality: null })} placeholder="兼容 Images API 的模型 ID" placeholderTextColor={colors.textMuted} autoCapitalize="none" style={styles.input} />

          {Boolean(form.model) && <>
          <Text style={styles.label}>画质</Text>
          <View style={styles.chips}>{allowedQualities.map((quality) => <Chip key={quality} label={quality} selected={form.quality === quality} onPress={() => setForm({ ...form, quality })} />)}</View>
          <Text style={styles.label}>清晰度</Text>
          <View style={styles.chips}>{TIERS.map((resolutionTier) => <Chip key={resolutionTier} label={resolutionTier} selected={form.resolutionTier === resolutionTier} onPress={() => setForm({ ...form, resolutionTier })} />)}</View>
          </>}
          <Text style={styles.label}>对话／图片与文件解析模型（可留空）</Text>
          <View style={styles.chips}>{models.filter((model) => !/image|dall-e|flux/i.test(model)).slice(0, 24).map((chatModel) => <Chip key={chatModel} label={chatModel} selected={form.chatModel === chatModel} onPress={() => setForm({ ...form, chatModel })} />)}</View>
          {models.length > 24 && <Text style={styles.hint}>显示部分模型，其他模型可手动填写完整 ID。</Text>}
          <TextInput value={form.chatModel} onChangeText={(chatModel) => setForm({ ...form, chatModel })} placeholder="输入支持对话的模型 ID" placeholderTextColor={colors.textMuted} autoCapitalize="none" style={styles.input} />
          <Text style={styles.hint}>识图和 PDF 需要多模态模型，仅模型列表无法确认支持情况。</Text>
          <Text style={styles.hint}>比例属于每次生成设置，可在对话框中调整。密钥只保存在 Android 安全存储中。</Text>
          <PrimaryButton label="保存并使用" icon="checkmark" loading={saving} disabled={generating || busy} onPress={() => void save()} />
        </View>
      </View>
      <AppDialog visible={Boolean(dialog)} title={dialog?.title ?? ''} message={dialog?.message} actions={dialog?.actions} onClose={() => setDialog(null)} />
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
