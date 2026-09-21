import * as Application from 'expo-application';
import * as FileSystem from 'expo-file-system/legacy';
import { File } from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import { fetch } from 'expo/fetch';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Linking, Platform, StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing } from '../theme';
import { type AppRelease, compareVersions, fetchLatestRelease, formatBytes, latestReleasePageUrl } from '../update';
import { AppDialog, type DialogAction } from './ui';
import { networkFailureMessage } from '../api/network';
import { copyVerifiedApk } from '../apk-download';

type Phase = 'idle' | 'checking' | 'available' | 'up-to-date' | 'downloading' | 'permission' | 'error';

const INSTALL_MIME = 'application/vnd.android.package-archive';
const FLAG_GRANT_READ_URI_PERMISSION = 1;

export function UpdateManager({ manualCheckToken }: { manualCheckToken: number }) {
  const currentVersion = Application.nativeApplicationVersion ?? '0.0.0';
  const [phase, setPhase] = useState<Phase>('idle');
  const [release, setRelease] = useState<AppRelease | null>(null);
  const [message, setMessage] = useState('');
  const [progress, setProgress] = useState(0);
  const downloadedUriRef = useRef<string | null>(null);
  const downloadRef = useRef<AbortController | null>(null);
  const checkingRef = useRef(false);
  const manualRequestedRef = useRef(false);
  const lastCheckAtRef = useRef(0);
  const nextAutoCheckDelayRef = useRef(15 * 60_000);
  const lastManualTokenRef = useRef(0);

  const check = useCallback(async (manual: boolean) => {
    if (downloadRef.current) return;
    if (checkingRef.current) {
      if (manual) {
        manualRequestedRef.current = true;
        setPhase('checking');
      }
      return;
    }
    checkingRef.current = true;
    manualRequestedRef.current = manual;
    lastCheckAtRef.current = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    if (manual) {
      setMessage('');
      setPhase('checking');
    }
    try {
      const latest = await fetchLatestRelease(controller.signal);
      nextAutoCheckDelayRef.current = 6 * 60 * 60_000;
      setRelease(latest);
      if (compareVersions(latest.version, currentVersion) > 0) {
        setPhase('available');
      } else if (manualRequestedRef.current) {
        setPhase('up-to-date');
      }
    } catch (error) {
      nextAutoCheckDelayRef.current = 15 * 60_000;
      if (manualRequestedRef.current) {
        setMessage(error instanceof Error && error.name === 'AbortError' ? '连接超时，请检查网络后重试。' : error instanceof Error ? error.message : '暂时无法检查新版本。');
        setPhase('error');
      }
    } finally {
      checkingRef.current = false;
      manualRequestedRef.current = false;
      clearTimeout(timeout);
    }
  }, [currentVersion]);

  useEffect(() => {
    const timer = setTimeout(() => void check(false), 1_200);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && Date.now() - lastCheckAtRef.current >= nextAutoCheckDelayRef.current) void check(false);
    });
    return () => { clearTimeout(timer); subscription.remove(); downloadRef.current?.abort(); };
  }, [check]);

  useEffect(() => {
    if (manualCheckToken <= 0 || manualCheckToken === lastManualTokenRef.current) return;
    lastManualTokenRef.current = manualCheckToken;
    void check(true);
  }, [manualCheckToken, check]);

  const launchInstaller = useCallback(async (uri: string) => {
    if (Platform.OS !== 'android') {
      if (release) await Linking.openURL(release.pageUrl);
      return;
    }
    const contentUri = await FileSystem.getContentUriAsync(uri);
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: contentUri,
      type: INSTALL_MIME,
      flags: FLAG_GRANT_READ_URI_PERMISSION,
    });
  }, [release]);

  const downloadAndInstall = async () => {
    if (!release || downloadRef.current) return;
    if (!FileSystem.cacheDirectory) {
      setMessage('设备没有可用的更新缓存目录。');
      setPhase('error');
      return;
    }
    const destination = `${FileSystem.cacheDirectory}salcara-image-update-${release.version}.apk`;
    const controller = new AbortController();
    downloadRef.current = controller;
    const timeout = setTimeout(() => controller.abort('timeout'), 10 * 60_000);
    try {
      setProgress(0);
      setPhase('downloading');
      await FileSystem.deleteAsync(destination, { idempotent: true });
      const response = await fetch(release.apk.url, {
        signal: controller.signal,
        credentials: 'omit',
        headers: {
          Accept: 'application/vnd.android.package-archive,application/octet-stream,*/*',
          'User-Agent': 'Salcara-Image-Android',
        },
      });
      if (!response.ok) throw new Error(`下载服务器返回 HTTP ${response.status}`);
      if (!response.body) throw new Error('更新包下载为空');
      const file = new File(destination);
      file.create({ overwrite: true, intermediates: true });
      await copyVerifiedApk(response.body, file.writableStream(), release.apk, controller.signal, setProgress);
      const info = await FileSystem.getInfoAsync(destination);
      if (!info.exists || !info.size) throw new Error('下载的更新包为空');
      if (release.apk.size > 0 && info.size !== release.apk.size) throw new Error('更新包大小校验失败，请重新下载');
      if (controller.signal.aborted) throw new Error('下载已取消');
      downloadedUriRef.current = destination;
      setPhase('idle');
      try {
        await launchInstaller(destination);
      } catch {
        setMessage('Android 阻止了安装请求。请先允许 Salcara Image“安装未知应用”，返回后会继续打开安装界面。');
        setPhase('permission');
      }
    } catch (error) {
      await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => undefined);
      if (controller.signal.aborted && controller.signal.reason !== 'timeout') {
        setPhase('available');
        return;
      }
      const detail = controller.signal.reason === 'timeout'
        ? '更新包下载超过 10 分钟，已暂停。'
        : error instanceof Error && /^(下载服务器返回 HTTP|下载的更新包为空|更新包)/.test(error.message)
          ? error.message
          : networkFailureMessage(release.apk.url, '更新包下载', error);
      setMessage(`${detail}\n\n更新包托管在 GitHub，与 API 网站使用不同的网络。可点击“浏览器下载”交给系统浏览器。`);
      setPhase('error');
    } finally {
      clearTimeout(timeout);
      downloadRef.current = null;
    }
  };

  const downloadInBrowser = async () => {
    const url = release?.apk.url ?? latestReleasePageUrl();
    try {
      await Linking.openURL(url);
      setPhase('idle');
    } catch (error) {
      setMessage(error instanceof Error ? `无法打开系统浏览器：${error.message}` : '无法打开系统浏览器。');
      setPhase('error');
    }
  };

  const cancelDownload = async () => {
    downloadRef.current?.abort();
  };

  const allowAndInstall = async () => {
    const uri = downloadedUriRef.current;
    if (!uri) {
      setPhase('available');
      return;
    }
    try {
      await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.MANAGE_UNKNOWN_APP_SOURCES, {
        data: `package:${Application.applicationId ?? 'top.salcara.image'}`,
      });
      setPhase('idle');
      await launchInstaller(uri);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '仍无法打开系统安装器，请在系统设置中允许安装未知应用。');
      setPhase('error');
    }
  };

  const close = () => setPhase('idle');
  let title = '';
  let description = '';
  let icon: React.ComponentProps<typeof AppDialog>['icon'] = 'cloud-download-outline';
  let actions: DialogAction[] = [];
  let dismissible = true;

  if (phase === 'checking') {
    title = '正在检查更新';
    description = '正在连接 Salcara Image 的官方 GitHub 发布页。';
    actions = [{ label: '请稍候', disabled: true }];
    dismissible = false;
  } else if (phase === 'available' && release) {
    title = `发现新版本 ${release.tagName}`;
    description = `当前版本 ${currentVersion} · 安装包 ${formatBytes(release.apk.size)}\n\n${release.notes.slice(0, 420)}`;
    actions = [
      { label: '稍后', tone: 'secondary', onPress: close },
      { label: '浏览器下载', tone: 'secondary', onPress: () => void downloadInBrowser() },
      { label: '应用内下载', tone: 'primary', onPress: () => void downloadAndInstall() },
    ];
  } else if (phase === 'up-to-date') {
    title = '已经是最新版本';
    description = `当前安装的是 Salcara Image ${currentVersion}。`;
    icon = 'checkmark-circle-outline';
    actions = [{ label: '完成', tone: 'primary', onPress: close }];
  } else if (phase === 'downloading' && release) {
    title = '正在下载更新';
    description = `${release.apk.name} · ${formatBytes(release.apk.size)}`;
    actions = [{ label: '取消下载', tone: 'secondary', onPress: () => void cancelDownload() }];
    dismissible = false;
  } else if (phase === 'permission') {
    title = '需要安装权限';
    description = message;
    icon = 'shield-checkmark-outline';
    actions = [
      { label: '稍后', tone: 'secondary', onPress: close },
      { label: '允许并继续安装', tone: 'primary', onPress: () => void allowAndInstall() },
    ];
  } else if (phase === 'error') {
    title = '更新没有完成';
    description = message;
    icon = 'alert-circle-outline';
    actions = [
      { label: '关闭', tone: 'secondary', onPress: close },
      { label: '浏览器下载', tone: 'secondary', onPress: () => void downloadInBrowser() },
      { label: '重新检查', tone: 'primary', onPress: () => void check(true) },
    ];
  }

  return (
    <AppDialog visible={phase !== 'idle'} title={title} message={description} icon={icon} actions={actions} dismissible={dismissible} onClose={close}>
      {phase === 'checking' && <ActivityIndicator color={colors.primaryStrong} />}
      {phase === 'downloading' && (
        <View style={styles.progressArea}>
          <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} /></View>
          <Text style={styles.progressText}>{progress > 0 ? `${Math.round(progress * 100)}%` : '正在准备下载…'}</Text>
        </View>
      )}
      {phase === 'available' && release?.apk.digest && <Text style={styles.digest} numberOfLines={2}>官方校验：{release.apk.digest}</Text>}
    </AppDialog>
  );
}

const styles = StyleSheet.create({
  progressArea: { gap: spacing.sm },
  progressTrack: { height: 8, overflow: 'hidden', borderRadius: radius.pill, backgroundColor: colors.blueSurface },
  progressFill: { height: '100%', borderRadius: radius.pill, backgroundColor: colors.primary },
  progressText: { color: colors.primaryStrong, textAlign: 'right', fontSize: 12, fontWeight: '700' },
  digest: { color: colors.textMuted, fontSize: 11, lineHeight: 17 },
});
