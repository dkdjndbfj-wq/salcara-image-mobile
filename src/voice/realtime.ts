import { normalizeBaseUrl } from '../domain-utils';
import { utf8 } from './pcm';

/** wss://…/v1/realtime?model=… derived from the provider's HTTPS base URL. */
export function realtimeUrl(baseUrl: string, model: string): string {
  // normalizeBaseUrl only accepts HTTPS, so the socket is always TLS.
  const base = normalizeBaseUrl(baseUrl).replace(/^https:\/\//i, 'wss://');
  return `${base}/realtime?model=${encodeURIComponent(model.trim())}`;
}

export interface RealtimeConfig {
  baseUrl: string; apiKey: string; model: string; voice: string;
  instructions: string;
  transcribeModel?: string;
  /** Session dialect: OpenAI GA (default), the older OpenAI beta shape (阶跃…), or Qwen-Omni. */
  protocol?: 'openai' | 'openai-beta' | 'qwen';
  /** Full WebSocket URL when it is not `{base}/realtime?model=…`. */
  url?: string;
  headers?: Record<string, string>;
}

/** Microphone sample rate each dialect expects. */
export function realtimeInputRate(config: Pick<RealtimeConfig, 'protocol'>): number {
  return config.protocol === 'qwen' ? 16000 : 24000;
}

/** Session configuration in the vendor's dialect. */
export function sessionUpdate(config: RealtimeConfig) {
  if (config.protocol === 'openai-beta') {
    return {
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'], instructions: config.instructions, voice: config.voice,
        input_audio_format: 'pcm16', output_audio_format: 'pcm16',
        input_audio_transcription: config.transcribeModel ? { model: config.transcribeModel } : undefined,
        turn_detection: { type: 'server_vad', silence_duration_ms: 700 },
      },
    };
  }
  if (config.protocol === 'qwen') {
    return {
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'], instructions: config.instructions, voice: config.voice,
        audio: { input: { format: { type: 'pcm', sample_rate: 16000 } }, output: { format: { type: 'pcm', sample_rate: 24000 } } },
        // Without it Qwen-Omni never reports what the user said, so turns would save without the question.
        input_audio_transcription: { model: config.transcribeModel?.trim() || 'gummy-realtime-v1' },
        turn_detection: { type: 'server_vad', silence_duration_ms: 800 },
      },
    };
  }
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      model: config.model.trim(),
      instructions: config.instructions,
      output_modalities: ['audio'],
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          turn_detection: { type: 'semantic_vad', create_response: true, interrupt_response: true },
          transcription: { model: config.transcribeModel?.trim() || 'gpt-4o-mini-transcribe' },
          noise_reduction: { type: 'far_field' },
        },
        output: { format: { type: 'audio/pcm', rate: 24000 }, voice: config.voice },
      },
    },
  };
}

export interface RealtimeHandlers {
  onReady?: () => void;
  onResponseStarted?: () => void;
  onAudio?: (base64: string) => void;
  onAssistantText?: (delta: string) => void;
  onAssistantTextDone?: (text: string) => void;
  /**
   * What the user said. `itemId` ties a late transcript to its turn; `final` marks the finished
   * transcript (possibly empty, e.g. transcription failed) so the turn can be saved.
   */
  onUserText?: (text: string, meta?: { itemId?: string; final?: boolean }) => void;
  /** The server committed a user turn (VAD end of speech); transcripts and answers follow. */
  onUserTurn?: (itemId: string) => void;
  onSpeechStarted?: () => void;
  onSpeechStopped?: () => void;
  onResponseDone?: () => void;
  onError?: (message: string) => void;
  onClose?: (reason: string) => void;
}

type Event = Record<string, unknown> & { type?: string };

/** Maps one server event to handlers. Accepts GA and beta event names. */
export function handleRealtimeEvent(event: Event, handlers: RealtimeHandlers): void {
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  switch (event.type) {
    case 'session.created':
    case 'session.updated':
      handlers.onReady?.();
      break;
    case 'response.created':
      handlers.onResponseStarted?.();
      break;
    case 'response.output_audio.delta':
    case 'response.audio.delta':
      if (text(event.delta)) handlers.onAudio?.(text(event.delta));
      break;
    case 'response.output_audio_transcript.delta':
    case 'response.audio_transcript.delta':
    case 'response.output_text.delta':
      if (text(event.delta)) handlers.onAssistantText?.(text(event.delta));
      break;
    case 'response.output_audio_transcript.done':
    case 'response.audio_transcript.done':
      handlers.onAssistantTextDone?.(text(event.transcript));
      break;
    case 'input_audio_buffer.committed':
      if (text(event.item_id)) handlers.onUserTurn?.(text(event.item_id));
      break;
    // GA/beta and DashScope/StepFun variants of the user transcript.
    case 'conversation.item.input_audio_transcription.completed':
    case 'conversation.item.input_audio_transcription.failed':
      handlers.onUserText?.((text(event.transcript) || text(event.text)).trim(), { itemId: text(event.item_id) || undefined, final: true });
      break;
    case 'conversation.item.input_audio_transcription.text': {
      // DashScope streams the settled part as `text` and the unsettled rest as `stash`.
      const partial = `${text(event.text)}${text(event.stash)}`.trim();
      if (partial) handlers.onUserText?.(partial, { itemId: text(event.item_id) || undefined, final: false });
      break;
    }
    case 'conversation.item.created':
    case 'conversation.item.done': {
      // Some beta servers only put the transcript on the user item itself.
      const item = (event.item ?? {}) as { id?: unknown; role?: unknown; content?: Array<{ transcript?: unknown }> };
      const said = item.role === 'user' ? (item.content ?? []).map((part) => text(part?.transcript)).join('').trim() : '';
      if (said) handlers.onUserText?.(said, { itemId: text(item.id) || undefined, final: true });
      break;
    }
    case 'input_audio_buffer.speech_started':
      handlers.onSpeechStarted?.();
      break;
    case 'input_audio_buffer.speech_stopped':
      handlers.onSpeechStopped?.();
      break;
    case 'response.done':
      handlers.onResponseDone?.();
      break;
    case 'error': {
      const error = (event.error ?? {}) as { message?: unknown; code?: unknown };
      // Cancelling when nothing is playing is harmless.
      if (error.code === 'response_cancel_not_active') break;
      handlers.onError?.(text(error.message) || '实时语音服务返回错误');
      break;
    }
    default:
      break;
  }
}

type SocketLike = {
  readyState: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
};
type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike;

const defaultFactory: SocketFactory = (url, headers) => {
  // React Native's WebSocket accepts headers as a third argument.
  const Socket = WebSocket as unknown as new (url: string, protocols: string[] | undefined, options: { headers: Record<string, string> }) => SocketLike;
  return new Socket(url, undefined, { headers });
};

/** One live speech-to-speech session over WebSocket. */
export class RealtimeSession implements LiveSession {
  private socket: SocketLike | null = null;
  private closedByUs = false;

  constructor(private config: RealtimeConfig, private handlers: RealtimeHandlers, private factory: SocketFactory = defaultFactory) {}

  /** Resolves once the server accepted the session configuration. */
  connect(timeoutMs = 12000): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          // A rejected session must not leave its socket open.
          this.closedByUs = true;
          try { this.socket?.close(1000, 'rejected'); } catch { /* already closed */ }
          reject(error);
        } else resolve();
      };
      const timer = setTimeout(() => { finish(new Error('连接实时语音服务超时')); this.close(); }, timeoutMs);
      const socket = this.factory(this.config.url ?? realtimeUrl(this.config.baseUrl, this.config.model), this.config.headers ?? { Authorization: `Bearer ${this.config.apiKey.trim()}` });
      this.socket = socket;
      let configured = false;
      socket.onopen = () => {
        socket.send(JSON.stringify(sessionUpdate(this.config)));
      };
      socket.onmessage = (message) => {
        let event: Event;
        try { event = JSON.parse(String(message.data)) as Event; } catch { return; }
        if (!settled && event.type === 'error') {
          const detail = ((event.error ?? {}) as { message?: string }).message;
          finish(new Error(detail || '实时语音服务拒绝了会话配置'));
          return;
        }
        // Some vendors acknowledge with session.created only.
        if ((event.type === 'session.updated' || (event.type === 'session.created' && this.config.protocol && this.config.protocol !== 'openai')) && !configured) { configured = true; finish(); }
        handleRealtimeEvent(event, this.handlers);
      };
      socket.onerror = () => {
        if (!settled) finish(new Error('无法连接实时语音服务，请确认服务商支持 Realtime 接口'));
        else this.handlers.onError?.('实时语音连接出错');
      };
      socket.onclose = (event) => {
        if (!settled) finish(new Error(event?.reason || '实时语音连接被关闭，请确认服务商支持 Realtime 接口'));
        else if (!this.closedByUs) this.handlers.onClose?.(event?.reason || '连接已断开');
      };
    });
  }

  private send(payload: Record<string, unknown>): void {
    if (this.socket && this.socket.readyState === 1) this.socket.send(JSON.stringify(payload));
  }

  sendAudio(base64: string): void { this.send({ type: 'input_audio_buffer.append', audio: base64 }); }

  /** User interrupted: stop the current answer. */
  cancelResponse(): void { this.send({ type: 'response.cancel' }); }

  close(): void {
    this.closedByUs = true;
    try { this.socket?.close(1000, 'bye'); } catch { /* already closed */ }
    this.socket = null;
  }
}

/** What Live needs from any realtime vendor. */
export interface LiveSession {
  connect(timeoutMs?: number): Promise<void>;
  sendAudio(base64: string): void;
  cancelResponse(): void;
  close(): void;
}

export interface GeminiLiveConfig { url: string; apiKey: string; model: string; voice: string; instructions: string }

/**
 * Gemini Live over WebSocket: 16 kHz PCM in, 24 kHz PCM out, transcripts of both sides,
 * and barge-in reported by the server as `interrupted`.
 */
export class GeminiLiveSession implements LiveSession {
  private socket: SocketLike | null = null;
  private closedByUs = false;
  private speaking = false;
  /** The user stopped this answer: its remaining audio and text are dropped until the turn ends. */
  private dropping = false;
  private userText = '';
  private assistantText = '';

  constructor(private config: GeminiLiveConfig, private handlers: RealtimeHandlers, private factory: SocketFactory = defaultFactory) {}

  connect(timeoutMs = 12000): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) { this.closedByUs = true; try { this.socket?.close(1000, 'rejected'); } catch { /* closed */ } reject(error); } else resolve();
      };
      const timer = setTimeout(() => { finish(new Error('连接 Gemini Live 超时')); this.close(); }, timeoutMs);
      const url = `${this.config.url}${this.config.url.includes('?') ? '&' : '?'}key=${encodeURIComponent(this.config.apiKey.trim())}`;
      const socket = this.factory(url, {});
      // Gemini sends its JSON as binary frames.
      try { (socket as unknown as { binaryType: string }).binaryType = 'arraybuffer'; } catch { /* not supported */ }
      this.socket = socket;
      socket.onopen = () => {
        const model = this.config.model.startsWith('models/') ? this.config.model : `models/${this.config.model}`;
        socket.send(JSON.stringify({
          setup: {
            model,
            generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.config.voice || 'Kore' } } } },
            systemInstruction: { parts: [{ text: this.config.instructions }] },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
          },
        }));
      };
      socket.onmessage = (message) => {
        let event: Record<string, unknown>;
        try {
          const data = message.data;
          const raw = typeof data === 'string' ? data : data instanceof ArrayBuffer ? utf8(new Uint8Array(data)) : ArrayBuffer.isView(data) ? utf8(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)) : String(data);
          event = JSON.parse(raw) as Record<string, unknown>;
        } catch { return; }
        if (event.setupComplete !== undefined) { finish(); this.handlers.onReady?.(); return; }
        if (event.error) { const detail = (event.error as { message?: string }).message ?? 'Gemini Live 返回错误'; if (!settled) finish(new Error(detail)); else this.handlers.onError?.(detail); return; }
        const content = event.serverContent as Record<string, unknown> | undefined;
        if (!content) return;
        const input = (content.inputTranscription as { text?: string } | undefined)?.text;
        if (input) {
          // While the model talks, real barge-in arrives as `interrupted`; this may just be echo.
          if (!this.userText && !this.speaking) this.handlers.onSpeechStarted?.();
          this.userText += input;
          this.handlers.onUserText?.(this.userText.trim());
        }
        if (content.interrupted) {
          this.speaking = false;
          this.dropping = false;
          this.assistantText = '';
          this.handlers.onSpeechStarted?.();
        }
        const parts = ((content.modelTurn as { parts?: Array<{ inlineData?: { data?: string } }> } | undefined)?.parts ?? []);
        for (const part of parts) {
          if (!part.inlineData?.data || this.dropping) continue;
          if (!this.speaking) { this.speaking = true; if (this.userText) this.handlers.onSpeechStopped?.(); this.handlers.onResponseStarted?.(); }
          this.handlers.onAudio?.(part.inlineData.data);
        }
        const output = (content.outputTranscription as { text?: string } | undefined)?.text;
        if (output && !this.dropping) { this.assistantText += output; this.handlers.onAssistantText?.(output); }
        if (content.turnComplete) {
          if (!this.dropping) {
            this.handlers.onAssistantTextDone?.(this.assistantText);
            this.handlers.onResponseDone?.();
          }
          this.dropping = false;
          this.speaking = false;
          this.userText = '';
          this.assistantText = '';
        }
      };
      socket.onerror = () => { if (!settled) finish(new Error('无法连接 Gemini Live，请检查 API Key 和网络')); else this.handlers.onError?.('Gemini Live 连接出错'); };
      socket.onclose = (event) => {
        if (!settled) finish(new Error(event?.reason || 'Gemini Live 拒绝了连接，请检查模型名称'));
        else if (!this.closedByUs) this.handlers.onClose?.(event?.reason || '连接已断开');
      };
    });
  }

  sendAudio(base64: string): void {
    if (this.socket && this.socket.readyState === 1) this.socket.send(JSON.stringify({ realtimeInput: { audio: { data: base64, mimeType: 'audio/pcm;rate=16000' } } }));
  }

  /** Gemini stops by itself when the user talks; a tap only silences the rest of this answer. */
  cancelResponse(): void { if (this.speaking) this.dropping = true; this.speaking = false; }

  close(): void {
    this.closedByUs = true;
    try { this.socket?.close(1000, 'bye'); } catch { /* closed */ }
    this.socket = null;
  }
}
