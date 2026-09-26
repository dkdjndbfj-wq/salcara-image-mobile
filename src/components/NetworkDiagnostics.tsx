import { fetch } from 'expo/fetch';
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { networkFailureMessage, networkHost } from '../api/network';
import type { ChatApi } from '../domain';
import { imageEndpoint } from '../domain-utils';
import { getProviderKey } from '../storage/secure-keys';
import { colors, radius, spacing } from '../theme';
import { PrimaryButton, Sheet } from './ui';

type Probe = { label: string; host: string; reachable: boolean; message: string; elapsedMs: number };

/** Diagnostic traffic is limited to the selected API and its existing result URL. */
export function NetworkDiagnostics({ visible, onClose, providerId, baseUrl, imageUrl, api = 'chat-completions', secondaryProviderId, secondaryBaseUrl, secondaryApi = 'chat-completions' }: {
  visible: boolean; onClose: () => void; providerId: string; baseUrl: string; imageUrl?: string | null; api?: ChatApi;
  /** Optional second capability host, used by automatic chat + image routing. */
  secondaryProviderId?: string; secondaryBaseUrl?: string; secondaryApi?: ChatApi;
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
  }, [visible, providerId, baseUrl, imageUrl, api, secondaryProviderId, secondaryBaseUrl, secondaryApi]);

  const run = async () => {
    if (controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true);
    setResults([]);
    const timeout = setTimeout(() => controller.abort(), 12_000);
    const probe = async (url: string, label: string, apiKey?: string | null, method: 'GET' | 'HEAD' = 'GET', probeApi: ChatApi = api): Promise<Probe> => {
      const started = Date.now();
      let reachable = false;
      let message: string;
      try {
        const headers: Record<string, string> | undefined = apiKey
          ? probeApi === 'anthropic'
            ? { 'x-api-key': apiKey.trim(), 'anthropic-version': '2023-06-01' }
            : { Authorization: `Bearer ${apiKey.trim()}` }
          : undefined;
        const response = await fetch(url, {
          method,
          headers,
          signal: controller.signal,
          credentials: 'omit',
          redirect: apiKey ? 'error' : 'follow',
        });
        reachable = true;
        if (response.ok) message = label === '图片服务器' ? '图片地址可连接（未下载图片）' : label === '生图接口' ? '生图接口路由可连接（仅 HEAD，未生成图片）' : '模型接口可连接';
        else if (response.status === 401 || response.status === 403) message = `服务器可连接，但拒绝访问（HTTP ${response.status}）。请检查密钥或链接是否过期。`;
        else if (response.status === 405) message = label === '生图接口' ? '生图接口路由可连接，但服务商不支持 HEAD 探测；未生成图片。' : '服务器可连接，但不支持探测方法；需要实际下载才能确认。';
        else message = `服务器可连接，返回 HTTP ${response.status}；请检查地址或服务商状态。`;
        await response.body?.cancel().catch(() => undefined);
      } catch (error) {
        message = controller.signal.aborted ? '检测已取消或超过 12 秒，请在当前网络重试。' : networkFailureMessage(url, label, error);
      }
      return { label, host: networkHost(url), reachable, message, elapsedMs: Date.now() - started };
    };
    try {
      const primaryKey = await getProviderKey(providerId);
      if (controller.signal.aborted) return;
      if (!primaryKey) throw new Error('未找到当前服务商密钥，请重新保存服务商。');
      const probes = [
        probe(imageEndpoint(baseUrl, 'models'), 'API 服务器', primaryKey),
        probe(imageEndpoint(baseUrl, 'images/generations'), '生图接口', primaryKey, 'HEAD'),
      ];
      if (secondaryProviderId && secondaryBaseUrl && secondaryProviderId !== providerId) {
        const secondaryKey = await getProviderKey(secondaryProviderId);
        if (secondaryKey) {
          probes.push(
            probe(imageEndpoint(secondaryBaseUrl, 'models'), '图片 API 服务器', secondaryKey, 'GET', secondaryApi),
            probe(imageEndpoint(secondaryBaseUrl, 'images/generations'), '图片生图接口', secondaryKey, 'HEAD', secondaryApi),
          );
        }
      }
      if (imageUrl && /^https?:\/\//i.test(imageUrl)) probes.push(probe(imageUrl, '图片服务器', undefined, 'HEAD'));
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
      <Text style={styles.intro}>检测当前手机网络与所选服务商的连接，不生成图片，也不消耗模型额度。自动模式会同时检测对话 API 和图片 API。</Text>
      <View style={styles.note}><Text style={styles.noteText}>网站、模型列表和生图 POST 是不同链路。这里会额外用不扣费的 HEAD 探测生图接口路由；同一个网站或 /models 能打开，并不表示生图接口一定能完成请求。</Text></View>
      {results.map((result) => (
        <View key={result.label} style={styles.result}>
          <Text style={styles.label}>{result.label} · {result.host}</Text>
          <Text style={[styles.detail, { color: result.reachable ? colors.success : colors.danger }]}>{result.message}</Text>
          <Text style={styles.time}>{(result.elapsedMs / 1000).toFixed(1)} 秒</Text>
        </View>
      ))}
      {!imageUrl && <Text style={styles.detail}>当前没有可探测的图片外链。若 API 检测通过但下载失败，请把下载错误中的图片服务器域名反馈给服务商。</Text>}
      <PrimaryButton label="检测当前网络" icon="pulse" onPress={() => void run()} loading={busy} />
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
