import { getSetting, setSetting } from '../storage/database';
import type { ComputerSelection } from './computer-connections';

const KEY = 'remote_computer_selection_v1';
let tail: Promise<void> = Promise.resolve();
function serialized<T>(action: () => Promise<T>): Promise<T> {
  const operation = tail.then(action, action);
  tail = operation.then(() => undefined, () => undefined);
  return operation;
}

function validSelection(value: unknown): value is ComputerSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (typeof item.deviceId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(item.deviceId)) return false;
  const routed = item.kind === 'relay' || item.kind === 'bot';
  if (!routed && item.kind !== 'direct' && item.kind !== 'demo') return false;
  const keys = routed ? ['kind', 'deviceId', 'connectionId'] : ['kind', 'deviceId'];
  return Object.keys(item).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(item, key))
    && (!routed || typeof item.connectionId === 'string' && /^[a-f0-9]{64}$/.test(item.connectionId));
}

/** A navigation preference only. Callers must verify that the exact saved pairing still exists. */
export function readComputerSelection(): Promise<ComputerSelection | null> {
  return serialized(async () => {
    const raw = await getSetting(KEY);
    try {
      const value: unknown = JSON.parse(raw || 'null');
      return validSelection(value) && value.kind !== 'demo' ? value : null;
    } catch { return null; }
  });
}

export function saveComputerSelection(selection: ComputerSelection | null): Promise<void> {
  if (selection !== null && !validSelection(selection)) return Promise.reject(new Error('电脑选择记录无效'));
  // Capture now: callers cannot mutate a queued selection while a prior write waits.
  const value = selection && selection.kind !== 'demo' ? JSON.stringify(selection) : null;
  return serialized(() => setSetting(KEY, value));
}
