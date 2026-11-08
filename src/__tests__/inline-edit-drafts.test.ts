import { createInlineEditDraft, inlineEditDraftKey } from '../remote/inline-edit-drafts';
import { createComposerDraftSession } from '../remote/composer-drafts';

const mockSettings = new Map<string,string>();
const mockGet = jest.fn(async(key:string):Promise<string|null> => mockSettings.get(key) ?? null);
const mockSet = jest.fn(async(key:string,value:string) => { mockSettings.set(key,value); });
jest.mock('../storage/database',()=>({getSetting:(key:string)=>mockGet(key),setSetting:(key:string,value:string)=>mockSet(key,value)}));
jest.mock('expo-crypto',()=>({randomUUID:()=>require('node:crypto').randomUUID(),CryptoDigestAlgorithm:{SHA256:'SHA256'},digestStringAsync:async(_:string,value:string)=>require('node:crypto').createHash('sha256').update(value).digest('hex')}));
const scope='pairing|credential:test';
beforeEach(()=>{mockSettings.clear();mockGet.mockReset().mockImplementation(async key=>mockSettings.get(key)??null);mockSet.mockReset().mockImplementation(async(key,value)=>{mockSettings.set(key,value);});});
const open=async(identity:string,owner=scope)=>{const draft=createInlineEditDraft(owner,'pc',identity);await draft.restore();return draft;};

test('leaving flushes the final keystroke before the next editor restores the same identity',async()=>{
 const first=await open('immediate');first.stage('Last keystroke, including trailing space ');
 const closing=first.close(),next=createInlineEditDraft(scope,'pc','immediate');
 expect(await next.restore()).toEqual({text:'Last keystroke, including trailing space ',error:undefined});await closing;await next.close();
});

test('an intentionally empty edit survives reopen; explicit cancellation consumes only that draft',async()=>{
 const first=await open('empty');first.stage('');await first.close();
 const next=createInlineEditDraft(scope,'pc','empty');expect((await next.restore()).text).toBe('');await next.discard();await next.close();
 const canceled=createInlineEditDraft(scope,'pc','empty');expect((await canceled.restore()).text).toBeUndefined();await canceled.close();
});

test('source and message identities are hashed and isolated from the main input draft',async()=>{
 const source='computer-a|api-secret-identity|code|session|original-message-text';
 const writer=await open(source);writer.stage('Private edit');await writer.flush();
 const main=createComposerDraftSession(`${scope}|pc|codex:thread`,scope);await main.restore();await main.save({text:'Unrelated draft',images:[]});
 const other=await open(source.replace('code','work'));expect((await other.restore()).text).toBeUndefined();
 const otherPair=await open(source,'other-pair');expect((await otherPair.restore()).text).toBeUndefined();
 expect(inlineEditDraftKey(scope,'pc',source)).not.toContain('api-secret-identity');
 expect(await main.restore()).toMatchObject({text:'Unrelated draft'});
 await writer.close();await other.close();await otherPair.close();main.dispose();
});

test('a failed save retains the previous disk version and unsaved text for explicit recovery',async()=>{
 const writer=await open('failure');writer.stage('Old');await writer.flush();const disk=mockSettings.get('remote_composer_drafts_v1');
 writer.stage('New unsaved');mockSet.mockRejectedValueOnce(new Error('Disk unavailable'));
 await expect(writer.flush()).rejects.toThrow('Disk unavailable');expect(mockSettings.get('remote_composer_drafts_v1')).toBe(disk);
 mockSet.mockRejectedValueOnce(new Error('Still unavailable'));await expect(writer.close()).rejects.toThrow('Still unavailable');
 const next=createInlineEditDraft(scope,'pc','failure');expect(await next.restore()).toMatchObject({text:'New unsaved',error:'Still unavailable'});
 await next.flush();await next.close();
 const recovered=createInlineEditDraft(scope,'pc','failure');expect(await recovered.restore()).toEqual({text:'New unsaved',error:undefined});await recovered.close();
});

test('an old cancellation cannot remove a newer window edit',async()=>{
 const old=await open('windows');old.stage('Old');await old.flush();
 const next=await open('windows');next.stage('New');await next.flush();
 await expect(old.discard()).rejects.toThrow('已变化');
 expect((await createInlineEditDraft(scope,'pc','windows').restore()).text).toBe('New');
 await old.close();await next.close();
});

test('acceptance after the bubble unmounts clears only its frozen revision',async()=>{
 const writer=await open('accepted');writer.stage('Submitted');const receipt=await writer.flush();await writer.close();
 await writer.consume(receipt);
 const reopened=createInlineEditDraft(scope,'pc','accepted');expect((await reopened.restore()).text).toBeUndefined();await reopened.close();
});

test('a late acceptance cannot consume a newer draft with the same original message',async()=>{
 const old=await open('late');old.stage('Submitted');const receipt=await old.flush();await old.close();
 const next=await open('late');next.stage('Newer draft');await next.flush();
 await expect(old.consume(receipt)).rejects.toThrow('其他窗口');
 await next.close();const reopened=createInlineEditDraft(scope,'pc','late');expect((await reopened.restore()).text).toBe('Newer draft');await reopened.close();
});

test('full 100k code text round-trips without JSON-envelope truncation',async()=>{
 const text='"\\'.repeat(50_000),writer=await open('long');writer.stage(text);await writer.close();
 const reopened=createInlineEditDraft(scope,'pc','long');expect((await reopened.restore()).text).toBe(text);await reopened.close();
});

test('a superseded window cannot stage stale text over the new active editor',async()=>{
 const old=await open('superseded');old.stage('Older pending');
 const next=await open('superseded');next.stage('Newest');await next.flush();
 expect(()=>old.stage('Late keystroke')).toThrow('已变化');
 await old.close();await next.close();
 const reopened=createInlineEditDraft(scope,'pc','superseded');expect((await reopened.restore()).text).toBe('Newest');await reopened.close();
});
