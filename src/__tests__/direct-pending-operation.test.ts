import { createDirectPendingOperation, clearDirectPendingOperationScope, type DirectPendingOperation } from '../remote/direct-pending-operation';
const mockSettings = new Map<string,string>();
const mockSet = jest.fn(async (key:string,value:string) => { mockSettings.set(key,value); });
jest.mock('../storage/database', () => ({ getSetting: async (key:string) => mockSettings.get(key) ?? null, setSetting: (key:string,value:string) => mockSet(key,value) }));
const id = '12345678-1234-4123-8123-123456789abc', secondId = '23456789-1234-4123-8123-123456789abc';
const operation:DirectPendingOperation = { id,kind:'continue',expectedTurnId:'turn-1' };
const source = { pairing:'direct:binding',deviceId:'pc',owner:'session/agent/account/code' };
const setting = 'direct_pending_operations_v1';
beforeEach(() => { mockSettings.clear();mockSet.mockReset().mockImplementation(async (key,value) => { mockSettings.set(key,value); }); });

test('dispatch marker survives recreation and prevents an unconfirmed resend',async()=>{
  await createDirectPendingOperation(source).begin(operation);
  const restored = createDirectPendingOperation(source);
  expect(await restored.read()).toEqual(operation);
  await expect(restored.begin({...operation,id:secondId})).rejects.toThrow('未确认');
  await expect(restored.begin(operation)).rejects.toThrow('未确认');
  expect(await restored.read()).toEqual(operation);
});
test('only an exact operation receipt can clear the marker',async()=>{
  const store = createDirectPendingOperation(source);await store.begin(operation);
  expect(await store.clear(secondId)).toBe(false);expect(await store.read()).toEqual(operation);
  expect(await store.clear(id)).toBe(true);expect(await store.read()).toBeUndefined();
  await store.begin({...operation,id:secondId});expect(await store.read()).toMatchObject({id:secondId});
});
test('computer, binding, API and mode markers remain isolated',async()=>{
  await createDirectPendingOperation(source).begin(operation);
  for(const other of [{deviceId:'pc2'},{pairing:'direct:other'},{owner:'session/agent/account2/code'},{owner:'session/agent/account/work'}])expect(await createDirectPendingOperation({...source,...other}).read()).toBeUndefined();
});
test('simultaneous dispatches cannot replace one another',async()=>{
  const first=createDirectPendingOperation(source),second=createDirectPendingOperation(source);
  const outcomes=await Promise.allSettled([first.begin(operation),second.begin({...operation,id:secondId})]);
  expect(outcomes.map(result=>result.status)).toEqual(['fulfilled','rejected']);expect(await second.read()).toEqual(operation);
});
test('storage failure prevents dispatch and preserves an accepted-operation recovery marker',async()=>{
  const store=createDirectPendingOperation(source);mockSet.mockRejectedValueOnce(new Error('disk full'));
  await expect(store.begin(operation)).rejects.toThrow('disk full');expect(await store.read()).toBeUndefined();
  await store.begin(operation);mockSet.mockRejectedValueOnce(new Error('disk full'));
  await expect(store.clear(id)).rejects.toThrow('disk full');expect(await store.read()).toEqual(operation);
});
test('corrupted records block mutation and revoked scopes clear without touching other computers',async()=>{
  mockSettings.set(setting,'{broken');const store=createDirectPendingOperation(source);
  await expect(store.begin(operation)).rejects.toThrow('原内容未覆盖');expect(mockSettings.get(setting)).toBe('{broken');
  mockSettings.delete(setting);await store.begin(operation);
  const other=createDirectPendingOperation({...source,pairing:'direct:other'});await other.begin(operation);
  await clearDirectPendingOperationScope(source.pairing);expect(await store.read()).toBeUndefined();expect(await other.read()).toEqual(operation);
});
test('stale source cannot clear another screen dispatch',async()=>{
  let current=true;const store=createDirectPendingOperation({...source,isCurrent:()=>current});await store.begin(operation);current=false;
  await expect(store.clear(id)).rejects.toThrow('已变化');expect(await createDirectPendingOperation(source).read()).toEqual(operation);
});
