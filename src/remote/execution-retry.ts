/** Only explicit provider reset metadata for quota/rate limits may schedule UI. */
export function executionRetryAt(errorCode: unknown, value: unknown): number | undefined {
  return (errorCode === 'usage_limit' || errorCode === 'upstream_rate_limit')
    && typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 253402300799999 ? value : undefined;
}

export function validRetryAt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 253402300799999;
}
