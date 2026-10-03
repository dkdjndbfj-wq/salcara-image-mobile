import { useSyncExternalStore } from 'react';

/**
 * The text of replies that are being written right now.
 *
 * The typewriter reveals a reply about 25 times a second. Putting each step
 * into the app's message list re-rendered the whole app (chat screen, drawer,
 * every sheet) on every step. Instead each step lands here and only the bubble
 * showing that message re-renders; the message list itself is updated about
 * once a second, together with the progress save, and once at the end.
 */
const texts = new Map<string, string | null>();
const byId = new Map<string, Set<() => void>>();
const anyListeners = new Set<() => void>();
let version = 0;

function notify(id: string) {
  version += 1;
  byId.get(id)?.forEach((listener) => listener());
  anyListeners.forEach((listener) => listener());
}

export function setLiveText(id: string, text: string | null) {
  if (texts.get(id) === text && texts.has(id)) return;
  texts.set(id, text);
  notify(id);
}

/** The message list now holds the newest text: stop overriding it. */
export function clearLiveText(id: string) {
  if (!texts.delete(id)) return;
  notify(id);
}

/** undefined: nothing live, use the message's own text. */
export function liveText(id: string): string | null | undefined {
  return texts.has(id) ? texts.get(id) ?? null : undefined;
}

/** The text to show for a message: its live text while it is being written, else its saved text. */
export function useLiveText(id: string, saved: string | null | undefined): string | null | undefined {
  const live = useSyncExternalStore(
    (listener) => {
      let set = byId.get(id);
      if (!set) { set = new Set(); byId.set(id, set); }
      set.add(listener);
      return () => { set!.delete(listener); if (!set!.size) byId.delete(id); };
    },
    () => liveText(id),
    () => liveText(id),
  );
  return live === undefined ? saved : live;
}

/** Re-renders on any live change (voice mode speaks a reply while it is written). */
export function useLiveVersion(): number {
  return useSyncExternalStore((listener) => { anyListeners.add(listener); return () => { anyListeners.delete(listener); }; }, () => version, () => version);
}

export function resetLiveTextForTests() { texts.clear(); byId.clear(); anyListeners.clear(); version = 0; }
