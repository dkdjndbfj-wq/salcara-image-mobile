/** The Hub currently retains durable receipt tombstones for 24 hours. Keep a safety margin. */
export const DELIVERY_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;

export interface DeliveryRetryRecord {
  createdAt: number;
  attempted: boolean;
  safeRetry: boolean;
  uncertain?: boolean;
  executionId?: string;
  pausedByStop?: boolean;
  /** First request that could have reached the computer, not when the user wrote the message. */
  firstAttemptAt?: number;
  /** Persisted wall-clock high-water mark: rolling the phone clock back cannot extend retries. */
  lastObservedAt?: number;
  /** Once expiry or clock rollback is observed, restarting/changing time cannot re-enable sending. */
  reviewReason?: 'expired' | 'clock-changed';
}

export interface DeliveryRetryState {
  kind: 'waiting-device' | 'confirming' | 'needs-review';
  retryable: boolean;
  message: string;
  reason?: 'uncertain' | 'expired' | 'unsupported' | 'clock-changed' | 'stopped';
}

/** A read never renews a receipt. Old attempted records retain their original conservative deadline. */
export function deliveryRetryState(record: DeliveryRetryRecord, now = Date.now()): DeliveryRetryState {
  if (record.pausedByStop) return { kind: 'needs-review', retryable: false, reason: 'stopped', message: '重试已暂停 · 请核对原对话' };
  // v2 recovery always looks up the immutable ticket first. An expired or
  // uncertain execution is never redispatched; the legacy 23h send window
  // must not prevent reading its saved result after a long phone absence.
  if (record.executionId) return record.reviewReason === 'expired'
    ? { kind: 'needs-review', retryable: false, reason: 'expired', message: '原操作恢复内容已过期 · 请核对电脑原会话' }
    : { kind: 'confirming', retryable: true, message: '等待原操作确认 · 自动核对' };
  const firstAttempt = record.firstAttemptAt ?? record.createdAt;
  const observed = record.lastObservedAt ?? (record.attempted ? firstAttempt : record.createdAt);
  if (record.reviewReason === 'clock-changed' || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(observed) || now < observed) {
    return { kind: 'needs-review', retryable: false, reason: 'clock-changed',
      message: '设备时间异常 · 请核对原对话' };
  }
  if (record.reviewReason === 'expired') return { kind: 'needs-review', retryable: false, reason: 'expired',
    message: '确认期限已过 · 请核对原对话' };
  if (record.uncertain) return { kind: 'needs-review', retryable: false, reason: 'uncertain',
    message: '送达状态未确认 · 请核对原对话' };
  if (!record.attempted) return { kind: 'waiting-device', retryable: true,
    message: '等待电脑连接 · 自动重试' };
  if (!record.safeRetry) return { kind: 'needs-review', retryable: false, reason: 'unsupported',
    message: '当前不支持安全重试 · 请核对原对话' };
  if (!Number.isSafeInteger(firstAttempt) || firstAttempt < 0 || now - firstAttempt >= DELIVERY_RETRY_WINDOW_MS) {
    return { kind: 'needs-review', retryable: false, reason: 'expired',
      message: '确认期限已过 · 请核对原对话' };
  }
  return { kind: 'confirming', retryable: true,
    message: '等待送达确认 · 自动重试' };
}
