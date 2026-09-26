import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { fetchChatModels } from '../api/chat-api';
import type { ChatApi, ProviderProfile } from '../domain';
import { createId, normalizeBaseUrl, qualitiesForModel } from '../domain-utils';
import { useApp } from '../state/AppContext';
import { upsertProvider } from '../storage/database';
import { getProviderKey, saveProviderKey } from '../storage/secure-keys';
import { colors, radius } from '../theme';
import { ModelSelect } from './ModelSelect';
import { AppDialog, PrimaryButton, Sheet, dismissKeyboardAndBlur, type DialogAction } from './ui';

type Purpose = 'chat' | 'image' | 'both';
type Form = { id: string | null; name: string; baseUrl: string; apiKey: string; model: string; chatModel: string; chatApi: ChatApi };
const emptyForm = (): Form => ({ id: null, name: '', baseUrl: '', apiKey: '', model: '', chatModel: '', chatApi: 'chat-completions' });
const PURPOSES: { id: Purpose; title: string; hint: string; icon: React.ComponentProps<typeof Ionicons>['name'] }[] = [
  { id: 'chat', title: '对话', hint: '问答与文件分析', icon: 'chatbubble-outline' },
  { id: 'image', title: '图片', hint: '生成与编辑图片', icon: 'image-outline' },
  { id: 'both', title: '两种能力', hint: '共用一个密钥', icon: 'layers-outline' },
];
const PROTOCOLS: { value: ChatApi; title: string }[] = [
  { value: 'chat-completions', title: 'OpenAI 兼容' }, { value: 'responses', title: 'OpenAI Responses' }, { value: 'anthropic', title: 'Claude Messages' },
];

export function ProviderManager({ visible, onClose, focusProviderId }: { visible: boolean; onClose: () => void; focusProviderId?: string | null }) {
  const { providers, activeProvider, reloadProviders, activateProvider, removeProvider, generating } = useApp();
  const [form, setForm] = useState<Form>(emptyForm);
  const [purpose, setPurpose] = useState<Purpose>('chat');
  const [editorOpen, setEditorOpen] = useState(false);
  const [step, setStep] = useState<0 | 1>(0);
  const [keyVisible, setKeyVisible] = useState(false);
  const [protocolOpen, setProtocolOpen] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [modelPicker, setModelPicker] = useState<'chat' | 'image' | null>(null);
  const [loading, setLoading] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<{ title: string; message: string; actions?: DialogAction[] } | null>(null);
  const saveLock = useRef(false);
  const loadId = useRef(0);
  const reset = () => { loadId.current += 1; setLoading(false); setForm(emptyForm()); setModels([]); setPurpose('chat'); setStep(0); setKeyVisible(false); setProtocolOpen(false); setConnectionError(null); setModelPicker(null); };
  useEffect(() => { if (!visible) { loadId.current += 1; reset(); setLoading(false); setEditorOpen(false); } }, [visible]);
  const edit = (provider: ProviderProfile) => {
    loadId.current += 1; setLoading(false);
    setForm({ id: provider.id, name: provider.name, baseUrl: provider.baseUrl, apiKey: '', model: provider.model ?? '', chatModel: provider.chatModel ?? '', chatApi: provider.chatApi ?? 'chat-completions' });
    setPurpose(provider.model && provider.chatModel ? 'both' : provider.model ? 'image' : 'chat');
    setModels([provider.model, provider.chatModel].filter((model): model is string => Boolean(model)));
    setConnectionError(null); setKeyVisible(false); setStep(0); setEditorOpen(true);
  };
  useEffect(() => {
    if (!visible || !focusProviderId) return;
    const provider = providers.find((item) => item.id === focusProviderId);
    if (provider) edit(provider);
    // Snapshot once; background provider updates must not erase edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, focusProviderId]);

  const connection = async () => {
    const baseUrl = normalizeBaseUrl(form.baseUrl);
    if (!form.name.trim()) throw new Error('请填写服务商名称');
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error('API 地址需以 https:// 或 http:// 开头');
    const key = form.apiKey.trim() || (form.id ? await getProviderKey(form.id) : null);
    if (!key) throw new Error('请填写 API 密钥');
    return { baseUrl, key };
  };
  const loadModels = async (advance = false) => {
    const requestId = ++loadId.current;
    try {
      const config = await connection();
      if (advance) { dismissKeyboardAndBlur(); setStep(1); }
      setLoading(true); setConnectionError(null);
      try {
        const result = await fetchChatModels(config.baseUrl, config.key, purpose === 'image' ? 'chat-completions' : form.chatApi);
        if (requestId === loadId.current) { setModels(result); if (!result.length) setConnectionError('服务商没有提供模型列表，可在选择模型中手动添加。'); }
      } catch (error) {
        if (requestId === loadId.current) setConnectionError(error instanceof Error ? error.message : '未能读取模型，可稍后刷新或手动添加。');
      }
    } catch (error) { setDialog({ title: '请补全连接信息', message: error instanceof Error ? error.message : '请检查地址和密钥' }); }
    finally { if (requestId === loadId.current) setLoading(false); }
  };
  const save = async () => {
    if (saveLock.current || generating) return;
    saveLock.current = true; setSaving(true);
    try {
      const { baseUrl, key } = await connection();
      const model = purpose === 'chat' ? null : form.model.trim() || null;
      const chatModel = purpose === 'image' ? null : form.chatModel.trim() || null;
      if (purpose !== 'image' && !chatModel) throw new Error('请选择对话模型');
      if (purpose !== 'chat' && !model) throw new Error('请选择图片模型');
      const existing = providers.find((item) => item.id === form.id);
      const now = Date.now(); const id = form.id ?? createId();
      const quality = model && existing?.quality && qualitiesForModel(model).includes(existing.quality) ? existing.quality : null;
      await upsertProvider({ ...existing, id, name: form.name.trim(), baseUrl, model, chatModel, chatApi: form.chatApi,
        quality, aspectRatio: existing?.aspectRatio ?? null, resolutionTier: existing?.resolutionTier ?? null,
        analysisProviderId: existing?.analysisProviderId ?? null, createdAt: existing?.createdAt ?? now, updatedAt: now });
      if (form.apiKey.trim() || !form.id) await saveProviderKey(id, key);
      await reloadProviders();
      if (!form.id || !activeProvider) await activateProvider(id);
      onClose();
    } catch (error) { setDialog({ title: '无法保存', message: error instanceof Error ? error.message : '请检查配置' }); }
    finally { saveLock.current = false; setSaving(false); }
  };
  const confirmDelete = () => {
    if (!form.id) return;
    const id = form.id;
    setDialog({ title: '删除服务商？', message: `“${form.name}”的密钥、关联会话与本地文件将从此设备删除。`, actions: [
      { label: '取消', tone: 'secondary', onPress: () => setDialog(null) },
      { label: '删除', tone: 'danger', disabled: generating, onPress: () => { setDialog(null); void removeProvider(id).then(() => { reset(); setEditorOpen(false); }).catch((error) => setDialog({ title: '无法删除', message: error.message })); } },
    ] });
  };
  const back = () => { if (step === 1) setStep(0); else setEditorOpen(false); };
  const footer = <PrimaryButton label={!editorOpen ? '添加服务商' : step === 0 ? '下一步 · 选择模型' : '保存服务商'} icon={!editorOpen ? 'add' : step === 0 ? 'arrow-forward' : 'checkmark'} loading={saving} disabled={generating || (loading && step === 0)} onPress={() => { if (!editorOpen) { reset(); setEditorOpen(true); } else if (step === 0) void loadModels(true); else void save(); }} />;

  return <Sheet visible={visible} title={editorOpen ? form.id ? '编辑服务商' : '添加服务商' : '服务商'} onClose={onClose} presentation="page" footer={footer}>
    <View style={styles.page}>
      {!editorOpen ? <>
        <Text style={styles.intro}>连接你常用的 AI 服务。对话和图片 API 可以分别添加。</Text>
        {providers.length ? <View>{providers.map((provider) => <Pressable key={provider.id} accessibilityRole="button" onPress={() => edit(provider)} style={({ pressed }) => [styles.provider, pressed && styles.pressed]}><View style={styles.providerIcon}><Ionicons name={provider.chatModel ? 'chatbubbles-outline' : 'image-outline'} size={22} color={colors.text} /></View><View style={styles.providerCopy}><View style={styles.nameRow}><Text style={styles.providerName} numberOfLines={1}>{provider.name}</Text>{provider.id === activeProvider?.id && <View style={styles.activeDot} />}</View><Text style={styles.providerHint} numberOfLines={1}>{[provider.chatModel && '对话', provider.model && '图片'].filter(Boolean).join(' · ')} · {hostLabel(provider.baseUrl)}</Text></View><Ionicons name="chevron-forward" size={18} color={colors.textMuted} /></Pressable>)}</View> : <View style={styles.empty}><View style={styles.emptyIcon}><Ionicons name="server-outline" size={31} color={colors.primaryStrong} /></View><Text style={styles.emptyTitle}>添加第一个服务商</Text><Text style={styles.emptyHint}>准备好 API 地址和密钥，即可连接你的模型。</Text></View>}
        <View style={styles.privacy}><Ionicons name="lock-closed-outline" size={16} color={colors.textMuted} /><Text style={styles.smallHint}>密钥仅保存在此设备的安全存储中。</Text></View>
      </> : <>
        <Pressable style={styles.back} onPress={back}><Ionicons name="arrow-back" size={18} color={colors.textMuted} /><Text style={styles.backText}>{step ? '连接信息' : '所有服务商'}</Text></Pressable>
        <View style={styles.steps}><Step number="1" label="连接" active={step === 0} /><View style={styles.stepLine} /><Step number="2" label="模型" active={step === 1} /></View>
        {step === 0 ? <>
          <Text style={styles.heading}>接入服务商</Text><Text style={styles.description}>选择服务商用途，填写连接信息。</Text>
          <View style={styles.purposes}>{PURPOSES.map((item) => <Pressable key={item.id} accessibilityRole="radio" accessibilityState={{ selected: purpose === item.id }} onPress={() => setPurpose(item.id)} style={[styles.purpose, purpose === item.id && styles.purposeSelected]}><Ionicons name={item.icon} size={21} color={purpose === item.id ? colors.primaryStrong : colors.textMuted} /><Text style={[styles.purposeTitle, purpose === item.id && styles.selectedText]}>{item.title}</Text><Text style={styles.purposeHint}>{item.hint}</Text></Pressable>)}</View>
          <Field label="名称" value={form.name} placeholder="例如：我的对话服务" onChangeText={(name) => setForm((current) => ({ ...current, name }))} />
          <Field label="API 地址" value={form.baseUrl} placeholder="https://example.com/v1" keyboardType="url" autoCapitalize="none" autoCorrect={false} onChangeText={(baseUrl) => setForm((current) => ({ ...current, baseUrl }))} />
          <Text style={styles.smallHint}>可填写根地址，应用会自动补全 /v1。</Text>
          <View style={styles.field}><Text style={styles.label}>API 密钥</Text><View style={styles.keyField}><TextInput accessibilityLabel="API 密钥" value={form.apiKey} onChangeText={(apiKey) => setForm((current) => ({ ...current, apiKey }))} placeholder={form.id ? '留空保留已保存的密钥' : '输入 API 密钥'} placeholderTextColor={colors.textMuted} secureTextEntry={!keyVisible} autoCapitalize="none" autoCorrect={false} style={styles.keyInput} /><Pressable accessibilityLabel={keyVisible ? '隐藏密钥' : '显示密钥'} style={styles.eye} onPress={() => setKeyVisible((shown) => !shown)}><Ionicons name={keyVisible ? 'eye-off-outline' : 'eye-outline'} size={20} color={colors.textMuted} /></Pressable></View></View>
          {purpose !== 'image' && <><Pressable style={styles.protocolToggle} onPress={() => setProtocolOpen((open) => !open)}><Text style={styles.label}>接口类型</Text><Text style={styles.protocolValue}>{PROTOCOLS.find((item) => item.value === form.chatApi)?.title}</Text><Ionicons name={protocolOpen ? 'chevron-up' : 'chevron-down'} size={17} color={colors.textMuted} /></Pressable>{protocolOpen && <View style={styles.protocols}>{PROTOCOLS.map((item) => <Pressable key={item.value} style={styles.protocolRow} onPress={() => { setForm((current) => ({ ...current, chatApi: item.value })); setProtocolOpen(false); }}><Text style={styles.protocolTitle}>{item.title}</Text>{form.chatApi === item.value && <Ionicons name="checkmark" size={19} color={colors.primaryStrong} />}</Pressable>)}</View>}</>}
        </> : <>
          <Text style={styles.heading}>选择模型</Text><Text style={styles.description}>为 {form.name} 选择常用模型，聊天时可以随时更换。</Text>
          <View style={styles.connectionStatus}>{loading ? <ActivityIndicator size="small" color={colors.primaryStrong} /> : <Ionicons name={connectionError ? 'information-circle-outline' : 'checkmark-circle-outline'} size={19} color={connectionError ? colors.warningText : colors.success} />}<Text style={styles.connectionText}>{loading ? '正在读取可用模型…' : connectionError ? '暂未读取到模型列表' : `已连接 · ${models.length} 个可用模型`}</Text><Pressable style={styles.refresh} disabled={loading} onPress={() => void loadModels()}><Text style={styles.link}>刷新</Text></Pressable></View>
          {connectionError && <Text style={styles.connectionError}>{connectionError}</Text>}
          {purpose !== 'image' && <ModelRow title="对话模型" value={form.chatModel} hint="用于问答、识图与文件分析" icon="chatbubble-outline" onPress={() => setModelPicker('chat')} />}
          {purpose !== 'chat' && <><ModelRow title="图片模型" value={form.model} hint="用于生成与编辑图片" icon="image-outline" onPress={() => setModelPicker('image')} /><Text style={styles.smallHint}>画质、比例和清晰度在聊天中的「创作参数」里设置。</Text></>}
        </>}
        {form.id && <Pressable style={styles.delete} disabled={generating} onPress={confirmDelete}><Text style={styles.deleteText}>删除这个服务商</Text></Pressable>}
      </>}
    </View>
    <ModelSelect visible={Boolean(modelPicker)} title={modelPicker === 'chat' ? '选择对话模型' : '选择图片模型'} value={modelPicker === 'chat' ? form.chatModel : form.model} models={models.filter((model) => modelPicker === 'image' ? /image|dall-e|flux/i.test(model) : !/image|dall-e|flux/i.test(model))} loading={loading} error={connectionError} onClose={() => setModelPicker(null)} onRefresh={() => void loadModels()} onSelect={(model) => setForm((current) => modelPicker === 'chat' ? { ...current, chatModel: model } : { ...current, model })} />
    <AppDialog visible={Boolean(dialog)} title={dialog?.title ?? ''} message={dialog?.message} actions={dialog?.actions} onClose={() => setDialog(null)} />
  </Sheet>;
}

function hostLabel(url: string) { try { return new URL(url).host; } catch { return url; } }
function Step({ number, label, active }: { number: string; label: string; active: boolean }) { return <View style={styles.step}><View style={[styles.stepNumber, active && styles.stepNumberActive]}><Text style={[styles.stepNumberText, active && styles.selectedText]}>{number}</Text></View><Text style={[styles.stepLabel, active && styles.stepLabelActive]}>{label}</Text></View>; }
function ModelRow({ title, value, hint, icon, onPress }: { title: string; value: string; hint: string; icon: React.ComponentProps<typeof Ionicons>['name']; onPress: () => void }) { return <Pressable accessibilityRole="button" style={styles.modelRow} onPress={onPress}><Ionicons name={icon} size={22} color={colors.text} /><View style={styles.providerCopy}><Text style={styles.label}>{title}</Text><Text style={[styles.modelValue, !value && styles.modelPlaceholder]} numberOfLines={2}>{value || '点此选择模型'}</Text><Text style={styles.smallHint}>{hint}</Text></View><Ionicons name="chevron-forward" size={18} color={colors.textMuted} /></Pressable>; }
function Field({ label, ...props }: React.ComponentProps<typeof TextInput> & { label: string }) { return <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput {...props} accessibilityLabel={label} style={styles.input} placeholderTextColor={colors.textMuted} /></View>; }

const styles = StyleSheet.create({
  page: { paddingHorizontal: 22, paddingBottom: 26 },
  intro: { color: colors.textMuted, fontSize: 13, lineHeight: 21, marginTop: 14, marginBottom: 20 },
  provider: { minHeight: 86, flexDirection: 'row', alignItems: 'center', gap: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  providerIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  providerCopy: { flex: 1, gap: 6 }, nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  providerName: { flexShrink: 1, color: colors.text, fontSize: 15, fontWeight: '600' }, providerHint: { color: colors.textMuted, fontSize: 12 },
  activeDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.primaryStrong },
  empty: { alignItems: 'center', paddingVertical: 64, gap: 13 }, emptyIcon: { width: 70, height: 70, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.blueSurface, borderRadius: 23, marginBottom: 7 }, emptyTitle: { color: colors.text, fontSize: 18, fontWeight: '600' }, emptyHint: { textAlign: 'center', color: colors.textMuted, fontSize: 13, lineHeight: 21 },
  privacy: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 28 },
  back: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 7 }, backText: { color: colors.textMuted, fontSize: 13 },
  steps: { flexDirection: 'row', alignItems: 'center', marginTop: 8, marginBottom: 28, gap: 14 }, step: { flexDirection: 'row', alignItems: 'center', gap: 7 }, stepLine: { height: 1, width: 40, backgroundColor: colors.border }, stepNumber: { width: 26, height: 26, borderRadius: 13, backgroundColor: colors.surface, justifyContent: 'center', alignItems: 'center' }, stepNumberActive: { backgroundColor: colors.blueSurface }, stepNumberText: { color: colors.textMuted, fontSize: 12, fontWeight: '600' }, stepLabel: { color: colors.textMuted, fontSize: 13 }, stepLabelActive: { color: colors.text, fontWeight: '600' },
  heading: { color: colors.text, fontSize: 22, fontWeight: '700', letterSpacing: -0.4 }, description: { color: colors.textMuted, fontSize: 13, lineHeight: 21, marginTop: 8, marginBottom: 20 },
  purposes: { flexDirection: 'row', gap: 8, marginBottom: 24 }, purpose: { flex: 1, minHeight: 94, paddingVertical: 13, alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: 'transparent' }, purposeSelected: { backgroundColor: colors.blueSurface, borderColor: '#BBDFFF' }, purposeTitle: { color: colors.text, fontSize: 14, fontWeight: '600' }, purposeHint: { color: colors.textMuted, fontSize: 10 }, selectedText: { color: colors.primaryStrong },
  field: { marginTop: 13, gap: 6 }, label: { color: colors.text, fontSize: 13, fontWeight: '600' }, input: { minHeight: 49, paddingHorizontal: 1, borderBottomWidth: 1, borderColor: colors.border, color: colors.text, fontSize: 15 }, smallHint: { color: colors.textMuted, fontSize: 12, lineHeight: 20, marginTop: 5 }, keyField: { minHeight: 49, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderColor: colors.border }, keyInput: { flex: 1, minHeight: 49, paddingHorizontal: 1, color: colors.text, fontSize: 15 }, eye: { width: 44, height: 49, justifyContent: 'center', alignItems: 'center' },
  protocolToggle: { minHeight: 60, flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 14 }, protocolValue: { flex: 1, textAlign: 'right', color: colors.textMuted, fontSize: 12 }, protocols: { paddingHorizontal: 12, backgroundColor: colors.surface, borderRadius: radius.md }, protocolRow: { minHeight: 50, flexDirection: 'row', alignItems: 'center' }, protocolTitle: { flex: 1, color: colors.text, fontSize: 14 },
  connectionStatus: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }, connectionText: { flex: 1, color: colors.textMuted, fontSize: 12 }, refresh: { minHeight: 44, paddingHorizontal: 8, justifyContent: 'center' }, link: { color: colors.primaryStrong, fontWeight: '600', fontSize: 13 }, connectionError: { color: colors.warningText, fontSize: 12, lineHeight: 19, marginBottom: 12 },
  modelRow: { minHeight: 110, flexDirection: 'row', alignItems: 'center', gap: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border, paddingVertical: 16 }, modelValue: { color: colors.text, fontSize: 15, lineHeight: 22 }, modelPlaceholder: { color: colors.primaryStrong },
  delete: { minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 40 }, deleteText: { color: colors.danger, fontSize: 13 }, pressed: { opacity: 0.65 },
});
