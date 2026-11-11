import * as Application from 'expo-application';
import * as FileSystem from 'expo-file-system/legacy';
import { File, Paths } from 'expo-file-system';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing, themed } from '../theme';
import {
  apkDownloadCandidates, type AppRelease, autoUpdateCheckEnabled, compareVersions, fetchLatestRelease, formatBytes, IOS_UPDATE_URL, productionUpdateCheckEnabled, updateInstallMode,
} from '../update';
import { AppDialog, BrandFill, type DialogAction } from './ui';
import { Skeleton, SkeletonGroup } from './Skeleton';
import { abortError } from '../api/network';
import { apkFileStream, verifyDownloadedApk, withApkDownloadDeadline } from '../apk-download';
import { launchVerifiedApkInstaller, loadAndroidUpdateInstaller } from '../apk-installer';
import { runUpdateStep } from '../update-step';
import { cachedUpdateFile, rememberVerifiedUpdate } from '../apk-cache';

type Phase = 'idle' | 'checking' | 'available' | 'up-to-date' | 'downloading' | 'verifying' | 'ready' | 'installing' | 'permission' | 'error' | 'test-build';
type DownloadedUpdate = { uri: string; release: AppRelease };
let nextDownloadAttempt = 0;

function removeFile(file: File) {
  try { if (file.exists) file.delete(); } catch { /* Only task-owned cache files; best effort cleanup. */ }
}

export function UpdateManager({ manualCheckToken }: { manualCheckToken: number }) {
  const styles = useStyles();
  const currentVersion = Application.nativeApplicationVersion ?? '0.0.0';
  const productionUpdatesEnabled = productionUpdateCheckEnabled(Application.applicationId);
  /** Android installs the APK in-app; iOS can only point to the App Store / TestFlight (or just show the notes). */
  const installMode = updateInstallMode(Platform.OS);
  const [phase, setPhase] = useState<Phase>('idle');
  const [release, setRelease] = useState<AppRelease | null>(null);
  const [message, setMessage] = useState('');
  const [progress, setProgress] = useState(0);
  const downloadedRef = useRef<DownloadedUpdate | null>(null);
  const downloadRef = useRef<AbortController | null>(null);
  const checkRef = useRef<AbortController | null>(null);
  const installRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const manualRequestedRef = useRef(false);
  const lastCheckAtRef = useRef(0);
  const nextAutoCheckDelayRef = useRef(15 * 60_000);
  const lastManualTokenRef = useRef(0);

  const check = useCallback(async (manual: boolean) => {
    if (!productionUpdatesEnabled) {
      if (manual) setPhase('test-build');
      return;
    }
    if (downloadRef.current || installRef.current) return;
    if (checkRef.current) {
      if (manual) {
        manualRequestedRef.current = true;
        setPhase('checking');
      }
      return;
    }
    manualRequestedRef.current = manual;
    lastCheckAtRef.current = Date.now();
    const controller = new AbortController();
    checkRef.current = controller;
    if (manual) {
      setMessage('');
      setPhase('checking');
    }
    try {
      const latest = await runUpdateStep(fetchLatestRelease, controller.signal, 12_000, '连接更新服务器超时，请重试。');
      if (!mountedRef.current || controller.signal.aborted || checkRef.current !== controller) return;
      nextAutoCheckDelayRef.current = 6 * 60 * 60_000;
      setRelease(latest);
      if (compareVersions(latest.version, currentVersion) > 0) {
        setPhase('available');
      } else if (manualRequestedRef.current) {
        setPhase('up-to-date');
      }
    } catch (error) {
      if (!mountedRef.current || controller.signal.aborted || checkRef.current !== controller) return;
      nextAutoCheckDelayRef.current = 15 * 60_000;
      if (manualRequestedRef.current) {
        setMessage(error instanceof Error && error.name === 'AbortError' ? '连接超时，请检查网络后重试。' : error instanceof Error ? error.message : '暂时无法检查新版本。');
        setPhase('error');
      }
    } finally {
      if (checkRef.current === controller) {
        checkRef.current = null;
        manualRequestedRef.current = false;
      }
    }
  }, [currentVersion, productionUpdatesEnabled]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      checkRef.current?.abort();
      downloadRef.current?.abort();
      installRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    // iOS without a store link: no silent checks (an Android-only release must not nag iPhone users).
    if (!productionUpdatesEnabled || !autoUpdateCheckEnabled(Platform.OS)) return;
    const timer = setTimeout(() => { if (lastCheckAtRef.current === 0) void check(false); }, 1_200);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && Date.now() - lastCheckAtRef.current >= nextAutoCheckDelayRef.current) void check(false);
    });
    return () => { clearTimeout(timer); subscription.remove(); };
  }, [check, productionUpdatesEnabled]);

  useEffect(() => {
    if (manualCheckToken <= 0 || manualCheckToken === lastManualTokenRef.current) return;
    lastManualTokenRef.current = manualCheckToken;
    void check(true);
  }, [manualCheckToken, check]);

  const launchInstaller = useCallback(async (uri: string, signal?: AbortSignal) => {
    if (Platform.OS !== 'android') {
      if (IOS_UPDATE_URL) await Linking.openURL(IOS_UPDATE_URL);
      return;
    }
    const resolveContentUri = async () => uri.startsWith('content://')
      ? uri
      : (() => {
        try { return new File(uri).contentUri; }
        catch { return undefined; }
      })() ?? await FileSystem.getContentUriAsync(uri);
    // ACTION_INSTALL_PACKAGE is the Android-specific action intended for APKs.
    // A few older/OEM package installers only register ACTION_VIEW, so retain
    // that as a local fallback without sending the file to a browser.
    await launchVerifiedApkInstaller(resolveContentUri, loadAndroidUpdateInstaller, signal);
  }, []);

  const verifyFile = async (file: File, update: AppRelease, signal: AbortSignal) => {
    if (signal.aborted) throw abortError();
    setPhase('verifying');
    setProgress(0);
    await runUpdateStep((stepSignal) => verifyDownloadedApk(
      apkFileStream(file.open()), file.size, update.apk, stepSignal,
      fraction => { if (mountedRef.current && !stepSignal.aborted) setProgress(Math.floor(fraction * 100)); },
    ), signal, 120_000, '安装包校验超时，请重试。');
  };

  const installDownloaded = async (alreadyVerified = false) => {
    const downloaded = downloadedRef.current;
    if (!downloaded || installRef.current || downloadRef.current) return;
    const controller = new AbortController();
    installRef.current = controller;
    let fileVerified = alreadyVerified;
    try {
      if (!alreadyVerified) await verifyFile(new File(downloaded.uri), downloaded.release, controller.signal);
      fileVerified = true;
      if (controller.signal.aborted) throw abortError();
      setMessage('请在系统安装界面中完成更新。返回后可继续安装，无需重新下载。');
      setPhase('installing');
      await runUpdateStep(signal => launchInstaller(downloaded.uri, signal), controller.signal, 30_000,
        '尚未收到系统安装界面的返回结果。可以稍后继续安装，安装包已保留。');
      if (mountedRef.current && !controller.signal.aborted) setPhase('ready');
    } catch (error) {
      if (!mountedRef.current || controller.signal.aborted) return;
      if (!fileVerified) {
        removeFile(new File(downloaded.uri));
        downloadedRef.current = null;
        setMessage(error instanceof Error ? error.message : '无法读取安装包，请重新下载。');
        setPhase('error');
      } else {
        setMessage(error instanceof Error ? error.message : '暂时无法打开系统安装界面。可以检查安装权限后重试。');
        setPhase('ready');
      }
    } finally {
      if (installRef.current === controller) installRef.current = null;
    }
  };

  const openStore = async () => {
    setPhase('idle');
    try {
      await Linking.openURL(IOS_UPDATE_URL);
    } catch {
      setMessage('无法打开 App Store / TestFlight，请稍后在 App Store 或 TestFlight 中手动更新。');
      setPhase('error');
    }
  };

  const downloadAndInstall = async () => {
    // The APK is Android-only; never download it on iOS.
    if (!release || downloadRef.current || installRef.current || installMode !== 'apk') return;
    const downloaded = downloadedRef.current;
    if (downloaded?.release.apk.digest === release.apk.digest && downloaded.release.version === release.version) {
      await installDownloaded();
      return;
    }
    // Each attempt and mirror owns its own path: an uncooperative late native
    // response must never overwrite or delete a retry's package.
    const attempt = `${Date.now()}-${++nextDownloadAttempt}`;
    let finalFile: File | null = null;
    const controller = new AbortController();
    downloadRef.current = controller;
    const timeout = setTimeout(() => controller.abort('timeout'), 10 * 60_000);
    try {
      setProgress(0);
      setPhase('downloading');
      let installedFile: File | null = null;
      let lastError: unknown = null;
      const cached = cachedUpdateFile(release);
      if (cached) {
        try {
          await verifyFile(cached, release, controller.signal);
          if (controller.signal.aborted) throw abortError();
          installedFile = cached;
        } catch (error) {
          if (controller.signal.aborted) throw error;
          removeFile(cached);
        }
      }
      const candidates = apkDownloadCandidates(release);
      for (let index = 0; index < candidates.length && !installedFile; index += 1) {
        const candidate = candidates[index];
        const temporaryFile = new File(Paths.cache, `salcara-image-update-${release.version}-${attempt}-${index}.part`);
        const temporaryUri = temporaryFile.uri;
        finalFile = new File(Paths.cache, `salcara-image-update-${release.version}-${attempt}-${index}.apk`);
        if (controller.signal.aborted) throw new Error('下载已取消');
        setPhase('downloading');
        setProgress(0);
        setMessage(`${candidate.label} · ${index + 1}/${candidates.length}`);
        let receivedBytes = 0;
        try {
          const downloaded = await withApkDownloadDeadline((candidateSignal, keepAlive) => {
            const nativeDownload = File.downloadFileAsync(candidate.url, temporaryFile, {
            idempotent: true,
            signal: candidateSignal,
            headers: {
              Accept: 'application/vnd.android.package-archive,application/octet-stream,*/*',
              'User-Agent': 'Salcara-Image-Android',
              ...candidate.headers,
            },
            onProgress: ({ bytesWritten, totalBytes }) => {
              if (controller.signal.aborted || candidateSignal.aborted || !mountedRef.current) return;
              if (bytesWritten > receivedBytes) { keepAlive(); receivedBytes = bytesWritten; }
              const total = totalBytes > 0 ? totalBytes : release.apk.size;
              setProgress(total > 0 ? Math.min(100, Math.floor(bytesWritten / total * 100)) : 0);
            },
            });
            void nativeDownload.then(
              () => { if (candidateSignal.aborted) removeFile(new File(temporaryUri)); },
              () => removeFile(new File(temporaryUri)),
            );
            return nativeDownload;
          }, controller.signal);
          await verifyFile(downloaded, release, controller.signal);
          if (controller.signal.aborted) throw abortError();
          // Only replace the installable path after every byte has passed the
          // release size, ZIP header and SHA-256 checks.
          const destination = finalFile;
          const finalUri = destination.uri;
          await runUpdateStep(signal => {
            const moving = downloaded.move(destination, { overwrite: true });
            void Promise.resolve(moving).then(() => {
              if (signal.aborted) removeFile(new File(finalUri));
            }, () => { if (signal.aborted) removeFile(new File(finalUri)); });
            return Promise.resolve(moving);
          }, controller.signal, 15_000, '安装包保存超时，请重试。');
          if (!finalFile.exists || finalFile.size !== release.apk.size) throw new Error('更新包落盘失败，请重试');
          installedFile = finalFile;
          break;
        } catch (error) {
          lastError = error;
          removeFile(finalFile);
          if (controller.signal.aborted) throw error;
        } finally {
          // Expo move() mutates the File object's URI. Cleanup the immutable
          // temporary path, never the verified destination it now points at.
          removeFile(new File(temporaryUri));
        }
      }
      if (!installedFile) {
        throw lastError instanceof Error ? lastError : new Error('所有更新下载入口均不可用');
      }
      if (controller.signal.aborted) throw new Error('下载已取消');
      const previous = downloadedRef.current;
      downloadedRef.current = { uri: installedFile.uri, release };
      rememberVerifiedUpdate(installedFile, release);
      if (previous && previous.uri !== installedFile.uri) removeFile(new File(previous.uri));
      setPhase('ready');
    } catch (error) {
      if (!mountedRef.current) return;
      if (controller.signal.aborted && controller.signal.reason !== 'timeout') {
        setPhase('available');
        return;
      }
      const detail = controller.signal.reason === 'timeout'
        ? '更新包下载超过 10 分钟，已暂停。'
        : error instanceof Error && /^(下载服务器|下载的更新包为空|下载内容|更新包|安装包|所有更新)/.test(error.message)
          ? error.message
          : error instanceof Error && /ENOSPC|no space|disk full/i.test(error.message)
            ? '手机存储空间不足，请清理空间后重试。'
            : '安装包下载没有完成，请检查网络和可用存储空间。';
      setMessage(`${detail}\n\n请重试或切换网络后再次下载。`);
      setPhase('error');
    } finally {
      clearTimeout(timeout);
      if (downloadRef.current === controller) downloadRef.current = null;
      if (finalFile && downloadedRef.current?.uri !== finalFile.uri) removeFile(finalFile);
    }
    if (!controller.signal.aborted && mountedRef.current && downloadedRef.current?.release === release) {
      await installDownloaded(true);
    }
  };

  const cancelDownload = async () => {
    downloadRef.current?.abort();
    installRef.current?.abort();
    setPhase(downloadedRef.current ? 'ready' : 'available');
  };

  const allowAndInstall = async () => {
    if (!downloadedRef.current) {
      setPhase('available');
      return;
    }
    if (installRef.current || downloadRef.current) return;
    const controller = new AbortController();
    installRef.current = controller;
    try {
      setPhase('permission');
      await runUpdateStep(async signal => {
        const IntentLauncher = await loadAndroidUpdateInstaller();
        if (signal.aborted) throw abortError();
        return IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.MANAGE_UNKNOWN_APP_SOURCES, {
          data: `package:${Application.applicationId ?? 'top.salcara.image'}`,
        });
      }, controller.signal, 60_000, '请在系统设置中允许安装未知应用，再返回继续安装。');
      if (!controller.signal.aborted && mountedRef.current) {
        setMessage('从系统设置返回后，点击“继续安装”即可，无需重新下载。');
        setPhase('ready');
      }
    } catch (error) {
      if (controller.signal.aborted || !mountedRef.current) return;
      setMessage(error && typeof error === 'object' && 'message' in error ? String(error.message) : '仍无法打开系统安装器，请在系统设置中允许安装未知应用。');
      setPhase('ready');
    } finally {
      if (installRef.current === controller) installRef.current = null;
    }
  };

  const close = () => {
    checkRef.current?.abort();
    checkRef.current = null;
    installRef.current?.abort();
    setPhase('idle');
  };
  let title = '';
  let description = '';
  let icon: React.ComponentProps<typeof AppDialog>['icon'] = 'cloud-download-outline';
  let actions: DialogAction[] = [];
  let dismissible = true;

  if (phase === 'test-build') {
    title = '独立远程测试版';
    description = `当前版本 ${currentVersion}。测试版不检查或安装正式版更新，请从测试仓库的 GitHub Actions 构建产物下载新 APK。正式版与测试版的数据互不影响。`;
    icon = 'flask-outline';
    actions = [{ label: '知道了', tone: 'primary', onPress: close }];
  } else if (phase === 'checking') {
    title = '正在检查更新';
    description = '正在连接 Salcara 更新站与官方版本清单。';
    actions = [{ label: '取消检查', tone: 'secondary', onPress: close }];
  } else if (phase === 'available' && release && installMode !== 'apk') {
    title = `有新版本 ${release.tagName}`;
    description = installMode === 'store'
      ? `当前版本 ${currentVersion}\n\n${release.notes.slice(0, 420)}`
      : `当前版本 ${currentVersion}\n\n${release.notes.slice(0, 420)}\n\niPhone 版会通过 App Store / TestFlight 更新，上架后即可在那里获取新版本。`;
    actions = installMode === 'store'
      ? [{ label: '前往更新', tone: 'primary', onPress: () => void openStore() }]
      : [{ label: '知道了', tone: 'primary', onPress: close }];
  } else if (phase === 'available' && release) {
    title = `发现新版本 ${release.tagName}`;
    description = `当前版本 ${currentVersion} · 安装包 ${formatBytes(release.apk.size)}\n\n${release.notes.slice(0, 420)}`;
    actions = [
      { label: '应用内下载', tone: 'primary', onPress: () => void downloadAndInstall() },
    ];
  } else if (phase === 'up-to-date') {
    title = '已经是最新版本';
    description = `当前安装的是 Salcara AI ${currentVersion}。`;
    icon = 'checkmark-circle-outline';
    actions = [{ label: '完成', tone: 'primary', onPress: close }];
  } else if ((phase === 'downloading' || phase === 'verifying') && release) {
    title = phase === 'verifying' ? '正在校验安装包' : '正在下载更新';
    description = phase === 'verifying' ? '下载已完成，正在确认文件完整性。' : `${formatBytes(release.apk.size)} · ${message}`;
    actions = [{ label: phase === 'verifying' ? '取消校验' : '取消下载', tone: 'secondary', onPress: () => void cancelDownload() }];
    dismissible = false;
  } else if (phase === 'ready') {
    title = '安装包已准备好';
    description = message;
    icon = 'checkmark-circle-outline';
    actions = [
      { label: '继续安装', tone: 'primary', onPress: () => void installDownloaded() },
    ];
  } else if (phase === 'installing' || phase === 'permission') {
    title = phase === 'installing' ? '请在系统中完成安装' : '请在系统中允许安装';
    description = phase === 'installing' ? '安装包已校验。若未看到系统窗口，可以返回后继续安装或检查安装权限。' : '允许 Salcara AI 安装未知应用后，返回这里继续安装。';
    actions = [{ label: '返回', tone: 'secondary', onPress: () => { installRef.current?.abort(); setPhase('ready'); } }];
  } else if (phase === 'error') {
    title = '更新没有完成';
    description = message;
    icon = 'alert-circle-outline';
    actions = installMode === 'apk' && release
      ? [{ label: '再次下载', tone: 'primary', onPress: () => void downloadAndInstall() }]
      : [{ label: '重新检查', tone: 'primary', onPress: () => void check(true) }];
  }

  return (
    <AppDialog visible={phase !== 'idle'} title={title} message={description} icon={icon} actions={actions} dismissible={dismissible} onClose={close}>
      {phase === 'checking' && <SkeletonGroup label="正在检查更新" style={styles.checking}><Skeleton width="72%" height={11} /><Skeleton width="54%" height={11} /></SkeletonGroup>}
      {(phase === 'downloading' || phase === 'verifying') && (
        <View style={styles.progressArea}>
          <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${progress}%` }]}><BrandFill /></View></View>
          <Text style={styles.progressText}>{progress > 0 ? `${progress}%` : phase === 'verifying' ? '正在开始校验…' : '正在准备下载…'}</Text>
        </View>
      )}
      {phase === 'available' && installMode === 'apk' && release?.apk.digest && <Text style={styles.digest} numberOfLines={2}>官方校验：{release.apk.digest}</Text>}
      {phase === 'ready' && <Pressable accessibilityRole="button" accessibilityLabel="安装权限" hitSlop={4}
        onPress={() => void allowAndInstall()} style={({ pressed }) => [styles.permissionLink, pressed && { opacity: 0.65 }]}>
        <Text style={styles.permissionLinkText}>未出现安装界面？检查安装权限</Text>
      </Pressable>}
    </AppDialog>
  );
}

const useStyles = themed((c, d) => StyleSheet.create({
  progressArea: { gap: spacing.sm },
  progressTrack: { height: 8, overflow: 'hidden', borderRadius: radius.pill, backgroundColor: colors.blueSurface },
  progressFill: { height: '100%', overflow: 'hidden', borderRadius: radius.pill, backgroundColor: colors.primary },
  checking: { gap: 8, paddingTop: 2 },
  progressText: { color: colors.primaryStrong, textAlign: 'right', fontSize: 12, fontWeight: '700' },
  digest: { color: colors.textMuted, fontSize: 11, lineHeight: 17 },
  permissionLink: { alignSelf: 'flex-start', minHeight: 40, justifyContent: 'center' },
  permissionLinkText: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
}));
