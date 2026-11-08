import { appendRecoveredDirectDraft, recoverDirectMessageDraft } from '../remote/direct-retry-draft';
const mockCached=jest.fn(),mockRead=jest.fn();
jest.mock('../remote/attachment-cache',()=>({cachedAttachment:(...args:any[])=>mockCached(...args),parseAttachmentPage:(value:any)=>value}));
jest.mock('../remote/drafts',()=>({readRemoteRetryImages:(...args:any[])=>mockRead(...args)}));
jest.mock('../remote/direct-api',()=>({requestDirect:jest.fn()}));
const image={uri:'file://private/image.png',base64:'aW1hZ2U=',mime:'image/png' as const,width:20,height:30};
const ref={id:'att_11111111222243338444555555555555',mime:'image/png',width:20,height:30};
const message:any={kind:'message',id:'original',role:'user',text:'Image task',final:true,attachments:[ref],ts:1,skills:[{name:'review',path:'C:/review/SKILL.md'}]};
const services:any={guard:jest.fn()};
const args=()=>({pairing:'direct:pairing',deviceId:'pc',sessionKey:'codex:task',message,services,signal:new AbortController().signal});
beforeEach(()=>{jest.clearAllMocks();services.guard.mockReset();mockCached.mockResolvedValue(image.uri);mockRead.mockResolvedValue([image]);});

test('original images are materialized in the paired session scope and all input context is retained',async()=>{
  const input=await recoverDirectMessageDraft(args());
  expect(mockCached).toHaveBeenCalledWith('direct:pairing\0["pc","codex:task"]',ref,expect.any(Function),expect.any(AbortSignal));
  expect(mockRead).toHaveBeenCalledWith([{uri:image.uri,mime:ref.mime,width:20,height:30}]);
  expect(input).toMatchObject({text:'Image task',images:[image],imageCount:1,missingImages:false,options:{skills:message.skills}});
});

test('missing references, incomplete bytes, and a changed desktop never produce a partial restored prompt',async()=>{
  await expect(recoverDirectMessageDraft({...args(),message:{...message,attachments:undefined,images:['file://missing.png']}})).rejects.toThrow('引用不完整');
  mockRead.mockResolvedValue([]);await expect(recoverDirectMessageDraft(args())).rejects.toThrow('尚未完整恢复');
  mockCached.mockImplementation(async()=>{services.guard.mockImplementation(()=>{throw new Error('电脑已变化');});return image.uri;});
  await expect(recoverDirectMessageDraft(args())).rejects.toThrow('电脑已变化');
});

test('explicit append retains existing unsent data and checks image bounds before returning a new draft',()=>{
  const current:any={text:'Current draft',options:{collaborationMode:'plan'},images:[image],model:'selected',effort:'high',permission:'ask'};
  const recovered:any={text:'Original prompt',options:{skills:message.skills},images:[{...image,uri:'file://other.png'}],model:'',effort:'',permission:''};
  expect(appendRecoveredDirectDraft(current,recovered)).toMatchObject({text:'Current draft\n\nOriginal prompt',model:'selected',effort:'high',permission:'ask',options:{collaborationMode:'plan',skills:message.skills},images:[image,recovered.images[0]]});
  expect(()=>appendRecoveredDirectDraft({...current,images:[image,image,image,image]},recovered)).toThrow('超过 4 张');
  expect(current.text).toBe('Current draft');expect(current.images).toHaveLength(1);
});
