/**
 * 记忆匣 (Memory Box): the long-term memory of the chat space. Every chat
 * character has its own box: note cards connected by labelled links, like an
 * Obsidian vault the character keeps about its life with the user.
 */

export type NoteType = 'person' | 'preference' | 'event' | 'fact' | 'project' | 'moment' | 'feeling' | 'episode' | 'insight';

export const NOTE_TYPES: NoteType[] = ['person', 'preference', 'event', 'fact', 'project', 'moment', 'feeling', 'episode', 'insight'];

export const NOTE_TYPE_META: Record<NoteType, { label: string; color: string }> = {
  person: { label: '人物', color: '#6D5DF6' },
  preference: { label: '喜好', color: '#F08A3C' },
  event: { label: '事件', color: '#4F7CFF' },
  fact: { label: '事实', color: '#2A9DC4' },
  project: { label: '计划', color: '#2FA67A' },
  moment: { label: '一起做过', color: '#8B6CF6' },
  feeling: { label: '心情', color: '#E39A3B' },
  episode: { label: '往事', color: '#8A90A9' },
  insight: { label: '感悟', color: '#A8892B' },
};

export interface MemNote {
  id: string;
  /** Character that owns this note. */
  owner: string;
  type: NoteType;
  title: string;
  content: string;
  tags: string[];
  /** 1–10. */
  importance: number;
  /** A fact about the user that the assistant space may read. */
  aboutUser: boolean;
  /** Always in the character's context (core memory). */
  pinned: boolean;
  /** Since when this is true (ms). */
  validFrom: number;
  /** When it stopped being true; null = still true. */
  validTo: number | null;
  supersededBy: string | null;
  sourceConversationId: string | null;
  sourceMessageId: string | null;
  /** Episodes: the message time range they summarize, and their level (1 = raw turns). */
  rangeStart: number | null;
  rangeEnd: number | null;
  level: number;
  /** Episodes merged into a higher-level episode. */
  rolledUp: boolean;
  embedding: number[] | null;
  embeddingModel: string | null;
  /** Canvas position. */
  x: number | null;
  y: number | null;
  accessCount: number;
  lastAccessedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface MemLink {
  id: string;
  owner: string;
  source: string;
  target: string;
  /** e.g. 相关、属于、导致、取代、提到、总结. */
  relation: string;
  weight: number;
  createdAt: number;
}

export type MemoryMode = 'auto' | 'explicit' | 'off';

/** A chat character (聊天角色). */
export interface Character {
  id: string;
  name: string;
  /** Emoji or a short text shown as the avatar. */
  icon: string;
  /** A picture chosen by the user (app-private file); falls back to `icon` when absent. */
  avatarUri: string | null;
  color: string;
  /** Personality, background, how it sees the user. */
  persona: string;
  /** How it talks. */
  style: string;
  /** What the user and the character are to each other. */
  relationship: string;
  /** First message when the chat starts. */
  greeting: string;
  /** Tools it may use. */
  canDraw: boolean;
  canSearch: boolean;
  providerId: string | null;
  model: string | null;
  memoryMode: MemoryMode;
  /** Always-present core memory (≈ 1–2k characters), editable by the user and the character. */
  coreMemory: string;
  /** The one continuous conversation with this character. */
  conversationId: string | null;
  /** Pipeline progress: messages up to these times have been extracted / summarized. */
  extractedUntil: number;
  compactedUntil: number;
  notesSinceReflection: number;
  lastMessageAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface RecalledNote { id: string; title: string }
