import { useSyncExternalStore } from 'react';

import { getSetting, setSetting } from '../storage/database';
import type { AsrModelId, DownloadMirror } from './catalog';

export type InputEngine = 'local' | 'cloud';
export type ConversationEngine = 'auto' | 'cascade' | 'realtime';
export type SpeechOutput = 'cloud' | 'system';

export interface VoiceSettings {
  /** Voice typing in the composer. */
  inputEngine: InputEngine;
  localModel: AsrModelId | null;
  /** OpenAI-compatible provider used for cloud transcription (null = the chat provider). */
  transcribeProviderId: string | null;
  transcribeModel: string;
  mirror: DownloadMirror;
  /** Conversation mode. */
  conversationEngine: ConversationEngine;
  realtimeProviderId: string | null;
  realtimeModel: string;
  realtimeVoice: string;
  speechOutput: SpeechOutput;
  ttsProviderId: string | null;
  ttsModel: string;
  ttsVoice: string;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  inputEngine: 'cloud',
  localModel: null,
  transcribeProviderId: null,
  transcribeModel: 'gpt-4o-mini-transcribe',
  mirror: 'hf-mirror',
  conversationEngine: 'auto',
  realtimeProviderId: null,
  realtimeModel: 'gpt-realtime-2.1',
  realtimeVoice: 'marin',
  speechOutput: 'cloud',
  ttsProviderId: null,
  ttsModel: 'gpt-4o-mini-tts',
  ttsVoice: 'marin',
};

export const VOICES: Array<{ id: string; label: string }> = [
  { id: 'marin', label: 'Marin · 温柔自然' },
  { id: 'cedar', label: 'Cedar · 沉稳低音' },
  { id: 'coral', label: 'Coral · 明亮活泼' },
  { id: 'sage', label: 'Sage · 平和知性' },
  { id: 'verse', label: 'Verse · 富有表现力' },
  { id: 'alloy', label: 'Alloy · 中性清晰' },
];

const KEY = 'voice_settings';
let current: VoiceSettings = DEFAULT_VOICE_SETTINGS;
let loaded = false;
const listeners = new Set<() => void>();

/** Merges stored JSON with defaults; unknown or invalid values fall back safely. */
export function parseVoiceSettings(raw: string | null): VoiceSettings {
  if (!raw) return DEFAULT_VOICE_SETTINGS;
  try {
    const value = JSON.parse(raw) as Partial<VoiceSettings>;
    const pick = <K extends keyof VoiceSettings>(key: K, allowed?: readonly VoiceSettings[K][]): VoiceSettings[K] => {
      const candidate = value[key];
      if (candidate === undefined) return DEFAULT_VOICE_SETTINGS[key];
      if (allowed && !allowed.includes(candidate as VoiceSettings[K])) return DEFAULT_VOICE_SETTINGS[key];
      if (typeof candidate === 'string' && typeof DEFAULT_VOICE_SETTINGS[key] === 'string' && !candidate.trim()) return DEFAULT_VOICE_SETTINGS[key];
      return candidate as VoiceSettings[K];
    };
    return {
      inputEngine: pick('inputEngine', ['local', 'cloud']),
      localModel: pick('localModel', ['zipformer-bilingual', 'paraformer-bilingual', 'sensevoice', null]),
      transcribeProviderId: pick('transcribeProviderId'),
      transcribeModel: pick('transcribeModel'),
      mirror: pick('mirror', ['huggingface', 'hf-mirror']),
      conversationEngine: pick('conversationEngine', ['auto', 'cascade', 'realtime']),
      realtimeProviderId: pick('realtimeProviderId'),
      realtimeModel: pick('realtimeModel'),
      realtimeVoice: pick('realtimeVoice'),
      speechOutput: pick('speechOutput', ['cloud', 'system']),
      ttsProviderId: pick('ttsProviderId'),
      ttsModel: pick('ttsModel'),
      ttsVoice: pick('ttsVoice'),
    };
  } catch {
    return DEFAULT_VOICE_SETTINGS;
  }
}

export async function loadVoiceSettings(): Promise<VoiceSettings> {
  if (!loaded) {
    current = parseVoiceSettings(await getSetting(KEY));
    loaded = true;
    listeners.forEach((listener) => listener());
  }
  return current;
}

export async function updateVoiceSettings(patch: Partial<VoiceSettings>): Promise<VoiceSettings> {
  current = { ...current, ...patch };
  loaded = true;
  listeners.forEach((listener) => listener());
  await setSetting(KEY, JSON.stringify(current));
  return current;
}

export function voiceSettings(): VoiceSettings { return current; }

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!loaded) void loadVoiceSettings().catch(() => undefined);
  return () => { listeners.delete(listener); };
}

export function useVoiceSettings(): VoiceSettings {
  return useSyncExternalStore(subscribe, voiceSettings, voiceSettings);
}

/** Test hook. */
export function resetVoiceSettingsForTesting(): void { current = DEFAULT_VOICE_SETTINGS; loaded = false; }
