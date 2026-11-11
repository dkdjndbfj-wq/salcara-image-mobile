import { requireOptionalNativeModule } from 'expo';
import { loadNotificationTargets, resolveNotificationTarget, type NotificationTarget } from './connections';
import { getRemoteState, pushTarget } from './store';
import { notificationScopeFor } from './notification-scope';
import { remoteNotificationsEnabled } from './notification-preferences';

const native = (() => { try { return requireOptionalNativeModule<{ setNotificationTargets?(json: string): void }>('SalcaraNotify'); } catch { return null; } })();
export type NoticeTarget = Omit<NotificationTarget, 'connectionId'> & { connectionId?: string };

/** Legacy single-computer pairings have no saved profile; never use this to revive a removed saved binding. */
export async function notificationTargets(): Promise<NoticeTarget[]> {
  const targets: NoticeTarget[] = [...await loadNotificationTargets()];
  const current = pushTarget();
  if (current && !getRemoteState().connectionId) {
    const notificationScope = notificationScopeFor(current.hub, current.deviceId);
    if (notificationScope && !targets.some(target => target.notificationScope === notificationScope)) targets.push({ ...current, notificationScope });
  }
  return targets;
}

export async function currentNoticeTarget(target: NoticeTarget): Promise<boolean> {
  if (target.connectionId) return Boolean(await resolveNotificationTarget(target.notificationScope, target.deviceId));
  const current = pushTarget();
  return !getRemoteState().connectionId && Boolean(current && current.deviceId === target.deviceId
    && notificationScopeFor(current.hub, current.deviceId) === target.notificationScope);
}

export function publishNotificationTargets(targets: readonly NoticeTarget[]): void {
  // Disable takes effect synchronously even when registration cleanup is offline.
  native?.setNotificationTargets?.(JSON.stringify(remoteNotificationsEnabled()
    ? targets.map(({ notificationScope, deviceId }) => ({ notificationScope, deviceId })) : []));
}
