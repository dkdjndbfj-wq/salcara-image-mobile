/** The Hub currently retains durable receipt tombstones for 24 hours. Keep a safety margin. */
export const DELIVERY_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;

export interface DeliveryRetryRecord {
  createdAt: number;
  attempted: boolean;
  safeRetry: boolean;
  uncertain?: boolean;
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
  reason?: 'uncertain' | 'expired' | 'unsupported' | 'clock-changed';
}

/** A read never renews a receipt. Old attempted records retain their original conservative deadline. */
export function deliveryRetryState(record: DeliveryRetryRecord, now = Date.now()): DeliveryRetryState {
  const firstAttempt = record.firstAttemptAt ?? record.createdAt;
  const observed = record.lastObservedAt ?? (record.attempted ? firstAttempt : record.createdAt);
  if (record.reviewReason === 'clock-changed' || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(observed) || now < observed) {
    return { kind: 'needs-review', retryable: false, reason: 'clock-changed',
      message: '手机时间发生变化，已暂停重发。请刷新原会话核对，不会自动重复发布任务' };
  }
  if (record.reviewReason === 'expired') return { kind: 'needs-review', retryable: false, reason: 'expired',
    message: '离线时间已超过安全确认期限，已停止自动重发。文字仍在手机，请先核对原会话' };
  if (record.uncertain) return { kind: 'needs-review', retryable: false, reason: 'uncertain',
    message: '无法确认电脑是否收到消息，请先刷新原会话核对；不会自动重发' };
  if (!record.attempted) return { kind: 'waiting-device', retryable: true,
    message: '电脑离线，消息尚未下发；文字保存在手机，恢复连接后继续发送' };
  if (!record.safeRetry) return { kind: 'needs-review', retryable: false, reason: 'unsupported',
    message: '本站不支持安全重试，请先核对电脑上的原会话；不会自动重发' };
  if (!Number.isSafeInteger(firstAttempt) || firstAttempt < 0 || now - firstAttempt >= DELIVERY_RETRY_WINDOW_MS) {
    return { kind: 'needs-review', retryable: false, reason: 'expired',
      message: '离线时间已超过安全确认期限，已停止自动重发。文字仍在手机，请先核对原会话' };
  }
  return { kind: 'confirming', retryable: true,
    message: '消息等待确认，恢复连接后用同一编号继续确认，不会改成新任务' };
}
