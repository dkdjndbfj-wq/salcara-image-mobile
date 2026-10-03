import React, { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { getSearchKey, SEARCH_ENGINES, setSearchKey, updateAgentSettings, useAgentSettings, type SearchKeyName } from '../agent/settings';
import { colors, radius, themed } from '../theme';
import { Icon } from './Icon';
import { DraftField, RadioRow, ToggleRow } from './SettingsParts';
import { AppDialog, Group, SectionLabel, Sheet, showToast } from './ui';

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

/** 联网与手机操作: on/off first; other search services and their keys only when asked for. */
export function ToolsSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const styles = useStyles();
  const settings = useAgentSettings();
  const save = (patch: Parameters<typeof updateAgentSettings>[0]) => void updateAgentSettings(patch).catch(() => showToast('没有保存成功', 'alert'));
  const [clearing, setClearing] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);
  const [more, setMore] = useState(false);
  const simple = settings.webSearch === 'auto' || settings.webSearch === 'off';
  const showMore = more || !simple;
  const clearKeys = () => {
    setConfirmClear(false);
    void Promise.all([setSearchKey('tavily', ''), setSearchKey('brave', '')])
      .then(() => { setClearing((value) => value + 1); showToast('已清除搜索密钥'); })
      .catch(() => showToast('没有清除成功', 'alert'));
  };
  return <Sheet visible={visible} title="联网与手机操作" onClose={onClose} presentation="page">
    <View style={styles.body}>
      <SectionLabel>联网搜索</SectionLabel>
      <Group>
        <ToggleRow first icon="globe" title="允许联网" detail="问到新闻、天气、价格等最新信息时自动搜索并阅读网页，回答带来源" value={settings.webSearch !== 'off'}
          onChange={(on) => save({ webSearch: on ? 'auto' : 'off' })} />
      </Group>
      {settings.webSearch !== 'off' ? <>
        {!showMore ? <Text accessibilityRole="button" style={styles.more} onPress={() => setMore(true)} suppressHighlighting>更换搜索服务（一般不需要）</Text> : <>
          <Group style={{ marginTop: 12 }}>
            {SEARCH_ENGINES.filter((engine) => engine.id !== 'off').map((engine, index) => <RadioRow key={engine.id} first={index === 0} title={engine.label} detail={engine.detail}
              selected={settings.webSearch === engine.id} onPress={() => save({ webSearch: engine.id })} />)}
          </Group>
          {settings.webSearch === 'tavily' || settings.webSearch === 'brave' || settings.webSearch === 'searxng' || settings.webSearch === 'auto' ? <Group style={styles.group} key={clearing}>
            {settings.webSearch === 'tavily' || settings.webSearch === 'auto' ? <KeyField name="tavily" label="Tavily 密钥" hint="在 tavily.com 免费注册获取。只保存在这台手机的安全存储里。" /> : null}
            {settings.webSearch === 'brave' || settings.webSearch === 'auto' ? <KeyField name="brave" label="Brave Search 密钥" hint="在 api-dashboard.search.brave.com 获取。" /> : null}
            {settings.webSearch === 'searxng' || settings.webSearch === 'auto' ? <DraftField label="SearXNG 地址" value={settings.searxngUrl} onSave={(searxngUrl) => save({ searxngUrl: searxngUrl.trim() })} placeholder="https://search.example.com" /> : null}
            <Text accessibilityRole="button" style={styles.link} onPress={() => setConfirmClear(true)} suppressHighlighting>清除已保存的搜索密钥</Text>
          </Group> : null}
        </>}
      </> : null}
      <View style={styles.tip}>
        <Icon name="info" size={15} color={colors.subtle} />
        <Text style={styles.tipText}>搜索词会发送给所选的搜索服务；读取网页时手机会直接访问该网页，读不到时经 r.jina.ai 转换。不会读取局域网地址。</Text>
      </View>

      <SectionLabel>手机操作</SectionLabel>
      <Group>
        <ToggleRow first icon={Platform.OS === 'ios' ? 'calendar' : 'alarm'} title={Platform.OS === 'ios' ? '日程、短信、邮件、导航' : '闹钟、日程、短信、导航'} detail={Platform.OS === 'ios' ? 'Salcara 会先生成确认卡片，你点确认后才添加日程或打开系统应用' : 'Salcara 会先生成确认卡片，你点确认后才打开系统应用'} value={settings.phoneActions} onChange={(phoneActions) => save({ phoneActions })} />
      </Group>
    </View>
    <AppDialog visible={confirmClear} title="清除搜索密钥？" message="将删除这台手机上保存的 Tavily 和 Brave Search 密钥，之后需要重新粘贴才能使用。" icon="trash"
      actions={[{ label: '取消', tone: 'secondary', onPress: () => setConfirmClear(false) }, { label: '清除', tone: 'danger', onPress: clearKeys }]}
      onClose={() => setConfirmClear(false)} />
  </Sheet>;
}

const useStyles = themed((c, d) => StyleSheet.create({
  body: { paddingHorizontal: 16, paddingBottom: 28 },
  group: { padding: 14, gap: 14, marginTop: 12 },
  more: { color: colors.primary, fontSize: 13.5, fontWeight: '600', marginTop: 12, marginLeft: 8, alignSelf: 'flex-start', paddingVertical: 4 },
  link: { color: colors.danger, fontSize: 13, fontWeight: '500', alignSelf: 'flex-start', paddingVertical: 8 },
  tip: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', marginTop: 10, marginHorizontal: 6, padding: 10, borderRadius: radius.md },
  tipText: { flex: 1, color: colors.subtle, fontSize: 12.5, lineHeight: 18 },
}));
