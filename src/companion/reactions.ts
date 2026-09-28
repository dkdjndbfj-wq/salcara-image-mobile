import { useEffect, useSyncExternalStore } from 'react';

import { database } from '../storage/database';

/** Emoji reactions on chat messages (one per message), cached per conversation. */

export const REACTIONS = ['❤️', '😂', '🥺', '😮', '👍', '🔥'] as const;

const cache = new Map<string, Map<string, string>>();
const listeners = new Map<string, Set<() => void>>();
const loading = new Set<string>();
const EMPTY = new Map<string, string>();

function notify(conversationId: string) {
  // A fresh map per change keeps useSyncExternalStore snapshots immutable.
  const current = cache.get(conversationId);
  if (current) cache.set(conversationId, new Map(current));
  listeners.get(conversationId)?.forEach((listener) => listener());
}

async function load(conversationId: string): Promise<void> {
  if (loading.has(conversationId)) return;
  loading.add(conversationId);
  try {
    const rows = await (await database()).getAllAsync<{ message_id: string; emoji: string }>('SELECT message_id, emoji FROM reactions WHERE conversation_id = ?', conversationId);
    cache.set(conversationId, new Map(rows.map((row) => [row.message_id, row.emoji])));
    notify(conversationId);
  } finally {
    loading.delete(conversationId);
  }
}

export function useReactions(conversationId: string | null): Map<string, string> {
  const id = conversationId ?? '';
  const value = useSyncExternalStore(
    (listener) => {
      if (!id) return () => undefined;
      const set = listeners.get(id) ?? new Set();
      set.add(listener);
      listeners.set(id, set);
      return () => { set.delete(listener); };
    },
    () => (id ? cache.get(id) ?? EMPTY : EMPTY),
    () => EMPTY,
  );
  useEffect(() => { if (id && !cache.has(id)) void load(id).catch(() => undefined); }, [id]);
  return value;
}

/** Sets (or with `null`, removes) the reaction on a message. */
export async function setReaction(conversationId: string, messageId: string, emoji: string | null): Promise<void> {
  const current = cache.get(conversationId) ?? new Map<string, string>();
  if (emoji) current.set(messageId, emoji); else current.delete(messageId);
  cache.set(conversationId, current);
  notify(conversationId);
  const db = await database();
  if (emoji) {
    await db.runAsync(
      'INSERT INTO reactions (message_id, conversation_id, emoji, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at',
      messageId, conversationId, emoji, Date.now(),
    );
  } else {
    await db.runAsync('DELETE FROM reactions WHERE message_id = ?', messageId);
  }
}

export async function clearReactions(conversationId: string): Promise<void> {
  cache.delete(conversationId);
  await (await database()).runAsync('DELETE FROM reactions WHERE conversation_id = ?', conversationId);
}

// ——— Poke (拍一拍) ———

export const POKE_PREFIX = '〔拍一拍〕';
export const isPoke = (text: string | null | undefined) => Boolean(text?.startsWith(POKE_PREFIX));
export const pokeText = (name: string) => `${POKE_PREFIX}你拍了拍「${name}」`;

// ——— Emoji rain for special words ———

const RAIN: Array<[RegExp, string[]]> = [
  [/生日快乐|happy birthday/i, ['🎂', '🎉', '🎈']],
  [/新年快乐|过年好|happy new year/i, ['🧧', '🎆', '✨']],
  [/晚安|good ?night/i, ['🌙', '⭐', '✨']],
  [/早安|早上好|good ?morning/i, ['☀️', '🌤️', '✨']],
  [/爱你|喜欢你|love you|么么哒|mua/i, ['❤️', '💕', '💖']],
  [/下雪|雪花/, ['❄️', '⛄', '✨']],
  [/恭喜|太棒了|好耶|成功了/, ['🎉', '🌟', '🎊']],
];

/** Emoji for a celebratory rain, when a message contains one of the magic words. */
export function rainFor(text: string | null | undefined): string[] | null {
  if (!text || isPoke(text)) return null;
  return RAIN.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}
