import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';

import { getSetting, setSetting } from '../storage/database';

/**
 * - auto: the provider's own search on official OpenAI/Claude endpoints,
 *   otherwise a configured search key, otherwise the built-in free search.
 * - native: always ask the provider (works on relays that pass it through).
 */
export type SearchEngine = 'auto' | 'native' | 'builtin' | 'tavily' | 'brave' | 'searxng' | 'off';
export type ImageCheck = 'off' | 'check' | 'redraw';

export interface AgentSettings {
  webSearch: SearchEngine;
  searxngUrl: string;
  memoryEnabled: boolean;
  /** 关于我: what the assistant should know about the user. */
  aboutMe: string;
  /** 回答风格: how the assistant should answer. */
  responseStyle: string;
  suggestions: boolean;
  /** After drawing: look at the result, and optionally redraw once when it clearly misses. */
  imageCheck: ImageCheck;
  phoneActions: boolean;
  historySearch: boolean;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  webSearch: 'auto',
  searxngUrl: '',
  memoryEnabled: true,
  aboutMe: '',
  responseStyle: '',
  suggestions: true,
  imageCheck: 'off',
  phoneActions: true,
  historySearch: true,
};

export const SEARCH_ENGINES: Array<{ id: SearchEngine; label: string; detail: string }> = [
  { id: 'auto', label: '自动', detail: '官方 OpenAI / Claude 接口用原生搜索，否则用你填写的搜索密钥，都没有时用内置搜索' },
  { id: 'native', label: '服务商原生搜索', detail: '让模型服务商自己联网（Responses 与 Claude 接口；中转站需支持）' },
  { id: 'tavily', label: 'Tavily', detail: '为 AI 设计的搜索，每月 1000 次免费，需要密钥' },
  { id: 'brave', label: 'Brave Search', detail: '独立索引，需要密钥' },
  { id: 'searxng', label: 'SearXNG', detail: '自建或可信的 SearXNG 实例（需开启 JSON 输出）' },
  { id: 'builtin', label: '内置免费搜索', detail: '无需配置，直接读取公开搜索页面，稳定性一般' },
  { id: 'off', label: '关闭联网', detail: '不搜索、不读取网页' },
];

const KEY = 'agent_settings';
let current: AgentSettings = DEFAULT_AGENT_SETTINGS;
let loaded = false;
const listeners = new Set<() => void>();

export function parseAgentSettings(raw: string | null): AgentSettings {
  if (!raw) return DEFAULT_AGENT_SETTINGS;
  try {
    const value = JSON.parse(raw) as Partial<AgentSettings>;
    const text = (item: unknown, max: number) => (typeof item === 'string' ? item.slice(0, max) : '');
    const flag = (item: unknown, fallback: boolean) => (typeof item === 'boolean' ? item : fallback);
    return {
      webSearch: SEARCH_ENGINES.some((engine) => engine.id === value.webSearch) ? value.webSearch as SearchEngine : DEFAULT_AGENT_SETTINGS.webSearch,
      searxngUrl: text(value.searxngUrl, 300),
      memoryEnabled: flag(value.memoryEnabled, true),
      aboutMe: text(value.aboutMe, 1500),
      responseStyle: text(value.responseStyle, 1500),
      suggestions: flag(value.suggestions, true),
      imageCheck: value.imageCheck === 'check' || value.imageCheck === 'redraw' ? value.imageCheck : 'off',
      phoneActions: flag(value.phoneActions, true),
      historySearch: flag(value.historySearch, true),
    };
  } catch {
    return DEFAULT_AGENT_SETTINGS;
  }
}

export async function loadAgentSettings(): Promise<AgentSettings> {
  if (!loaded) {
    current = parseAgentSettings(await getSetting(KEY));
    loaded = true;
    listeners.forEach((listener) => listener());
  }
  return current;
}

export async function updateAgentSettings(patch: Partial<AgentSettings>): Promise<AgentSettings> {
  await loadAgentSettings();
  current = { ...current, ...patch };
  listeners.forEach((listener) => listener());
  await setSetting(KEY, JSON.stringify(current));
  return current;
}

export function agentSettings(): AgentSettings { return current; }

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!loaded) void loadAgentSettings().catch(() => undefined);
  return () => { listeners.delete(listener); };
}

export function useAgentSettings(): AgentSettings {
  return useSyncExternalStore(subscribe, agentSettings, agentSettings);
}

/** Test hook. */
export function resetAgentSettingsForTesting(value: AgentSettings = DEFAULT_AGENT_SETTINGS): void { current = value; loaded = value !== DEFAULT_AGENT_SETTINGS; }

// ——— Search service keys (never stored in SQLite) ———
export type SearchKeyName = 'tavily' | 'brave';
const keyName = (name: SearchKeyName) => `search-key-${name}`;

export async function getSearchKey(name: SearchKeyName): Promise<string | null> {
  try { return await SecureStore.getItemAsync(keyName(name)); } catch { return null; }
}

export async function setSearchKey(name: SearchKeyName, value: string): Promise<void> {
  const trimmed = value.trim();
  if (!trimmed) { await SecureStore.deleteItemAsync(keyName(name)); return; }
  await SecureStore.setItemAsync(keyName(name), trimmed, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
}
