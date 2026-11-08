import {command} from '../remote/client';
import {captureComputerPreview,isComputerLoopbackURL,parsePreviewFrame,type ComputerPreview} from '../remote/workspace-preview';
jest.mock('expo/fetch',()=>({fetch:jest.fn()}));
jest.mock('../remote/client',()=>({...jest.requireActual('../remote/client'),command:jest.fn()}));
let mockState:any,mockCredentials:any,mockScope='';const mockListeners=new Set<()=>void>();
jest.mock('../remote/store',()=>({getRemoteState:()=>mockState,watchCredentials:()=>mockCredentials,remoteDeliveryScope:()=>mockScope,timelineKey:(d:string,s:string)=>`${d}|${s}`,
 onRemoteChange:(fn:()=>void)=>{mockListeners.add(fn);return()=>mockListeners.delete(fn);}}));
const selection={deviceId:'pc',sessionKey:'codex:session',agentId:'codex',surface:'cli' as const,cwd:'C:/project'};
const reply={pageId:'synthetic-preview-0001',url:'http://localhost:3000/',width:640,height:480,nextSequence:1,imageBase64:'/9j/AA=='};
const previews:ComputerPreview[]=[];const create=()=>{const p=captureComputerPreview(selection,jest.fn());previews.push(p);return p;};
beforeEach(()=>{jest.clearAllMocks();mockListeners.clear();mockScope='station|phone1';mockCredentials={url:'https://relay.test',pairToken:'synthetic-token'};
 mockState={devices:[{deviceId:'pc',online:true,capabilities:['workspace.preview.v1'],projects:[{path:selection.cwd}]}],sessions:{pc:{list:[{sessionKey:selection.sessionKey,cwd:selection.cwd,controlSurface:'cli'}]}},timelines:{},agents:{}};
 (command as jest.Mock).mockImplementation(async(_h,_d,c)=>c.type==='workspace.preview.input'?{pageId:reply.pageId,sequence:c.sequence}:reply);});
afterEach(()=>previews.splice(0).forEach(p=>p.dispose()));
test('only explicit computer loopback targets qualify for remote browsing',()=>{
 for(const value of ['http://localhost:3000','http://127.0.0.1:5173/a','https://[::1]:8443/'])expect(isComputerLoopbackURL(value)).toBe(true);
 for(const value of ['file:///secret','http://username:password@localhost:3000/','https://other.test','http://localhost.evil.test'])expect(isComputerLoopbackURL(value)).toBe(false);
});
test('inputs are serialized, bound to the same session and never retried after uncertain delivery',async()=>{
 const p=create();await p.open(reply.url,640,480);await Promise.all([p.input({action:'click',x:5,y:5}),p.input({action:'text',text:'你好'})]);
 expect((command as jest.Mock).mock.calls.filter(call=>call[2].type==='workspace.preview.input').map(call=>call[2].sequence)).toEqual([1,2]);
 (command as jest.Mock).mockRejectedValueOnce(new Error('disconnected'));
 await expect(p.input({action:'key',key:'Enter'})).rejects.toThrow();const count=(command as jest.Mock).mock.calls.length;
 await expect(p.input({action:'key',key:'Enter'})).rejects.toThrow();expect(command).toHaveBeenCalledTimes(count);
});
test.each(['computer','credential','session','project','offline'])('retiring %s blocks stale frame and input delivery',async(change)=>{
 const p=create();await p.open(reply.url,640,480);
 if(change==='computer')mockScope='other-pc';if(change==='credential')mockCredentials={...mockCredentials,pairToken:'new'};
 if(change==='session')mockState.sessions.pc.list[0].cwd='C:/different';if(change==='project')mockState.devices[0].projects=[];if(change==='offline')mockState.devices[0].online=false;
 mockListeners.forEach(fn=>fn());await expect(p.frame(true)).rejects.toThrow();await expect(p.input({action:'text',text:'no'})).rejects.toThrow();expect(command).toHaveBeenCalledTimes(1);
});
test('late response after computer replacement is discarded',async()=>{
 let complete!:(value:unknown)=>void;(command as jest.Mock).mockReturnValueOnce(new Promise(resolve=>{complete=resolve;}));
 const pending=create().open(reply.url,640,480);mockScope='new-pc';complete(reply);await expect(pending).rejects.toThrow();
});
test('foreign page, oversized image and invalid dimensions are rejected',()=>{
 expect(()=>parsePreviewFrame(reply,'another-preview')).toThrow();expect(()=>parsePreviewFrame({...reply,width:10000})).toThrow();
 expect(()=>parsePreviewFrame({...reply,imageBase64:'a'.repeat(230*1024)})).toThrow();
});
test('closing uses only the same live owner and releases listeners',async()=>{
 const p=create();await p.open(reply.url,640,480);p.dispose();expect((command as jest.Mock).mock.calls.at(-1)[2]).toMatchObject({type:'workspace.preview.close',pageId:reply.pageId,sessionKey:selection.sessionKey});expect(mockListeners.size).toBe(0);
});
