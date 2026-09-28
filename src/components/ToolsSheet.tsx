import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { getSearchKey, SEARCH_ENGINES, setSearchKey, updateAgentSettings, useAgentSettings, type ImageCheck, type SearchKeyName } from '../agent/settings';
import { colors, radius } from '../theme';
import { Icon } from './Icon';
import { DraftField, RadioRow, ToggleRow } from './SettingsParts';
import { AppDialog, Group, SectionLabel, Sheet, showToast } from './ui';

const IMAGE_CHECKS: Array<{ id: ImageCheck; title: string; detail: string }> = [
  { id: 'off', title: '不检查', detail: '画完直接给你，最快、最省' },
  { id: 'check', title: '画完看一眼', detail: '模型查看成图并指出问题（多一次对话请求）' },
  { id: 'redraw', title: '不满意自动重画一次', detail: '明显不符合要求时自动改进后重画（最多多一张图的费用）' },
];

function KeyField({ name, label, hint }: { name: SearchKeyName; label: string; hint: string }) {
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => { void getSearchKey(name).then((value) => setSaved(value ?? '')); }, [name]);
  if (saved === null) return null;
  const masked = saved ? `已保存（…${saved.slice(-4)}）` : '';
  return <DraftField label={label} value="" secure placeholder={masked || '粘贴密钥'} hint={hint}
    onSave={(value) => {
      if (!value.trim()) return;
      void setSearchKey(name, value).then(() => { setSaved(value.trim()); showToast('密钥已保存'); }).catch(() => showToast('保存失败', 'alert'));
    }} />;
}

/** 工具与联网: search engine, keys and tool switches. */
export function ToolsSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const settings = useAgentSettings();
  const save = (patch: Parameters<typeof updateAgentSettings>[0]) => void updateAgentSettings(patch).catch(() => showToast('没有保存成功', 'alert'));
  const [clearing, setClearing] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);
  const clearKeys = () => {
    setConfirmClear(false);
    void Promise.all([setSearchKey('tavily', ''), setSearchKey('brave', '')])
      .then(() => { setClearing((value) => value + 1); showToast('已清除搜索密钥'); })
      .catch(() => showToast('没有清除成功', 'alert'));
  };
  return <Sheet visible={visible} title="工具与联网" onClose={onClose} presentation="page">
    <View style={styles.body}>
      <SectionLabel>联网搜索</SectionLabel>
      <Group>
        {SEARCH_ENGINES.map((engine, index) => <RadioRow key={engine.id} first={index === 0} title={engine.label} detail={engine.detail}
          selected={settings.webSearch === engine.id} onPress={() => save({ webSearch: engine.id })} />)}
      </Group>
      {settings.webSearch !== 'off' ? <Group style={styles.group} key={clearing}>
        <KeyField name="tavily" label="Tavily 密钥" hint="在 tavily.com 免费注册获取。只保存在这台手机的安全存储里。" />
        <KeyField name="brave" label="Brave Search 密钥" hint="在 api-dashboard.search.brave.com 获取。" />
        <DraftField label="SearXNG 地址" value={settings.searxngUrl} onSave={(searxngUrl) => save({ searxngUrl: searxngUrl.trim() })} placeholder="https://search.example.com" />
        <Text accessibilityRole="button" style={styles.link} onPress={() => setConfirmClear(true)} suppressHighlighting>清除已保存的搜索密钥</Text>
      </Group> : null}
      <View style={styles.tip}>
        <Icon name="info" size={15} color={colors.subtle} />
        <Text style={styles.tipText}>搜索词会发送给所选的搜索服务；读取网页时手机会直接访问该网页，读不到时经 r.jina.ai 转换。不会读取局域网地址。</Text>
      </View>

      <SectionLabel>画图后自检</SectionLabel>
      <Group>
        {IMAGE_CHECKS.map((item, index) => <RadioRow key={item.id} first={index === 0} title={item.title} detail={item.detail}
          selected={settings.imageCheck === item.id} onPress={() => save({ imageCheck: item.id })} />)}
      </Group>

      <SectionLabel>手机操作</SectionLabel>
      <Group>
        <ToggleRow first icon="alarm" title="闹钟、日程、短信、导航" detail="Salcara 会先生成确认卡片，你点确认后才打开系统应用" value={settings.phoneActions} onChange={(phoneActions) => save({ phoneActions })} />
      </Group>
    </View>
    <AppDialog visible={confirmClear} title="清除搜索密钥？" message="将删除这台手机上保存的 Tavily 和 Brave Search 密钥，之后需要重新粘贴才能使用。" icon="trash"
      actions={[{ label: '取消', tone: 'secondary', onPress: () => setConfirmClear(false) }, { label: '清除', tone: 'danger', onPress: clearKeys }]}
      onClose={() => setConfirmClear(false)} />
  </Sheet>;
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 16, paddingBottom: 28 },
  group: { padding: 14, gap: 14, marginTop: 12 },
  link: { color: colors.danger, fontSize: 13, fontWeight: '500', alignSelf: 'flex-start', paddingVertical: 8 },
  tip: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', marginTop: 10, marginHorizontal: 6, padding: 10, borderRadius: radius.md },
  tipText: { flex: 1, color: colors.subtle, fontSize: 12.5, lineHeight: 18 },
});
