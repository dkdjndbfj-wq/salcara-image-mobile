import type { ProviderProfile } from '../domain';

let mockProviders: ProviderProfile[] = [];
let mockKeys: Record<string, string> = {};
const mockUpsert = jest.fn();
const mockDelete = jest.fn();
const mockReadKey = jest.fn();
const mockSaveKey = jest.fn();
const mockDeleteKey = jest.fn();
jest.mock('expo-crypto', () => ({ randomUUID: () => 'new-phone-api' }));
jest.mock('../storage/database', () => ({
  listProviders: async () => mockProviders,
  upsertProvider: (...args: unknown[]) => mockUpsert(...args),
  deleteProviderRecord: (...args: unknown[]) => mockDelete(...args),
}));
jest.mock('../storage/secure-keys', () => ({
  getProviderKey: (...args: unknown[]) => mockReadKey(...args),
  saveProviderKey: (...args: unknown[]) => mockSaveKey(...args),
  deleteProviderKey: (...args: unknown[]) => mockDeleteKey(...args),
}));
import { programmingApiDraft, saveProgrammingApi } from '../remote/api-library';

const profile = (patch: Partial<ProviderProfile> = {}): ProviderProfile => ({
  id: 'saved-phone-api', name: '已有 API', baseUrl: 'https://api.example/v1', model: 'image-config', chatModel: 'existing-chat',
  quality: 'high', aspectRatio: '2:1', resolutionTier: '2K', chatApi: 'anthropic', vendor: 'custom',
  analysisProviderId: 'analysis-api', imageProviderId: 'image-api', extra: { retained: 'field' }, createdAt: 1, updatedAt: 2, ...patch,
});
beforeEach(() => {
  jest.clearAllMocks(); mockProviders = []; mockKeys = {};
  mockReadKey.mockImplementation(async (id: string) => mockKeys[id] ?? null);
  mockSaveKey.mockImplementation(async (id: string, key: string) => { mockKeys[id] = key; });
  mockDeleteKey.mockImplementation(async (id: string) => { delete mockKeys[id]; });
  mockUpsert.mockImplementation(async (next: ProviderProfile) => { mockProviders = [...mockProviders.filter((item) => item.id !== next.id), next]; });
  mockDelete.mockImplementation(async (id: string) => { mockProviders = mockProviders.filter((item) => item.id !== id); });
});
const input = { name: '主力 API', baseUrl: 'https://api.example', key: 'synthetic-key' };

test('new resources store only metadata in SQLite and never select a model or app function', async () => {
  const saved = await saveProgrammingApi(input);
  expect(saved).toMatchObject({ name: '主力 API', baseUrl: 'https://api.example/v1', model: null, chatModel: null,
    quality: null, aspectRatio: null, resolutionTier: null, analysisProviderId: null, imageProviderId: null });
  expect(mockSaveKey).toHaveBeenCalledWith(saved.id, 'synthetic-key');
  expect(mockUpsert).toHaveBeenCalledWith(saved);
  expect(JSON.stringify(saved)).not.toContain('synthetic-key');
  expect(mockReadKey).not.toHaveBeenCalled();
});
test('draft editing never reads or exposes the saved key', () => {
  expect(programmingApiDraft(profile())).toEqual({ id: 'saved-phone-api', name: '已有 API', baseUrl: 'https://api.example/v1', key: '' });
  expect(mockReadKey).not.toHaveBeenCalled();
});
test('same origin edit retains the key and all latest shared-function configuration', async () => {
  const previous = profile(); mockProviders = [previous]; mockKeys[previous.id] = 'saved-synthetic-key';
  const saved = await saveProgrammingApi({ id: previous.id, name: '重命名', baseUrl: 'https://API.example/v2/', key: '' });
  expect(saved).toEqual({ ...previous, name: '重命名', baseUrl: 'https://api.example/v2', updatedAt: expect.any(Number) });
  expect(mockSaveKey).not.toHaveBeenCalled();
});
test.each(['https://another.example', 'https://api.example:8443'])('origin change %s requires a fresh key without reading old key', async (baseUrl) => {
  mockProviders = [profile()]; mockKeys['saved-phone-api'] = 'old-key';
  await expect(saveProgrammingApi({ ...input, id: 'saved-phone-api', baseUrl, key: '' })).rejects.toThrow('重新填写密钥');
  expect(mockReadKey).not.toHaveBeenCalled(); expect(mockUpsert).not.toHaveBeenCalled(); expect(mockSaveKey).not.toHaveBeenCalled();
});
test('origin change with explicit fresh key succeeds and never repurposes the old key', async () => {
  mockProviders = [profile()]; mockKeys['saved-phone-api'] = 'old-key';
  const saved = await saveProgrammingApi({ ...input, id: 'saved-phone-api', baseUrl: 'https://other.example', key: ' new-key ' });
  expect(mockSaveKey).toHaveBeenCalledWith(saved.id, 'new-key'); expect(saved.baseUrl).toBe('https://other.example/v1');
  expect(saved.chatModel).toBe('existing-chat');
});
test.each(['https://user:password@api.example', 'https://api.example?key=synthetic', 'https://api.example#secret', 'ftp://localhost', 'http://api.example'])('unsafe URL %s is rejected before secret or metadata writes', async (baseUrl) => {
  await expect(saveProgrammingApi({ ...input, baseUrl })).rejects.toThrow();
  expect(mockReadKey).not.toHaveBeenCalled(); expect(mockUpsert).not.toHaveBeenCalled(); expect(mockSaveKey).not.toHaveBeenCalled();
});
test('editing a removed resource cannot silently recreate it', async () => {
  await expect(saveProgrammingApi({ ...input, id: 'removed' })).rejects.toThrow('已被删除');
  expect(mockSaveKey).not.toHaveBeenCalled();
});
test('new metadata failure restores both stores even if a write had completed before throwing', async () => {
  mockUpsert.mockImplementationOnce(async (next: ProviderProfile) => { mockProviders.push(next); throw new Error('synthetic-key must not appear'); });
  await expect(saveProgrammingApi(input)).rejects.toThrow('没有保存成功，请重试');
  expect(mockProviders).toEqual([]); expect(mockKeys).toEqual({});
  expect(mockDelete).toHaveBeenCalledWith('new-phone-api'); expect(mockDeleteKey).toHaveBeenCalledWith('new-phone-api');
});
test('existing save failure restores original metadata and original secret', async () => {
  const previous = profile(); mockProviders = [previous]; mockKeys[previous.id] = 'old-key';
  mockUpsert.mockRejectedValueOnce(new Error('new-key'));
  await expect(saveProgrammingApi({ ...input, id: previous.id, key: 'new-key' })).rejects.toThrow('没有保存成功，请重试');
  expect(mockProviders).toEqual([previous]); expect(mockKeys[previous.id]).toBe('old-key');
  expect(mockSaveKey.mock.calls).toEqual([[previous.id, 'new-key'], [previous.id, 'old-key']]);
});
test('SecureStore partial failure restores the key without writing metadata', async () => {
  mockSaveKey.mockImplementationOnce(async (id: string, key: string) => { mockKeys[id] = key; throw new Error('synthetic-key'); });
  await expect(saveProgrammingApi(input)).rejects.toThrow('没有保存成功，请重试');
  expect(mockUpsert).not.toHaveBeenCalled(); expect(mockKeys).toEqual({});
});
test('old-key read failures are sanitized and do not overwrite metadata', async () => {
  mockProviders = [profile()]; mockReadKey.mockRejectedValueOnce(new Error('private-read-error'));
  await expect(saveProgrammingApi({ ...input, id: 'saved-phone-api' })).rejects.toThrow('没有读到已保存的密钥，请重试');
  expect(mockUpsert).not.toHaveBeenCalled(); expect(mockSaveKey).not.toHaveBeenCalled();
});
