import React, { useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useApp } from '../state/AppContext';
import { colors, radius } from '../theme';
import { supportsSpeechApi } from '../voice/providers';
import { deleteSpeechService, hasSecret, isServiceRef, saveSpeechService, serviceById, serviceRef, servicesFor, useSpeechServices, type SpeechService } from '../voice/services';
import { updateVoiceSettings, voiceSettings } from '../voice/settings';
import { capabilityOf, KIND_LABEL, VENDORS, vendorById, type SpeechKind, type Vendor } from '../voice/vendors';
import { Icon } from './Icon';
import { MotionPressable } from './MotionPressable';
import { AppDialog, Chip, PrimaryButton, SectionLabel, Sheet, showToast } from './ui';

/**
 * Speech services: each speech function (识别 / 合成 / 实时) picks its own API. The picker lists the
 * user's speech services that offer that function, plus their OpenAI-compatible chat providers.
 */

const KIND_TITLE: Record<SpeechKind, string> = { stt: '语音识别', tts: '语音合成', realtime: '实时语音' };

function Tags({ vendor }: { vendor: Vendor }) {
  return <View style={styles.tags}>
    {(['stt', 'tts', 'realtime'] as SpeechKind[]).filter((kind) => vendor[kind]).map((kind) => <View key={kind} style={styles.tag}><Text style={styles.tagText}>{KIND_LABEL[kind]}</Text></View>)}
  </View>;
}

/** Initial-letter badge standing in for a vendor logo. */
function VendorBadge({ vendor, size = 36 }: { vendor: Vendor; size?: number }) {
  const hue = [...vendor.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 6;
  const palette = ['#3D7BFA', '#7B6CF6', '#12A150', '#E0822B', '#2A9DC4', '#D2477A'][hue];
  return <View style={[styles.badge, { width: size, height: size, borderRadius: size * 0.32, backgroundColor: `${palette}1A` }]}>
    <Text style={[styles.badgeText, { color: palette, fontSize: size * 0.42 }]}>{[...vendor.name][0]}</Text>
  </View>;
}

/**
 * The service a function uses. `value` is a provider id or `svc:<id>`; null = the chat provider,
 * or — with `offLabel` — the function is off (e.g. realtime in “auto” mode), shown as its own chip.
 */
export function ServicePicker({ kind, value, onChange, onAdd, offLabel }: { kind: SpeechKind; value: string | null; onChange: (ref: string | null, service: SpeechService | null) => void; onAdd: () => void; offLabel?: string }) {
  const { providers, chatProvider } = useApp();
  const services = servicesFor(kind, useSpeechServices());
  const openAiProviders = kind === 'stt' || kind === 'tts' || kind === 'realtime' ? providers.filter((item) => supportsSpeechApi(item)) : [];
  const defaultProvider = !offLabel && supportsSpeechApi(chatProvider) ? chatProvider : null;
  const current = value ?? (defaultProvider ? defaultProvider.id : null);
  return <View style={styles.field}>
    <Text style={styles.fieldLabel}>{KIND_TITLE[kind]}服务</Text>
    <View style={styles.chips}>
      {offLabel ? <Chip label={offLabel} selected={value === null} onPress={() => onChange(null, null)} /> : null}
      {services.map((service) => <Chip key={service.id} label={service.name} selected={current === serviceRef(service.id)} onPress={() => onChange(serviceRef(service.id), service)} />)}
      {openAiProviders.map((item) => <Chip key={item.id} label={`${item.name}${item.id === defaultProvider?.id && value === null ? '（默认）' : ''}`} selected={current === item.id} onPress={() => onChange(item.id, null)} />)}
      <Chip label="添加服务" icon="plus" onPress={onAdd} />
    </View>
    {!services.length && !openAiProviders.length ? <Text style={styles.note}>还没有能做{KIND_TITLE[kind]}的服务。点“添加服务”，选择阿里云百炼、豆包、OpenAI、硅基流动等，填上它们的 API Key 即可。</Text> : null}
  </View>;
}

/** Model and voice presets of the chosen vendor, plus free input. */
export function ModelVoiceFields({ kind, reference, model, voice, onModel, onVoice }: {
  kind: SpeechKind; reference: string | null; model: string; voice?: string; onModel: (value: string) => void; onVoice?: (value: string) => void;
}) {
  const services = useSpeechServices();
  const service = isServiceRef(reference) ? serviceById(reference.slice(4), services) : null;
  const vendor = service ? vendorById(service.vendor) : vendorById('openai');
  const capability = vendor ? capabilityOf(vendor, kind) : undefined;
  const models = capability?.models ?? [];
  const voices = capability?.voices ?? [];
  const modelLabel = vendor?.id === 'azure-speech' || vendor?.id === 'google-cloud' ? (kind === 'stt' ? '识别语言' : '模型') : '模型';
  return <>
    {models.length > 1 || !service || !models.length || !models.includes(model) ? <View style={styles.field}>
      <Text style={styles.fieldLabel}>{modelLabel}</Text>
      <TextInput value={model} onChangeText={onModel} autoCapitalize="none" autoCorrect={false} style={styles.input} placeholder={models[0] ?? '模型 ID'} placeholderTextColor={colors.subtle} />
      {models.length ? <View style={styles.chips}>{models.map((item) => <Chip key={item} label={item} selected={item === model} onPress={() => onModel(item)} />)}</View> : null}
    </View> : null}
    {onVoice && (voices.length || capability?.customVoice || !service) ? <View style={styles.field}>
      <Text style={styles.fieldLabel}>声音</Text>
      {voices.length ? <View style={styles.chips}>{voices.map((item) => <Chip key={item.id} label={item.label} selected={item.id === voice} onPress={() => onVoice(item.id)} />)}</View> : null}
      {capability?.customVoice || !service ? <TextInput value={voice ?? ''} onChangeText={onVoice} autoCapitalize="none" autoCorrect={false} style={styles.input} placeholder="音色 ID" placeholderTextColor={colors.subtle} /> : null}
    </View> : null}
    {capability?.note ? <Text style={styles.note}>{capability.note}</Text> : null}
  </>;
}

/** Added speech services, for the top of voice settings. */
export function SpeechServiceList({ onEdit, onAdd }: { onEdit: (service: SpeechService) => void; onAdd: () => void }) {
  const services = useSpeechServices();
  return <View style={styles.list}>
    {services.map((service) => {
      const vendor = vendorById(service.vendor)!;
      return <MotionPressable key={service.id} scaleTo={0.98} accessibilityRole="button" accessibilityLabel={`编辑 ${service.name}`} onPress={() => onEdit(service)} style={styles.serviceRow}>
        <VendorBadge vendor={vendor} />
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={styles.serviceName} numberOfLines={1}>{service.name}</Text>
          <Tags vendor={vendor} />
        </View>
        <Icon name="chevronRight" size={18} color={colors.faint} />
      </MotionPressable>;
    })}
    <MotionPressable scaleTo={0.98} accessibilityRole="button" accessibilityLabel="添加语音服务" onPress={onAdd} style={[styles.serviceRow, styles.addRow]}>
      <View style={[styles.badge, { width: 36, height: 36, borderRadius: 12, backgroundColor: colors.primarySoft }]}><Icon name="plus" size={18} color={colors.primary} /></View>
      <Text style={[styles.serviceName, { color: colors.primary }]}>添加语音服务</Text>
    </MotionPressable>
  </View>;
}

/** Add or edit one speech service: pick the vendor, then fill in its keys. */
export function SpeechServiceSheet({ visible, service, kind, onClose, onSaved }: {
  visible: boolean; service: SpeechService | null; kind?: SpeechKind | null; onClose: () => void; onSaved?: (service: SpeechService) => void;
}) {
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [stored, setStored] = useState<Record<string, boolean>>({});
  const [shown, setShown] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const vendor = vendorById(vendorId);

  useEffect(() => {
    if (!visible) return;
    setVendorId(service?.vendor ?? null);
    setName(service?.name ?? '');
    setValues({ ...(service?.config ?? {}) });
    setShown(false);
    setStored({});
    if (service) {
      const secretFields = vendorById(service.vendor)?.fields.filter((field) => field.secret) ?? [];
      void Promise.all(secretFields.map(async (field) => [field.key, await hasSecret(service.id, field.key)] as const)).then((entries) => setStored(Object.fromEntries(entries)));
    }
  }, [visible, service]);

  const groups = useMemo(() => {
    const matching = VENDORS.filter((item) => !kind || item[kind]);
    return [{ title: '国内', items: matching.filter((item) => item.region === 'cn') }, { title: '海外', items: matching.filter((item) => item.region === 'global') }];
  }, [kind]);

  const save = async () => {
    if (!vendor) return;
    setSaving(true);
    try {
      const config: Record<string, string> = {};
      const secrets: Record<string, string> = {};
      for (const field of vendor.fields) (field.secret ? secrets : config)[field.key] = values[field.key] ?? '';
      const saved = await saveSpeechService({ id: service?.id, vendor: vendor.id, name: name || vendor.name, config }, secrets);
      showToast('已保存');
      onSaved?.(saved);
      onClose();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存失败', 'alert');
    } finally {
      setSaving(false);
    }
  };

  return <Sheet visible={visible} onClose={onClose} presentation="page" title={service ? '编辑语音服务' : vendor ? vendor.name : kind ? `添加${KIND_TITLE[kind]}服务` : '添加语音服务'}
    footer={vendor ? <PrimaryButton label="保存" loading={saving} onPress={() => void save()} /> : undefined}>
    <View style={styles.body}>
      {!vendor ? <>
        <Text style={styles.lead}>Salcara 不提供语音服务，所有云端语音都调用你自己的 API。每个功能可以选不同的服务商，比如对话用 DeepSeek、朗读用 OpenAI、识别用豆包。</Text>
        {groups.map((group) => group.items.length ? <View key={group.title}>
          <SectionLabel>{group.title}</SectionLabel>
          <View style={styles.grid}>
            {group.items.map((item) => <MotionPressable key={item.id} wrapperStyle={styles.cellWrap} scaleTo={0.96} accessibilityRole="button" accessibilityLabel={item.name}
              onPress={() => { setVendorId(item.id); setName(item.name); }} style={styles.cell}>
              <VendorBadge vendor={item} size={34} />
              <Text style={styles.cellName} numberOfLines={1}>{item.name}</Text>
              <Text style={styles.cellBlurb} numberOfLines={2}>{item.blurb}</Text>
              <Tags vendor={item} />
            </MotionPressable>)}
          </View>
        </View> : null)}
      </> : <>
        <View style={styles.vendorHead}>
          <VendorBadge vendor={vendor} size={44} />
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={styles.vendorName}>{vendor.name}</Text>
            <Tags vendor={vendor} />
          </View>
          {!service ? <Pressable accessibilityRole="button" onPress={() => setVendorId(null)} hitSlop={8}><Text style={styles.link}>换一个</Text></Pressable> : null}
        </View>
        <SectionLabel>名称</SectionLabel>
        <TextInput value={name} onChangeText={setName} placeholder={vendor.name} placeholderTextColor={colors.subtle} style={styles.input} />
        {vendor.fields.map((field) => <View key={field.key}>
          <SectionLabel>{field.label}{field.optional ? '（可选）' : ''}</SectionLabel>
          <View style={styles.inputRow}>
            <TextInput value={values[field.key] ?? ''} onChangeText={(text) => setValues((current) => ({ ...current, [field.key]: text }))}
              placeholder={field.secret && stored[field.key] ? '已保存，留空不修改' : field.placeholder ?? ''} placeholderTextColor={colors.subtle}
              secureTextEntry={field.secret && !shown} autoCapitalize="none" autoCorrect={false} style={[styles.input, { flex: 1 }]} />
            {field.secret ? <Pressable accessibilityRole="button" accessibilityLabel={shown ? '隐藏' : '显示'} onPress={() => setShown((value) => !value)} style={styles.eye}>
              <Icon name={shown ? 'eyeOff' : 'eye'} size={19} color={colors.textMuted} />
            </Pressable> : null}
          </View>
          {field.help ? <Text style={styles.note}>{field.help}</Text> : null}
        </View>)}
        {vendor.keyUrl ? <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(vendor.keyUrl!)} style={styles.keyLink}>
          <Icon name="key" size={16} color={colors.primary} />
          <Text style={styles.link}>去 {vendor.name} 获取密钥</Text>
          <Icon name="external" size={14} color={colors.primary} />
        </Pressable> : null}
        <View style={styles.privacy}>
          <Icon name="lock" size={14} color={colors.subtle} />
          <Text style={styles.privacyText}>密钥只保存在这台手机的安全存储里，只会发送给 {vendor.name}。</Text>
        </View>
        {service ? <Pressable accessibilityRole="button" onPress={() => setConfirm(true)} style={styles.delete}>
          <Icon name="trash" size={17} color={colors.danger} /><Text style={styles.deleteText}>删除这个服务</Text>
        </Pressable> : null}
      </>}
    </View>
    <AppDialog visible={confirm} title="删除语音服务？" message="使用它的功能会改回默认服务，密钥也会一起删除。" icon="trash" onClose={() => setConfirm(false)} actions={[
      { label: '取消', tone: 'secondary', onPress: () => setConfirm(false) },
      { label: '删除', tone: 'danger', onPress: () => { setConfirm(false); if (service) void deleteSpeechService(service.id).then(() => {
        // Functions that used it fall back to the default service.
        const ref = serviceRef(service.id);
        const current = voiceSettings();
        void updateVoiceSettings({
          ...(current.transcribeProviderId === ref ? { transcribeProviderId: null } : {}),
          ...(current.ttsProviderId === ref ? { ttsProviderId: null } : {}),
          ...(current.realtimeProviderId === ref ? { realtimeProviderId: null } : {}),
        });
        showToast('已删除'); onClose();
      }); } },
    ]} />
  </Sheet>;
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 16, paddingBottom: 28 },
  lead: { color: colors.textMuted, fontSize: 13.5, lineHeight: 20, marginTop: 6, marginHorizontal: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  cellWrap: { width: '48%', flexGrow: 1 },
  cell: { padding: 14, gap: 6, borderRadius: 20, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, minHeight: 142 },
  cellName: { color: colors.text, fontSize: 15, fontWeight: '700', marginTop: 4 },
  cellBlurb: { color: colors.textMuted, fontSize: 12, lineHeight: 17, minHeight: 34 },
  badge: { alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontWeight: '800' },
  tags: { flexDirection: 'row', gap: 4, flexWrap: 'wrap' },
  tag: { paddingHorizontal: 7, height: 20, borderRadius: 10, justifyContent: 'center', backgroundColor: colors.primarySoft },
  tagText: { color: colors.primaryDeep, fontSize: 11, fontWeight: '600' },
  vendorHead: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 10 },
  vendorName: { color: colors.text, fontSize: 18, fontWeight: '700' },
  link: { color: colors.primary, fontSize: 14, fontWeight: '600' },
  input: { minHeight: 46, borderRadius: 14, paddingHorizontal: 14, backgroundColor: colors.surface, color: colors.text, fontSize: 15, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  eye: { width: 46, height: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  keyLink: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 18, alignSelf: 'flex-start', paddingVertical: 6 },
  privacy: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 14 },
  privacyText: { flexShrink: 1, color: colors.subtle, fontSize: 12.5 },
  delete: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 26, paddingVertical: 10 },
  deleteText: { color: colors.danger, fontSize: 15, fontWeight: '500' },
  field: { gap: 8 },
  fieldLabel: { color: colors.text, fontSize: 13.5, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  note: { color: colors.textMuted, fontSize: 12.5, lineHeight: 18, marginTop: 4 },
  list: { gap: 8 },
  serviceRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: radius.lg, backgroundColor: colors.card, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  addRow: { borderStyle: 'dashed', borderColor: 'rgba(61,123,250,0.35)', backgroundColor: colors.background },
  serviceName: { color: colors.text, fontSize: 15, fontWeight: '600' },
});
