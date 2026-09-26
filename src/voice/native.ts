import { requireOptionalNativeModule } from 'expo';

export interface NativeRecognizerOptions {
  kind: string; encoder: string; decoder: string; joiner: string; model: string; tokens: string; vad: string;
  numThreads: number; endSilence: number;
}

export interface NativeCaptureOptions {
  sampleRate?: number;
  chunkMs?: number;
  emitPcm?: boolean;
  useRecognizer?: boolean;
  turnDetection?: boolean;
  endSilenceMs?: number;
  utteranceWav?: boolean;
  sessionWav?: boolean;
  conversation?: boolean;
}

export interface VoiceEvents {
  onLevel: { level: number };
  onPcm: { data: string };
  onTranscript: { text: string; isFinal: boolean };
  onSpeech: { speaking: boolean };
  onUtterance: { uri: string; durationMs: number };
  onCaptureError: { message: string };
  onPlaybackLevel: { level: number };
  onPlaybackDone: { interrupted: boolean };
  onSpeakDone: { id: string };
}

interface Subscription { remove(): void }

export interface VoiceNativeModule {
  engineAvailable(): boolean;
  prepareRecognizer(options: NativeRecognizerOptions): Promise<boolean>;
  releaseRecognizer(): void;
  startCapture(options: NativeCaptureOptions): Promise<boolean>;
  stopCapture(): Promise<{ uri: string | null }>;
  cancelCapture(): void;
  setMuted(muted: boolean): void;
  playerStart(sampleRate: number, communication: boolean): void;
  playerWrite(base64: string): void;
  playerEnd(): void;
  playerStop(): void;
  playerRelease(): void;
  speak(text: string, id: string): void;
  stopSpeaking(): void;
  endConversationAudio(): void;
  deleteFile(uri: string): boolean;
  addListener<K extends keyof VoiceEvents>(event: K, listener: (payload: VoiceEvents[K]) => void): Subscription;
}

let override: VoiceNativeModule | null | undefined;

/** Test / preview hook. */
export function setVoiceNativeForTesting(module: VoiceNativeModule | null | undefined): void { override = module; }

/** The native voice module, or null (Expo Go, web preview, tests, outdated APK). */
export function voiceNative(): VoiceNativeModule | null {
  if (override !== undefined) return override;
  try {
    return requireOptionalNativeModule('SalcaraVoice') as VoiceNativeModule | null;
  } catch {
    return null;
  }
}

export function requireVoiceNative(): VoiceNativeModule {
  const native = voiceNative();
  if (!native) throw new Error('当前安装包缺少语音组件，请安装最新完整 APK');
  return native;
}

/** Subscribes to a native voice event; returns an unsubscribe function. */
export function onVoiceEvent<K extends keyof VoiceEvents>(event: K, listener: (payload: VoiceEvents[K]) => void): () => void {
  const native = voiceNative();
  if (!native) return () => undefined;
  const subscription = native.addListener(event, listener);
  return () => subscription.remove();
}

/** Whether on-device recognition can run on this phone (64-bit ARM build with the engine). */
export function localEngineAvailable(): boolean {
  try { return Boolean(voiceNative()?.engineAvailable()); } catch { return false; }
}
