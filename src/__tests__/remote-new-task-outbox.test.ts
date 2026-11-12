import { AppState } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { setHubFetch, type FetchLike } from '../remote/client';
import { acknowledgeNewSession, bootRemote, cachedAgentFeatures, connectStation, getPendingNewSession, getRemoteState, listAgentFeatures, loadAgentProfiles, newSessionReceiptKey, pairRemoteQr, parseRemoteQr, refreshDevices, remoteDeliveryScope, resetRemoteForTests, retryNewSession, sendToSession, startSession, timelineKey } from '../remote/store';
import { resetDeliveryForTests } from '../remote/delivery';
import { withdrawQueuedRemoteMessage } from '../remote/store';
import { decodeNewTask, encodeNewTask } from '../remote/new-task';
import { diffSelectionReference, parseDiffForAnnotations } from '../remote/diff-annotations';

const mockSettings = new Map<string,string>(), mockSecrets = new Map<string,string>();
let mockUuid=0, mockFailReceipt=false, mockFailCleanup=false;
jest.mock('expo-crypto',()=>({randomUUID:()=>`0199aaa1-1234-4678-9abc-${String(++mockUuid).padStart(12,'0')}`}));
jest.mock('../storage/database',()=>({getSetting:async(key:string)=>mockSettings.get(key)??null,
  setSetting:async(key:string,value:string|null)=>{
    if (key==='remote_pending_delivery_v1'&&(mockFailReceipt||mockFailCleanup&&value==='[]')) throw new Error('synthetic storage failure');
    if(value===null)mockSettings.delete(key);else mockSettings.set(key,value);
  }}));
jest.mock('../storage/secure-keys',()=>({getProviderKey:async()=>null}));
jest.mock('expo-secure-store',()=>({WHEN_UNLOCKED_THIS_DEVICE_ONLY:'private',getItemAsync:async(key:string)=>mockSecrets.get(key)??null,
  setItemAsync:async(key:string,value:string)=>{mockSecrets.set(key,value);},deleteItemAsync:async(key:string)=>{mockSecrets.delete(key);}}));
jest.mock('expo-file-system/legacy',()=>({documentDirectory:'file://private/',EncodingType:{Base64:'base64'},getInfoAsync:jest.fn(),readAsStringAsync:jest.fn(),makeDirectoryAsync:jest.fn(),copyAsync:jest.fn()}));

const origin='https://new-task-fixture.example', hubUrl=`${origin}/salcara-hub/v1`;
const device={deviceId:'pc',name:'Fixture',os:'windows',tools:[],projects:[],online:true,lastSeen:1};
const baseInput={tool:'codex' as const,cwd:'C:/fixture',prompt:'synthetic new task',approval:'ask' as const,model:'fixture-model',effort:'low' as const,composerDraft:{key:'private-draft',revision:1}};
const image={uri:'file://synthetic-image',base64:'AQID',mime:'image/jpeg' as const,width:1,height:1};
const response=(value:unknown)=>({ok:true,status:200,text:async()=>JSON.stringify(value)});
let writes:Array<{requestId:string;command:Record<string,unknown>}>, idempotency:boolean, diffCapability = false, projectlessCapability = false;
let handler:(body:typeof writes[number])=>unknown|Promise<unknown>;
function installTransport(){setHubFetch((async(endpoint,init)=>{
  if(endpoint.endsWith('/ping'))return response({service:'salcara-hub',protocol:'salcara-remote',protocolVersion:1,authModes:['device-pairing'],capabilities:['device.identity.v1','pair.qr.v1','session.remote.v1','pair.revoke.v1',...(projectlessCapability?['session.projectless.v1']:[]),...(diffCapability?['context.references.diff.v1']:[]),...(idempotency?['commands.idempotency.v1']:[])]});
  if(endpoint.endsWith('/app/pair/qr'))return response({pair_token:'a'.repeat(64),device});
  if(endpoint.endsWith('/app/devices'))return response({devices:[device]});
  if(endpoint.endsWith('/app/commands')){
    const body=JSON.parse(String(init.body));
    if(body.command.type==='agents.status')return response({ok:true,result:{agents:[{id:'codex',available:true,api:{configured:true,accountId:'api_fixture',source:'computer'}},{id:'claude',available:true,api:{configured:true,accountId:'api_claude',source:'computer'}}]}});
    writes.push(body);return response(await handler(body));
  }
  throw new Error('unexpected synthetic route');
}) as FetchLike);}
async function pair(){await bootRemote([]);await connectStation(origin);await pairRemoteQr(parseRemoteQr(JSON.stringify({type:'salcara-remote-pair',version:1,hubUrl,deviceId:'pc',deviceName:'Fixture',ticket:'b'.repeat(64),expiresAt:Date.now()+120_000})));await loadAgentProfiles('pc');}
async function restoreConnection() {
  await bootRemote([]);
  expect(getRemoteState()).toMatchObject({ phase: 'ready', selectedHubUrl: hubUrl });
  expect(getRemoteState().connectionId).toBeTruthy();
  await refreshDevices(); await loadAgentProfiles('pc');
}
beforeEach(()=>{
  resetRemoteForTests();mockSettings.clear();mockSecrets.clear();mockUuid=0;mockFailReceipt=false;mockFailCleanup=false;
  writes=[];idempotency=true;diffCapability=false;projectlessCapability=false;handler=body=>({ok:true,result:body.command.type==='session.start'?{sessionKey:'codex:created'}:{}});
  (AppState as unknown as {currentState:string}).currentState='active';
  (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({exists:true,isDirectory:false});
  (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue('AQID');
  (FileSystem.copyAsync as jest.Mock).mockResolvedValue(undefined);(FileSystem.makeDirectoryAsync as jest.Mock).mockResolvedValue(undefined);
  installTransport();
});
afterEach(()=>{resetRemoteForTests();setHubFetch(null);(AppState as unknown as {currentState:string}).currentState='active';});

function installQueuedStartFixture(holdOriginal = false) {
  const operationId = '0199aaa1-1234-4678-9abc-999999999991';
  const ticket = { operationId, ticket: 'original-store-ticket', storageEpoch: 'store-epoch', dispatchNotAfter: Date.now() + 600_000 };
  let state = 'prepared', prepares = 0, starts = 0, cancels = 0, finishOriginal: (() => void) | undefined;
  let notifyStarted!: () => void;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  const failed = (code: string, status: number) => ({ ok: false, status, text: async () => JSON.stringify({ ok: false, operationId, code, error: code }) });
  setHubFetch((async (endpoint, init) => {
    if (endpoint.endsWith('/ping')) return response({ service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, authModes: ['device-pairing'],
      capabilities: ['device.identity.v1','pair.qr.v1','session.remote.v1','pair.revoke.v1','commands.idempotency.v1','commands.durable.v2','commands.queue-cancel.v1'] });
    if (endpoint.endsWith('/app/pair/qr')) return response({ pair_token: 'a'.repeat(64), device });
    if (endpoint.endsWith('/app/devices')) return response({ devices: [device] });
    if (endpoint.endsWith('/app/commands/prepare')) {
      prepares++; return response({ ...ticket, state: 'prepared' });
    }
    if (endpoint.includes('/app/operations?')) {
      const url = new URL(endpoint);
      expect(url.searchParams.get('operationId')).toBe(operationId);
      expect(url.searchParams.get('ticket')).toBe(ticket.ticket);
      return response({ ...ticket, state, ok: state === 'prepared' || state === 'completed',
        ...(state === 'completed' ? { result: { sessionKey: 'codex:original-created' } } : {}) });
    }
    if (endpoint.endsWith('/app/operations/cancel')) {
      cancels++; expect(JSON.parse(String(init.body))).toEqual({ deviceId: 'pc', operationId, ticket: ticket.ticket });
      state = 'completed'; return failed('operation_not_cancellable', 409);
    }
    if (endpoint.endsWith('/app/operations/ack')) return response({ ok: true });
    if (endpoint.endsWith('/app/commands')) {
      const body = JSON.parse(String(init.body));
      if (body.command.type === 'agents.status') return response({ ok: true, result: { agents: [
        { id: 'codex', available: true, api: { configured: true, accountId: 'api_fixture', source: 'computer' } },
        { id: 'claude', available: true, api: { configured: true, accountId: 'api_claude', source: 'computer' } },
      ] } });
      expect(body.command.type).toBe('session.start'); starts++; writes.push(body);
      expect(body).toMatchObject({ requestId: operationId, executionTicket: ticket.ticket, command: { operationId } });
      state = 'queued'; notifyStarted();
      if (holdOriginal) return new Promise<ReturnType<typeof response>>(resolve => {
        finishOriginal = () => resolve(response({ ok: true, result: { sessionKey: 'codex:original-created' } }));
      });
      return response({ ok: false, state: 'queued' });
    }
    throw new Error('unexpected queued-start fixture route');
  }) as FetchLike);
  return { operationId, started, finish: () => finishOriginal!(), counts: () => ({ prepares, starts, cancels }) };
}

test('queue cancellation store integration: a claim winner restores the exact new-session receipt and survives local ACK failure', async () => {
  const fixture = installQueuedStartFixture(); await pair();
  await expect(startSession('pc', baseInput)).rejects.toThrow();
  const pending = (await getPendingNewSession('pc', 'codex'))!, scope = remoteDeliveryScope();
  expect(pending).toMatchObject({ durableProtocol: 2, executionId: fixture.operationId });
  expect(pending.requestId).not.toBe(fixture.operationId);
  const result = await withdrawQueuedRemoteMessage('pc', newSessionReceiptKey('codex'), pending.requestId, scope);
  expect(result).toEqual({ state: 'accepted', sessionKey: 'codex:original-created', composerDraft: baseInput.composerDraft });
  expect(await getPendingNewSession('pc', 'codex')).toMatchObject({
    requestId: pending.requestId, executionId: fixture.operationId, pausedByStop: true,
    acceptedSessionKey: 'codex:original-created', composerDraft: baseInput.composerDraft,
  });
  // This path is the existing accepted-receipt recovery, never another start.
  await expect(retryNewSession('pc', 'codex', false, pending.requestId)).resolves.toBe('codex:original-created');
  mockFailCleanup = true;
  await expect(acknowledgeNewSession('pc', 'codex', false, 'codex:original-created', scope)).rejects.toThrow('synthetic storage failure');
  expect((await getPendingNewSession('pc', 'codex'))!.requestId).toBe(pending.requestId);
  mockFailCleanup = false;
  await acknowledgeNewSession('pc', 'codex', false, 'codex:original-created', scope);
  expect(await getPendingNewSession('pc', 'codex')).toBeUndefined();
  expect(fixture.counts()).toEqual({ prepares: 1, starts: 1, cancels: 1 });
});

test('queue cancellation store integration: a late successful original HTTP cannot recreate a receipt already consumed by recovery', async () => {
  const fixture = installQueuedStartFixture(true); await pair();
  const original = startSession('pc', baseInput);
  await fixture.started;
  const pending = (await getPendingNewSession('pc', 'codex'))!, scope = remoteDeliveryScope();
  const result = await withdrawQueuedRemoteMessage('pc', newSessionReceiptKey('codex'), pending.requestId, scope);
  expect(result).toMatchObject({ state: 'accepted', sessionKey: 'codex:original-created' });
  await acknowledgeNewSession('pc', 'codex', false, 'codex:original-created', scope);
  fixture.finish();
  await expect(original).resolves.toBe('codex:original-created');
  expect(await getPendingNewSession('pc', 'codex')).toBeUndefined();
  expect(fixture.counts()).toEqual({ prepares: 1, starts: 1, cancels: 1 });
  expect(JSON.parse(mockSettings.get('remote.durable.commands.v2')!)[0]).toMatchObject({
    intentId: pending.requestId, cancelRequested: true, completed: { ok: true, result: { sessionKey: 'codex:original-created' } },
  });
});

test('image-only new tasks retain empty text and immutable images through the outbox', async () => {
  await pair();
  expect(await startSession('pc', { ...baseInput, prompt: '', images: [image] })).toBe('codex:created');
  const start = writes.find(row => row.command.type === 'session.start')!;
  expect(start.command.prompt).toBe('');
  expect(start.command.attachments).toHaveLength(1);
  const pending = await getPendingNewSession('pc', 'codex');
  expect(pending?.requestId).toBe(start.requestId);
  expect(pending?.text).toBe('');
  const saved = JSON.parse(mockSettings.get('remote_pending_delivery_v1')!)[0];
  expect(decodeNewTask(saved.text)).toMatchObject({ prompt: '', images: [expect.objectContaining({ mime: 'image/jpeg' })] });
  expect(getRemoteState().timelines[timelineKey('pc', 'codex:created')].items[0]).toMatchObject({ text: '', attachments: [expect.anything()] });
});

test('Code/Work mode is frozen in the new-task receipt before dispatch', async () => {
  await pair();
  expect(await startSession('pc', { ...baseInput, workspaceMode: 'work' })).toBe('codex:created');
  expect(writes.find(row => row.command.type === 'session.start')?.command.workspaceMode).toBe('work');
  const saved = JSON.parse(mockSettings.get('remote_pending_delivery_v1')!)[0];
  expect(decodeNewTask(saved.text).workspaceMode).toBe('work');
});

test('new task rejects an empty prompt without images before sending', async () => {
  await pair();
  await expect(startSession('pc', { ...baseInput, prompt: '  ' })).rejects.toThrow();
  expect(writes).toEqual([]);
});

test('reference-only new and existing turns preserve an empty body and exact snapshot through transport', async () => {
  await pair();
  const profile = getRemoteState().agents.pc.list.find(item => item.id === 'codex')!;
  profile.capabilities = { list: true, read: true, send: true, modelOverride: true, contextReferences: true,
    interrupt: false, approval: false, questions: false, subagents: false, attachments: false, imageInput: false, imageOutput: false };
  const contextReferences = [{ kind: 'file' as const, projectPath: 'C:/fixture', label: 'main.ts', path: 'main.ts', text: 'selected code', capturedAt: 1, startLine: 1, endLine: 1 }];
  expect(await startSession('pc', { ...baseInput, prompt: '', contextReferences })).toBe('codex:created');
  const start = writes.find(row => row.command.type === 'session.start')!;
  expect(start.command).toMatchObject({ prompt: '', contextReferences });
  const saved = JSON.parse(mockSettings.get('remote_pending_delivery_v1')!)[0];
  expect(decodeNewTask(saved.text)).toMatchObject({ prompt: '', contextReferences });
  await sendToSession('pc', 'codex:existing', '', { surface: 'cli', contextReferences });
  expect(writes.find(row => row.command.type === 'session.send')?.command).toMatchObject({ text: '', contextReferences });
  expect(getRemoteState().timelines[timelineKey('pc', 'codex:existing')].items[0]).toMatchObject({ text: '', contextReferences });
});

test.each(['supported', 'old-hub', 'old-bridge', 'stale'])('diff review follows real send receipt with %s transport', async support => {
  diffCapability = support !== 'old-hub'; await pair();
  const profile = getRemoteState().agents.pc.list.find(item => item.id === 'codex')!;
  profile.capabilities = { list: true, read: true, send: true, modelOverride: true, contextReferences: true, contextDiffAnnotations: support !== 'old-bridge',
    interrupt: false, approval: false, questions: false, subagents: false, attachments: false, imageInput: false, imageOutput: false };
  const p = parseDiffForAnnotations('a.ts', '@@ -1 +1 @@\n-old\n+new');
  getRemoteState().timelines[timelineKey('pc', 'codex:existing')] = { items: [{ kind: 'tool', id: 'edit', tool: 'file_change', title: 'a.ts', diff: '@@ -1 +1 @@\n-old\n+new', status: 'done', ts: 1 }], loading: false };
  const refs = [diffSelectionReference(p, 'codex:existing', 'old', 1, 1, '旧行'), diffSelectionReference(p, 'codex:existing', 'new', 1, 1, '新行')];
  if (support === 'stale') {
    getRemoteState().timelines[timelineKey('pc', 'codex:existing')].items.push({ kind: 'tool', id: 'new-edit', tool: 'file_change', title: 'a.ts', diff: '@@ -1 +1 @@\n-new\n+changed', status: 'done', ts: 2 });
    await expect(sendToSession('pc', 'codex:existing', '审查', { surface: 'cli', contextReferences: refs })).rejects.toThrow('差异版本已变化'); expect(writes).toEqual([]); return;
  }
  if (support !== 'supported') {
    await expect(sendToSession('pc', 'codex:existing', '审查', { surface: 'cli', contextReferences: refs })).rejects.toThrow('差异行批注'); expect(writes).toEqual([]); return;
  }
  handler = body => {
    const receipt = JSON.parse(mockSettings.get('remote_pending_delivery_v1')!)[0];
    expect(body.command).toMatchObject({ type: 'session.send', text: '审查', sessionKey: 'codex:existing', contextReferences: refs, operationId: body.requestId });
    expect(receipt.sendOptions.contextReferences).toEqual(refs); expect(receipt.requestId).toBe(body.requestId);
    return { ok: true, result: {} };
  };
  await sendToSession('pc', 'codex:existing', '审查', { surface: 'cli', contextReferences: refs });
  expect(writes).toHaveLength(1); expect(getRemoteState().timelines[timelineKey('pc', 'codex:existing')].items.at(-1)).toMatchObject({ clientId: writes[0].requestId, text: '审查', contextReferences: refs });
});

test('new task receipt commits before upload and carries exact UUID through first turn',async()=>{
  await pair();handler=body=>{
    const receipt=JSON.parse(mockSettings.get('remote_pending_delivery_v1')!)[0];
    expect(receipt.requestId).toBeTruthy();expect(receipt.text).not.toContain(image.base64);
    if(body.command.type==='attachment.put')expect(receipt.attachmentsUploaded).toBe(false);
    if(body.command.type==='session.start'){expect(body.requestId).toBe(receipt.requestId);expect(body.command.operationId).toBe(receipt.requestId);expect(body.command.attachments).toEqual(receipt.attachments);return{ok:true,result:{sessionKey:'codex:created'}};}
    return{ok:true,result:{}};
  };
  expect(await startSession('pc',{...baseInput,images:[image]})).toBe('codex:created');
  await acknowledgeNewSession('pc','codex',false,'codex:created',remoteDeliveryScope());
  expect(mockSettings.get('remote_pending_delivery_v1')).toBe('[]');
  expect(getRemoteState().timelines[timelineKey('pc','codex:created')].items[0]).toMatchObject({clientId:writes.at(-1)!.requestId,role:'user'});
});

test('failed receipt commit starts neither upload nor task and never overwrites old records',async()=>{
  await pair();mockFailReceipt=true;
  await expect(startSession('pc',{...baseInput,images:[image]})).rejects.toThrow('synthetic storage');expect(writes).toEqual([]);
  expect(mockSettings.get('remote_pending_delivery_v1')).toBeUndefined();
});

test('lost acceptance survives restart; only explicit original UUID retry can recover',async()=>{
  await pair();handler=()=>{throw new Error('synthetic lost acknowledgement');};
  await expect(startSession('pc',baseInput)).rejects.toMatchObject({name:'DeliveryPendingError',retryable:true});
  const original=writes[0], before=await getPendingNewSession('pc','codex');expect(before?.composerDraft).toEqual(baseInput.composerDraft);
  resetRemoteForTests();resetDeliveryForTests();await restoreConnection();
  await expect(startSession('pc',{...baseInput,prompt:'a different task'})).rejects.toMatchObject({name:'DeliveryPendingError'});
  await expect(retryNewSession('pc','codex',false,'00000000-1111-4222-8333-444444444444')).rejects.toMatchObject({name:'DeliveryPendingError'});
  handler=()=>({ok:true,result:{sessionKey:'codex:created'}});
  expect(await retryNewSession('pc','codex',false,before!.requestId)).toBe('codex:created');
  expect(writes).toEqual([original,original]);
});

test('accepted task still opens if cleanup fails; stored outcome recovers locally with no redispatch',async()=>{
  await pair();mockFailCleanup=true;
  expect(await startSession('pc',baseInput)).toBe('codex:created');
  const pending=await getPendingNewSession('pc','codex');expect(pending?.acceptedSessionKey).toBe('codex:created');
  mockFailCleanup=false;handler=()=>{throw new Error('must not call network for accepted outcome');};
  (AppState as unknown as {currentState:string}).currentState='background';
  expect(await retryNewSession('pc','codex',false,pending!.requestId)).toBe('codex:created');expect(writes).toHaveLength(1);
  await acknowledgeNewSession('pc','codex',false,'codex:created',remoteDeliveryScope());
  expect(await getPendingNewSession('pc','codex')).toBeUndefined();
});

test('upload failure restarts from original images and IDs, without a new operation',async()=>{
  await pair();handler=()=>{throw new Error('synthetic upload interruption');};
  await expect(startSession('pc',{...baseInput,images:[image]})).rejects.toMatchObject({name:'DeliveryPendingError'});
  const pending=await getPendingNewSession('pc','codex');const originalId=writes[0].command.id;
  resetDeliveryForTests();handler=body=>({ok:true,result:body.command.type==='session.start'?{sessionKey:'codex:created'}:{}});
  expect(await retryNewSession('pc','codex',false,pending!.requestId)).toBe('codex:created');
  expect(writes.filter(body=>body.command.type==='attachment.put').map(body=>body.command.id)).toEqual([originalId,originalId]);
  expect(writes.at(-1)!.requestId).toBe(pending!.requestId);
});

test.each(['background','missing-image','old-hub','foreign-result','corrupt-receipt'])('new task never silently duplicates or downgrades: %s',async(reason)=>{
  await pair();
  if(reason==='background'){
    handler=()=>{(AppState as unknown as {currentState:string}).currentState='background';return{ok:true,result:{}};};
    await expect(startSession('pc',{...baseInput,images:[image]})).rejects.toMatchObject({code:'new_task_not_dispatched'});
    expect(writes.some(body=>body.command.type==='session.start')).toBe(false);return;
  }
  if(reason==='corrupt-receipt'){
    mockSettings.set('remote_pending_delivery_v1','{future:corrupt');resetDeliveryForTests();
    await expect(startSession('pc',baseInput)).rejects.toThrow('无法读取');expect(writes).toEqual([]);return;
  }
  if(reason==='old-hub'){idempotency=false;resetRemoteForTests();await restoreConnection();}
  handler=()=>reason==='foreign-result'?{ok:true,result:{sessionKey:'claude:foreign'}}:(()=>{throw new Error('synthetic interruption');})();
  await expect(startSession('pc',{...baseInput,...(reason==='missing-image'?{images:[image]}:{})})).rejects.toMatchObject({name:'DeliveryPendingError'});
  const pending=await getPendingNewSession('pc','codex');const priorWrites=writes.length;
  if(reason==='missing-image')(FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({exists:false});
  await expect(retryNewSession('pc','codex',false,pending!.requestId)).rejects.toBeTruthy();expect(writes).toHaveLength(priorWrites);
});

test('snapshot validation separates desktop/code and refuses unsafe/future metadata',()=>{
  expect(newSessionReceiptKey('claude')).not.toBe(newSessionReceiptKey('claude',true));
  const snapshot={version:1 as const,...baseInput,images:[]};const encoded=encodeNewTask(snapshot);expect(decodeNewTask(encoded)).toEqual(snapshot);
  for(const changed of [{...snapshot,version:2},{...snapshot,extra:'future'},{...snapshot,composerDraft:{key:'x',revision:-1}},{...snapshot,tool:'codex',desktop:true}])expect(()=>decodeNewTask(JSON.stringify(changed))).toThrow();
});


test('feature directory carries exact project and selected API through transport', async () => {
  await pair(); handler=body=>({ok:true,result:{collaborationModes:['default','plan'],skillsSupported:true,skills:[{name:'review',path:'C:/fixture/SKILL.md',description:'Review'}]}});
  getRemoteState().agents.pc.list.find(item=>item.id==='codex')!.api.accountId='api_1234abcd';
  expect(await listAgentFeatures('pc','codex',{cwd:'C:/fixture'})).toMatchObject({skills:[{name:'review',path:'C:/fixture/SKILL.md'}]});
  expect(writes[0].command).toEqual({type:'features.list',tool:'codex',cwd:'C:/fixture',controlSurface:'cli',accountId:'api_1234abcd',syncVersion:1});
});

test('feature store reuses exact scope and sends a conditional revision after TTL', async () => {
  await pair(); const target={cwd:'C:/fixture'}, revision='a'.repeat(64);
  handler=body=>({ok:true,result:body.command.ifRevision?{notModified:true,revision}:{revision,collaborationModes:['default','plan'],skillsSupported:true,skills:[{name:'review',description:'old'}]}});
  const value=await listAgentFeatures('pc','codex',target);
  expect(cachedAgentFeatures('pc','codex',target)).toEqual(value);
  await listAgentFeatures('pc','codex',target); expect(writes).toHaveLength(1);
  expect(cachedAgentFeatures('pc','claude',target)).toBeUndefined();
  expect(cachedAgentFeatures('pc','codex',{cwd:'C:/other'})).toBeUndefined();
  const clock=jest.spyOn(Date,'now').mockReturnValue(Date.now()+30_001);
  try { expect(await listAgentFeatures('pc','codex',target)).toEqual(value); }
  finally { clock.mockRestore(); }
  expect(writes.at(-1)?.command.ifRevision).toBe(revision);
  await listAgentFeatures('pc','codex',target,{force:true});
  expect(writes.at(-1)?.command).toMatchObject({force:true});
  expect(writes.at(-1)?.command.ifRevision).toBe('a'.repeat(64));
});

test('feature store account and source changes cannot expose another directory', async () => {
  await pair(); const target={cwd:'C:/fixture'};
  handler=body=>({ok:true,result:{revision:'a'.repeat(64),collaborationModes:[],skillsSupported:true,skills:[{name:String(body.command.accountId),description:''}]}});
  await listAgentFeatures('pc','codex',target);
  const profile=getRemoteState().agents.pc.list.find(item=>item.id==='codex')!;
  profile.api.accountId='account_changed';
  expect(cachedAgentFeatures('pc','codex',target)).toBeUndefined();
  expect((await listAgentFeatures('pc','codex',target)).skills[0].name).toBe('account_changed');
  profile.api.source='phone'; expect(cachedAgentFeatures('pc','codex',target)).toBeUndefined();
  await listAgentFeatures('pc','codex',target); expect(writes).toHaveLength(3);
});

test('feature store discards a response whose account changed while it was loading', async () => {
  await pair(); let finish!:(value:unknown)=>void;
  handler=()=>new Promise(resolve=>{finish=resolve;});
  const read=listAgentFeatures('pc','codex',{cwd:'C:/fixture'}), failed=expect(read).rejects.toThrow('已切换');
  for(let i=0;i<10&&!finish;i++)await Promise.resolve();
  expect(finish).toBeDefined();
  getRemoteState().agents.pc.list.find(item=>item.id==='codex')!.api.accountId='account_changed';
  handler=()=>({ok:true,result:{collaborationModes:[],skillsSupported:true,skills:[{name:'current',description:''}]}});
  await listAgentFeatures('pc','codex',{cwd:'C:/fixture'});
  finish({ok:true,result:{collaborationModes:[],skillsSupported:true,skills:[{name:'stale',description:''}]}});
  await failed; expect(cachedAgentFeatures('pc','codex',{cwd:'C:/fixture'})?.skills[0].name).toBe('current');
});

test('feature store reset and cross-agent sessions never reuse a cached catalog', async () => {
  await pair(); handler=()=>({ok:true,result:{collaborationModes:[],skillsSupported:true,skills:[]}});
  await listAgentFeatures('pc','codex',{cwd:'C:/fixture'});
  await expect(listAgentFeatures('pc','codex',{sessionKey:'claude:other'})).rejects.toThrow('归属');
  expect(writes).toHaveLength(1);
  resetRemoteForTests(); expect(cachedAgentFeatures('pc','codex',{cwd:'C:/fixture'})).toBeUndefined();
});
test('new task sends feature selections as native fields and freezes skills before storage', async () => {
  await pair(); const profile=getRemoteState().agents.pc.list.find(item=>item.id==='codex')!;
  profile.capabilities={list:true,read:true,send:true,interrupt:true,approval:true,questions:true,subagents:true,attachments:true,imageInput:true,imageOutput:true,modelOverride:true,features:true};
  const skills=[{name:'review',path:'C:/fixture/SKILL.md'}];
  const start=startSession('pc',{...baseInput,collaborationMode:'plan',skills}); skills[0].name='mutated';
  await expect(start).resolves.toBe('codex:created');
  expect(writes.find(row=>row.command.type==='session.start')!.command).toMatchObject({collaborationMode:'plan',skills:[{name:'review',path:'C:/fixture/SKILL.md'}]});
  expect(getRemoteState().timelines[timelineKey('pc','codex:created')].items[0]).toMatchObject({
    role:'user',text:baseInput.prompt,skills:[{name:'review',path:'C:/fixture/SKILL.md'}],clientId:writes.find(row=>row.command.type==='session.start')!.requestId,
  });
  const accepted = await getPendingNewSession('pc','codex');
  resetRemoteForTests(); resetDeliveryForTests(); await restoreConnection();
  expect(await retryNewSession('pc','codex',false,accepted!.requestId)).toBe('codex:created');
  expect(writes.filter(row=>row.command.type==='session.start')).toHaveLength(1);
  expect(getRemoteState().timelines[timelineKey('pc','codex:created')].items[0]).toMatchObject({
    clientId:accepted!.requestId,skills:[{name:'review',path:'C:/fixture/SKILL.md'}],
  });
});


test('explicit projectless first send freezes the flag, empty cwd and operation id across restart recovery',async()=>{
 projectlessCapability=true; await pair();getRemoteState().devices[0].capabilities=['session.projectless.v1'];
 let first=true;handler=body=>{if(body.command.type==='session.start'&&first){first=false;throw new Error('connection lost');}return {ok:true,result:{sessionKey:'codex:created'}};};
 await expect(startSession('pc',{...baseInput,cwd:'',projectless:true,workspaceMode:'work'})).rejects.toThrow();
 const original=writes.find(row=>row.command.type==='session.start')!;
 expect(original.command).toMatchObject({projectless:true,cwd:'',controlSurface:'cli',workspaceMode:'work'});
 const saved=JSON.parse(mockSettings.get('remote_pending_delivery_v1')!)[0];
 expect(decodeNewTask(saved.text)).toMatchObject({cwd:'',projectless:true,workspaceMode:'work'});
 resetDeliveryForTests();
 expect(await retryNewSession('pc','codex',false,original.requestId)).toBe('codex:created');
 const starts=writes.filter(row=>row.command.type==='session.start');expect(starts).toHaveLength(2);expect(starts[1]).toEqual(starts[0]);
});
test.each(['bridge','hub','missing-choice'] as const)('projectless %s refuses before dispatch and does not substitute any directory',async missing=>{
 projectlessCapability=missing!=='hub';await pair();if(missing!=='bridge')getRemoteState().devices[0].capabilities=['session.projectless.v1'];
 await expect(startSession('pc',{...baseInput,cwd:'',...(missing!=='missing-choice'?{projectless:true as const}:{}),workspaceMode:'code'})).rejects.toThrow();
 expect(writes).toEqual([]);
});
test.each([{projectless:false},{projectless:'true'},{projectless:true,cwd:'C:/other'},{projectless:true,desktop:true}])('projectless persisted records reject invalid combinations %p',fields=>{
 const encoded=encodeNewTask({version:1,tool:'codex',cwd:'',projectless:true,prompt:'hello',workspaceMode:'code',approval:'ask',images:[]});
 expect(()=>decodeNewTask(JSON.stringify({...JSON.parse(encoded),...fields}))).toThrow();
});


test.each([false,'true',null])('nonliteral projectless option %p cannot be coerced into a new start',async flag=>{
 projectlessCapability=true;await pair();getRemoteState().devices[0].capabilities=['session.projectless.v1'];
 await expect(startSession('pc',{...baseInput,cwd:'',projectless:flag} as never)).rejects.toThrow();expect(writes).toEqual([]);
});
