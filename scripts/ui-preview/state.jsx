import React, { createContext, useContext, useState } from 'react';
import { sampleImage } from './services';
const Context = createContext(null);
const initialProviders = [
  { id: 'chat', name: '日常对话', baseUrl: 'https://example.com/v1', chatModel: 'claude-sonnet-4', model: null, chatApi: 'anthropic', analysisProviderId: null, imageProviderId: 'image', quality: null, aspectRatio: null, resolutionTier: null, createdAt: 1, updatedAt: 1 },
  { id: 'image', name: 'Salcara 图片', baseUrl: 'https://salcara.top/v1', chatModel: null, model: 'gpt-image-2.5', quality: 'high', aspectRatio: '16:9', resolutionTier: '2K', createdAt: 1, updatedAt: 1 },
];
const base = { conversationId: 'today', role: 'assistant', prompt: '', mode: 'chat', status: 'complete', providerId: 'chat', model: 'claude-sonnet-4', quality: 'high', size: '1536x1024', transparent: false, references: [], documents: [], imageUri: null, remoteImageUrl: null, maskUri: null, error: null, elapsedMs: 2400, createdAt: 1 };
const conversations = ['周末的城市漫游计划', '品牌视觉与海报灵感', '产品说明书摘要', '一个新的开始'].map((title, i) => ({ id: i ? 'old-' + i : 'today', title, providerId: 'chat', mode: 'auto', transparent: false, createdAt: Date.now() - i * 86400000, updatedAt: Date.now() - i * 86400000 }));
export function PreviewProvider({ children }) {
  const scenario = new URLSearchParams(location.search).get('scene');
  const [providers, setProviders] = useState(initialProviders);
  const [activeId, setActiveId] = useState('chat');
  const [activeConversation, setConversation] = useState(scenario ? conversations[0] : null);
  const [mode, setMode] = useState('auto');
  const [messages, setMessages] = useState(scenario === 'image' ? [{ ...base, id: 'u', role: 'user', prompt: '画一幅安静的山水，清晨有一点薄雾。' }, { ...base, id: 'a', mode: 'generate', model: 'gpt-image-2.5', imageUri: sampleImage, elapsedMs: 36000 }] : scenario === 'chat' ? [{ ...base, id: 'u', role: 'user', prompt: '帮我规划一个轻松的城市漫游周末。' }, { ...base, id: 'a', text: '当然。把行程留白一点，让周末真正慢下来。\n\n## 周六 · 在城市里散步\n\n- **上午**：找一家街角咖啡馆，读几页喜欢的书。\n- **午后**：去美术馆看展，再沿着河边走一走。\n- **傍晚**：在日落前回家，做一顿简单的晚餐。\n\n你更喜欢自然风景，还是小店和街区？' }] : scenario === 'error' ? [{ ...base, id: 'e', status: 'error', error: '连接暂时中断，请稍后重试。' }] : []);
  const updateProviderSettings = async (id, settings) => setProviders((items) => items.map((p) => p.id === id ? { ...p, ...settings } : p));
  const value = { ready: true, providers, activeProvider: providers.find((p) => p.id === activeId), conversations, activeConversation, messages, generating: false, elapsedSeconds: 0, requestStage: '', composerMode: mode,
    setComposerMode: async (value) => setMode(value), reloadProviders: async () => {}, activateProvider: async (id) => setActiveId(id), updateProviderSettings,
    updateActiveProviderSettings: async (settings) => updateProviderSettings(activeId, settings), removeProvider: async (id) => setProviders((items) => items.filter((p) => p.id !== id)),
    startConversation: async () => { setConversation(null); setMessages([]); }, selectConversation: async (id) => { setConversation(conversations.find((c) => c.id === id)); setMessages([]); }, removeConversation: async () => {},
    toggleTransparent: async () => setConversation((c) => ({ ...(c ?? conversations[0]), transparent: !c?.transparent })),
    sendPrompt: async (prompt, references, mask, continuation, documents, skill) => { setMessages((items) => [...items, { ...base, id: crypto.randomUUID(), role: 'user', prompt, references, documents }, { ...base, id: crypto.randomUUID(), text: skill ? '本地界面预览：此处将开始创作检查，未发出真实请求。' : '这是界面预览回复，未请求任何 API。' }]); }, cancelGeneration: () => {}, retryMessage: async () => {},
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useApp = () => useContext(Context);
