import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, PermissionsAndroid, Platform } from 'react-native';

import type { ProviderProfile } from '../domain';
import { modelById, recognizerOptions } from './catalog';
import { isInstalled, modelDirectory, refreshModels } from './models';
import { localEngineAvailable, onVoiceEvent, requireVoiceNative } from './native';
import { resolveSpeechProvider, speechCredentials } from './providers';
import { voiceSettings, loadVoiceSettings } from './settings';
import { transcribeAudio } from './speech-api';

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
  const base = useRef('');
  const committed = useRef('');
  const partial = useRef('');
  const unsubscribe = useRef<Array<() => void>>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef(false);
  const transcribing = useRef<AbortController | null>(null);
  const callbacks = useRef({ onText, onError });
  callbacks.current = { onText, onError };

  const cleanup = useCallback(() => {
    unsubscribe.current.forEach((off) => off());
    unsubscribe.current = [];
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    live.current = false;
    level.setValue(0);
  }, [level]);

  useEffect(() => () => {
    if (live.current) { try { requireVoiceNative().cancelCapture(); } catch { /* not available */ } }
    cleanup();
  }, [cleanup]);

  const render = () => callbacks.current.onText(joinText(base.current, joinText(committed.current, partial.current)));

  const stopRef = useRef<() => Promise<void>>(async () => undefined);

  const start = useCallback(async (currentText: string) => {
    if (live.current) return;
    try {
      const native = requireVoiceNative();
      await ensureMicPermission();
      const settings = await loadVoiceSettings();
      await refreshModels();
      const model = modelById(settings.localModel);
      const useLocal = settings.inputEngine === 'local' && Boolean(model) && isInstalled(model?.id) && localEngineAvailable();
      if (settings.inputEngine === 'local' && !useLocal) {
        if (!resolveSpeechProvider(providers, settings.transcribeProviderId, chatProvider)) {
          throw new Error(localEngineAvailable() ? '还没有下载本地语音模型，请在“设置 → 语音”中下载' : '这台手机不支持本地语音模型，请在“设置 → 语音”改用云端识别');
        }
      }
      base.current = currentText.trimEnd();
      committed.current = '';
      partial.current = '';
      live.current = true;
      setMode(useLocal ? 'local' : 'cloud');
      setState(useLocal ? 'preparing' : 'listening');
      unsubscribe.current.push(onVoiceEvent('onLevel', ({ level: value }) => level.setValue(value)));
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
      setStartedAt(Date.now());
      setState('listening');
      timer.current = setTimeout(() => { void stopRef.current(); }, MAX_DICTATION_MS);
    } catch (error) {
      cleanup();
      setState('idle');
      callbacks.current.onError(error);
    }
  }, [chatProvider, cleanup, level, providers]);

  /** Finish: local keeps the text; cloud uploads the recording and inserts the result. */
  const stop = useCallback(async () => {
    if (!live.current) return;
    const native = requireVoiceNative();
    const cloud = mode === 'cloud';
    if (cloud) setState('transcribing');
    try {
      const { uri } = await native.stopCapture();
      if (cloud) {
        if (!uri) throw new Error('没有录到声音');
        const settings = voiceSettings();
        const provider = resolveSpeechProvider(providers, settings.transcribeProviderId, chatProvider);
        if (!provider) throw new Error('云端语音识别需要一个 OpenAI 兼容的服务商，或在“设置 → 语音”下载本地模型');
        const controller = new AbortController();
        transcribing.current = controller;
        let timerFired = false;
        const timer = setTimeout(() => { timerFired = true; controller.abort(); }, 60_000);
        try {
          const text = await transcribeAudio({ ...(await speechCredentials(provider)), model: settings.transcribeModel, uri, signal: controller.signal });
          if (!controller.signal.aborted) { committed.current = text; render(); }
        } catch (error) {
          // Cancelled by the user: keep quiet. Timed out: say so.
          if (timerFired) throw new Error('语音识别超过 60 秒没有返回，请检查网络或服务商后重试');
          if (!controller.signal.aborted) throw error;
        } finally {
          clearTimeout(timer);
          transcribing.current = null;
          native.deleteFile(uri);
        }
      } else {
        // Final sentences are delivered as events right after the native stop.
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (partial.current) { committed.current = joinText(committed.current, partial.current); partial.current = ''; }
        render();
      }
    } catch (error) {
      callbacks.current.onError(error);
    } finally {
      cleanup();
      setState('idle');
    }
  }, [chatProvider, cleanup, mode, providers]);
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
