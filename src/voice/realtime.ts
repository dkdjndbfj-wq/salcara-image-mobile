import { normalizeBaseUrl } from '../domain-utils';

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
}

/** GA session shape: 24 kHz PCM in and out, server-side turn detection that allows barge-in. */
export function sessionUpdate(config: RealtimeConfig) {
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
  onUserText?: (text: string) => void;
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
    case 'conversation.item.input_audio_transcription.completed':
      if (text(event.transcript).trim()) handlers.onUserText?.(text(event.transcript).trim());
      break;
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
export class RealtimeSession {
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
      const socket = this.factory(realtimeUrl(this.config.baseUrl, this.config.model), { Authorization: `Bearer ${this.config.apiKey.trim()}` });
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
        if (event.type === 'session.updated' && !configured) { configured = true; finish(); }
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
