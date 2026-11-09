import { projectBrowserRequest } from '../remote/project-browser';

const mockCommand = jest.fn(), mockDirect = jest.fn();
let mockScope = 'pair-generation-1', mockGeneration = 1;
let mockCredentials = {url:'https://fixture.invalid/hub',pairToken:'synthetic-pair'};
let mockDirectDevice = 'pc';
jest.mock('../remote/client', () => ({command:(...args: unknown[])=>mockCommand(...args)}));
jest.mock('../remote/store', () => ({watchCredentials:()=>mockCredentials,remoteDeliveryScope:()=>mockScope,getRemoteState:()=>({devices:[{deviceId:'pc',online:true}]})}));
jest.mock('../remote/direct-api', () => ({requestDirect:(...args: unknown[])=>mockDirect(...args)}));
jest.mock('../remote/direct-pairing', () => ({directDeliveryScope:()=>mockScope,directConnectionGeneration:()=>mockGeneration,getDirectConnectionState:()=>({deviceId:mockDirectDevice,status:'connected'})}));
beforeEach(()=>{jest.clearAllMocks();mockScope='pair-generation-1';mockGeneration=1;mockDirectDevice='pc';mockCredentials={url:'https://fixture.invalid/hub',pairToken:'synthetic-pair'};mockCommand.mockResolvedValue({});mockDirect.mockResolvedValue({});});

test.each(['remote','direct'] as const)('%s directory mutations carry only workspace identity and are never repeated by the requester',async transport=>{
  const call=transport==='remote'?mockCommand:mockDirect;
  call.mockRejectedValueOnce(new Error('response lost'));
  const request=projectBrowserRequest(transport,'pc','codex','work');
  await expect(request({action:'mkdir',cwd:'C:/allowed',path:'',name:'chosen'})).rejects.toThrow('response lost');
  expect(call).toHaveBeenCalledTimes(1);
  const cmd=call.mock.calls[0][transport==='remote'?2:0];
  expect(cmd).toEqual({type:'workspace.projects',controlSurface:'cli',tool:'codex',workspaceMode:'work',action:'mkdir',cwd:'C:/allowed',path:'',name:'chosen'});
  if(transport==='remote')expect(call.mock.calls[0].slice(0,2)).toEqual([mockCredentials,'pc']);
});

test.each(['remote','direct'] as const)('%s rejects a late reply and blocks further mutations after connection identity changes',async transport=>{
  let finish!:(value:unknown)=>void;
  const call=transport==='remote'?mockCommand:mockDirect;
  call.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const request=projectBrowserRequest(transport,'pc','codex','code');
  const pending=request({action:'list',cwd:'',path:''});
  mockScope='pair-generation-2';mockGeneration++;
  const rejected=expect(pending).rejects.toThrow('电脑连接已变化');finish({roots:[]});await rejected;
  await expect(request({action:'mkdir',cwd:'C:/allowed',path:'',name:'must-not-create'})).rejects.toThrow('电脑连接已变化');
  expect(call).toHaveBeenCalledTimes(1);
});

test.each(['remote','direct'] as const)('%s explorer uses a distinct command and cannot select a parent disk as the project',async transport=>{
 const call=transport==='remote'?mockCommand:mockDirect;
 const request=projectBrowserRequest(transport,'pc','claude','work',true);
 await request({action:'mkdir',cwd:'C:/',path:'Users/test/.projects',name:'new'});
 expect(call.mock.calls[0][transport==='remote'?2:0]).toEqual({type:'workspace.explorer',controlSurface:'cli',tool:'claude',workspaceMode:'work',action:'mkdir',cwd:'C:/',path:'Users/test/.projects',name:'new'});
 await expect(request({action:'select',cwd:'C:/',path:''})).rejects.toThrow('命名');expect(call).toHaveBeenCalledTimes(1);
});
