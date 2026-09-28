import { act, render, waitFor } from '@testing-library/react-native';
import React from 'react';

const mockNativeDb = new (require('node:sqlite').DatabaseSync)(':memory:');
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: async () => ({
    execAsync: async (sql: string) => mockNativeDb.exec(sql),
    runAsync: async (sql: string, ...args: unknown[]) => mockNativeDb.prepare(sql).run(...args),
    getAllAsync: async (sql: string, ...args: unknown[]) => mockNativeDb.prepare(sql).all(...args),
    getFirstAsync: async (sql: string, ...args: unknown[]) => mockNativeDb.prepare(sql).get(...args) ?? null,
  }),
}));
const mockAgent = jest.fn();
const mockSchedule = jest.fn();
jest.mock('expo-crypto', () => { let next = 0; return { randomUUID: () => `id-${++next}` }; });
jest.mock('../api/chat-api', () => ({ runAgentTurn: (...args: unknown[]) => mockAgent(...args), localTimeLine: () => '2026-09-28 周一 10:00（UTC+8）' }));
jest.mock('../memorybox/pipeline', () => ({
  scheduleMemoryWork: (...args: unknown[]) => { mockSchedule(...args); return Promise.resolve(); },
  catchUpAll: async () => undefined, configureMemoryPipeline: () => undefined, writeMemory: async () => undefined,
}));
jest.mock('../agent/web', () => ({ hostOf: (url: string) => url, webSearch: async () => ({ engine: 't', results: [] }), readWebpage: async () => { throw new Error('x'); } }));
jest.mock('../image-inputs', () => ({ createReferenceFromGenerated: async () => undefined, previewDataUrl: async () => '' }));
jest.mock('../document-inputs', () => ({ validateAttachments: () => undefined }));
jest.mock('expo-keep-awake', () => ({ activateKeepAwakeAsync: async () => undefined, deactivateKeepAwake: async () => undefined }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => 'key', deleteProviderKey: async () => undefined }));
jest.mock('expo-secure-store', () => ({ getItemAsync: async () => null }));
jest.mock('../storage/files', () => ({
  downloadPng: async () => '', deleteLocalFile: () => undefined, sweepUnreferencedFiles: () => 0,
  RemoteImageDownloadError: class extends Error { remoteImageUrl = ''; },
}));

import { CHARACTER_TEMPLATES } from '../memorybox/characters';
import { newNote, putNotes, resetMemoryBoxCacheForTesting, updateCharacter } from '../memorybox/store';
import { AppProvider, useApp } from '../state/AppContext';
import { upsertProvider } from '../storage/database';

let app: ReturnType<typeof useApp>;
function Probe() { app = useApp(); return null; }

beforeAll(async () => {
  resetMemoryBoxCacheForTesting();
  await upsertProvider({ id: 'chat', name: '对话', baseUrl: 'https://api.example', model: null, quality: null, aspectRatio: null, resolutionTier: null, chatModel: 'chat-model', chatApi: 'chat-completions', createdAt: 1, updatedAt: 1 });
});
afterAll(() => mockNativeDb.close());

test('a character has its own endless thread, persona and memory, separate from the assistant space', async () => {
  await render(<AppProvider><Probe /></AppProvider>);
  await waitFor(() => expect(app.ready).toBe(true));
  expect(app.space).toBe('assistant');

  // An assistant chat first, to check that switching spaces returns to it.
  mockAgent.mockResolvedValueOnce({ text: '助手的回答', imageCall: null, images: new Map(), toolMode: 'native', suggestions: [], sources: [], steps: 1 });
  await act(async () => { await app.send({ text: '你好助手' }); });
  const assistantConversation = app.activeConversationId;

  await act(async () => { app.switchSpace('companion'); });
  await waitFor(() => expect(app.space).toBe('companion'));
  expect(app.activeConversationId).toBeNull();

  let characterId = '';
  await act(async () => { characterId = (await app.createCharacter({ ...CHARACTER_TEMPLATES[0] })).id; });
  await act(async () => { await app.openCharacter(characterId); });
  expect(app.activeCharacterId).toBe(characterId);
  expect(app.messages.map((message) => [message.role, message.text])).toEqual([['assistant', CHARACTER_TEMPLATES[0].greeting]]);

  await updateCharacter(characterId, { coreMemory: '用户叫小满，养了猫团子' });
  await putNotes(characterId, [newNote({ owner: characterId, type: 'person', title: '猫叫团子', content: '橘猫，三岁', importance: 8 })]);

  mockAgent.mockImplementationOnce(async (request: { persona: string; extraInstructions: string[]; history: unknown[]; suggestions: boolean; toolkit: { specs: Array<{ name: string }> } }, onText?: (text: string) => void) => {
    expect(request.persona).toContain('你是「暖暖」');
    expect(request.persona).toContain('无话不谈的朋友');
    const instructions = request.extraInstructions.join('\n');
    expect(instructions).toContain('用户叫小满，养了猫团子');
    expect(instructions).toContain('猫叫团子');
    expect(request.suggestions).toBe(false);
    expect(request.toolkit.specs.map((spec) => spec.name)).toEqual(expect.arrayContaining(['memory_search', 'recall_conversation', 'memory_write', 'core_memory_update']));
    expect(request.toolkit.specs.map((spec) => spec.name)).not.toContain('phone_action');
    onText?.('团子');
    return { text: '团子今天乖不乖呀？', imageCall: null, images: new Map(), toolMode: 'native', suggestions: ['x'], sources: [], steps: 1 };
  });
  await act(async () => { await app.send({ text: '团子今天好调皮' }); });
  const reply = app.messages[app.messages.length - 1];
  expect(reply).toMatchObject({ role: 'assistant', status: 'complete', text: '团子今天乖不乖呀？' });
  expect(reply.agent?.recalled?.map((item) => item.title)).toEqual(['猫叫团子']);
  expect(reply.agent?.suggestions).toBeUndefined();
  expect(mockSchedule).toHaveBeenCalledWith(characterId);

  // The character's conversation never shows up in the assistant drawer.
  expect(app.conversations.filter((item) => item.kind === 'companion').map((item) => item.characterId)).toEqual([characterId]);

  await act(async () => { app.switchSpace('assistant'); });
  await waitFor(() => expect(app.activeConversationId).toBe(assistantConversation));
  expect(app.activeCharacterId).toBeNull();
  await act(async () => { app.switchSpace('companion'); });
  await waitFor(() => expect(app.activeCharacterId).toBe(characterId));
  expect(app.messages.map((message) => message.text ?? message.prompt)).toEqual([CHARACTER_TEMPLATES[0].greeting, '团子今天好调皮', '团子今天乖不乖呀？']);
});
