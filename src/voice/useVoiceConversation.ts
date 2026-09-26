import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated } from 'react-native';

import { VOICE_INSTRUCTIONS } from '../api/chat-api';
import type { ChatMessage } from '../domain';
import { useApp } from '../state/AppContext';
import { prettyModel } from '../theme';
import { modelById, recognizerOptions } from './catalog';
import { ensureMicPermission, joinText } from './useDictation';
import { isInstalled, modelDirectory, refreshModels } from './models';
import { localEngineAvailable, onVoiceEvent, requireVoiceNative, type VoiceNativeModule } from './native';
import { resolveSpeechProvider, speechCredentials } from './providers';
import { RealtimeSession } from './realtime';
import { loadVoiceSettings, type VoiceSettings } from './settings';
import { streamSpeech, transcribeAudio } from './speech-api';
import { takeSentences, toSpeakable } from './speech-text';

export type LivePhase = 'connecting' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'error';
export type LiveEngine = 'cascade' | 'realtime';

const KEEP_AWAKE_TAG = 'salcara-live';

interface Turn {
  since: number;
  consumed: number;
  final: boolean;
  aborted: boolean;
  abort: AbortController;
  spoke: boolean;
  /** Reply is an image job: interrupting must not cancel the drawing. */
  imageJob: boolean;
  /** System-voice sentences not finished yet. */
  speaking: Set<string>;
  /** Cloud audio written to the player and not yet reported as drained. */
  awaitingPlayer: boolean;
  playerEnded: boolean;
}

/** Thrown when a session was closed while it was still starting. */
class Superseded extends Error {}

/** Recent text of the open conversation, so a realtime session continues where the chat is. */
function conversationContext(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const message of messages.slice(-8)) {
    const text = (message.role === 'user' ? message.prompt : message.text ?? '').trim();
    if (text) lines.push(`${message.role === 'user' ? '用户' : '你'}：${text.slice(0, 300)}`);
  }
  const joined = lines.join('\n');
  return joined ? `\n\n此前的对话（供参考）：\n${joined.slice(-1800)}` : '';
}

export function useVoiceConversation(active: boolean) {
  const app = useApp();
  const appRef = useRef(app);
  appRef.current = app;

  const [phase, setPhase] = useState<LivePhase>('connecting');
  const [engine, setEngine] = useState<LiveEngine | null>(null);
  const [engineLabel, setEngineLabel] = useState('');
  const [userText, setUserText] = useState('');
  const [assistantText, setAssistantText] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [syntheticVoice, setSyntheticVoice] = useState(false);
  const micLevel = useRef(new Animated.Value(0)).current;
  const outLevel = useRef(new Animated.Value(0)).current;

  const phaseRef = useRef<LivePhase>('connecting');
  const setPhaseBoth = useCallback((next: LivePhase) => { phaseRef.current = next; setPhase(next); }, []);
  const offs = useRef<Array<() => void>>([]);
  const nativeRef = useRef<VoiceNativeModule | null>(null);
  const settingsRef = useRef<VoiceSettings | null>(null);
  const turnRef = useRef<Turn | null>(null);
  const queue = useRef<string[]>([]);
  const pumping = useRef(false);
  const outputRef = useRef<'cloud' | 'system'>('cloud');
  const ttsCreds = useRef<{ baseUrl: string; apiKey: string } | null>(null);
  const sttCreds = useRef<{ baseUrl: string; apiKey: string } | null>(null);
  const utterance = useRef('');
  const submitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const realtime = useRef<RealtimeSession | null>(null);
  const realtimeTurn = useRef({ user: '', assistant: '', acceptAudio: true });
  /** Session generation: bumped on teardown so late async steps of an old start stop themselves. */
  const generation = useRef(0);
  const speakSeq = useRef(0);
  /** Cloud transcriptions in flight, kept in order so a pause mid-sentence doesn't split the question. */
  const transcripts = useRef<Array<string | null>>([]);
  const speechActive = useRef(false);

  const clearSubmit = () => { if (submitTimer.current) clearTimeout(submitTimer.current); submitTimer.current = null; };

  /** Back to listening once every sentence has been heard. */
  const finishIfDone = useCallback(() => {
    const turn = turnRef.current;
    if (!turn || !turn.final || queue.current.length || pumping.current) return;
    if (turn.awaitingPlayer) {
      if (!turn.playerEnded) { turn.playerEnded = true; nativeRef.current?.playerEnd(); }
      return;
    }
    if (turn.speaking.size) return;
    turnRef.current = null;
    if (phaseRef.current === 'speaking' || phaseRef.current === 'thinking') setPhaseBoth('listening');
  }, [setPhaseBoth]);

  const speakSystem = useCallback((sentence: string) => {
    const turn = turnRef.current;
    if (!turn || turn.aborted) return;
    speakSeq.current += 1;
    const id = `s${speakSeq.current}`;
    turn.speaking.add(id);
    turn.spoke = true;
    setPhaseBoth('speaking');
    nativeRef.current?.speak(sentence, id);
  }, [setPhaseBoth]);

  const pump = useCallback(async () => {
    if (pumping.current) return;
    pumping.current = true;
    try {
      while (queue.current.length) {
        const turn = turnRef.current;
        if (!turn || turn.aborted) { queue.current = []; break; }
        const sentence = queue.current.shift()!;
        if (outputRef.current === 'system' || !ttsCreds.current) { speakSystem(sentence); continue; }
        const settings = settingsRef.current!;
        try {
          await streamSpeech({
            ...ttsCreds.current, model: settings.ttsModel, voice: settings.ttsVoice, input: sentence, signal: turn.abort.signal,
            instructions: '用自然、亲切、口语化的语气说话，语速适中。',
            onAudio: (base64) => {
              if (turn.aborted) return;
              if (!turn.spoke) { turn.spoke = true; setPhaseBoth('speaking'); }
              turn.awaitingPlayer = true;
              nativeRef.current?.playerWrite(base64);
            },
          });
        } catch (caught) {
          if (turn.aborted) break;
          // Keep talking with the phone's own voice instead of going silent.
          outputRef.current = 'system';
          setSyntheticVoice(true);
          setNotice(`云端语音合成不可用（${caught instanceof Error ? caught.message.slice(0, 40) : '未知错误'}），已改用手机系统语音`);
          speakSystem(sentence);
        }
      }
    } finally {
      pumping.current = false;
      finishIfDone();
    }
  }, [finishIfDone, setPhaseBoth, speakSystem]);

  /** Stop talking / thinking right now (tap or speak over it). A drawing keeps going. */
  const interrupt = useCallback(() => {
    const turn = turnRef.current;
    if (turn) { turn.aborted = true; turn.abort.abort(); }
    turnRef.current = null;
    queue.current = [];
    try { nativeRef.current?.playerStop(); } catch { /* not started */ }
    try { nativeRef.current?.stopSpeaking(); } catch { /* not started */ }
    if (realtime.current) {
      realtime.current.cancelResponse();
    } else if (appRef.current.busy && !turn?.imageJob) {
      appRef.current.stop();
    }
    outLevel.setValue(0);
    if (phaseRef.current === 'speaking' || phaseRef.current === 'thinking') setPhaseBoth('listening');
  }, [outLevel, setPhaseBoth]);

  const submit = useCallback(async (text: string) => {
    const clean = text.trim();
    utterance.current = '';
    if (!clean) { if (phaseRef.current !== 'speaking') setPhaseBoth('listening'); return; }
    const current = appRef.current;
    const lastReply = [...current.messages].reverse().find((message) => message.role === 'assistant');
    if (current.busy && lastReply?.preparedPrompt && lastReply.status === 'pending') {
      // One reply per conversation at a time; the drawing is still running.
      setUserText(clean);
      setNotice('图片还在生成，画好后就能继续聊');
      setPhaseBoth('listening');
      return;
    }
    // A new question replaces anything still in progress.
    const previous = turnRef.current;
    if (previous) { previous.aborted = true; previous.abort.abort(); }
    setUserText(clean);
    setAssistantText('');
    setPhaseBoth('thinking');
    const turn: Turn = {
      since: Date.now(), consumed: 0, final: false, aborted: false, abort: new AbortController(), spoke: false,
      imageJob: false, speaking: new Set(), awaitingPlayer: false, playerEnded: false,
    };
    turnRef.current = turn;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await appRef.current.send({ text: clean, voice: true });
        return;
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : '发送失败';
        // The interrupted reply may still be winding down for a moment.
        if (/请先等待/.test(message) && attempt < 7 && turnRef.current === turn) { await new Promise((resolve) => setTimeout(resolve, 250)); continue; }
        if (turnRef.current === turn) { turnRef.current = null; setNotice(message); setPhaseBoth('listening'); }
        return;
      }
    }
  }, [setPhaseBoth]);

  /** Cloud recognition: submit once every pending piece is back and the user is quiet. */
  const flushTranscripts = useCallback(() => {
    if (speechActive.current) return;
    if (transcripts.current.some((item) => item === null)) return;
    const text = transcripts.current.reduce<string>((joined, item) => joinText(joined, item ?? ''), '');
    transcripts.current = [];
    if (text.trim()) void submit(text); else if (phaseRef.current === 'thinking' && !turnRef.current) setPhaseBoth('listening');
  }, [setPhaseBoth, submit]);

  // Follow the streamed reply of the current cascade turn and speak it sentence by sentence.
  useEffect(() => {
    const turn = turnRef.current;
    if (!turn || engine !== 'cascade') return;
    const reply = [...app.messages].reverse().find((message) => message.role === 'assistant' && message.createdAt >= turn.since);
    if (!reply) return;
    const raw = reply.text ?? '';
    const imageJob = Boolean(reply.preparedPrompt);
    turn.imageJob = imageJob;
    const final = reply.status !== 'pending' || imageJob;
    setAssistantText(toSpeakable(raw) || (imageJob ? '正在为你画图…' : ''));
    if ((reply.status === 'error' || reply.status === 'interrupted') && !raw) setNotice(reply.error ?? '这次没有完成');
    const { sentences, next } = takeSentences(raw, turn.consumed, final, turn.consumed === 0);
    turn.consumed = next;
    if (final && imageJob && !turn.final) sentences.push('图片正在生成，完成后会出现在对话里。');
    if (sentences.length) { queue.current.push(...sentences); void pump(); }
    if (final && !turn.final) { turn.final = true; finishIfDone(); }
  }, [app.messages, engine, finishIfDone, pump]);

  const teardown = useCallback(() => {
    generation.current += 1;
    clearSubmit();
    offs.current.forEach((off) => off());
    offs.current = [];
    const turn = turnRef.current;
    if (turn) { turn.aborted = true; turn.abort.abort(); }
    turnRef.current = null;
    queue.current = [];
    transcripts.current = [];
    realtime.current?.close();
    realtime.current = null;
    const native = nativeRef.current;
    if (native) {
      try { native.cancelCapture(); } catch { /* idle */ }
      try { native.playerStop(); native.playerRelease(); } catch { /* idle */ }
      try { native.stopSpeaking(); } catch { /* idle */ }
      try { native.endConversationAudio(); } catch { /* idle */ }
    }
    if (appRef.current.busy && phaseRef.current === 'thinking' && !turn?.imageJob) appRef.current.stop();
    try { void Promise.resolve(deactivateKeepAwake(KEEP_AWAKE_TAG)).catch(() => undefined); } catch { /* not active */ }
    micLevel.setValue(0);
    outLevel.setValue(0);
  }, [micLevel, outLevel]);

  const startCascade = useCallback(async (native: VoiceNativeModule, settings: VoiceSettings, check: () => void, listen: (off: () => void) => void) => {
    const current = appRef.current;
    if (!current.chatProvider) throw new Error('语音对话需要一个对话模型，请先在设置中连接服务商');
    await refreshModels();
    check();
    const model = modelById(settings.localModel) ?? null;
    const local = Boolean(model && isInstalled(model.id) && localEngineAvailable());
    const sttProvider = resolveSpeechProvider(current.providers, settings.transcribeProviderId, current.chatProvider);
    if (!local && !sttProvider) throw new Error('需要语音识别：请在“设置 → 语音”下载本地模型，或添加 OpenAI 兼容的服务商');
    sttCreds.current = !local && sttProvider ? await speechCredentials(sttProvider) : null;
    const ttsProvider = settings.speechOutput === 'cloud' ? resolveSpeechProvider(current.providers, settings.ttsProviderId, current.chatProvider) : null;
    ttsCreds.current = ttsProvider ? await speechCredentials(ttsProvider) : null;
    check();
    outputRef.current = ttsCreds.current ? 'cloud' : 'system';
    setSyntheticVoice(outputRef.current === 'system');
    setEngine('cascade');
    setEngineLabel(`${prettyModel(current.chatProvider.chatModel)} · ${local ? '本地识别' : '云端识别'}`);

    listen(onVoiceEvent('onPlaybackLevel', ({ level }) => outLevel.setValue(level)));
    listen(onVoiceEvent('onPlaybackDone', ({ interrupted }) => {
      const turn = turnRef.current;
      if (interrupted || !turn) return;
      turn.awaitingPlayer = false;
      finishIfDone();
    }));
    listen(onVoiceEvent('onSpeakDone', ({ id }) => {
      const turn = turnRef.current;
      if (!turn) return;
      turn.speaking.delete(id);
      finishIfDone();
    }));
    listen(onVoiceEvent('onSpeech', ({ speaking }) => {
      speechActive.current = speaking;
      if (speaking) {
        // Speaking over the assistant interrupts it, like talking to a person.
        if (phaseRef.current === 'speaking' || phaseRef.current === 'thinking') interrupt();
        clearSubmit();
        setPhaseBoth('hearing');
      } else if (!local) {
        if (phaseRef.current === 'hearing') setPhaseBoth('thinking');
        flushTranscripts();
      }
    }));
    if (local && model) {
      listen(onVoiceEvent('onTranscript', ({ text, isFinal }) => {
        if (phaseRef.current === 'speaking' || (phaseRef.current === 'thinking' && turnRef.current)) return;
        clearSubmit();
        if (phaseRef.current !== 'hearing') setPhaseBoth('hearing');
        if (isFinal) {
          utterance.current = joinText(utterance.current, text);
          setUserText(utterance.current);
          submitTimer.current = setTimeout(() => { void submit(utterance.current); }, 450);
        } else {
          setUserText(joinText(utterance.current, text));
        }
      }));
      await native.prepareRecognizer(recognizerOptions(model, modelDirectory(model.id), 0.6));
      check();
    } else {
      listen(onVoiceEvent('onUtterance', ({ uri }) => {
        if (phaseRef.current === 'speaking') { native.deleteFile(uri); return; }
        const creds = sttCreds.current!;
        const slot = transcripts.current.length;
        transcripts.current.push(null);
        setPhaseBoth('thinking');
        void transcribeAudio({ ...creds, model: settings.transcribeModel, uri })
          .then((text) => { transcripts.current[slot] = text; })
          .catch((caught) => { transcripts.current[slot] = ''; setNotice(caught instanceof Error ? caught.message : '语音识别失败'); })
          .finally(() => { native.deleteFile(uri); flushTranscripts(); });
      }));
    }
    if (outputRef.current === 'cloud') native.playerStart(24000, true);
    await native.startCapture({ sampleRate: 16000, conversation: true, turnDetection: true, endSilenceMs: local ? 900 : 750, useRecognizer: local, utteranceWav: !local });
    check();
    setPhaseBoth('listening');
  }, [finishIfDone, flushTranscripts, interrupt, outLevel, setPhaseBoth, submit]);

  const startRealtime = useCallback(async (native: VoiceNativeModule, settings: VoiceSettings, check: () => void, listen: (off: () => void) => void) => {
    const current = appRef.current;
    const provider = resolveSpeechProvider(current.providers, settings.realtimeProviderId, current.chatProvider);
    if (!provider) throw new Error('实时语音需要 OpenAI 兼容且支持 Realtime 的服务商');
    const creds = await speechCredentials(provider);
    check();
    realtimeTurn.current = { user: '', assistant: '', acceptAudio: true };
    const saveTurn = (suffix = '') => {
      const { user, assistant } = realtimeTurn.current;
      realtimeTurn.current.user = '';
      realtimeTurn.current.assistant = '';
      if (user || assistant) void appRef.current.recordVoiceExchange(user, assistant ? `${assistant}${suffix}` : '').catch(() => undefined);
    };
    const session = new RealtimeSession({
      ...creds, model: settings.realtimeModel, voice: settings.realtimeVoice, transcribeModel: settings.transcribeModel,
      instructions: `你是 Salcara，用户手机上的 AI 助手。${VOICE_INSTRUCTIONS}${conversationContext(current.messages)}`,
    }, {
      onResponseStarted: () => { realtimeTurn.current.acceptAudio = true; },
      onAudio: (base64) => {
        // Audio still in flight from an answer the user talked over is dropped.
        if (!realtimeTurn.current.acceptAudio) return;
        if (phaseRef.current !== 'speaking') setPhaseBoth('speaking');
        native.playerWrite(base64);
      },
      onSpeechStarted: () => {
        realtimeTurn.current.acceptAudio = false;
        native.playerStop();
        outLevel.setValue(0);
        // Keep what was said before the interruption in the conversation.
        if (realtimeTurn.current.assistant) saveTurn('……');
        setAssistantText('');
        setPhaseBoth('hearing');
      },
      onSpeechStopped: () => setPhaseBoth('thinking'),
      onUserText: (text) => { realtimeTurn.current.user = text; setUserText(text); },
      onAssistantText: (delta) => {
        if (!realtimeTurn.current.acceptAudio) return;
        realtimeTurn.current.assistant += delta;
        setAssistantText(realtimeTurn.current.assistant);
      },
      onResponseDone: () => {
        native.playerEnd();
        if (realtimeTurn.current.acceptAudio) saveTurn();
        if (phaseRef.current === 'thinking') setPhaseBoth('listening');
      },
      onError: (message) => setNotice(message),
      onClose: (reason) => { setError(`实时语音连接已断开：${reason}`); setPhaseBoth('error'); },
    });
    try {
      await session.connect();
      check();
    } catch (caught) {
      session.close();
      throw caught;
    }
    realtime.current = session;
    setEngine('realtime');
    setEngineLabel(`实时语音 · ${prettyModel(settings.realtimeModel)}`);
    setSyntheticVoice(false);
    listen(onVoiceEvent('onPcm', ({ data }) => session.sendAudio(data)));
    listen(onVoiceEvent('onPlaybackLevel', ({ level }) => outLevel.setValue(level)));
    listen(onVoiceEvent('onPlaybackDone', ({ interrupted }) => {
      if (!interrupted && phaseRef.current === 'speaking') setPhaseBoth('listening');
    }));
    native.playerStart(24000, true);
    await native.startCapture({ sampleRate: 24000, emitPcm: true, conversation: true, chunkMs: 40 });
    check();
    setPhaseBoth('listening');
  }, [outLevel, setPhaseBoth]);

  const start = useCallback(async () => {
    const mine = generation.current;
    const check = () => { if (generation.current !== mine) throw new Superseded('closed'); };
    const own: Array<() => void> = [];
    const listen = (off: () => void) => { own.push(off); offs.current.push(off); };
    setPhaseBoth('connecting');
    setError(null); setNotice(null); setUserText(''); setAssistantText(''); setMuted(false);
    try {
      const native = requireVoiceNative();
      nativeRef.current = native;
      await ensureMicPermission();
      check();
      const settings = await loadVoiceSettings();
      check();
      settingsRef.current = settings;
      // Android pauses the microphone of apps whose screen went off.
      void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => undefined);
      listen(onVoiceEvent('onLevel', ({ level }) => micLevel.setValue(level)));
      listen(onVoiceEvent('onCaptureError', ({ message }) => setNotice(message)));
      const wantsRealtime = settings.conversationEngine === 'realtime' || (settings.conversationEngine === 'auto' && Boolean(settings.realtimeProviderId));
      if (wantsRealtime) {
        try {
          await startRealtime(native, settings, check, listen);
          return;
        } catch (caught) {
          if (caught instanceof Superseded || settings.conversationEngine === 'realtime') throw caught;
          realtime.current?.close();
          realtime.current = null;
          setNotice(`实时语音不可用（${caught instanceof Error ? caught.message : '连接失败'}），已改用分段语音`);
        }
      }
      check();
      await startCascade(native, settings, check, listen);
    } catch (caught) {
      // A closed session undoes whatever its late steps managed to start.
      if (caught instanceof Superseded || generation.current !== mine) {
        // Only this start's own listeners; a newer session may already be running.
        own.forEach((off) => off());
        return;
      }
      setError(caught instanceof Error ? caught.message : '无法开始语音对话');
      setPhaseBoth('error');
    }
  }, [micLevel, setPhaseBoth, startCascade, startRealtime, teardown]);

  // Wait for providers to load (e.g. Live opened right after a cold start).
  const ready = app.ready;
  useEffect(() => {
    if (!active || !ready) return undefined;
    void start();
    return () => teardown();
  }, [active, ready, start, teardown]);

  const toggleMute = useCallback(() => {
    setMuted((value) => {
      const next = !value;
      try { nativeRef.current?.setMuted(next); } catch { /* idle */ }
      if (next) micLevel.setValue(0);
      return next;
    });
  }, [micLevel]);

  const retry = useCallback(() => { teardown(); void start(); }, [start, teardown]);

  return { phase, engine, engineLabel, userText, assistantText, notice, error, muted, syntheticVoice, micLevel, outLevel, interrupt, toggleMute, retry, dismissNotice: () => setNotice(null) };
}
