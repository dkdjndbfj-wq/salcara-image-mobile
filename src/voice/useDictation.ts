import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, PermissionsAndroid, Platform } from 'react-native';

import type { ProviderProfile } from '../domain';
import { modelById, recognizerOptions } from './catalog';
import { isInstalled, modelDirectory, refreshModels } from './models';
import { localEngineAvailable, onVoiceEvent, requireVoiceNative } from './native';
import { maxRecordingMs, missingTargetMessage, resolveTarget, transcribe } from './engines';
import { voiceSettings, loadVoiceSettings } from './settings';
import { levelSetter } from './levels';

export type DictationState = 'idle' | 'preparing' | 'listening' | 'transcribing';
const MAX_DICTATION_MS = 5 * 60 * 1000;

export async function ensureMicPermission(): Promise<void> {
  if (Platform.OS !== 'android') return;
  const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, {
    title: '允许使用麦克风', message: 'Salcara 需要麦克风来听你说话。录音只用于语音输入和语音对话。', buttonPositive: '允许', buttonNegative: '不允许',
  });
  if (granted !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('没有麦克风权限，请在系统设置中允许 Salcara 使用麦克风');
}

/** Joins recognized pieces; a space only between Latin words. */
export function joinText(base: string, addition: string): string {
  if (!addition) return base;
  if (!base) return addition;
  const needsSpace = /[A-Za-z0-9]$/.test(base) && /^[A-Za-z0-9]/.test(addition);
  return `${base}${needsSpace || (/[.,!?;:]$/.test(base) && /^[A-Za-z]/.test(addition)) ? ' ' : ''}${addition}`;
}

interface Options {
  providers: ProviderProfile[];
  chatProvider: ProviderProfile | null;
  /** Called with the full composer text as recognition progresses. */
  onText: (text: string) => void;
  onError: (error: unknown) => void;
}

/** Voice typing for the composer: on-device streaming, or record-then-transcribe in the cloud. */
export function useDictation({ providers, chatProvider, onText, onError }: Options) {
  const [state, setState] = useState<DictationState>('idle');
  const [mode, setMode] = useState<'local' | 'cloud'>('cloud');
  const [startedAt, setStartedAt] = useState(0);
  const level = useRef(new Animated.Value(0)).current;
  const setLevel = useMemo(() => levelSetter(level), [level]);
  const base = useRef('');
  const committed = useRef('');
  const partial = useRef('');
  const unsubscribe = useRef<Array<() => void>>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef(false);
  /** Set from the first tap until recording starts or fails: a second tap must not start another capture. */
  const starting = useRef(false);
  const stopping = useRef(false);
  const mounted = useRef(true);
  const transcribing = useRef<AbortController | null>(null);
  /** A cloud recording whose transcription failed: kept so the next mic tap retries it without re-recording. */
  const failed = useRef<{ uri: string; base: string } | null>(null);
  const callbacks = useRef({ onText, onError });
  callbacks.current = { onText, onError };

  const deleteFile = (uri: string) => { try { requireVoiceNative().deleteFile(uri); } catch { /* not available */ } };
  const setStateSafe = (next: DictationState) => { if (mounted.current) setState(next); };

  const cleanup = useCallback(() => {
    unsubscribe.current.forEach((off) => off());
    unsubscribe.current = [];
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    live.current = false;
    setLevel(0);
  }, [setLevel]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (live.current) { try { requireVoiceNative().cancelCapture(); } catch { /* not available */ } }
      transcribing.current?.abort();
      if (failed.current) { deleteFile(failed.current.uri); failed.current = null; }
      cleanup();
    };
  }, [cleanup]);

  const render = () => { if (mounted.current) callbacks.current.onText(joinText(base.current, joinText(committed.current, partial.current))); };

  /** Uploads a recording; keeps the file when it fails (for a retry), deletes it otherwise. */
  const transcribeFile = useCallback(async (uri: string) => {
    const settings = voiceSettings();
    const controller = new AbortController();
    transcribing.current = controller;
    let timerFired = false;
    const limit = setTimeout(() => { timerFired = true; controller.abort(); }, 60_000);
    let keep = false;
    try {
      const target = await resolveTarget('stt', settings.transcribeProviderId, settings.transcribeModel, '', providers, chatProvider);
      if (!target) throw new Error(missingTargetMessage('stt'));
      const text = await transcribe(target, { uri, language: settings.transcribeLanguage, signal: controller.signal });
      if (!controller.signal.aborted) { committed.current = text; render(); }
    } catch (error) {
      // Cancelled by the user (or the screen closed): keep quiet and drop the recording.
      if (controller.signal.aborted && !timerFired) return;
      keep = true;
      failed.current = { uri, base: base.current };
      const reason = timerFired ? '语音识别超过 60 秒没有返回，请检查网络或服务商' : error instanceof Error ? error.message : '语音识别失败';
      throw new Error(`${reason}。录音已保留，再点一次麦克风即可重新识别`);
    } finally {
      clearTimeout(limit);
      if (transcribing.current === controller) transcribing.current = null;
      if (!keep) deleteFile(uri);
    }
  }, [chatProvider, providers]);

  const stopRef = useRef<() => Promise<void>>(async () => undefined);

  const start = useCallback(async (currentText: string) => {
    if (live.current || starting.current || transcribing.current) return;
    starting.current = true;
    try {
      const retry = failed.current;
      if (retry) {
        // Retry the kept recording instead of recording again.
        failed.current = null;
        base.current = retry.base;
        committed.current = '';
        partial.current = '';
        setMode('cloud');
        setState('transcribing');
        try { await transcribeFile(retry.uri); } catch (error) { if (mounted.current) callbacks.current.onError(error); } finally { setStateSafe('idle'); }
        return;
      }
      const native = requireVoiceNative();
      await ensureMicPermission();
      const settings = await loadVoiceSettings();
      await refreshModels();
      const model = modelById(settings.localModel);
      const useLocal = settings.inputEngine === 'local' && Boolean(model) && isInstalled(model?.id) && localEngineAvailable();
      let maxMs = MAX_DICTATION_MS;
      if (!useLocal) {
        // Cloud recognition always goes to the API picked for 语音识别; check it before recording.
        const target = await resolveTarget('stt', settings.transcribeProviderId, settings.transcribeModel, '', providers, chatProvider);
        if (!target) {
          throw new Error(settings.inputEngine === 'local'
            ? (localEngineAvailable() ? '还没有下载本地语音模型，请在“设置 → 语音”中下载，或选择一个云端识别服务' : '这台手机不支持本地语音模型，请在“设置 → 语音”选择云端识别服务')
            : missingTargetMessage('stt'));
        }
        // Stop (and transcribe) at the longest audio this API accepts in one request.
        maxMs = Math.min(MAX_DICTATION_MS, maxRecordingMs(target.protocol));
      }
      if (!mounted.current) return;
      base.current = currentText.trimEnd();
      committed.current = '';
      partial.current = '';
      live.current = true;
      setMode(useLocal ? 'local' : 'cloud');
      setState(useLocal ? 'preparing' : 'listening');
      unsubscribe.current.push(onVoiceEvent('onLevel', ({ level: value }) => setLevel(value)));
      unsubscribe.current.push(onVoiceEvent('onCaptureError', ({ message }) => callbacks.current.onError(new Error(message))));
      if (useLocal && model) {
        unsubscribe.current.push(onVoiceEvent('onTranscript', ({ text, isFinal }) => {
          if (isFinal) { committed.current = joinText(committed.current, text); partial.current = ''; } else partial.current = text;
          render();
        }));
        await native.prepareRecognizer(recognizerOptions(model, modelDirectory(model.id)));
        if (!live.current) return;
        await native.startCapture({ sampleRate: 16000, useRecognizer: true });
      } else {
        await native.startCapture({ sampleRate: 16000, sessionWav: true });
      }
      if (!live.current) return;
      setStartedAt(Date.now());
      setState('listening');
      timer.current = setTimeout(() => { void stopRef.current(); }, maxMs);
    } catch (error) {
      if (live.current) { try { requireVoiceNative().cancelCapture(); } catch { /* not available */ } }
      cleanup();
      setStateSafe('idle');
      if (mounted.current) callbacks.current.onError(error);
    } finally {
      starting.current = false;
    }
  }, [chatProvider, cleanup, providers, setLevel, transcribeFile]);

  /** Finish: local keeps the text; cloud uploads the recording and inserts the result. */
  const stop = useCallback(async () => {
    if (!live.current || stopping.current) return;
    stopping.current = true;
    const native = requireVoiceNative();
    const cloud = mode === 'cloud';
    if (cloud) setState('transcribing');
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    try {
      const { uri } = await native.stopCapture();
      if (cloud) {
        if (!uri) throw new Error('没有录到声音');
        await transcribeFile(uri);
      } else {
        // Final sentences are delivered as events right after the native stop.
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (partial.current) { committed.current = joinText(committed.current, partial.current); partial.current = ''; }
        render();
      }
    } catch (error) {
      if (mounted.current) callbacks.current.onError(error);
    } finally {
      stopping.current = false;
      cleanup();
      setStateSafe('idle');
    }
  }, [cleanup, mode, transcribeFile]);
  stopRef.current = stop;

  /** Discard: put the text back exactly as it was before dictation. */
  const cancel = useCallback(() => {
    if (transcribing.current) {
      transcribing.current.abort();
      callbacks.current.onText(base.current);
      return;
    }
    if (!live.current) return;
    try { requireVoiceNative().cancelCapture(); } catch { /* not available */ }
    callbacks.current.onText(base.current);
    cleanup();
    setState('idle');
  }, [cleanup]);

  return { state, mode, level, startedAt, start, stop, cancel };
}
