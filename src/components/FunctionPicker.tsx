import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { refreshServiceModels, useServiceModels } from '../api/services';
import { capabilityOf, defaultModel, KIND_TITLE, modelsFor, supports, vendorForService, voicesFor, type ServiceKind, type Vendor } from '../api/vendors';
import type { ProviderProfile } from '../domain';
import { useApp } from '../state/AppContext';
import { colors, prettyModel, radius } from '../theme';
import { Icon } from './Icon';
import { ModelSelect } from './ModelSelect';
import { MotionPressable } from './MotionPressable';
import { Chip } from './ui';

/**
 * One function (对话 / 绘图 / 语音识别 / 语音合成 / 实时语音): which service, which of its models,
 * and — for speech output — which voice. Every service is just an address and a key; the models come
 * from the vendor's known list plus whatever the service reports.
 */

export interface FunctionChoice { serviceId: string | null; model: string; voice?: string }

/** Initial-letter badge standing in for a vendor logo. */
export function VendorBadge({ vendor, size = 36 }: { vendor: Vendor; size?: number }) {
  const hue = [...vendor.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 6;
  const tint = ['#3D7BFA', '#7B6CF6', '#12A150', '#E0822B', '#2A9DC4', '#D2477A'][hue];
  return <View style={[styles.badge, { width: size, height: size, borderRadius: size * 0.32, backgroundColor: `${tint}1A` }]}>
    <Text style={[styles.badgeText, { color: tint, fontSize: size * 0.42 }]}>{[...vendor.name][0]}</Text>
  </View>;
}

/** A service's name, with its address when two services share a name (two keys at one vendor). */
export function serviceLabel(service: ProviderProfile, all: ProviderProfile[]): string {
  const twin = all.some((other) => other.id !== service.id && other.name === service.name);
  if (!twin) return service.name;
  const host = service.baseUrl.replace(/^[a-z]+:\/\//i, '').split('/')[0];
  return host ? `${service.name} · ${host}` : `${service.name} · ${service.id.slice(0, 4)}`;
}

export function servicesFor(kind: ServiceKind, providers: ProviderProfile[]): ProviderProfile[] {
  return providers.filter((item) => supports(vendorForService(item), kind));
}

/** The choice when switching a function to another service: that vendor's sensible defaults. */
export function choiceFor(kind: ServiceKind, service: ProviderProfile, listed: string[]): FunctionChoice {
  const vendor = vendorForService(service);
  const capability = kind === 'chat' || kind === 'image' ? undefined : capabilityOf(vendor, kind);
  const model = defaultModel(vendor, kind, listed);
  return { serviceId: service.id, model, voice: voicesFor(capability, model)[0]?.id ?? '' };
}

export function FunctionPicker({ kind, value, onChange, onAddService, offLabel, followChat = false, hideLabel = false }: {
  kind: ServiceKind;
  value: FunctionChoice;
  onChange: (choice: FunctionChoice) => void;
  onAddService: () => void;
  /** A chip meaning “off” (null service), e.g. realtime voice in auto mode. */
  offLabel?: string;
  /** Speech: a null service means “the chat service”, shown as such. */
  followChat?: boolean;
  hideLabel?: boolean;
}) {
  const { providers, chatProvider } = useApp();
  const options = servicesFor(kind, providers);
  const fallback = followChat && !value.serviceId && chatProvider && supports(vendorForService(chatProvider), kind) ? chatProvider : null;
  const service = providers.find((item) => item.id === value.serviceId) ?? fallback;
  const vendor = service ? vendorForService(service) : null;
  const listed = useServiceModels(service?.id);
  const [picking, setPicking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const capability = vendor && kind !== 'chat' && kind !== 'image' ? capabilityOf(vendor, kind) : undefined;
  const models = vendor ? modelsFor(vendor, kind, listed) : [];
  const allVoices = capability?.voices ?? [];
  const wantsVoice = (kind === 'tts' || kind === 'realtime') && Boolean(service);
  const languageModel = vendor && (vendor.id === 'azure-speech' || vendor.id === 'google-cloud') && kind === 'stt';
  // Following the chat service, or nothing chosen yet: what will actually be used is the vendor's default.
  const following = !value.serviceId;
  const shownModel = (!following && value.model) || (vendor ? defaultModel(vendor, kind, listed) : '');
  // Voices follow the model: each vendor (and often each model) has its own set.
  const voices = voicesFor(capability, shownModel);
  const shownVoice = (!following && value.voice) || voices[0]?.id || '';
  /** Keeps a typed / cloned voice; a listed voice the new model doesn't have is swapped for its first one. */
  const voiceFor = (model: string) => {
    const next = voicesFor(capability, model);
    const listed = allVoices.some((voice) => voice.id === shownVoice);
    return !listed || next.some((voice) => voice.id === shownVoice) ? shownVoice : next[0]?.id ?? '';
  };

  const refresh = async () => {
    if (!service) return;
    setLoading(true); setError(null);
    try { await refreshServiceModels(service); } catch (reason) { setError(reason instanceof Error ? reason.message : '读取模型失败'); } finally { setLoading(false); }
  };
  const openModels = () => {
    setPicking(true);
    if (service && vendor?.lists && !listed.length) void refresh();
  };
  const pickService = (next: ProviderProfile) => {
    if (next.id === service?.id) return;
    onChange(choiceFor(kind, next, []));
    if (vendorForService(next).lists) void refreshServiceModels(next).then((list) => onChange(choiceFor(kind, next, list))).catch(() => undefined);
  };

  return <View style={styles.wrap}>
    {!hideLabel ? <Text style={styles.label}>{KIND_TITLE[kind]}</Text> : null}
    {/* Step 1: which API (one vendor can have several accounts / keys); step 2: which of its models. */}
    <Text style={styles.step}>① 选择 API</Text>
    <View style={styles.chips}>
      {offLabel ? <Chip label={offLabel} selected={!value.serviceId} onPress={() => onChange({ serviceId: null, model: '', voice: '' })} /> : null}
      {options.map((item) => <Chip key={item.id} label={`${serviceLabel(item, options)}${item.id === fallback?.id ? '（跟随对话）' : ''}`} selected={item.id === service?.id} onPress={() => pickService(item)} />)}
      <Chip label="添加 API" icon="plus" onPress={onAddService} />
    </View>
    {!options.length ? <Text style={styles.note}>{`还没有能做${KIND_TITLE[kind]}的 API。点“添加 API”，选一家平台填上地址和密钥即可。`}</Text> : null}
    {service && vendor ? <>
      <Text style={styles.step}>② 选择{languageModel ? '语言' : '模型'}{vendor.lists ? '（从这个 API 读取）' : ''}</Text>
      <MotionPressable accessibilityRole="button" accessibilityLabel={`选择${KIND_TITLE[kind]}的模型`} scaleTo={0.98} onPress={openModels} style={styles.model}>
        <View style={{ flex: 1 }}>
          <Text style={styles.modelLabel}>{languageModel ? '识别语言' : '模型'}</Text>
          <Text style={[styles.modelValue, !shownModel && { color: colors.primary }]} numberOfLines={1}>{shownModel ? prettyModel(shownModel) : `选择${languageModel ? '语言' : '模型'}`}</Text>
          {shownModel && prettyModel(shownModel) !== shownModel ? <Text style={styles.modelId} numberOfLines={1}>{shownModel}</Text> : null}
        </View>
        <Icon name="chevronDown" size={17} color={colors.subtle} />
      </MotionPressable>
      {wantsVoice ? <View style={styles.voice}>
        <Text style={styles.modelLabel}>音色</Text>
        {voices.length ? <View style={styles.chips}>{voices.map((item) => <Chip key={item.id} label={item.label} selected={item.id === shownVoice} onPress={() => onChange({ serviceId: service.id, model: shownModel, voice: item.id })} />)}</View> : null}
        {capability?.customVoice || !voices.length ? <TextInput value={following ? '' : value.voice ?? ''} onChangeText={(voice) => onChange({ serviceId: service.id, model: shownModel, voice })} autoCapitalize="none" autoCorrect={false}
          placeholder={voices.length ? '或填写音色 ID（克隆音色等）' : '音色 ID'} placeholderTextColor={colors.subtle} style={styles.input} /> : null}
      </View> : null}
      {capability?.note ? <Text style={styles.note}>{capability.note}</Text> : null}
    </> : null}
    <ModelSelect visible={picking} title={`${KIND_TITLE[kind]} · ${service?.name ?? ''}`} value={shownModel} models={models} loading={loading}
      error={error ?? (vendor && !vendor.lists ? `${vendor.name} 没有模型列表接口，下面是它支持的${languageModel ? '语言' : '模型'}，也可以手动填写。` : null)}
      onClose={() => setPicking(false)} onRefresh={() => void refresh()}
      onSelect={(model) => service && onChange({ serviceId: service.id, model, voice: voiceFor(model) })} />
  </View>;
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  label: { color: colors.text, fontSize: 13.5, fontWeight: '600' },
  step: { color: colors.subtle, fontSize: 12, fontWeight: '600', letterSpacing: 0.2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  note: { color: colors.textMuted, fontSize: 12.5, lineHeight: 18 },
  model: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 56, paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  modelLabel: { color: colors.subtle, fontSize: 11.5, fontWeight: '600', letterSpacing: 0.3 },
  modelValue: { color: colors.text, fontSize: 15, fontWeight: '600', marginTop: 2 },
  modelId: { color: colors.subtle, fontSize: 11.5, marginTop: 1 },
  voice: { gap: 8 },
  input: { minHeight: 44, borderRadius: 12, paddingHorizontal: 12, backgroundColor: colors.surface, color: colors.text, fontSize: 14.5, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  badge: { alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontWeight: '800' },
});
