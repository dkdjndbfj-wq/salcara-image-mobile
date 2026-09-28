import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated } from 'react-native';

import { VOICE_INSTRUCTIONS } from '../api/chat-api';
import { personaPrompt } from '../memorybox/context';
import { loadMemoryBoxSettings } from '../memorybox/settings';
import { characterById } from '../memorybox/store';
import type { ChatMessage } from '../domain';
import { useApp } from '../state/AppContext';
import { prettyModel } from '../theme';
import { modelById, recognizerOptions } from './catalog';
import { ensureMicPermission, joinText } from './useDictation';
import { isInstalled, modelDirectory, refreshModels } from './models';
import { localEngineAvailable, onVoiceEvent, requireVoiceNative, type VoiceNativeModule } from './native';
import { missingTargetMessage, openRealtime, resolveTarget, synthesize, transcribe, type SpeechTarget } from './engines';
import { VoiceExchanges } from './exchanges';
import { levelSetter } from './levels';
import type { LiveSession } from './realtime';
import { isServiceRef } from './services';
import { loadVoiceSettings, type VoiceSettings } from './settings';
import { takeSentences, toSpeakable } from './speech-text';

export type LivePhase = 'connecting' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'error';
export type LiveEngine = 'cascade' | 'realtime';

const KEEP_AWAKE_TAG = 'salcara-live';
/** A cloud recognition or one synthesized sentence that takes longer than this is given up. */
const TRANSCRIBE_TIMEOUT_MS = 20_000;
const SYNTHESIZE_TIMEOUT_MS = 30_000;

/** Server / socket failures in words a user can act on. */
export function realtimeErrorText(message: string): string {
  if (/\b401\b|unauthori[sz]ed|invalid.{0,12}(api.?key|token)|authentication/i.test(message)) return 'API 密钥无效或没有实时语音权限';
  if (/\b403\b|forbidden|permission/i.test(message)) return '这个密钥没有使用该实时模型的权限';
  if (/\b404\b|not.?found|does not exist|model_not_found/i.test(message)) return '找不到这个实时语音模型，请检查模型名称';
  if (/\b429\b|rate.?limit|quota|insufficient/i.test(message)) return '请求太频繁或额度不足，请稍后再试';
  return message || '连接出错';
}

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
  /** Cloud synthesis failed once: the rest of this answer is text only, with a single notice. */
  ttsFailed: boolean;
}

/** Thrown when a session was closed while it was still starting. */
class Superseded extends Error {}

/** Recent text of the open conversation, so a realtime session continues where the chat is. */
/** Chat space: the realtime model speaks as the character and keeps its core memory in mind. */
async function realtimePersona(characterId: string | null): Promise<string> {
  const character = characterById(characterId);
  if (!character) return '你是 Salcara，用户手机上的 AI 助手。';
  // Core memory only when the memory box is on for this character.
  const box = await loadMemoryBoxSettings().catch(() => null);
  const memoryOn = Boolean(box?.enabled) && character.memoryMode !== 'off';
  const core = memoryOn ? character.coreMemory.trim() : '';
  return `${personaPrompt(character)}\n${core ? `你一直记得：${core.slice(0, 1200)}\n` : ''}`;
}

function conversationContext(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const message of messages.slice(-8)) {
    const text = (message.role === 'user' ? message.prompt : message.text ?? '').trim();
    if (text) lines.push(`${message.role === 'user' ? '用户' : '你'}：${text.slice(0, 300)}`);
  }
  const joined = lines.join('\n');
  return joined ? `\n\n此前的对话（供参考）：\n${joined.slice(-1800)}` : '';
}

const CAPTION_INTERVAL_MS = 100;

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
  const setMic = useMemo(() => levelSetter(micLevel), [micLevel]);
  const setOut = useMemo(() => levelSetter(outLevel), [outLevel]);
  const captionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCaption = useRef<string | null>(null);
  /** Streamed captions render at most ~10 times a second; `now` (clears, new turns) applies at once. */
  const showAssistant = useCallback((text: string, now = false) => {
    if (now) {
      pendingCaption.current = null;
      if (captionTimer.current) clearTimeout(captionTimer.current);
      captionTimer.current = null;
      setAssistantText(text);
      return;
    }
    if (captionTimer.current) { pendingCaption.current = text; return; }
    setAssistantText(text);
    const tick = () => {
      if (pendingCaption.current === null) { captionTimer.current = null; return; }
      setAssistantText(pendingCaption.current);
      pendingCaption.current = null;
      captionTimer.current = setTimeout(tick, CAPTION_INTERVAL_MS);
    };
    captionTimer.current = setTimeout(tick, CAPTION_INTERVAL_MS);
  }, []);

  const phaseRef = useRef<LivePhase>('connecting');
  const setPhaseBoth = useCallback((next: LivePhase) => { phaseRef.current = next; setPhase(next); }, []);
  const offs = useRef<Array<() => void>>([]);
  const nativeRef = useRef<VoiceNativeModule | null>(null);
  const settingsRef = useRef<VoiceSettings | null>(null);
  const turnRef = useRef<Turn | null>(null);
  const queue = useRef<string[]>([]);
  const pumping = useRef(false);
  const outputRef = useRef<'cloud' | 'system'>('cloud');
  const ttsTarget = useRef<SpeechTarget | null>(null);
  const sttTarget = useRef<SpeechTarget | null>(null);
  const utterance = useRef('');
  const submitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const realtime = useRef<LiveSession | null>(null);
  const realtimeTurn = useRef({ user: '', assistant: '', acceptAudio: true });
  const exchanges = useRef<VoiceExchanges | null>(null);
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
        if (turn.ttsFailed) { queue.current = []; break; }
        const sentence = queue.current.shift()!;
        if (outputRef.current === 'system' || !ttsTarget.current) { speakSystem(sentence); continue; }
        const controller = new AbortController();
        const cancel = () => controller.abort();
        turn.abort.signal.addEventListener('abort', cancel);
        const timer = setTimeout(cancel, SYNTHESIZE_TIMEOUT_MS);
        try {
          await synthesize(ttsTarget.current, {
            text: sentence, signal: controller.signal,
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
          // The chosen synthesis API failed: say why once and keep the rest of the answer as text on screen.
          turn.ttsFailed = true;
          setNotice(controller.signal.aborted ? '语音合成超时，这次回答只显示文字' : `语音合成失败：${caught instanceof Error ? caught.message.slice(0, 80) : '未知错误'}`);
          queue.current = [];
          break;
        } finally {
          clearTimeout(timer);
          turn.abort.signal.removeEventListener('abort', cancel);
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
      // Audio of the cancelled answer can still be in flight; drop it until the next answer starts.
      realtimeTurn.current.acceptAudio = false;
      realtime.current.cancelResponse();
    } else if (appRef.current.busy && !turn?.imageJob) {
      appRef.current.stop();
    }
    setOut(0);
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
    showAssistant('', true);
    setPhaseBoth('thinking');
    const turn: Turn = {
      since: Date.now(), consumed: 0, final: false, aborted: false, abort: new AbortController(), spoke: false,
      imageJob: false, speaking: new Set(), awaitingPlayer: false, playerEnded: false, ttsFailed: false,
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
    showAssistant(toSpeakable(raw) || (imageJob ? '正在为你画图…' : ''));
    if ((reply.status === 'error' || reply.status === 'interrupted') && !raw) setNotice(reply.error ?? '这次没有完成');
    const { sentences, next } = takeSentences(raw, turn.consumed, final, turn.consumed === 0);
    turn.consumed = next;
    if (final && imageJob && !turn.final) sentences.push('图片正在生成，完成后会出现在对话里。');
    if (sentences.length && !turn.ttsFailed) { queue.current.push(...sentences); void pump(); }
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
    exchanges.current?.close();
    exchanges.current = null;
    if (captionTimer.current) clearTimeout(captionTimer.current);
    captionTimer.current = null;
    pendingCaption.current = null;
    const native = nativeRef.current;
    if (native) {
      try { native.cancelCapture(); } catch { /* idle */ }
      try { native.playerStop(); native.playerRelease(); } catch { /* idle */ }
      try { native.stopSpeaking(); } catch { /* idle */ }
      try { native.endConversationAudio(); } catch { /* idle */ }
    }
    if (appRef.current.busy && phaseRef.current === 'thinking' && !turn?.imageJob) appRef.current.stop();
    try { void Promise.resolve(deactivateKeepAwake(KEEP_AWAKE_TAG)).catch(() => undefined); } catch { /* not active */ }
    setMic(0);
    setOut(0);
  }, [micLevel, outLevel]);

  const startCascade = useCallback(async (native: VoiceNativeModule, settings: VoiceSettings, check: () => void, listen: (off: () => void) => void) => {
    const current = appRef.current;
    if (!current.chatProvider) throw new Error('语音对话需要一个对话模型，请先在设置中连接服务商');
    await refreshModels();
    check();
    const model = modelById(settings.localModel) ?? null;
    // Same choice as voice typing: the on-device model only when “本地模型” is picked and ready.
    const wantsLocal = settings.inputEngine === 'local';
    const local = Boolean(wantsLocal && model && isInstalled(model.id) && localEngineAvailable());
    sttTarget.current = local ? null : await resolveTarget('stt', settings.transcribeProviderId, settings.transcribeModel, '', current.providers, current.chatProvider);
    if (!local && !sttTarget.current) {
      throw new Error(wantsLocal
        ? `${localEngineAvailable() ? '本地识别模型还没有下载' : '这台手机不支持本地识别模型'}：请在“设置 → 语音”中${localEngineAvailable() ? '下载模型，或' : ''}为「语音识别」选择一个云端服务`
        : missingTargetMessage('stt'));
    }
    if (wantsLocal && !local) setNotice(`本地识别不可用，已改用 ${sttTarget.current!.label} 云端识别`);
    ttsTarget.current = settings.speechOutput === 'cloud' ? await resolveTarget('tts', settings.ttsProviderId, settings.ttsModel, settings.ttsVoice, current.providers, current.chatProvider) : null;
    if (settings.speechOutput === 'cloud' && !ttsTarget.current) throw new Error(`${missingTargetMessage('tts')}，或改用手机系统语音`);
    check();
    outputRef.current = ttsTarget.current ? 'cloud' : 'system';
    setSyntheticVoice(outputRef.current === 'system');
    setEngine('cascade');
    setEngineLabel([prettyModel(current.chatProvider.chatModel), local ? '本地识别' : sttTarget.current?.label, ttsTarget.current ? ttsTarget.current.label : '系统语音']
      .filter((item, index, list) => item && list.indexOf(item) === index).join(' · '));

    listen(onVoiceEvent('onPlaybackLevel', ({ level }) => setOut(level)));
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
        const target = sttTarget.current!;
        const slot = transcripts.current.length;
        transcripts.current.push(null);
        setPhaseBoth('thinking');
        const mine = generation.current;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
        void transcribe(target, { uri, language: settings.transcribeLanguage, signal: controller.signal })
          .then((text) => { if (generation.current === mine) transcripts.current[slot] = text; })
          .catch((caught) => {
            if (generation.current !== mine) return;
            transcripts.current[slot] = '';
            setNotice(controller.signal.aborted ? '语音识别超时，请再说一次' : caught instanceof Error ? caught.message : '语音识别失败');
          })
          .finally(() => {
            clearTimeout(timer);
            native.deleteFile(uri);
            // A closed session's late result must not submit into a new one.
            if (generation.current === mine) flushTranscripts();
          });
      }));
    }
    if (outputRef.current === 'cloud') native.playerStart(24000, true);
    await native.startCapture({ sampleRate: 16000, conversation: true, turnDetection: true, endSilenceMs: local ? 900 : 750, useRecognizer: local, utteranceWav: !local });
    check();
    setPhaseBoth('listening');
  }, [finishIfDone, flushTranscripts, interrupt, outLevel, setPhaseBoth, submit]);

  const startRealtime = useCallback(async (native: VoiceNativeModule, settings: VoiceSettings, check: () => void, listen: (off: () => void) => void) => {
    const current = appRef.current;
    const target = await resolveTarget('realtime', settings.realtimeProviderId, settings.realtimeModel, settings.realtimeVoice, current.providers, current.chatProvider);
    if (!target) throw new Error(missingTargetMessage('realtime'));
    check();
    realtimeTurn.current = { user: '', assistant: '', acceptAudio: true };
    const log = new VoiceExchanges((user, assistant) => { void appRef.current.recordVoiceExchange(user, assistant).catch(() => undefined); });
    exchanges.current = log;
    const instructions = `${await realtimePersona(current.activeCharacterId)}${VOICE_INSTRUCTIONS}${conversationContext(current.messages)}`;
    // The realtime API can only use its own transcription models: pass one only when recognition is set to the same service.
    const sameService = settings.transcribeProviderId === settings.realtimeProviderId || (!settings.transcribeProviderId && !isServiceRef(settings.realtimeProviderId));
    const transcribeModel = sameService && /transcribe|whisper|asr/i.test(settings.transcribeModel) ? settings.transcribeModel : undefined;
    const { session, inputRate } = openRealtime(target, instructions, transcribeModel, {
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
        setOut(0);
        // Keep what was said before the interruption in the conversation.
        log.interrupted();
        realtimeTurn.current.assistant = '';
        showAssistant('', true);
        setPhaseBoth('hearing');
      },
      onSpeechStopped: () => setPhaseBoth('thinking'),
      onUserTurn: (itemId) => log.userTurn(itemId),
      onUserText: (text, meta) => { if (log.userText(text, meta) && text) setUserText(text); },
      onAssistantText: (delta) => {
        if (!realtimeTurn.current.acceptAudio) return;
        log.assistantText(delta);
        realtimeTurn.current.assistant += delta;
        showAssistant(realtimeTurn.current.assistant);
      },
      onResponseDone: () => {
        native.playerEnd();
        if (realtimeTurn.current.acceptAudio) { log.responseDone(); realtimeTurn.current.assistant = ''; }
        if (phaseRef.current === 'thinking') setPhaseBoth('listening');
      },
      onError: (message) => {
        setNotice(realtimeErrorText(message));
        // A failed answer must not leave the screen stuck on “thinking”.
        if (phaseRef.current === 'thinking') setPhaseBoth('listening');
      },
      onClose: (reason) => {
        // Nothing to talk to any more: release the microphone, the player and the screen lock.
        try { native.cancelCapture(); } catch { /* idle */ }
        try { native.playerStop(); } catch { /* idle */ }
        try { void Promise.resolve(deactivateKeepAwake(KEEP_AWAKE_TAG)).catch(() => undefined); } catch { /* not active */ }
        realtime.current = null;
        log.close();
        setError(`实时语音连接已断开：${realtimeErrorText(reason)}`);
        setPhaseBoth('error');
      },
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
    setEngineLabel(`实时语音 · ${target.label} · ${prettyModel(target.model)}`);
    setSyntheticVoice(false);
    listen(onVoiceEvent('onPcm', ({ data }) => session.sendAudio(data)));
    listen(onVoiceEvent('onPlaybackLevel', ({ level }) => setOut(level)));
    listen(onVoiceEvent('onPlaybackDone', ({ interrupted }) => {
      if (!interrupted && phaseRef.current === 'speaking') setPhaseBoth('listening');
    }));
    native.playerStart(24000, true);
    await native.startCapture({ sampleRate: inputRate, emitPcm: true, conversation: true, chunkMs: 40 });
    check();
    setPhaseBoth('listening');
  }, [outLevel, setPhaseBoth]);

  const start = useCallback(async () => {
    const mine = generation.current;
    const check = () => { if (generation.current !== mine) throw new Superseded('closed'); };
    const own: Array<() => void> = [];
    const listen = (off: () => void) => { own.push(off); offs.current.push(off); };
    setPhaseBoth('connecting');
    setError(null); setNotice(null); setUserText(''); showAssistant('', true); setMuted(false);
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
      listen(onVoiceEvent('onLevel', ({ level }) => setMic(level)));
      listen(onVoiceEvent('onCaptureError', ({ message }) => {
        // The microphone stopped: say so instead of pretending to listen.
        setError(message || '麦克风已停止工作');
        setPhaseBoth('error');
      }));
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
      if (next) setMic(0);
      return next;
    });
  }, [micLevel]);

  const retry = useCallback(() => { teardown(); void start(); }, [start, teardown]);

  return { phase, engine, engineLabel, userText, assistantText, notice, error, muted, syntheticVoice, micLevel, outLevel, interrupt, toggleMute, retry, dismissNotice: () => setNotice(null) };
}
