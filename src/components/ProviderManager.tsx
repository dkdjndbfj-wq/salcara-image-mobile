import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { fetchChatModels } from '../api/chat-api';
import { CHAT_PRESETS, presetFor } from '../api/presets';
import type { ChatApi, ProviderProfile } from '../domain';
import { createId, normalizeBaseUrl, qualitiesForModel } from '../domain-utils';
import { useApp } from '../state/AppContext';
import { upsertProvider } from '../storage/database';
import { getProviderKey, saveProviderKey } from '../storage/secure-keys';
import { colors, prettyModel, radius } from '../theme';
import { BrandMark } from './Brand';
import { Icon, type IconName } from './Icon';
import { ModelSelect } from './ModelSelect';
import { Appear, AppDialog, Group, ListRow, PrimaryButton, SectionLabel, Sheet, dismissKeyboardAndBlur, type DialogAction } from './ui';

type Form = { id: string | null; name: string; baseUrl: string; apiKey: string; chatApi: ChatApi; useChat: boolean; chatModel: string; useImage: boolean; model: string };
const emptyForm = (): Form => ({ id: null, name: '', baseUrl: '', apiKey: '', chatApi: 'chat-completions', useChat: true, chatModel: '', useImage: true, model: '' });
const PROTOCOLS: { value: ChatApi; title: string }[] = [
  { value: 'chat-completions', title: 'OpenAI 兼容' }, { value: 'responses', title: 'Responses' }, { value: 'anthropic', title: 'Claude' },
];
const IMAGE_MODEL = /image|dall-e|flux|imagen|seedream|midjourney|sd-|stable|cogview|kolors|wanx/i;

export function ProviderManager({ visible, onClose, focusProviderId }: { visible: boolean; onClose: () => void; focusProviderId?: string | null }) {
  const { providers, chatProvider, imageProvider, reloadProviders, selectChatProvider, selectImageProvider, removeProvider } = useApp();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Form>(emptyForm);
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState<{ state: 'idle' | 'loading' | 'ok' | 'error'; message?: string }>({ state: 'idle' });
  const [picker, setPicker] = useState<'chat' | 'image' | null>(null);
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<{ title: string; message: string; actions?: DialogAction[]; icon?: string } | null>(null);
  const loadId = useRef(0);
  const patch = (value: Partial<Form>) => setForm((current) => ({ ...current, ...value }));

  const startNew = () => { loadId.current += 1; setForm(emptyForm()); setModels([]); setStatus({ state: 'idle' }); setShowKey(false); setEditing(true); };
  const edit = (provider: ProviderProfile) => {
    loadId.current += 1;
    setForm({ id: provider.id, name: provider.name, baseUrl: provider.baseUrl, apiKey: '', chatApi: provider.chatApi ?? 'chat-completions',
      useChat: Boolean(provider.chatModel), chatModel: provider.chatModel ?? '', useImage: Boolean(provider.model), model: provider.model ?? '' });
    setModels([provider.chatModel, provider.model].filter((item): item is string => Boolean(item)));
    setStatus({ state: 'idle' }); setShowKey(false); setEditing(true);
  };
  useEffect(() => {
    if (!visible) { setEditing(false); return; }
    if (!providers.length) startNew();
    else if (focusProviderId) { const provider = providers.find((item) => item.id === focusProviderId); if (provider) edit(provider); }
    // Snapshot on open only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, focusProviderId]);

  const connection = async () => {
    if (!form.baseUrl.trim()) throw new Error('请填写 API 地址');
    const baseUrl = normalizeBaseUrl(form.baseUrl);
    // A saved key only goes back to the host it was saved for; a new address needs its own key.
    const saved = form.id ? providers.find((item) => item.id === form.id) : null;
    const sameHost = saved ? hostOf(saved.baseUrl) === hostOf(baseUrl) : false;
    const key = form.apiKey.trim() || (form.id && sameHost ? await getProviderKey(form.id) : null);
    if (!key) throw new Error(form.id && !sameHost ? '地址换成了另一个服务，请重新填写这个服务的 API 密钥' : '请填写 API 密钥');
    return { baseUrl, key };
  };
  const loadModels = async () => {
    const requestId = ++loadId.current;
    dismissKeyboardAndBlur();
    try {
      const { baseUrl, key } = await connection();
      setStatus({ state: 'loading' });
      const list = await fetchChatModels(baseUrl, key, form.chatApi);
      const preset = presetFor(baseUrl);
      if (requestId !== loadId.current) return;
      setModels(list);
      setStatus(list.length ? { state: 'ok', message: `连接成功 · ${list.length} 个模型` } : { state: 'error', message: '已连接，但服务商没有返回模型列表，可手动填写模型 ID' });
      // Helpful defaults: pick the first obvious candidates when empty.
      setForm((current) => ({
        ...current,
        name: current.name || hostLabel(baseUrl),
        chatModel: current.chatModel || list.find((item) => !IMAGE_MODEL.test(item) && Boolean(preset?.prefer?.test(item))) || list.find((item) => !IMAGE_MODEL.test(item)) || '',
        model: current.model || list.find((item) => Boolean(preset?.preferImage?.test(item))) || list.find((item) => /gpt-image/i.test(item)) || list.find((item) => IMAGE_MODEL.test(item)) || '',
        // Only pre-enable a capability the service appears to offer.
        useImage: current.id || !list.length ? current.useImage : list.some((item) => IMAGE_MODEL.test(item)),
        useChat: current.id || !list.length ? current.useChat : list.some((item) => !IMAGE_MODEL.test(item)),
      }));
    } catch (error) {
      if (requestId === loadId.current) setStatus({ state: 'error', message: error instanceof Error ? error.message : '连接失败' });
    }
  };
  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const { baseUrl, key } = await connection();
      let draft = form;
      // “连接” works without a separate “测试连接”: fill missing models from the service's list.
      if ((draft.useChat && !draft.chatModel.trim()) || (draft.useImage && !draft.model.trim())) {
        try {
          const list = await fetchChatModels(baseUrl, key, draft.chatApi);
          if (list.length) {
            setModels(list);
            const chatModel = draft.chatModel.trim() || list.find((item) => !IMAGE_MODEL.test(item)) || '';
            const model = draft.model.trim() || list.find((item) => /gpt-image/i.test(item)) || list.find((item) => IMAGE_MODEL.test(item)) || '';
            draft = {
              ...draft, name: draft.name || hostLabel(baseUrl), chatModel, model,
              // A new service only keeps the capabilities it actually offers.
              useChat: draft.id ? draft.useChat : draft.useChat && Boolean(chatModel),
              useImage: draft.id ? draft.useImage : draft.useImage && Boolean(model),
            };
            setForm(draft);
            setStatus({ state: 'ok', message: `连接成功 · ${list.length} 个模型` });
          }
        } catch {
          // Validation below explains what is missing.
        }
      }
      if (!draft.useChat && !draft.useImage) throw new Error('请至少开启“对话”或“绘图”中的一项');
      if (draft.useChat && !draft.chatModel.trim()) throw new Error('请选择对话模型');
      if (draft.useImage && !draft.model.trim()) throw new Error('请选择图片模型');
      const existing = providers.find((item) => item.id === draft.id);
      const now = Date.now();
      const id = draft.id ?? createId();
      const model = draft.useImage ? draft.model.trim() : null;
      const profile: ProviderProfile = {
        id, name: draft.name.trim() || hostLabel(baseUrl), baseUrl,
        chatModel: draft.useChat ? draft.chatModel.trim() : null, chatApi: draft.chatApi,
        model,
        quality: model ? (existing?.quality && qualitiesForModel(model).includes(existing.quality) ? existing.quality : 'auto') : null,
        aspectRatio: model ? existing?.aspectRatio ?? '1:1' : null,
        resolutionTier: model ? existing?.resolutionTier ?? '1K' : null,
        analysisProviderId: null, imageProviderId: null,
        createdAt: existing?.createdAt ?? now, updatedAt: now,
      };
      await upsertProvider(profile);
      if (draft.apiKey.trim() || !draft.id) await saveProviderKey(id, key);
      await reloadProviders();
      if (profile.chatModel && (!chatProvider || !draft.id)) await selectChatProvider(id);
      if (profile.model && (!imageProvider || !draft.id)) await selectImageProvider(id);
      setEditing(false);
      if (!draft.id && providers.length === 0) onClose();
    } catch (error) {
      setDialog({ title: '还差一点', message: error instanceof Error ? error.message : '请检查配置', icon: 'alert' });
    } finally { setSaving(false); }
  };
  const confirmDelete = () => {
    const id = form.id; if (!id) return;
    setDialog({ title: '删除这个服务商？', message: `“${form.name}”的密钥会从设备中移除。已有对话会保留。`, icon: 'trash', actions: [
      { label: '取消', tone: 'secondary', onPress: () => setDialog(null) },
      { label: '删除', tone: 'danger', onPress: () => { setDialog(null); void removeProvider(id).then(() => setEditing(false)).catch((error) => setDialog({ title: '无法删除', message: error.message })); } },
    ] });
  };

  const footer = editing
    ? <PrimaryButton label={form.id ? '保存' : '连接'} loading={saving} onPress={() => void save()} />
    : <PrimaryButton label="添加服务" icon="plus" onPress={startNew} />;
  const firstRun = !providers.length;

  return <Sheet visible={visible} presentation="page" title={editing ? (form.id ? '编辑服务' : firstRun ? '' : '添加服务') : 'AI 服务'} onClose={() => { if (editing && providers.length) setEditing(false); else onClose(); }} footer={footer}>
    {!editing ? <View style={styles.page}>
      <Text style={styles.lead}>对话和绘图可以用同一个服务，也可以分开。聊天时 Salcara 会自己决定什么时候画图。</Text>
      <Group>{providers.map((provider, index) => <Pressable key={provider.id} accessibilityRole="button" onPress={() => edit(provider)}
        style={({ pressed }) => [styles.providerRow, pressed && { backgroundColor: colors.surfaceStrong }]}>
        <View style={styles.avatar}><Text style={styles.avatarText}>{provider.name.slice(0, 1).toUpperCase()}</Text></View>
        <View style={[styles.providerBody, index > 0 && styles.divider]}>
          <View style={{ flex: 1, gap: 6 }}>
            <Text style={styles.providerName} numberOfLines={1}>{provider.name}</Text>
            <View style={styles.tags}>
              {provider.chatModel ? <Tag icon="chat" text={prettyModel(provider.chatModel)} active={provider.id === chatProvider?.id} /> : null}
              {provider.model ? <Tag icon="palette" text={prettyModel(provider.model)} active={provider.id === imageProvider?.id} /> : null}
            </View>
          </View>
          <Icon name="chevronRight" size={18} color={colors.faint} />
        </View>
      </Pressable>)}</Group>
      <View style={styles.privacy}><Icon name="lock" size={14} color={colors.subtle} /><Text style={styles.privacyText}>密钥只保存在这台设备的安全存储中</Text></View>
    </View> : <Appear style={styles.page} key={form.id ?? 'new'}>
      {!form.id && <View style={styles.hero}>
        <BrandMark size={56} />
        <Text style={styles.heroTitle}>连接你的 AI 服务</Text>
        <Text style={styles.heroText}>填入服务地址和密钥，Salcara 会自动识别可用的模型。</Text>
      </View>}
      {!form.id ? <>
        <SectionLabel>选择服务商</SectionLabel>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.presets}>
          {CHAT_PRESETS.map((preset) => {
            const selected = normalizeBaseUrlSafe(form.baseUrl) === preset.baseUrl;
            return <Pressable key={preset.id} accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={preset.name}
              onPress={() => patch({ baseUrl: preset.baseUrl, chatApi: preset.chatApi, name: preset.name })}
              style={({ pressed }) => [styles.preset, selected && styles.presetOn, pressed && { opacity: 0.8 }]}>
              <Text style={[styles.presetText, selected && styles.presetTextOn]}>{preset.name}</Text>
            </Pressable>;
          })}
        </ScrollView>
        {presetFor(form.baseUrl) ? <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(presetFor(form.baseUrl)!.keyUrl)} style={styles.keyLink}>
          <Icon name="key" size={15} color={colors.primary} />
          <Text style={styles.keyLinkText}>去 {presetFor(form.baseUrl)!.name} 获取 API Key</Text>
        </Pressable> : <Text style={styles.presetHint}>也可以直接填写任何 OpenAI 兼容地址（中转站、自建服务）。</Text>}
      </> : null}
      <SectionLabel>连接</SectionLabel>
      <Group>
        <Field first label="地址" value={form.baseUrl} placeholder="https://api.example.com" onChangeText={(baseUrl) => patch({ baseUrl })} keyboardType="url" autoCapitalize="none" autoCorrect={false} />
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>密钥</Text>
          <View style={[styles.fieldBody, styles.divider]}>
            <TextInput accessibilityLabel="API 密钥" value={form.apiKey} onChangeText={(apiKey) => patch({ apiKey })} placeholder={form.id ? '留空则保留原密钥' : 'sk-…'} placeholderTextColor={colors.subtle} secureTextEntry={!showKey} autoCapitalize="none" autoCorrect={false} style={styles.fieldInput} />
            <Pressable accessibilityLabel={showKey ? '隐藏密钥' : '显示密钥'} hitSlop={10} onPress={() => setShowKey((value) => !value)}><Icon name={showKey ? 'eyeOff' : 'eye'} size={19} color={colors.subtle} /></Pressable>
          </View>
        </View>
        <Field label="名称" value={form.name} placeholder="可选" onChangeText={(name) => patch({ name })} />
      </Group>
      <SectionLabel>接口类型</SectionLabel>
      <View style={styles.segment}>{PROTOCOLS.map((item) => {
        const selected = form.chatApi === item.value;
        return <Pressable key={item.value} accessibilityRole="radio" accessibilityState={{ selected }} onPress={() => patch({ chatApi: item.value })} style={[styles.segmentItem, selected && styles.segmentOn]}>
          <Text style={[styles.segmentText, selected && styles.segmentTextOn]}>{item.title}</Text>
        </Pressable>;
      })}</View>
      <Pressable accessibilityRole="button" onPress={() => void loadModels()} style={({ pressed }) => [styles.test, status.state === 'ok' && styles.testOk, pressed && { opacity: 0.8 }]}>
        {status.state === 'loading' ? <ActivityIndicator size="small" color={colors.primary} /> : <Icon name={status.state === 'ok' ? 'checkCircle' : status.state === 'error' ? 'alert' : 'bolt'} size={18} color={status.state === 'error' ? colors.warningText : status.state === 'ok' ? colors.success : colors.primary} />}
        <Text style={[styles.testText, status.state === 'error' && { color: colors.warningText }, status.state === 'ok' && { color: colors.success }]} numberOfLines={3}>{status.state === 'loading' ? '正在连接…' : status.message ?? '测试连接并读取模型'}</Text>
      </Pressable>

      <SectionLabel>用途</SectionLabel>
      <Group>
        <Capability first icon="chat" title="对话" hint="聊天、看图、读文件，并决定何时作图" enabled={form.useChat} onToggle={(useChat) => patch({ useChat })} model={form.chatModel} onPick={() => setPicker('chat')} />
        <Capability icon="palette" title="绘图" hint="生成和修改图片" enabled={form.useImage} onToggle={(useImage) => patch({ useImage })} model={form.model} onPick={() => setPicker('image')} />
      </Group>
      {form.id && <View style={{ marginTop: 24 }}><Group><ListRow first icon="trash" title="删除这个服务" danger onPress={confirmDelete} right={<View />} /></Group></View>}
    </Appear>}
    <ModelSelect visible={Boolean(picker)} title={picker === 'image' ? '选择绘图模型' : '选择对话模型'} value={picker === 'image' ? form.model : form.chatModel}
      models={models.filter((item) => picker === 'image' ? IMAGE_MODEL.test(item) : !IMAGE_MODEL.test(item))}
      loading={status.state === 'loading'} error={status.state === 'error' ? status.message : null}
      onClose={() => setPicker(null)} onRefresh={() => void loadModels()} onSelect={(model) => patch(picker === 'image' ? { model, useImage: true } : { chatModel: model, useChat: true })} />
    <AppDialog visible={Boolean(dialog)} title={dialog?.title ?? ''} message={dialog?.message} icon={dialog?.icon} actions={dialog?.actions} onClose={() => setDialog(null)} />
  </Sheet>;
}

function hostOf(url: string): string {
  try { return new URL(url).host.toLowerCase(); } catch { return url; }
}

function normalizeBaseUrlSafe(value: string): string {
  try { return normalizeBaseUrl(value); } catch { return value.trim(); }
}

function Capability({ icon, title, hint, enabled, onToggle, model, onPick, first }: {
  icon: IconName; title: string; hint: string; enabled: boolean; onToggle: (value: boolean) => void; model: string; onPick: () => void; first?: boolean;
}) {
  return <View style={[styles.capability, !first && styles.divider]}>
    <View style={styles.capHead}>
      <Icon name={icon} size={21} color={colors.textSecondary} />
      <View style={{ flex: 1 }}><Text style={styles.capTitle}>{title}</Text><Text style={styles.capHint}>{hint}</Text></View>
      <Switch accessibilityLabel={`用于${title}`} value={enabled} onValueChange={onToggle} trackColor={{ false: '#DDE3EC', true: colors.primary }} thumbColor="#fff" />
    </View>
    {enabled && <Pressable accessibilityRole="button" accessibilityLabel={`选择${title}模型`} onPress={onPick} style={styles.modelButton}>
      <Text style={[styles.modelValue, !model && { color: colors.primary }]} numberOfLines={1}>{model ? prettyModel(model) : '选择模型'}</Text>
      {model ? <Text style={styles.modelId} numberOfLines={1}>{model}</Text> : null}
      <Icon name="chevronDown" size={16} color={colors.subtle} />
    </Pressable>}
  </View>;
}

function Tag({ icon, text, active }: { icon: IconName; text: string; active: boolean }) {
  return <View style={[styles.tag, active && styles.tagActive]}><Icon name={icon} size={12} color={active ? colors.primaryDeep : colors.subtle} strokeWidth={2} /><Text style={[styles.tagText, active && { color: colors.primaryDeep }]} numberOfLines={1}>{text}</Text></View>;
}

function Field({ label, first, ...props }: React.ComponentProps<typeof TextInput> & { label: string; first?: boolean }) {
  return <View style={styles.field}>
    <Text style={styles.fieldLabel}>{label}</Text>
    <View style={[styles.fieldBody, !first && styles.divider]}><TextInput {...props} accessibilityLabel={label} style={styles.fieldInput} placeholderTextColor={colors.subtle} /></View>
  </View>;
}

function hostLabel(url: string) { try { return new URL(url).host; } catch { return url; } }

const styles = StyleSheet.create({
  presets: { gap: 8, paddingRight: 8 },
  preset: { height: 36, paddingHorizontal: 14, borderRadius: 18, justifyContent: 'center', backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  presetOn: { backgroundColor: colors.primarySoft, borderColor: 'rgba(61,123,250,0.45)' },
  presetText: { color: colors.textSecondary, fontSize: 13.5, fontWeight: '500' },
  presetTextOn: { color: colors.primaryDeep, fontWeight: '700' },
  presetHint: { color: colors.textMuted, fontSize: 12.5, marginTop: 8, marginLeft: 4 },
  keyLink: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, marginLeft: 4, alignSelf: 'flex-start' },
  keyLinkText: { color: colors.primary, fontSize: 13.5, fontWeight: '600' },
  page: { paddingHorizontal: 16, paddingBottom: 20 },
  lead: { color: colors.textMuted, fontSize: 14, lineHeight: 21, marginVertical: 12, marginHorizontal: 8 },
  providerRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 14 },
  providerBody: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 14, paddingRight: 14 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  avatarText: { color: colors.primary, fontSize: 16, fontWeight: '700' },
  providerName: { color: colors.text, fontSize: 16, fontWeight: '500' },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: 180, paddingHorizontal: 8, height: 22, borderRadius: 11, backgroundColor: colors.surfaceStrong },
  tagActive: { backgroundColor: colors.primarySoft },
  tagText: { color: colors.textMuted, fontSize: 11.5 },
  privacy: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 22 },
  privacyText: { color: colors.subtle, fontSize: 12.5 },
  hero: { alignItems: 'center', paddingTop: 16, paddingBottom: 4, gap: 10, paddingHorizontal: 20 },
  heroTitle: { color: colors.text, fontSize: 24, fontWeight: '700', letterSpacing: -0.5, marginTop: 8 },
  heroText: { color: colors.textMuted, fontSize: 14.5, lineHeight: 21, textAlign: 'center' },
  field: { flexDirection: 'row', alignItems: 'center', paddingLeft: 16 },
  fieldLabel: { width: 52, color: colors.text, fontSize: 15.5 },
  fieldBody: { flex: 1, minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 16 },
  fieldInput: { flex: 1, minHeight: 50, color: colors.text, fontSize: 15.5, padding: 0 },
  segment: { flexDirection: 'row', padding: 4, borderRadius: radius.pill, backgroundColor: colors.surfaceStrong, gap: 4 },
  segmentItem: { flex: 1, height: 38, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  segmentOn: { backgroundColor: colors.card, shadowColor: '#1B2150', shadowOpacity: 0.08, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
  segmentText: { color: colors.textMuted, fontSize: 13.5, fontWeight: '500' },
  segmentTextOn: { color: colors.text, fontWeight: '600' },
  test: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingHorizontal: 16, marginTop: 14, borderRadius: 18, backgroundColor: colors.blueSurface },
  testOk: { backgroundColor: '#EAF7EF' },
  testText: { flex: 1, color: colors.primaryDeep, fontSize: 14.5, fontWeight: '500', lineHeight: 20 },
  capability: { paddingVertical: 14, paddingHorizontal: 16, gap: 12 },
  capHead: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  capTitle: { color: colors.text, fontSize: 15.5, fontWeight: '500' },
  capHint: { color: colors.subtle, fontSize: 12.5, marginTop: 2 },
  modelButton: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 46, paddingHorizontal: 14, borderRadius: 14, backgroundColor: colors.card, marginLeft: 35 },
  modelValue: { color: colors.text, fontSize: 15, fontWeight: '500' },
  modelId: { flex: 1, color: colors.subtle, fontSize: 12 },
});
