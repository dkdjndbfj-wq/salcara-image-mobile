import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { hasServiceSecret, refreshServiceModels, rememberModels, saveServiceSecrets } from '../api/services';
import { defaultModel, KIND_LABEL, supports, VENDORS, vendorById, vendorForService, type ServiceKind, type Vendor } from '../api/vendors';
import type { ChatApi, ProviderProfile } from '../domain';
import { createId, normalizeBaseUrl } from '../domain-utils';
import { useApp } from '../state/AppContext';
import { upsertProvider } from '../storage/database';
import { getProviderKey } from '../storage/secure-keys';
import { colors, prettyModel, radius } from '../theme';
import { updateVoiceSettings, useVoiceSettings, voiceSettings } from '../voice/settings';
import { VendorBadge } from './FunctionPicker';
import { Icon } from './Icon';
import { MotionPressable } from './MotionPressable';
import { Appear, AppDialog, Group, PrimaryButton, SectionLabel, Sheet, showToast, dismissKeyboardAndBlur, type DialogAction } from './ui';

/**
 * AI services: each is an account at one vendor — just its address and key. Which service and model
 * does chat, drawing or each voice function is picked in “模型” and “语音”, never typed again here.
 */

type Form = { id: string | null; vendor: string | null; name: string; baseUrl: string; apiKey: string; chatApi: ChatApi; extra: Record<string, string>; secrets: Record<string, string> };
const emptyForm = (): Form => ({ id: null, vendor: null, name: '', baseUrl: '', apiKey: '', chatApi: 'chat-completions', extra: {}, secrets: {} });
const PROTOCOLS: { value: ChatApi; title: string }[] = [
  { value: 'chat-completions', title: 'OpenAI 兼容' }, { value: 'responses', title: 'Responses' }, { value: 'anthropic', title: 'Claude' },
];
const KINDS: ServiceKind[] = ['chat', 'image', 'stt', 'tts', 'realtime'];

export function ProviderManager({ visible, onClose, focusProviderId, kind }: { visible: boolean; onClose: () => void; focusProviderId?: string | null; kind?: ServiceKind | null }) {
  const { providers, chatProvider, imageProvider, reloadProviders, selectChatProvider, selectImageProvider, removeProvider } = useApp();
  const voice = useVoiceSettings();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Form>(emptyForm);
  const [stored, setStored] = useState<Record<string, boolean>>({});
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [dialog, setDialog] = useState<{ title: string; message: string; actions?: DialogAction[]; icon?: string } | null>(null);
  const patch = (value: Partial<Form>) => setForm((current) => ({ ...current, ...value }));
  const vendor = vendorById(form.vendor);

  const startNew = () => { setForm(emptyForm()); setShowKey(false); setStored({}); setAdvanced(false); setEditing(true); };
  const edit = (service: ProviderProfile) => {
    const serviceVendor = vendorForService(service);
    setForm({ id: service.id, vendor: serviceVendor.id, name: service.name, baseUrl: service.baseUrl, apiKey: '', chatApi: service.chatApi ?? serviceVendor.chatApi ?? 'chat-completions', extra: { ...(service.extra ?? {}) }, secrets: {} });
    setShowKey(false); setStored({}); setEditing(true);
    void Promise.all((serviceVendor.fields ?? []).filter((field) => field.secret).map(async (field) => [field.key, await hasServiceSecret(service.id, field.key)] as const))
      .then((entries) => setStored(Object.fromEntries(entries)));
  };
  const chooseVendor = (next: Vendor) => patch({ vendor: next.id, name: next.id === 'custom' ? '' : next.name, baseUrl: next.baseUrl ?? '', chatApi: next.chatApi ?? 'chat-completions', extra: {}, secrets: {} });

  useEffect(() => {
    if (!visible) { setEditing(false); return; }
    if (!providers.length || kind) startNew();
    else if (focusProviderId) { const service = providers.find((item) => item.id === focusProviderId); if (service) edit(service); }
    // Snapshot on open only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, focusProviderId, kind]);

  /** What each service is used for right now. */
  const usage = useMemo(() => {
    const map = new Map<string, string[]>();
    const add = (id: string | null | undefined, label: string) => { if (id) map.set(id, [...(map.get(id) ?? []), label]); };
    add(chatProvider?.id, `对话 · ${prettyModel(chatProvider?.chatModel)}`);
    add(imageProvider?.id, `绘图 · ${prettyModel(imageProvider?.model)}`);
    add(voice.transcribeProviderId, '语音识别');
    add(voice.ttsProviderId, '语音合成');
    add(voice.realtimeProviderId, '实时语音');
    return map;
  }, [chatProvider, imageProvider, voice.transcribeProviderId, voice.ttsProviderId, voice.realtimeProviderId]);

  const save = async (skipCheck = false) => {
    if (saving || !vendor) return;
    dismissKeyboardAndBlur();
    setSaving(true);
    try {
      const hasAddress = vendor.baseUrl !== undefined || vendor.id === 'azure-openai';
      if (hasAddress && !form.baseUrl.trim()) throw new Error(`请填写${vendor.addressLabel ?? 'API 地址'}`);
      const baseUrl = !hasAddress ? '' : vendor.chatApi ? normalizeBaseUrl(form.baseUrl) : form.baseUrl.trim().replace(/\/+$/, '');
      if (vendor.id === 'azure-openai' && !/^https:\/\//i.test(baseUrl)) throw new Error('终结点需要以 https:// 开头');
      const existing = providers.find((item) => item.id === form.id) ?? null;
      // A saved key only goes back to the address it was saved for.
      const sameHost = existing ? hostOf(existing.baseUrl) === hostOf(baseUrl) : false;
      const key = form.apiKey.trim() || (existing && sameHost ? await getProviderKey(existing.id) : null);
      if (!key) throw new Error(existing && !sameHost ? '地址换成了另一个服务，请重新填写这个服务的密钥' : `请填写${vendor.keyLabel ?? 'API Key'}`);
      for (const field of vendor.fields ?? []) {
        if (field.optional) continue;
        const filled = field.secret ? form.secrets[field.key]?.trim() || stored[field.key] : form.extra[field.key]?.trim();
        if (!filled) throw new Error(`请填写${field.label}`);
      }
      const id = existing?.id ?? createId();
      const draft: ProviderProfile = {
        id, name: form.name.trim() || uniqueName(vendor.name, providers, existing?.id), baseUrl, vendor: vendor.id,
        extra: Object.fromEntries(Object.entries(form.extra).map(([name, value]) => [name, value.trim()]).filter(([, value]) => value)),
        chatApi: vendor.id === 'custom' ? form.chatApi : vendor.chatApi ?? 'chat-completions',
        chatModel: existing?.chatModel ?? null, model: existing?.model ?? null,
        quality: existing?.quality ?? null, aspectRatio: existing?.aspectRatio ?? null, resolutionTier: existing?.resolutionTier ?? null,
        analysisProviderId: null, imageProviderId: null, createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now(),
      };
      // “连接” checks the key right away where the vendor has a model list.
      let listed: string[] = [];
      if (vendor.lists && baseUrl && !skipCheck) {
        try {
          listed = await refreshServiceModels(draft, key);
        } catch (error) {
          setSaving(false);
          setDialog({
            title: '没有连上', message: `${error instanceof Error ? error.message : '连接失败'}\n\n请检查地址和密钥。确定没问题（例如服务不提供模型列表）也可以直接保存。`, icon: 'alert',
            actions: [{ label: '返回修改', tone: 'secondary', onPress: () => setDialog(null) }, { label: '仍然保存', onPress: () => { setDialog(null); void save(true); } }],
          });
          return;
        }
      }
      // A brand-new account fills the functions that have nothing yet, so it works right away.
      const used: string[] = [];
      if (!existing) {
        if (supports(vendor, 'chat') && (!chatProvider || kind === 'chat')) { const model = defaultModel(vendor, 'chat', listed); if (model) { draft.chatModel = model; used.push('对话'); } }
        if (supports(vendor, 'image') && (!imageProvider || kind === 'image')) {
          const model = defaultModel(vendor, 'image', listed);
          if (model) { draft.model = model; draft.quality = 'auto'; draft.aspectRatio = '1:1'; draft.resolutionTier = '1K'; used.push('绘图'); }
        }
      }
      await upsertProvider(draft);
      await saveServiceSecrets(id, vendor, form.apiKey.trim() ? key : existing ? '' : key, form.secrets);
      if (listed.length) rememberModels(id, listed);
      await reloadProviders();
      if (draft.chatModel && !existing && (!chatProvider || kind === 'chat')) await selectChatProvider(id);
      if (draft.model && !existing && (!imageProvider || kind === 'image')) await selectImageProvider(id);
      if (!existing) {
        const current = voiceSettings();
        const chatVendor = chatProvider ? vendorForService(chatProvider) : null;
        const voicePatch: Parameters<typeof updateVoiceSettings>[0] = {};
        // Opened from a voice function: the new service takes that function over.
        const fill = (speech: 'stt' | 'tts' | 'realtime', label: string) => {
          if (!supports(vendor, speech)) return false;
          if (kind !== speech && ((speech === 'stt' ? current.transcribeProviderId : current.ttsProviderId) || (chatVendor && supports(chatVendor, speech)))) return false;
          used.push(label); return true;
        };
        const capabilities = { stt: vendor.stt, tts: vendor.tts, realtime: vendor.realtime };
        if (fill('stt', '语音识别')) Object.assign(voicePatch, { transcribeProviderId: id, transcribeModel: defaultModel(vendor, 'stt', listed) });
        if (fill('tts', '语音合成')) Object.assign(voicePatch, { ttsProviderId: id, ttsModel: defaultModel(vendor, 'tts', listed), ttsVoice: capabilities.tts!.voices?.[0]?.id ?? '' });
        if (kind === 'realtime' && supports(vendor, 'realtime')) { used.push('实时语音'); Object.assign(voicePatch, { realtimeProviderId: id, realtimeModel: defaultModel(vendor, 'realtime', listed), realtimeVoice: capabilities.realtime!.voices?.[0]?.id ?? '' }); }
        if (Object.keys(voicePatch).length) await updateVoiceSettings(voicePatch);
      }
      showToast(used.length ? `已连接 · 已用于${used.join('、')}` : existing ? '已保存' : '已连接，可在“模型”“语音”里选用它');
      setEditing(false);
      if (!existing && (providers.length === 0 || kind)) onClose();
    } catch (error) {
      setDialog({ title: '还差一点', message: error instanceof Error ? error.message : '请检查配置', icon: 'alert' });
    } finally { setSaving(false); }
  };
  const confirmDelete = () => {
    const id = form.id; if (!id) return;
    setDialog({ title: '删除这个 API？', message: `“${form.name || vendor?.name}”的密钥会从设备中移除，用到它的功能会改用其他服务。已有对话会保留。`, icon: 'trash', actions: [
      { label: '取消', tone: 'secondary', onPress: () => setDialog(null) },
      { label: '删除', tone: 'danger', onPress: () => { setDialog(null); void removeProvider(id).then(() => setEditing(false)).catch((error) => setDialog({ title: '无法删除', message: error.message })); } },
    ] });
  };

  const groups = useMemo(() => {
    const matching = VENDORS.filter((item) => !kind || supports(item, kind));
    return [{ title: '国内', items: matching.filter((item) => item.region === 'cn' && item.id !== 'custom') }, { title: '海外', items: matching.filter((item) => item.region === 'global' && item.id !== 'custom') }, { title: '自定义', items: matching.filter((item) => item.id === 'custom') }];
  }, [kind]);

  const footer = editing
    ? vendor ? <PrimaryButton label={form.id ? '保存' : '连接'} loading={saving} onPress={() => void save()} /> : undefined
    : <PrimaryButton label="添加 API" icon="plus" onPress={startNew} />;
  const title = editing ? (form.id ? '编辑 API' : vendor ? vendor.name : kind ? `添加能做${KIND_LABEL[kind]}的 API` : '添加 API') : 'API 管理';
  const back = () => {
    if (editing && vendor && !form.id) { patch({ vendor: null }); return; }
    if (editing && providers.length && !kind) setEditing(false); else onClose();
  };
  const hasAddress = vendor ? vendor.baseUrl !== undefined || vendor.id === 'azure-openai' : false;

  return <Sheet visible={visible} presentation="page" title={title} onClose={back} footer={footer}>
    {!editing ? <View style={styles.page}>
      <Text style={styles.lead}>这里只填各家平台的 API 地址和密钥。对话、绘图、语音分别用哪个 API 的哪个模型，在“切换模型”和“语音”里选：先选 API，再选模型。</Text>
      <Group>{providers.map((service, index) => {
        const serviceVendor = vendorForService(service);
        const uses = usage.get(service.id) ?? [];
        return <Pressable key={service.id} accessibilityRole="button" accessibilityLabel={`编辑 ${service.name}`} onPress={() => edit(service)}
          style={({ pressed }) => [styles.serviceRow, pressed && { backgroundColor: colors.surfaceStrong }]}>
          <VendorBadge vendor={serviceVendor} size={40} />
          <View style={[styles.serviceBody, index > 0 && styles.divider]}>
            <View style={{ flex: 1, gap: 5 }}>
              <Text style={styles.serviceName} numberOfLines={1}>{service.name}</Text>
              <View style={styles.tags}>
                {uses.length
                  ? uses.map((item) => <View key={item} style={[styles.tag, styles.tagActive]}><Text style={[styles.tagText, { color: colors.primaryDeep }]} numberOfLines={1}>{item}</Text></View>)
                  : <Text style={styles.unused}>{KINDS.filter((item) => supports(serviceVendor, item)).map((item) => KIND_LABEL[item]).join(' · ')} · 未使用</Text>}
              </View>
            </View>
            <Icon name="chevronRight" size={18} color={colors.faint} />
          </View>
        </Pressable>;
      })}</Group>
      <View style={styles.privacy}><Icon name="lock" size={14} color={colors.subtle} /><Text style={styles.privacyText}>密钥只保存在这台设备的安全存储中，只发送给对应的服务</Text></View>
    </View> : !vendor ? <Appear style={styles.page} key="vendors">
      <Text style={styles.lead}>{kind ? `选一家能做${KIND_LABEL[kind]}的平台。` : '选择平台，填上地址和密钥就能用。同一个平台有多个 Key 也可以分别添加。'}</Text>
      {groups.map((group) => group.items.length ? <View key={group.title}>
        <SectionLabel>{group.title}</SectionLabel>
        <View style={styles.grid}>
          {group.items.map((item) => <MotionPressable key={item.id} wrapperStyle={styles.cellWrap} scaleTo={0.96} accessibilityRole="button" accessibilityLabel={item.name}
            onPress={() => chooseVendor(item)} style={styles.cell}>
            <VendorBadge vendor={item} size={34} />
            <Text style={styles.cellName} numberOfLines={1}>{item.name}</Text>
            <Text style={styles.cellBlurb} numberOfLines={2}>{item.blurb}</Text>
          </MotionPressable>)}
        </View>
      </View> : null)}
    </Appear> : <Appear style={styles.page} key={form.id ?? vendor.id}>
      <View style={styles.vendorHead}>
        <VendorBadge vendor={vendor} size={46} />
        <View style={{ flex: 1, gap: 5 }}>
          <Text style={styles.vendorName}>{vendor.name}</Text>
          <View style={styles.tags}>{KINDS.filter((item) => supports(vendor, item)).map((item) => <View key={item} style={styles.tag}><Text style={styles.tagText}>{KIND_LABEL[item]}</Text></View>)}</View>
        </View>
      </View>
      <SectionLabel>连接</SectionLabel>
      <Group>
        {hasAddress ? <Field first label={vendor.addressLabel ?? '地址'} value={form.baseUrl} placeholder={vendor.addressPlaceholder ?? vendor.baseUrl ?? 'https://'} onChangeText={(baseUrl) => patch({ baseUrl })} keyboardType="url" autoCapitalize="none" autoCorrect={false} /> : null}
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>密钥</Text>
          <View style={[styles.fieldBody, hasAddress && styles.divider]}>
            <TextInput accessibilityLabel={vendor.keyLabel ?? 'API Key'} value={form.apiKey} onChangeText={(apiKey) => patch({ apiKey })} placeholder={form.id ? '已保存，留空不修改' : vendor.keyLabel ?? 'API Key'}
              placeholderTextColor={colors.subtle} secureTextEntry={!showKey} autoCapitalize="none" autoCorrect={false} style={styles.fieldInput} />
            <Pressable accessibilityLabel={showKey ? '隐藏密钥' : '显示密钥'} hitSlop={10} onPress={() => setShowKey((value) => !value)}><Icon name={showKey ? 'eyeOff' : 'eye'} size={19} color={colors.subtle} /></Pressable>
          </View>
        </View>
        {(vendor.fields ?? []).filter((field) => !field.optional || advanced || form.extra[field.key]).map((field) => <Field key={field.key} label={field.label} secureTextEntry={field.secret && !showKey}
          value={field.secret ? form.secrets[field.key] ?? '' : form.extra[field.key] ?? ''}
          placeholder={field.secret && stored[field.key] ? '已保存，留空不修改' : field.placeholder ?? (field.optional ? '可选' : '')}
          onChangeText={(text) => (field.secret ? patch({ secrets: { ...form.secrets, [field.key]: text } }) : patch({ extra: { ...form.extra, [field.key]: text } }))}
          autoCapitalize="none" autoCorrect={false} />)}
        <Field label="名称" value={form.name} placeholder={`${vendor.name}（同一平台有多个 Key 时用来区分）`} onChangeText={(name) => patch({ name })} />
      </Group>
      {(vendor.fields ?? []).filter((field) => field.help && (!field.optional || advanced || form.extra[field.key])).map((field) => <Text key={field.key} style={styles.help}>{field.label}：{field.help}</Text>)}
      {(vendor.fields ?? []).some((field) => field.optional && !form.extra[field.key]) && !advanced
        ? <Text style={styles.advanced} onPress={() => setAdvanced(true)}>高级选项（一般不用填）</Text> : null}
      {vendor.id === 'custom' ? <>
        <SectionLabel>接口类型</SectionLabel>
        <View style={styles.segment}>{PROTOCOLS.map((item) => {
          const selected = form.chatApi === item.value;
          return <Pressable key={item.value} accessibilityRole="radio" accessibilityState={{ selected }} onPress={() => patch({ chatApi: item.value })} style={[styles.segmentItem, selected && styles.segmentOn]}>
            <Text style={[styles.segmentText, selected && styles.segmentTextOn]}>{item.title}</Text>
          </Pressable>;
        })}</View>
      </> : null}
      {vendor.keyUrl ? <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(vendor.keyUrl!)} style={styles.keyLink}>
        <Icon name="key" size={15} color={colors.primary} />
        <Text style={styles.keyLinkText}>去 {vendor.name} 获取密钥</Text>
        <Icon name="external" size={13} color={colors.primary} />
      </Pressable> : null}
      {saving ? <View style={styles.checking}><ActivityIndicator size="small" color={colors.primary} /><Text style={styles.checkingText}>正在连接并读取模型…</Text></View> : null}
      {form.id ? <View style={{ marginTop: 28 }}>
        <Pressable accessibilityRole="button" onPress={confirmDelete} style={styles.delete}><Icon name="trash" size={17} color={colors.danger} /><Text style={styles.deleteText}>删除这个 API</Text></Pressable>
      </View> : null}
    </Appear>}
    <AppDialog visible={Boolean(dialog)} title={dialog?.title ?? ''} message={dialog?.message} icon={dialog?.icon} actions={dialog?.actions} onClose={() => setDialog(null)} />
  </Sheet>;
}

/** “OpenAI”, then “OpenAI 2”… so two keys at one vendor are easy to tell apart. */
function uniqueName(base: string, services: ProviderProfile[], selfId?: string): string {
  const taken = new Set(services.filter((item) => item.id !== selfId).map((item) => item.name));
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}

function hostOf(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0].toLowerCase();
}

function Field({ label, first, ...props }: React.ComponentProps<typeof TextInput> & { label: string; first?: boolean }) {
  return <View style={styles.field}>
    <Text style={styles.fieldLabel} numberOfLines={1}>{label}</Text>
    <View style={[styles.fieldBody, !first && styles.divider]}><TextInput {...props} accessibilityLabel={label} style={styles.fieldInput} placeholderTextColor={colors.subtle} /></View>
  </View>;
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 16, paddingBottom: 20 },
  lead: { color: colors.textMuted, fontSize: 14, lineHeight: 21, marginVertical: 12, marginHorizontal: 6 },
  serviceRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 14 },
  serviceBody: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 14, paddingRight: 14 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  serviceName: { color: colors.text, fontSize: 16, fontWeight: '600' },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag: { paddingHorizontal: 8, height: 22, borderRadius: 11, justifyContent: 'center', backgroundColor: colors.surfaceStrong, maxWidth: 220 },
  tagActive: { backgroundColor: colors.primarySoft },
  tagText: { color: colors.textMuted, fontSize: 11.5, fontWeight: '600' },
  unused: { color: colors.subtle, fontSize: 12 },
  privacy: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 22, paddingHorizontal: 12 },
  privacyText: { flexShrink: 1, color: colors.subtle, fontSize: 12.5, textAlign: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  cellWrap: { width: '48%', flexGrow: 1 },
  cell: { padding: 14, gap: 6, borderRadius: 20, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, minHeight: 118 },
  cellName: { color: colors.text, fontSize: 15, fontWeight: '700', marginTop: 4 },
  cellBlurb: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  vendorHead: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12 },
  vendorName: { color: colors.text, fontSize: 19, fontWeight: '700' },
  field: { flexDirection: 'row', alignItems: 'center', paddingLeft: 16 },
  fieldLabel: { width: 76, color: colors.text, fontSize: 15 },
  fieldBody: { flex: 1, minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 16 },
  fieldInput: { flex: 1, minHeight: 50, color: colors.text, fontSize: 15.5, padding: 0 },
  advanced: { color: colors.primary, fontSize: 13, fontWeight: '600', marginTop: 12, marginLeft: 8, alignSelf: 'flex-start' },
  help: { color: colors.textMuted, fontSize: 12.5, lineHeight: 18, marginTop: 8, marginHorizontal: 8 },
  segment: { flexDirection: 'row', padding: 4, borderRadius: radius.pill, backgroundColor: colors.surfaceStrong, gap: 4 },
  segmentItem: { flex: 1, height: 38, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  segmentOn: { backgroundColor: colors.card, shadowColor: '#1B2150', shadowOpacity: 0.08, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
  segmentText: { color: colors.textMuted, fontSize: 13.5, fontWeight: '500' },
  segmentTextOn: { color: colors.text, fontWeight: '600' },
  keyLink: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 16, marginLeft: 8, alignSelf: 'flex-start', paddingVertical: 4 },
  keyLinkText: { color: colors.primary, fontSize: 14, fontWeight: '600' },
  checking: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16, marginLeft: 8 },
  checkingText: { color: colors.primaryDeep, fontSize: 13.5 },
  delete: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 8 },
  deleteText: { color: colors.danger, fontSize: 15, fontWeight: '500' },
});
