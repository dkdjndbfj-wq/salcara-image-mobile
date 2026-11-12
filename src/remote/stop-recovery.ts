import { HubError } from './client';
import { directActionUncertain } from './direct-turn-actions';

/** Only the local preflight may use this marker, before command() is invoked. */
export function stopNotDispatched(error: unknown): HubError & { interruptNotDispatched: true } {
  // Preserve existing capability error codes consumed by other callers.
  const failure = error instanceof HubError ? error
    : new HubError(error instanceof Error ? error.message : '停止请求尚未发送，请重试', 200, 'interrupt_not_dispatched');
  return Object.assign(failure, { interruptNotDispatched: true as const });
}

/** A missing transport receipt is not evidence that stopping failed. */
export function stopDefinitelyRejected(error: unknown): boolean {
  if (error instanceof HubError && 'interruptNotDispatched' in error && error.interruptNotDispatched === true) return true;
  if (!(error instanceof HubError) || directActionUncertain(error)
    || ['command_receipt_pending', 'command_delivery_uncertain', 'hub_identity_changed'].includes(error.code ?? '')) return false;
  if (error.status === 401 || error.status === 403) return true;
  if (error.status === 409) return error.code === 'computer_offline' || error.code === 'bot_binding_changed';
  return error.status === 200 && ['interrupt_not_dispatched', 'agent_capability_unavailable',
    'desktop_capability_unavailable', 'turn_control_stale', 'request_scope_changed'].includes(error.code ?? '');
}
