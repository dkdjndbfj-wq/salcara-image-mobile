import { fetch } from 'expo/fetch';
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { networkFailureMessage, networkHost } from '../api/network';
import { imageEndpoint } from '../domain-utils';
import { getProviderKey } from '../storage/secure-keys';
import { colors, radius, spacing } from '../theme';
import { PrimaryButton, Sheet } from './ui';

type Probe = { label: string; host: string; reachable: boolean; message: string; elapsedMs: number };

/** Diagnostic traffic is limited to the selected API and its existing result URL. */
export function NetworkDiagnostics({ visible, onClose, providerId, baseUrl, imageUrl }: {
  visible: boolean; onClose: () => void; providerId: string; baseUrl: string; imageUrl?: string | null;
}) {
  const [results, setResults] = useState<Probe[]>([]);
  const [busy, setBusy] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => {
    setResults([]);
    setBusy(false);
    return () => {
      const controller = controllerRef.current;
      controllerRef.current = null;
      controller?.abort();
    };
  }, [visible, providerId, baseUrl, imageUrl]);

  const run = async () => {
    if (controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true);
    setResults([]);
    const timeout = setTimeout(() => controller.abort(), 12_000);
    const probe = async (url: string, label: string, apiKey?: string | null): Promise<Probe> => {
      const started = Date.now();
      let reachable = false;
      let message: string;
      try {
        const response = await fetch(url, {
          method: label === '图片服务器' ? 'HEAD' : 'GET',
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
          signal: controller.signal,
          credentials: 'omit',
          redirect: apiKey ? 'error' : 'follow',
        });
        reachable = true;
        if (response.ok) message = label === '图片服务器' ? '图片地址可连接（未下载图片）' : '模型接口可连接';
        else if (response.status === 401 || response.status === 403) message = `服务器可连接，但拒绝访问（HTTP ${response.status}）。请检查密钥或链接是否过期。`;
        else if (response.status === 405) message = '服务器可连接，但不支持探测方法；需要实际下载才能确认。';
        else message = `服务器可连接，返回 HTTP ${response.status}；请检查地址或服务商状态。`;
        await response.body?.cancel().catch(() => undefined);
      } catch (error) {
        message = controller.signal.aborted ? '检测已取消或超过 12 秒，请在当前网络重试。' : networkFailureMessage(url, label, error);
      }
      return { label, host: networkHost(url), reachable, message, elapsedMs: Date.now() - started };
    };
    try {
      const key = await getProviderKey(providerId);
      if (controller.signal.aborted) return;
      if (!key) throw new Error('未找到当前服务商密钥，请重新保存服务商。');
      const probes = [probe(imageEndpoint(baseUrl, 'models'), 'API 服务器', key)];
      if (imageUrl && /^https?:\/\//i.test(imageUrl)) probes.push(probe(imageUrl, '图片服务器'));
      const result = await Promise.all(probes);
      if (controllerRef.current === controller) setResults(result);
    } catch (error) {
      if (controllerRef.current === controller) setResults([{ label: 'API 服务器', host: networkHost(baseUrl), reachable: false, message: error instanceof Error ? error.message : '无法开始检测', elapsedMs: 0 }]);
    } finally {
      clearTimeout(timeout);
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setBusy(false);
      }
    }
  };

  return (
    <Sheet visible={visible} title="网络诊断" onClose={() => { controllerRef.current?.abort(); onClose(); }}>
      <View style={styles.body}>
      <Text style={styles.intro}>检测当前手机网络与所选服务商的连接，不生成图片，也不消耗模型额度。密钥只发往你配置的 API 地址。</Text>
      <View style={styles.note}><Text style={styles.noteText}>网站、API 和图片下载可能使用不同域名。你可以先关闭节点检测，再开启节点对比结果；同一个网站能打开，并不表示图片服务器也可连接。</Text></View>
      {results.map((result) => (
        <View key={result.label} style={styles.result}>
          <Text style={styles.label}>{result.label} · {result.host}</Text>
          <Text style={[styles.detail, { color: result.reachable ? colors.success : colors.danger }]}>{result.message}</Text>
          <Text style={styles.time}>{(result.elapsedMs / 1000).toFixed(1)} 秒</Text>
        </View>
      ))}
      {!imageUrl && <Text style={styles.detail}>当前没有可探测的图片外链。若 API 检测通过但下载失败，请把下载错误中的图片服务器域名反馈给服务商。</Text>}
      <PrimaryButton label="检测当前网络" icon="pulse-outline" onPress={() => void run()} loading={busy} />
      <Text style={styles.detail}>对于 sub2api 服务商，可在上游账户中启用“生图结果 URL 转 base64”，让 API 直接返回图片内容，减少对外部图片域名的依赖。</Text>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { padding: spacing.lg, gap: spacing.md },
  intro: { color: colors.text, fontSize: 14, lineHeight: 22 },
  note: { backgroundColor: colors.blueSurface, borderRadius: radius.md, padding: spacing.md },
  noteText: { color: colors.primaryStrong, fontSize: 13, lineHeight: 21 },
  result: { borderColor: colors.border, borderWidth: 1, borderRadius: radius.md, padding: spacing.md, gap: spacing.sm },
  label: { color: colors.text, fontSize: 14, fontWeight: '700' },
  detail: { color: colors.textMuted, fontSize: 13, lineHeight: 21 },
  time: { color: colors.textMuted, fontSize: 12 },
});
