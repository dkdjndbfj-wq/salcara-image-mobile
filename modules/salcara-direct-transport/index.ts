import { EventSubscription, requireOptionalNativeModule } from 'expo-modules-core';
import { validateDirectEndpoint } from './validation';

export type DirectTransportState = 'connecting' | 'open' | 'closing' | 'closed';
export interface DirectTransportEvents {
  onState: { state: DirectTransportState };
  onMessage: { text: string };
  onError: { message: string };
}

interface NativeDirectTransport {
  connect(url: string, certificateSha256: string): void;
  send(text: string): boolean;
  close(): void;
  addListener<K extends keyof DirectTransportEvents>(
    eventName: K,
    listener: (event: DirectTransportEvents[K]) => void,
  ): EventSubscription;
}

const Native = requireOptionalNativeModule<NativeDirectTransport>('SalcaraDirectTransport');
const MAX_FRAME_BYTES = 256 * 1024;

function nativeTransport(): NativeDirectTransport {
  if (!Native) throw new Error('当前平台不支持电脑直连');
  return Native;
}

/**
 * Starts a direct-only WSS connection. The pin is SHA-256 of the complete DER
 * leaf certificate (lowercase hex); native code also verifies the URL hostname.
 * This module never uses the Hub client or retries through another endpoint.
 */
export function connect(url: string, certificateSha256: string): void {
  const endpoint = validateDirectEndpoint(url, certificateSha256);
  nativeTransport().connect(endpoint.url, endpoint.certificateSha256);
}

/** Sends one bounded JSON text frame to the already authenticated direct peer. */
export function send(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0 || new TextEncoder().encode(text).byteLength > MAX_FRAME_BYTES) {
    throw new Error('直连消息无效或超出大小限制');
  }
  return nativeTransport().send(text);
}

export function close(): void { nativeTransport().close(); }

export function addListener<K extends keyof DirectTransportEvents>(
  eventName: K,
  listener: (event: DirectTransportEvents[K]) => void,
): EventSubscription {
  return nativeTransport().addListener(eventName, listener);
}
