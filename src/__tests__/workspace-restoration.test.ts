const mockDisk = new Map<string,string>();
const mockRead = jest.fn(async (key:string) => mockDisk.get(key) ?? null);
const mockWrite = jest.fn(async (key:string,value:string|null) => {if(value===null)mockDisk.delete(key);else mockDisk.set(key,value);});
jest.mock('../storage/database',()=>({getSetting:(key:string)=>mockRead(key),setSetting:(key:string,value:string|null)=>mockWrite(key,value)}));
import { discardWorkspaceFileDraft, flushWorkspaceFileDrafts, hydrateWorkspaceFileDrafts, readWorkspaceFileDraft, resetWorkspaceFileDraftMemoryForTests, saveWorkspaceFileDraft } from '../remote/workspace-file-drafts';
import { loadWorkspaceLayout, parseWorkspaceLayout, resetWorkspaceLayoutMemoryForTests, saveWorkspaceLayout, type WorkspaceLayout } from '../remote/workspace-layout';

const identity={scope:'paired:credential',deviceId:'pc',agentId:'codex',sessionKey:'codex:one',surface:'cli' as const,cwd:'C:/repo',path:'index.ts'};
const base={path:'index.ts',text:'original',size:8,modifiedAt:1,revision:'a'.repeat(64)};
beforeEach(()=>{mockDisk.clear();mockRead.mockClear();mockWrite.mockClear();resetWorkspaceFileDraftMemoryForTests();resetWorkspaceLayoutMemoryForTests();});

test('unsaved file content and its base version survive process restart only in the exact scope',async()=>{
  saveWorkspaceFileDraft(identity,base,'edited');await flushWorkspaceFileDrafts(identity.scope);
  resetWorkspaceFileDraftMemoryForTests();expect(readWorkspaceFileDraft(identity)).toBeUndefined();
  await hydrateWorkspaceFileDrafts('replacement-pairing');expect(readWorkspaceFileDraft({...identity,scope:'replacement-pairing'})).toBeUndefined();
  await hydrateWorkspaceFileDrafts(identity.scope);expect(readWorkspaceFileDraft(identity)).toEqual({base,text:'edited'});
  discardWorkspaceFileDraft(identity);await flushWorkspaceFileDrafts(identity.scope);resetWorkspaceFileDraftMemoryForTests();await hydrateWorkspaceFileDrafts(identity.scope);
  expect(readWorkspaceFileDraft(identity)).toBeUndefined();
});

test('rapid edits are serialized and leave the last accepted text on disk',async()=>{
  for(let i=0;i<20;i++)saveWorkspaceFileDraft(identity,base,`draft ${i}`);
  await flushWorkspaceFileDrafts(identity.scope);resetWorkspaceFileDraftMemoryForTests();await hydrateWorkspaceFileDrafts(identity.scope);
  expect(readWorkspaceFileDraft(identity)?.text).toBe('draft 19');
});

test('discard during slow hydration cannot resurrect the old draft',async()=>{
  saveWorkspaceFileDraft(identity,base,'old');await flushWorkspaceFileDrafts(identity.scope);resetWorkspaceFileDraftMemoryForTests();
  const raw=[...mockDisk.values()][0];let finish!:(value:string|null)=>void;
  mockRead.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const loading=hydrateWorkspaceFileDrafts(identity.scope);discardWorkspaceFileDraft(identity);finish(raw);await loading;await flushWorkspaceFileDrafts(identity.scope);
  expect(readWorkspaceFileDraft(identity)).toBeUndefined();expect(mockDisk.size).toBe(0);
});

test('corrupt drafts are not overwritten with an empty successful recovery',async()=>{
  mockDisk.set('remote.workspace.file-drafts.v2:'+identity.scope,'{broken');
  await expect(hydrateWorkspaceFileDrafts(identity.scope)).rejects.toThrow();expect(mockDisk.values().next().value).toBe('{broken');
});

const layout:WorkspaceLayout={scope:'pc-a:session-a',activeId:'browser:7',browserEvents:['observed-open-event'],pages:[
  {id:'terminal:6',title:'终端',kind:'terminal'},
  {id:'browser:7',title:'Example',kind:'preview',preview:{kind:'web',url:'https://example.com/two'},browserPageId:'desktop-page-1',browserHistory:{urls:['https://example.com/one','https://example.com/two'],index:1}},
]};
test('tab order, selected tab, desktop identity and navigation history survive restart without restarting a shell',async()=>{
  await saveWorkspaceLayout(layout);resetWorkspaceLayoutMemoryForTests();
  const result=await loadWorkspaceLayout(layout.scope);expect(result).toMatchObject({...layout,pages:[{...layout.pages[0],restored:true},layout.pages[1]]});
  expect(await loadWorkspaceLayout('pc-b:session-a')).toBeUndefined();
});
test('unsafe saved URLs, malformed diffs and different scopes never restore',()=>{
  expect(parseWorkspaceLayout(JSON.stringify(layout),'other')).toBeUndefined();
  expect(parseWorkspaceLayout(JSON.stringify({...layout,pages:[{...layout.pages[1],preview:{kind:'web',url:'javascript:alert(1)'}}]}),layout.scope)).toBeUndefined();
  expect(parseWorkspaceLayout(JSON.stringify({...layout,pages:[{...layout.pages[0],changes:{}}]}),layout.scope)).toBeUndefined();
});

test('project preview restores only its source identity, without a process lease or automatic run command',async()=>{
  const page:WorkspaceLayout['pages'][number]={id:'project-preview:src/App.tsx',kind:'project-preview',title:'预览 App.tsx',
    projectPreview:{sourcePath:'src/App.tsx',selection:{deviceId:'pc',agentId:'codex',sessionKey:'codex:one',surface:'cli',cwd:'C:/repo'}}};
  const saved:WorkspaceLayout={scope:layout.scope,pages:[page],activeId:page.id};
  await saveWorkspaceLayout(saved);resetWorkspaceLayoutMemoryForTests();
  expect(await loadWorkspaceLayout(layout.scope)).toEqual(saved);
  expect([...mockDisk.values()][0]).not.toMatch(/runId|operationId|localhost|127\.0\.0\.1/);
  expect(parseWorkspaceLayout(JSON.stringify({...saved,pages:[{...page,projectPreview:{...page.projectPreview,runId:'stale-lease'}}]}),saved.scope)).toBeUndefined();
  expect(parseWorkspaceLayout(JSON.stringify({...saved,pages:[{...page,projectPreview:{...page.projectPreview,sourcePath:'../other/App.tsx'}}]}),saved.scope)).toBeUndefined();
});
