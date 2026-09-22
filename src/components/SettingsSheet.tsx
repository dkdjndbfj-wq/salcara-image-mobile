import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import type { AspectRatio, ChatApi, Quality, ResolutionTier } from '../domain';
import { ALL_QUALITIES, qualitiesForModel, sizeFor } from '../domain-utils';
import { useApp } from '../state/AppContext';
import { colors, radius, spacing } from '../theme';
import { AppDialog, Chip, PrimaryButton, Sheet } from './ui';

const RATIOS: AspectRatio[] = ['1:1', '16:9', '9:16'];
const TIERS: ResolutionTier[] = ['1K', '2K', '4K'];

export function SettingsSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { activeProvider, providers, composerMode, generating, updateActiveProviderSettings } = useApp();
  const isChat = composerMode === 'chat';
  const [chatApi, setChatApi] = useState<ChatApi>('chat-completions');
  const [analysisProviderId, setAnalysisProviderId] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const [quality, setQuality] = useState<Quality | null>(null);
  const [ratio, setRatio] = useState<AspectRatio | null>(null);
  const [tier, setTier] = useState<ResolutionTier | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!visible || !activeProvider) return;
    setModel((isChat ? activeProvider.chatModel : activeProvider.model) ?? '');
    setChatApi(activeProvider.chatApi ?? 'chat-completions');
    setAnalysisProviderId(activeProvider.analysisProviderId ?? null);
    setQuality(activeProvider.quality);
    setRatio(activeProvider.aspectRatio);
    setTier(activeProvider.resolutionTier);
  }, [visible, activeProvider, isChat]);

  const save = async () => {
    try {
      if (isChat) {
        if (analysisProviderId && analysisProviderId !== activeProvider?.id) {
          if (!providers.find((item) => item.id === analysisProviderId)?.chatModel) throw new Error('请先为该服务商配置对话模型');
          await updateActiveProviderSettings({ analysisProviderId });
          onClose();
          return;
        }
        if (!model.trim()) throw new Error('请填写服务商支持的对话模型 ID');
        await updateActiveProviderSettings({ chatModel: model.trim(), chatApi, analysisProviderId: null });
        onClose();
        return;
      }
      if (!model.trim() || !quality || !ratio || !tier) throw new Error('请选择模型、画质、比例和清晰度');
      if (!qualitiesForModel(model.trim()).includes(quality)) throw new Error('此模型不支持所选画质');
      await updateActiveProviderSettings({ model: model.trim(), quality, aspectRatio: ratio, resolutionTier: tier, analysisProviderId });
      onClose();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '请检查参数。');
    }
  };

  const qualities = model ? qualitiesForModel(model) : ALL_QUALITIES;
  return (
    <Sheet visible={visible} title={isChat ? '对话设置' : '生成设置'} onClose={onClose}>
      <View style={styles.body}>
        <Text style={styles.provider}>{activeProvider?.name ?? '尚未选择服务商'}</Text>
        {isChat && <>
          <Text style={styles.label}>对话与文件解析服务商</Text>
          <View style={styles.chips}>
            <Chip label="使用当前服务商" selected={!analysisProviderId} onPress={() => setAnalysisProviderId(null)} />
            {providers.filter((item) => item.chatModel && item.id !== activeProvider?.id).map((item) => <Chip key={item.id} label={item.name} selected={analysisProviderId === item.id} onPress={() => setAnalysisProviderId(item.id)} />)}
          </View>
          {analysisProviderId && <Text style={styles.hint}>当前会话保持不变，内容发给 {providers.find((item) => item.id === analysisProviderId)?.name ?? '已删除的服务商'} 的对话模型。模型与接口在服务商管理中修改。</Text>}
        </>}
        {(!isChat || !analysisProviderId) && <>
        <Text style={styles.label}>模型</Text>
        <TextInput value={model} onChangeText={(value) => { setModel(value); if (!isChat) setQuality(null); }} placeholder={isChat ? '填写对话／视觉模型 ID' : 'gpt-image…'} placeholderTextColor={colors.textMuted} autoCapitalize="none" autoCorrect={false} style={styles.input} />
        {isChat ? <>
          <Text style={styles.label}>接口类型</Text>
          <View style={styles.chips}><Chip label="Chat Completions" selected={chatApi === 'chat-completions'} onPress={() => setChatApi('chat-completions')} /><Chip label="Responses" selected={chatApi === 'responses'} onPress={() => setChatApi('responses')} /><Chip label="Claude Messages" selected={chatApi === 'anthropic'} onPress={() => setChatApi('anthropic')} /></View>
          <Text style={styles.hint}>PDF 会在手机本地逐页转成图片（每份最多 12 页），再发送给视觉模型，避免上游忽略 PDF 文件。</Text>
          <Text style={styles.hint}>图片理解和 PDF 需要该模型及服务商支持。应用不会自动切换接口或自动重发付费请求。</Text>
        </> : <>
        <Text style={styles.label}>画质</Text>
        <View style={styles.chips}>{qualities.map((item) => <Chip key={item} label={item} selected={quality === item} onPress={() => setQuality(item)} />)}</View>
        <Text style={styles.label}>比例</Text>
        <View style={styles.chips}>{RATIOS.map((item) => <Chip key={item} label={item} selected={ratio === item} onPress={() => setRatio(item)} />)}</View>
        <Text style={styles.label}>清晰度</Text>
        <View style={styles.chips}>{TIERS.map((item) => <Chip key={item} label={item} selected={tier === item} onPress={() => setTier(item)} />)}</View>
        {ratio && tier && <Text style={styles.hint}>本次尺寸：{sizeFor(ratio, tier)} · PNG · 1 张</Text>}
        <Text style={styles.label}>文件解析服务商</Text>
        <View style={styles.chips}>
          <Chip label="使用当前服务商" selected={!analysisProviderId} onPress={() => setAnalysisProviderId(null)} />
          {providers.filter((item) => item.chatModel && item.id !== activeProvider?.id).map((item) => <Chip key={item.id} label={item.name} selected={analysisProviderId === item.id} onPress={() => setAnalysisProviderId(item.id)} />)}
        </View>
        <Text style={styles.hint}>仅上传 PDF 等文档时使用对话模型解析，再调用生图模型，两次调用分别计费。请先在服务商管理中填写解析服务商的对话模型。PDF 内容用于整理提示词，不会直接传给生图接口。</Text>
        </>}
        </>}
        <PrimaryButton label="应用设置" icon="checkmark" disabled={generating} onPress={() => void save()} />
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
