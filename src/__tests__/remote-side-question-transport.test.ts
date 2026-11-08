import { setHubFetch, type FetchLike } from '../remote/client';
import { askSessionSideQuestion, getRemoteState, bootRemote, connectStation, loadAgentProfiles, pairRemoteQr, parseRemoteQr, readSessionSideQuestion, resetRemoteForTests, restoreSessionSideQuestionStorageScope, sessionSideQuestionStorageScope, loadSessionSideQuestionHistoryScopes } from '../remote/store';
import { rememberSideQuestionPairing } from '../remote/side-question-history';
import { readTemporarySideChat, askTemporarySideChat, runTemporarySideChatTool } from '../remote/store';
import { deliveryCredentialId } from '../remote/connections';
const mockSettings = new Map<string, string>(), mockSecrets = new Map<string, string>();
let mockUuid = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `0199bbb1-1234-4678-9abc-${String(++mockUuid).padStart(12, '0')}` }));
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => { if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); } }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));
jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'this-device-only', getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); }, deleteItemAsync: async (key: string) => { mockSecrets.delete(key); } }));
const origin = 'https://side-questions-fixture.example', hubUrl = `${origin}/salcara-hub/v1`, sessionKey = 'codex:s';
const chainId = '00000000-0000-4000-8000-000000000001', operationId = '00000000-0000-4000-8000-000000000002', nextOperationId = '00000000-0000-4000-8000-000000000003';
const attachmentId = 'att_00000000000040008000000000000001';
const device = { deviceId: 'pc', name: 'Fixture', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 };
const catalog = () => ({ sessionKey, chainId, revision: 'runtime-1', available: true, contextScope: 'loadedSnapshot', contextMessages: 2, contextTruncated: false, turns: [] });
const response = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
let commands: Record<string, unknown>[], account: string, support: boolean, sideCap: boolean,toolsSupport:boolean;
let handle: (input: Record<string, unknown>) => unknown | Promise<unknown>;
async function pair() {
  await bootRemote([]); await connectStation(origin);
  await pairRemoteQr(parseRemoteQr(JSON.stringify({ type: 'salcara-remote-pair', version: 1, hubUrl, deviceId: 'pc', deviceName: 'Fixture', ticket: 'b'.repeat(64), expiresAt: Date.now() + 120000 })));
  await loadAgentProfiles('pc');
}
beforeEach(() => {
  resetRemoteForTests(); mockSettings.clear(); mockSecrets.clear(); mockUuid = 0; commands = []; account = 'api_aaaaaaaa'; support = true; sideCap = true;toolsSupport=true;
  handle = () => ({ ok: true, result: catalog() });
  setHubFetch((async (endpoint, init) => {
    if (endpoint.endsWith('/ping')) return response({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'], capabilities: ['device.identity.v1', 'pair.qr.v1', 'pair.revoke.v1', 'session.remote.v1', 'commands.idempotency.v1', ...(support ? ['session.side-question.persistent.v1', 'session.side-question.v1'] : []),...(toolsSupport?['session.side-question.tools.v1']:[])] });
    if (endpoint.endsWith('/app/pair/qr')) return response({ pair_token: 'a'.repeat(64), device });
    if (endpoint.endsWith('/app/devices')) return response({ devices: [device] });
    if (endpoint.endsWith('/app/commands')) {
      const input = JSON.parse(String(init.body)).command; commands.push(input);
      if (input.type === 'agents.status') return response({ ok: true, result: { agents: [{ id: 'codex', tool: 'codex', available: true,
        capabilities: { read: true, list: true, send: true, sideQuestion: sideCap }, execution: { tool: 'codex', controlSurface: 'cli' }, api: { source: 'computer', configured: true, accountId: account } }] } });
      return response(await handle(input));
    }
    return response({ events: [], nextSeq: 0, lastSeq: 0, hasMore: false });
  }) as FetchLike);
});
afterEach(() => { resetRemoteForTests(); setHubFetch(null); });
const reply = (input: Record<string, unknown>) => ({ ...catalog(), lastOperationId: input.operationId, turns: [{ operationId: input.operationId, question: input.question, selection: input.selection, state: 'completed', answer: '这是独立回答', createdAt: 1 }] });
test('opening a side panel refreshes read-only history, freezes it, and never writes a parent message', async () => {
  await pair(); const reading = await readSessionSideQuestion('pc', sessionKey, chainId, undefined, { create: true }), parent = getRemoteState().timelines;
  expect(commands.filter(value => value.type === 'session.open')).toEqual([{ type: 'session.open', sessionKey, limit: 400 }]);
  handle = input => ({ ok: true, result: reply(input) });
  const answer = await askSessionSideQuestion('pc', sessionKey, reading, { question: '这是什么意思' }, operationId);
  expect(answer.answer).toBe('这是独立回答'); expect(getRemoteState().timelines).toBe(parent);
  expect(commands.some(value => ['session.send', 'session.start', 'session.continue'].includes(String(value.type)))).toBe(false);
});

test('Hub temporary chat uses ephemeral commands and keeps drafts and answers out of durable side-question storage', async () => {
  await pair(); const before = new Map(mockSettings);
  handle = () => ({ ok:true, result:{...catalog(),inputOptions:{version:1,model:true,effort:true,images:true,readOnly:true,defaultModel:'model-a'}} });
  const reading = await readTemporarySideChat('pc',sessionKey,new AbortController().signal);
  handle = input => ({ok:true,result:{sessionKey,operationId:input.operationId,state:'completed',answer:'Temporary response',contextScope:'loadedSnapshot',contextMessages:2,contextTruncated:false}});
  await askTemporarySideChat('pc',sessionKey,reading,{question:'Explain',model:'model-b',effort:'high',attachments:[attachmentId]},operationId);
  expect(commands.filter(value=>String(value.type).startsWith('session.side-question')).map(value=>value.type)).toEqual(['session.side-question.catalog','session.side-question.ask']);
  expect(commands.at(-1)).toMatchObject({accountId:account,controlSurface:'cli',model:'model-b',effort:'high',attachments:[attachmentId]});
  expect(mockSettings).toEqual(before);
});

test('Hub temporary readings from an old API cannot authorize a new ask',async()=>{
  await pair();const reading=await readTemporarySideChat('pc',sessionKey,new AbortController().signal);
  account='api_bbbbbbbb';await loadAgentProfiles('pc');
  await expect(askTemporarySideChat('pc',sessionKey,reading,{question:'Stale'},operationId)).rejects.toMatchObject({name:'SideQuestionNotDispatchedError'});
  expect(commands.some(command=>command.type==='session.side-question.ask')).toBe(false);
});

test('Hub tools use a private command reply without changing timelines or saved settings',async()=>{
  await pair();handle=()=>({ok:true,result:{...catalog(),inputOptions:{version:1,model:true,effort:true,images:false,readOnly:true,defaultModel:'model-a',tools:{version:1,permissions:['workspace-write']}}}});
  const reading=await readTemporarySideChat('pc',sessionKey,new AbortController().signal),before=new Map(mockSettings),timeline=getRemoteState().timelines;
  handle=input=>({ok:true,result:{sessionKey,chainId:input.chainId,revision:input.expectedRevision,permission:'workspace-write',state:'idle',canSend:true,sequence:1,expiresAt:1000,answer:'private answer',events:[],approvals:[]}});
  const request={action:'open' as const,chainId,expectedRevision:reading.value.revision,operationId,permission:'workspace-write' as const};
  await expect(runTemporarySideChatTool('pc',sessionKey,reading,request)).resolves.toMatchObject({answer:'private answer'});
  expect(commands.at(-1)).toMatchObject({type:'session.side-question.tools',accountId:account,controlSurface:'cli',...request});
  expect(getRemoteState().timelines).toBe(timeline);expect(mockSettings).toEqual(before);
  account='api_bbbbbbbb';await loadAgentProfiles('pc');const count=commands.length;
  await expect(runTemporarySideChatTool('pc',sessionKey,reading,{...request,action:'read',operationId:undefined,permission:undefined})).rejects.toMatchObject({name:'SideQuestionNotDispatchedError'});expect(commands).toHaveLength(count);
});

test('older Hub never exposes tools even when a newer Bridge catalog reports them',async()=>{
  toolsSupport=false;await pair();handle=()=>({ok:true,result:{...catalog(),inputOptions:{version:1,model:true,effort:true,images:false,readOnly:true,defaultModel:'model-a',tools:{version:1,permissions:['workspace-write']}}}});
  const reading=await readTemporarySideChat('pc',sessionKey,new AbortController().signal);expect(reading.value.inputOptions?.tools).toBeUndefined();
  const count=commands.length;await expect(runTemporarySideChatTool('pc',sessionKey,reading,{action:'read',chainId,expectedRevision:reading.value.revision})).rejects.toMatchObject({name:'SideQuestionNotDispatchedError'});expect(commands).toHaveLength(count);
});
test('follow-ups keep the original reading and use only the confirmed operation as predecessor', async () => {
  await pair(); const reading = await readSessionSideQuestion('pc', sessionKey, chainId, undefined, { create: true }); handle = input => ({ ok: true, result: reply(input) });
  const first = await askSessionSideQuestion('pc', sessionKey, reading, { question: '第一问' }, operationId);
  expect(() => askSessionSideQuestion('pc', sessionKey, reading, { question: '错误分叉' }, nextOperationId)).toThrow('侧边对话已改变');
  await askSessionSideQuestion('pc', sessionKey, reading, { question: '继续说明', previousOperationId: first.operationId }, nextOperationId);
  expect(commands.filter(value => value.type === 'session.side-question.send')).toEqual([
    expect.objectContaining({ question: '第一问', expectedRevision: 'runtime-1', accountId: account }),
    expect.objectContaining({ question: '继续说明', expectedRevision: 'runtime-1', previousOperationId: first.operationId, accountId: account }),
  ]);
  expect(commands.filter(value => value.type === 'session.open')).toHaveLength(1);
});
test('double taps share one receipt and changes to the draft cannot alter the in-flight request', async () => {
  await pair(); const reading = await readSessionSideQuestion('pc', sessionKey, chainId), pending = deferred<unknown>(), started = deferred<void>(); let sent: Record<string, unknown> | undefined;
  handle = input => { sent = input; started.resolve(); return pending.promise; };
  const input = { question: '原始问题' }, first = askSessionSideQuestion('pc', sessionKey, reading, input, operationId), second = askSessionSideQuestion('pc', sessionKey, reading, input, operationId);
  expect(first).toBe(second); input.question = '修改后的草稿'; await started.promise;
  expect(sent!.question).toBe('原始问题'); expect(() => askSessionSideQuestion('pc', sessionKey, reading, input, operationId)).toThrow('仍在进行');
  pending.resolve({ ok: true, result: reply(sent!) }); await first;
  expect(commands.filter(value => value.type === 'session.side-question.send')).toHaveLength(1);
});
test('A-B-A rejects a delayed answer and any later follow-up from the old source', async () => {
  await pair(); const reading = await readSessionSideQuestion('pc', sessionKey, chainId), pending = deferred<unknown>(), started = deferred<void>(); let sent: Record<string, unknown> | undefined;
  handle = input => { sent = input; started.resolve(); return pending.promise; };
  const result = askSessionSideQuestion('pc', sessionKey, reading, { question: '解释' }, operationId); await started.promise;
  account = 'api_bbbbbbbb'; await loadAgentProfiles('pc'); account = 'api_aaaaaaaa'; await loadAgentProfiles('pc');
  pending.resolve({ ok: true, result: reply(sent!) }); await expect(result).rejects.toThrow('来源已改变');
  expect(() => askSessionSideQuestion('pc', sessionKey, reading, { question: '继续' }, nextOperationId)).toThrow('不能侧边提问');
});
test('an uncertain answer cannot be repeated with a new receipt', async () => {
  await pair(); const reading = await readSessionSideQuestion('pc', sessionKey, chainId);
  handle = input => ({ ok: true, result: { ...reply(input), turns: [{ ...reply(input).turns[0], state: 'unconfirmed', answer: '' }] } });
  expect((await askSessionSideQuestion('pc', sessionKey, reading, { question: '解释' }, operationId)).state).toBe('unconfirmed');
  expect(() => askSessionSideQuestion('pc', sessionKey, reading, { question: '解释' }, nextOperationId)).toThrow('结果未确认');
  expect(commands.filter(value => value.type === 'session.side-question.send')).toHaveLength(1);
});
test.each(['hub', 'adapter'])('absent %s capability does not read parent or submit a question', async missing => {
  if (missing === 'hub') support = false; else sideCap = false; await pair();
  await expect(readSessionSideQuestion('pc', sessionKey, chainId)).rejects.toThrow(); expect(commands.some(value => value.type === 'session.open' || String(value.type).startsWith('session.side-question'))).toBe(false);
});

test('empty agent profiles offline restore only the last verified history scope and cannot authorize a send', async () => {
  await pair(); const reading = await readSessionSideQuestion('pc', sessionKey, chainId), history = sessionSideQuestionStorageScope('pc', sessionKey);
  const count = commands.length; getRemoteState().agents = {}; getRemoteState().connection = 'error';
  expect(sessionSideQuestionStorageScope('pc', sessionKey)).toBe('');
  expect(await restoreSessionSideQuestionStorageScope('pc', sessionKey)).toBe(history);
  expect(() => askSessionSideQuestion('pc', sessionKey, reading, { question: '不能自动发' }, operationId)).toThrow();
  expect(commands).toHaveLength(count);
});

test('cold-start saved scope discovers previous pairing history before live agent profiles are available', async () => {
  await pair(); const history = sessionSideQuestionStorageScope('pc', sessionKey), connection = getRemoteState().connections[0];
  connection.computerId = 'verified-physical-pc';
  await rememberSideQuestionPairing(connection.id, connection.computerId, deliveryCredentialId('c'.repeat(64)), deliveryCredentialId('a'.repeat(64)));
  getRemoteState().agents = {};
  const count = commands.length, parts = JSON.parse(history);
  const expected = JSON.stringify([`${connection.id}|credential:${deliveryCredentialId('c'.repeat(64))}`, ...parts.slice(1)]);
  expect(await loadSessionSideQuestionHistoryScopes('pc', sessionKey, history)).toEqual([expected]);
  expect(commands).toHaveLength(count);
  expect(await loadSessionSideQuestionHistoryScopes('other-pc', sessionKey, history)).toEqual([]);
});
