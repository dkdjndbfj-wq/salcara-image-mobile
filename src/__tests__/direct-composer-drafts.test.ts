import {createDirectComposerDraft,directDraftKey,type DirectDraftInput} from '../remote/direct-composer-drafts';
const mockSettings=new Map<string,string>(),mockFiles=new Map<string,string>();
const mockGet=jest.fn(async(key:string)=>mockSettings.get(key)??null),mockSet=jest.fn(async(key:string,value:string)=>{mockSettings.set(key,value);});
jest.mock('../storage/database',()=>({getSetting:(key:string)=>mockGet(key),setSetting:(key:string,value:string)=>mockSet(key,value)}));
jest.mock('expo-crypto',()=>({randomUUID:()=>require('node:crypto').randomUUID(),CryptoDigestAlgorithm:{SHA256:'SHA256'},digestStringAsync:async(_algorithm:string,text:string)=>require('node:crypto').createHash('sha256').update(text).digest('hex')}));
jest.mock('expo-file-system/legacy',()=>({documentDirectory:'file://direct-draft-tests/',EncodingType:{Base64:'base64'},getInfoAsync:async(uri:string)=>({exists:mockFiles.has(uri),isDirectory:false}),
  readAsStringAsync:async(uri:string)=>mockFiles.get(uri)??'',writeAsStringAsync:async(uri:string,bytes:string)=>{mockFiles.set(uri,bytes);},makeDirectoryAsync:async()=>{},deleteAsync:async(uri:string)=>{mockFiles.delete(uri);}}));
const scope='direct:binding',owner='binding/pc/codex:s/account-a',setting='remote_composer_drafts_v1';
const input:DirectDraftInput={text:'review this',model:'model-a',effort:'high',permission:'auto_review',images:[],options:{collaborationMode:'plan',skills:[{name:'review',path:'C:/skills/review/SKILL.md'}],contextReferences:[{kind:'message',sessionKey:'codex:s',messageId:'m',label:'Agent',text:'exact',startOffset:0,endOffset:5,capturedAt:1}]}};
beforeEach(()=>{jest.clearAllMocks();mockSettings.clear();mockFiles.clear();mockGet.mockImplementation(async(key:string)=>mockSettings.get(key)??null);});

test('text, all composer choices and private image snapshots restore together',async()=>{
  const first=createDirectComposerDraft(scope,'pc',owner);await first.restore();
  const image={uri:'file://picker/photo.png',width:20,height:20,mime:'image/png' as const,base64:Buffer.from('photo').toString('base64')};
  const saved=await first.save({...input,images:[image]});first.close();
  const second=createDirectComposerDraft(scope,'pc',owner),restored=await second.restore();
  expect(restored).toMatchObject({...input,images:[{...image,base64:'',uri:saved.images[0].uri}],imageCount:1});
  expect(mockSettings.get(setting)).not.toContain(image.base64);expect(await second.hydrate(restored!)).toEqual([{...image,uri:saved.images[0].uri}]);second.close();
});

test('binding, API, project and Code/Work owners have separate draft keys',async()=>{
  const first=createDirectComposerDraft(scope,'pc',owner);await first.restore();await first.save(input);first.close();
  for(const [pairing,nextOwner] of [[scope,owner+'/other-api'],[scope,owner+'/other-project'],[scope,owner+'/work'],['direct:new-binding',owner]]){
    expect(directDraftKey(pairing,'pc',nextOwner)).not.toBe(directDraftKey(scope,'pc',owner));
    const other=createDirectComposerDraft(pairing,'pc',nextOwner);expect(await other.restore()).toBeUndefined();other.close();
  }
});

test('saving before hydration is rejected and accepted drafts consume only their exact revision',async()=>{
  const draft=createDirectComposerDraft(scope,'pc',owner);await expect(draft.save(input)).rejects.toThrow('尚未读取');await draft.restore();
  const first=await draft.save(input);await draft.save({...input,text:'newer text'});expect(await draft.consume(first)).toBe(false);
  expect(await draft.restore()).toMatchObject({text:'newer text'});draft.close();
});

test('corrupted or mismatched draft envelopes never become empty input',async()=>{
  const first=createDirectComposerDraft(scope,'pc',owner);await first.restore();await first.save(input);first.close();
  const rows=JSON.parse(mockSettings.get(setting)!);rows[directDraftKey(scope,'pc',owner)].text=JSON.stringify({version:1,owner:'other',text:'wrong'});mockSettings.set(setting,JSON.stringify(rows));
  const next=createDirectComposerDraft(scope,'pc',owner);await expect(next.restore()).rejects.toThrow('来源');await expect(next.save(input)).rejects.toThrow('尚未读取');next.close();
});

test('a later mounted owner fences delayed reads and saves from an old composer',async()=>{
  let release!:(value:string|null)=>void;mockGet.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
  const old=createDirectComposerDraft(scope,'pc',owner),reading=old.restore();
  await new Promise(resolve=>setTimeout(resolve,0));const current=createDirectComposerDraft(scope,'pc',owner);release(null);
  await expect(reading).rejects.toThrow('会话已改变');await current.restore();await current.save({...input,text:'current'});
  await expect(old.save(input)).rejects.toThrow();expect(await current.restore()).toMatchObject({text:'current'});old.close();current.close();
});

test('visiting empty composers does not consume the shared draft capacity',async()=>{
  const draft=createDirectComposerDraft(scope,'pc',owner);await draft.restore();await draft.save({text:'',options:{},model:'',effort:'',permission:'',images:[]});
  expect(JSON.parse(mockSettings.get(setting)!)).toEqual({});draft.close();
});
