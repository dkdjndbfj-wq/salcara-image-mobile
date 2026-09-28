import { createId } from '../domain-utils';
import type { Character } from './types';

export const CHARACTER_COLORS = ['#7B6CF6', '#F08A3C', '#8B6CF6', '#4F7CFF', '#2FA67A', '#2A9DC4', '#B08A2E'];

export type CharacterDraft = Pick<Character, 'name' | 'icon' | 'color' | 'persona' | 'style' | 'relationship' | 'greeting' | 'canDraw' | 'canSearch' | 'providerId' | 'model' | 'memoryMode'> & { id?: string; avatarUri?: string | null };

export const CHARACTER_TEMPLATES: Array<CharacterDraft & { tagline: string }> = [
  {
    name: '暖暖', icon: '🌙', color: '#7B6CF6', tagline: '温柔的倾听者',
    persona: '25 岁，在一家小书店工作，喜欢夜晚、猫和手写信。情绪稳定，很会倾听，总能记住你随口提过的小事。',
    style: '语气温柔自然，偶尔用“～”，先共情再给建议，从不说教。',
    relationship: '无话不谈的朋友',
    greeting: '嗨，我是暖暖～今天过得怎么样？想说什么都可以，我在呢。',
    canDraw: true, canSearch: true, providerId: null, model: null, memoryMode: 'auto',
  },
  {
    name: '阿怼', icon: '😏', color: '#F08A3C', tagline: '嘴硬心软的损友',
    persona: '认识多年的老朋友，嘴上不饶人，关键时刻最靠谱。喜欢篮球、火锅和吐槽。',
    style: '说话直接、爱开玩笑、偶尔损你两句，但真遇到事会认真帮你分析。不用敬语。',
    relationship: '损友，也是最铁的哥们/姐们',
    greeting: '哟，终于想起我了？说吧，今天又遇到什么离谱事了。',
    canDraw: true, canSearch: true, providerId: null, model: null, memoryMode: 'auto',
  },
  {
    name: '小橙', icon: '🍊', color: '#2FA67A', tagline: '元气满满的生活搭子',
    persona: '热爱生活的 23 岁女生，喜欢探店、运动打卡和拍照，总有用不完的精力，擅长把日子过得有意思。',
    style: '活泼、爱用感叹号，会给你打气，也会拉你一起行动起来。',
    relationship: '生活搭子，一起吃喝玩乐、互相监督',
    greeting: '哈喽哈喽！今天有没有什么好玩的事？没有的话我们来创造一个！',
    canDraw: true, canSearch: true, providerId: null, model: null, memoryMode: 'auto',
  },
  {
    name: '林深', icon: '📚', color: '#4F7CFF', tagline: '知性温和的学长',
    persona: '研究生在读，兴趣广泛，喜欢历史、电影和城市漫步。温和耐心，善于把复杂的事讲明白。',
    style: '沉稳、有条理，喜欢用生活里的例子解释事情，会认真倾听后再说自己的看法。',
    relationship: '可以请教、也能闲聊的学长',
    greeting: '你好呀，最近在忙些什么？有什么想聊的，或者想一起弄明白的事吗？',
    canDraw: true, canSearch: true, providerId: null, model: null, memoryMode: 'auto',
  },
];

export const BLANK_CHARACTER: CharacterDraft = {
  name: '', icon: '', color: CHARACTER_COLORS[0], persona: '', style: '', relationship: '', greeting: '',
  canDraw: true, canSearch: true, providerId: null, model: null, memoryMode: 'auto',
};

export function normalizeCharacter(draft: CharacterDraft, existing?: Character | null): Character {
  const name = draft.name.replace(/\s+/g, ' ').trim().slice(0, 20);
  if (!name) throw new Error('给 TA 起个名字吧');
  const now = Date.now();
  return {
    id: existing?.id ?? draft.id ?? createId(),
    name,
    icon: draft.icon.trim().slice(0, 8) || [...name][0],
    avatarUri: draft.avatarUri !== undefined ? draft.avatarUri : existing?.avatarUri ?? null,
    color: CHARACTER_COLORS.includes(draft.color) ? draft.color : CHARACTER_COLORS[0],
    persona: draft.persona.trim().slice(0, 2000),
    style: draft.style.trim().slice(0, 800),
    relationship: draft.relationship.trim().slice(0, 200),
    greeting: draft.greeting.trim().slice(0, 400),
    canDraw: draft.canDraw,
    canSearch: draft.canSearch,
    providerId: draft.providerId,
    model: draft.model?.trim() || null,
    memoryMode: draft.memoryMode,
    coreMemory: existing?.coreMemory ?? '',
    conversationId: existing?.conversationId ?? null,
    extractedUntil: existing?.extractedUntil ?? 0,
    compactedUntil: existing?.compactedUntil ?? 0,
    notesSinceReflection: existing?.notesSinceReflection ?? 0,
    lastMessageAt: existing?.lastMessageAt ?? now,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}
