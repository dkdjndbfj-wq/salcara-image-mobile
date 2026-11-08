import React from 'react';
import {DEMO_AGENT_FEATURES} from '../../src/remote/demo-agent-features';
import {outputItems} from './conversation-output-data';
import {commandOutputItems} from './command-output-data';
import {createContextFixture} from './context-fixture';
import {SIMULATED_REMOTE_AGENTS} from '../../src/remote/development-fixture';
const allAgentsPreview=new URLSearchParams(globalThis.location?.search??'').get('agent-catalog')==='all';
const outputScene=new URLSearchParams(globalThis.location?.search??'').get('scene')==='conversation-outputs';
const commandPreview=new URLSearchParams(globalThis.location?.search??'').get('command-output');
const completedPreview=new URLSearchParams(globalThis.location?.search??'').get('completed')==='1';
const hermesState=new URLSearchParams(globalThis.location?.search??'').get('hermes-state');
const editOutcome=new URLSearchParams(globalThis.location?.search??'').get('edit-outcome');
const connectionPreview=new URLSearchParams(globalThis.location?.search??'').get('connection-preview');
const directoryActivity=new URLSearchParams(globalThis.location?.search??'').get('directory-activity');
const conversationRefinements=new URLSearchParams(globalThis.location?.search??'').get('conversation-refinements')==='1';

const deviceId = 'preview-pc';
const sessionKey = 'codex:preview-thread';
const contextFixture = createContextFixture(sessionKey, 'preview-context');
// Opt-in, in-memory command states for the actual command menu. No remote APIs.
export function createSessionCommandFixture(key, scope) {
  const mode = new URLSearchParams(globalThis.location?.search ?? '').get('session-commands');
  const enabled = ['ready', 'unavailable', 'unconfirmed', 'error'].includes(mode);
  let revision = 1, operation = 0, archived = false, actionUnconfirmed = false, reviewUnconfirmed = false;
  const checkRead = signal => { if (signal?.aborted) throw new Error('读取已取消'); if (mode === 'error') throw new Error('本地示例读取失败'); };
  const revisionId = () => `local-command-${revision}`;
  const validate = reading => { if (!enabled || mode === 'unavailable' || reading.scope !== scope || reading.value.sessionKey !== key || reading.value.revision !== revisionId()) throw new Error('本地示例状态已改变'); };
  return {
    enabled, mode, scope: () => scope, isCurrent: () => true,
    readActions: async signal => {
      checkRead(signal);
      return { scope, value: { sessionKey: key, revision: revisionId(), title: '本地示例对话', archived,
        actions: enabled && mode !== 'unavailable' && !actionUnconfirmed && !archived ? ['fork', 'archive'] : [],
        ...(!enabled || mode === 'unavailable' ? { unavailableReason: '当前会话暂不支持此操作' } : actionUnconfirmed ? { unavailableReason: '上次操作结果未确认' } : {}) } };
    },
    applyAction: async (reading, action) => {
      validate(reading); if (actionUnconfirmed || !reading.value.actions.includes(action) || !['fork', 'archive'].includes(action)) throw new Error('本地示例不能执行此操作');
      const operationId = `local-operation-${++operation}`;
      if (mode === 'unconfirmed') { actionUnconfirmed = true; return { sessionKey: key, operationId, action, state: 'unconfirmed' }; }
      revision++; if (action === 'archive') archived = true;
      return { sessionKey: key, operationId, action, state: 'completed', session: { sessionKey: action === 'fork' ? `codex:local-branch-${operation}` : key,
        tool: 'codex', client: 'Local preview', title: '本地示例对话', cwd: 'C:/fixture', updatedAt: Date.now(), status: 'idle', controllable: true, controlSurface: 'cli', archived } };
    },
    readWorkflows: async signal => {
      checkRead(signal);
      return { scope, value: { sessionKey: key, revision: revisionId(), canReview: enabled && mode !== 'unavailable' && !reviewUnconfirmed,
        goalSupported: false, goalActions: [], ...(!enabled || mode === 'unavailable' ? { unavailableReason: '当前会话暂不支持此操作' } : reviewUnconfirmed ? { unavailableReason: '上次审查结果未确认' } : {}) } };
    },
    applyReview: async reading => {
      validate(reading); if (reviewUnconfirmed || !reading.value.canReview) throw new Error('本地示例不能开始审查');
      const operationId = `local-operation-${++operation}`;
      if (mode === 'unconfirmed') { reviewUnconfirmed = true; return { sessionKey: key, operationId, kind: 'review', state: 'unconfirmed' }; }
      revision++; return { sessionKey: key, operationId, kind: 'review', state: 'requested', turnId: `local-review-${operation}` };
    },
  };
}
const sessionCommandFixtures = new Map();
const sessionCommandsFor = (key = sessionKey) => {
  if (!sessionCommandFixtures.has(key)) sessionCommandFixtures.set(key, createSessionCommandFixture(key, `preview-session-commands:${key}`));
  return sessionCommandFixtures.get(key);
};
const sessionCommandsEnabled = sessionCommandsFor().enabled;
export const previewAgent = {
  id: 'codex', name: 'Codex', tool: 'codex', available: true, remoteSendSupported: true,
  api: { name: '工作 API', model: 'gpt-5.1', source: 'computer', configured: true, pending: false, protocol: 'responses' },
  capabilities: { list: true, read: true, send: true, interrupt: true, approval: true, questions: true, subagents: true,
    attachments: true, imageInput: true, imageOutput: true, modelOverride: true, continue: true, preciseInterrupt: true, features:true,latestTurnRevert:outputScene,context:contextFixture.enabled,compact:contextFixture.enabled,
    sessionActions:sessionCommandsEnabled,sessionWorkflows:sessionCommandsEnabled,permissionModes: ['ask', 'auto_review', 'full_access'] },
};
export const previewSession = { latestTurnRevert:outputScene,sessionKey, tool: 'codex', client: 'Codex App', title: outputScene?'项目概览 · 本地界面验收':'修复移动端对话布局', cwd: 'D:\\Projects\\Salcara', workspaceMode: 'code', updatedAt: Date.now(), status: commandPreview||outputScene||completedPreview?'idle':'running', controllable: true, controlSurface: 'cli', model: 'gpt-5.1' };
// Opt-in catalogue for the real home/API surfaces. All assignments stay in memory.
const catalogueProfiles=SIMULATED_REMOTE_AGENTS.map(profile=>({...profile,...(profile.id==='codex'?previewAgent:{}),
  api:{...profile.api,accountId:`preview-${profile.id}`}}));
const catalogueApis=catalogueProfiles.map(profile=>({id:profile.api.accountId,name:profile.api.name,models:[profile.api.model]}));
const sessions = [
  previewSession,
  { ...previewSession, sessionKey: 'codex:preview-tests', title: '检查图片预览与手势', status: 'running', updatedAt: Date.now() - 3600000 },
  { ...previewSession, sessionKey: 'codex:preview-design', title: '整理手机端工具栏', status: 'waiting_approval', updatedAt: Date.now() - 7200000 },
  { ...previewSession, sessionKey: 'codex:preview-work', title: '梳理发布前验证', workspaceMode: 'work', status: 'idle', updatedAt: Date.now() - 86400000 },
];
if(allAgentsPreview)sessions.push(...catalogueProfiles.filter(profile=>profile.id==='deepseek-harness'||profile.id==='hermes')
  .map((profile,index)=>({...previewSession,sessionKey:`${profile.id}:preview-thread`,tool:profile.tool,client:profile.name,
    title:`${profile.name} 本地示例`,model:profile.api.model,status:'idle',latestTurnRevert:false,updatedAt:Date.now()+index+1})));
if (hermesState === 'progress') { previewSession.status = 'running'; previewSession.activeTurnId = 'hermes-preview-turn'; }
if (hermesState === 'approval') previewSession.status = 'waiting_approval';
if(directoryActivity==='running'||directoryActivity==='approval'){
  previewSession.status='idle';
  sessions.push({...previewSession,sessionKey:'codex:preview-child',parentSessionKey:sessionKey,title:'仅用于主会话状态汇总的子任务',status:'running'});
  if(directoryActivity==='approval')sessions.push({...previewSession,sessionKey:'codex:preview-grandchild',parentSessionKey:'codex:preview-child',title:'等待回复的子任务',status:'waiting_approval'});
}
const liveItems = [
  { kind: 'message', id: 'user-1', role: 'user', text: '请检查图片预览在窄屏上的边界，并修复横向溢出。', final: true, ts: Date.now() - 42000, seq: 1 },
  { kind: 'message', id: 'assistant-1', role: 'assistant', text: '我先检查消息容器和图片预览的尺寸约束，再验证手机宽度下的滚动行为。', final: true, ts: Date.now() - 40000, seq: 2, messagePhase: 'commentary' },
  { kind: 'tool', id: 'tool-1', tool: 'command', title: '检查消息布局组件', detail: 'rg -n "ImagePreview|overflow" src/components', status: 'done', output: 'src/components/ImagePreview.tsx\nsrc/components/MessageContent.tsx', outputFinal: true, ts: Date.now() - 36000, seq: 3, durationMs: 840 },
  { kind: 'tool', id: 'tool-2', tool: 'file_change', title: '修改图片预览约束', detail: 'src/components/ImagePreview.tsx', status: 'done', output: 'maxWidth: 100%\naspectRatio: intrinsic', outputFinal: true, ts: Date.now() - 26000, seq: 4, durationMs: 1200 },
  { kind: 'message', id: 'assistant-2', role: 'assistant', text: '布局已限制在消息列宽度内。接下来我会检查图片查看器和旋转屏幕时的表现。', final: true, ts: Date.now() - 18000, seq: 5, messagePhase: 'commentary' },
  { kind: 'tool', id: 'tool-3', tool: 'command', title: '运行图片预览测试', detail: 'npm test -- --runInBand generated-image-gallery', status: 'running', ts: Date.now() - 5000, seq: 6, startedAt: Date.now() - 5000 },
];
const completedItems = [
  ...liveItems.map(item=>item.id==='tool-3'?{...item,status:'done',output:'图片预览测试通过。',outputFinal:true,durationMs:2300}:item),
  {kind:'message',id:'assistant-final',role:'assistant',text:'已修复图片预览的尺寸约束，手机宽度下没有横向溢出，相关测试通过。',final:true,messagePhase:'final_answer',ts:Date.now()-2000,seq:7},
  {kind:'turn',id:'turn-completed',turnId:'preview-turn',status:'completed',ts:Date.now()-2000,seq:8},
];
// Optional reference conversation exercises the actual main-thread renderer;
// this development-only fixture never supplies production session content.
const referenceNow = Date.now();
const referenceItems = [
  { kind: 'turn', id: 'reference-start', turnId: 'reference-finished', status: 'started', ts: referenceNow - 80_000 },
  { kind: 'message', id: 'reference-final', turnId: 'reference-finished', role: 'assistant', text: '主对话的消息和执行过程会按时间顺序显示。`ThreadView` 与 `DirectConversation` 使用相同的正文样式，已完成回复的耗时来自电脑返回的回合记录。', final: true, messagePhase: 'final_answer', ts: referenceNow - 64_000 },
  { kind: 'turn', id: 'reference-end', turnId: 'reference-finished', status: 'completed', durationMs: 16_000, ts: referenceNow - 64_000 },
  { kind: 'message', id: 'reference-long-user', role: 'user', text: '请检查主对话的阅读体验：长消息应当可以展开和收起，短消息保持完整显示。\n电脑返回的执行过程要与正文保持相同的顺序，不要混入其他回合的统计。\n切换到手机宽度后，代码和命令可以在自己的区域滚动，不要把页面撑宽。\n用户向上阅读历史时，新内容不能把位置拉回底部。\n我会再查看平板和手机两种尺寸的展示结果。', final: true, messageOrigin: { kind: 'delegation', verification: 'native_reported' }, ts: referenceNow - 45_000 },
  { kind: 'message', id: 'reference-short-user', role: 'user', text: '主对话也要按照这个样式做好。', final: true, ts: referenceNow - 30_000 },
  { kind: 'turn', id: 'reference-live-start', turnId: 'reference-live', status: 'started', ts: referenceNow - 26_000 },
  { kind: 'message', id: 'reference-progress', turnId: 'reference-live', role: 'assistant', text: '我会核对正文消息、执行过程、代码展示和会话状态。先检查实际界面，再验证长消息展开以及返回最新的行为。', messagePhase: 'commentary', final: true, ts: referenceNow - 20_000 },
  { kind: 'tool', id: 'reference-command', turnId: 'reference-live', tool: 'command', title: '检查主对话样式', detail: 'rg -n "userBubble|turnHeader|stepText" src/remote/thread-styles.ts', status: 'running', output: '正在读取主对话组件与共享样式。', ts: referenceNow - 5_000, startedAt: referenceNow - 5_000 },
];
const hermesItems = [
  { kind: 'message', id: 'hermes-user', role: 'user', text: '检查项目中的界面与运行日志。这是本地交互预览，不会连接真实 Agent。', turnId: 'hermes-preview-turn', final: true, ts: Date.now() - 5000 },
  { kind: 'turn', id: 'hermes-start', turnId: 'hermes-preview-turn', status: 'started', ts: Date.now() - 4000 },
  ...(hermesState === 'progress' ? [{ kind: 'tool', id: 'hermes-plan', tool: 'plan', turnId: 'hermes-preview-turn', title: '检查项目', output: '✓ 读取项目\n▸ 检查界面\n○ 运行验证', status: 'done', ts: Date.now() - 3000 }] : []),
  ...(hermesState === 'approval' ? [{ kind: 'approval', id: 'hermes-approval', approval: 'command', title: '查看项目日志', detail: 'git status\n' + Array.from({length:18},(_,i)=>`# 第 ${i+1} 项检查说明：仅用于完整审批详情预览`).join('\n'), state: 'pending', expiresAt: Date.now() + 3600000, ts: Date.now() - 3000 }] : []),
  ...(hermesState === 'quota' ? [{ kind: 'turn', id: 'hermes-error', turnId: 'hermes-preview-turn', status: 'failed', error: '已达到使用额度（本地示例）', errorCode: 'usage_limit', retryAt: Date.now() + 600000, ts: Date.now() - 1000 }] : []),
];
const items = ['progress','approval','quota'].includes(hermesState)?hermesItems:commandPreview?commandOutputItems(commandPreview==='long'):outputScene?[...outputItems.map(item=>({...item,turnId:'preview-edit-turn'})),{kind:'turn',id:'preview-edit-terminal',turnId:'preview-edit-turn',status:'completed',ts:4}]:new URLSearchParams(globalThis.location?.search ?? '').get('conversation') === 'reference' ? referenceItems : completedPreview?completedItems:liveItems;
let state = {
  phase: 'ready', serviceId: 'preview-service', connections: [{ id: 'preview-connection', hubUrl: 'https://preview.invalid', deviceId, ...(allAgentsPreview?{deviceName:'工作电脑'}:{}) }],
  connectionId: 'preview-connection', selectedHubUrl: 'https://preview.invalid', probes: {}, connection: 'open', devicesLoaded: true,
  devices: [{ deviceId, name: '工作电脑', online: true, os: 'windows', lastSeen: Date.now(), tools: [], projects: [{ name: 'Salcara', path: 'D:\\Projects\\Salcara' }] }],
  agents: { [deviceId]: { list: allAgentsPreview?catalogueProfiles:[previewAgent], apis: allAgentsPreview?catalogueApis:[], loading: false, loaded: true } },
  sessions: { [deviceId]: { list: sessions, loading: false, loaded: true } },
  timelines: Object.fromEntries(sessions.map(session=>[`${deviceId}|${session.sessionKey}`, {
    items: session.sessionKey===sessionKey?items:session.sessionKey==='codex:preview-tests'?liveItems:[
      {kind:'message',id:`local-${session.sessionKey}`,role:'assistant',text:`${session.title}。这是用于检查侧栏切换的本地示例会话，不连接模型。`,final:true,messagePhase:'final_answer',ts:Date.now(),seq:1},
    ], loading:false, session, snapshotAt:Date.now(),
  }])),
  approvals: {}, signingIn: null, focus: null,
};
const previewListeners=new Set();
const notifyPreview=()=>{for(const listener of previewListeners)listener();};
// Opt-in local completion and recoverable thumbnail for conversation QA only.
if(outputScene&&conversationRefinements){
  previewAgent.capabilities.contextReferences=true;
  const target=`${deviceId}|${sessionKey}`,timeline=state.timelines[target];
  state={...state,timelines:{...state.timelines,[target]:{...timeline,items:[...timeline.items,
    {kind:'message',id:'history-with-reference',role:'user',text:'保留这段代码，再检查紧凑布局。',final:true,ts:5,contextReferences:[{kind:'file',projectPath:'D:/Projects/Salcara',path:'README.md',label:'README.md',startLine:1,endLine:1,text:'# 本地验收引用',capturedAt:1}]},
    {kind:'message',id:'retry-thumbnail',role:'assistant',text:'图片重试验收：只重新加载本张缩略图。',final:true,ts:6,images:['/preview-image.svg?conversation-retry=1']},
  ]}}};
  setTimeout(()=>{
    const key='codex:preview-tests',at=Date.now(),session={...state.sessions[deviceId].list.find(item=>item.sessionKey===key),status:'idle',activeTurnId:undefined,lastTerminalTurnId:'local-unread-turn',updatedAt:at};
    state={...state,sessions:{...state.sessions,[deviceId]:{...state.sessions[deviceId],list:state.sessions[deviceId].list.map(item=>item.sessionKey===key?session:item)}},timelines:{...state.timelines,[`${deviceId}|${key}`]:{loading:false,snapshotAt:at,session,items:[
      {kind:'message',id:'local-unread-final',turnId:'local-unread-turn',role:'assistant',text:'图片预览与手势检查已完成。这条本地示例用于验证未读结果。',final:true,messagePhase:'final_answer',ts:at},
      {kind:'turn',id:'local-unread-end',turnId:'local-unread-turn',status:'completed',ts:at},
    ]}}};notifyPreview();
  },4000);
}
// Opt-in local-only disconnect/reconnect states for the real conversation UI.
if(outputScene&&connectionPreview==='reconnect'){
  state={...state,connection:'closed',devices:state.devices.map(device=>({...device,online:false}))};
  setTimeout(()=>{state={...state,connection:'open',devices:state.devices.map(device=>({...device,online:true})),timelines:{...state.timelines,[`${deviceId}|${sessionKey}`]:{...state.timelines[`${deviceId}|${sessionKey}`],loading:true}}};notifyPreview();},8000);
  setTimeout(()=>{state={...state,timelines:{...state.timelines,[`${deviceId}|${sessionKey}`]:{...state.timelines[`${deviceId}|${sessionKey}`],loading:false,snapshotAt:Date.now()}}};notifyPreview();},16000);
}
export const useRemote = () => React.useSyncExternalStore(listener=>{previewListeners.add(listener);return()=>previewListeners.delete(listener);},()=>state,()=>state);
export const getRemoteState = () => state;
export const remoteConnectionRevision = () => 0;
export const timelineKey = (id, key) => `${id}|${key}`;
export const EMPTY_TIMELINE = { items: [], loading: false };
export const remoteDeliveryScope = () => 'local-preview-scope';
export const setRemoteScreenOpen = () => {};
export const setRemoteFocus = () => {};
export const resetIncompleteTurnRecovery = () => {};
export const lastAgent = async () => 'codex';
export const loadAgentProfiles = async () => state.agents[deviceId];
export const previewDeviceId = deviceId;
export const apiRemoteProblem = () => null;
export const apiStationChoices = async () => [];
export const setAgentApi = async (id,agentId,accountId) => {
  if(!allAgentsPreview)return;
  const catalogue=state.agents[id],selected=catalogue?.apis.find(api=>api.id===accountId),previous=catalogue?.list.find(profile=>profile.id===agentId);
  if(!selected||!previous)throw new Error('本地示例 API 不存在');
  const changed={...previous,api:{...previous.api,name:selected.name,model:selected.models[0],accountId,source:'phone',pending:false}};
  state={...state,agents:{...state.agents,[id]:{...catalogue,list:catalogue.list.map(profile=>profile.id===agentId?changed:profile)}}};notifyPreview();
  return changed;
};
let computerRoutesPreview=false;
export function configureComputerRoutesPreview(){
  computerRoutesPreview=true;
  const connections=[
    {id:'preview-relay-A',hubUrl:'https://relay.example.com/salcara-hub/v1',deviceId:'A',deviceName:'工作电脑',pairedAt:Date.now(),computerId:'physical-A'},
    {id:'preview-relay-A2',hubUrl:'https://backup.example.com/salcara-hub/v1',deviceId:'A2',deviceName:'工作电脑',pairedAt:Date.now(),computerId:'physical-A'},
    {id:'preview-bot-B',hubUrl:'https://bot.example.com/salcara-hub/v1',deviceId:'B',deviceName:'家里电脑',pairedAt:Date.now(),botGroupId:'home'},
    {id:'preview-bot-D',hubUrl:'https://bot.example.com/salcara-hub/v1',deviceId:'D',deviceName:'开发主机',pairedAt:Date.now(),botGroupId:'home'},
  ];
  state={...state,connections,connectionId:connections[0].id,selectedHubUrl:connections[0].hubUrl,devices:[{deviceId:'A',name:'工作电脑',online:true,os:'windows',tools:[],projects:[]}],connection:'open',agents:{},sessions:{},timelines:{}};
  notifyPreview();
}
export const useSavedConnection = async (id,_defer,options) => {
  if(!computerRoutesPreview||options?.stillWanted&&!options.stillWanted())return;
  const target=state.connections.find(item=>item.id===id);if(!target)throw new Error('演示设备不存在');
  state={...state,connectionId:id,selectedHubUrl:target.hubUrl,devices:[{deviceId:target.deviceId,name:target.deviceName,online:true,os:'windows',tools:[],projects:[]}]};notifyPreview();
};
export const probeSavedConnections = async () => computerRoutesPreview?Object.fromEntries(state.connections.map(item=>[item.id,item.id==='preview-relay-A2'?'offline':'online'])):[];
export const renameRemoteConnection = async () => {};
export const revokeRemoteConnectionById = async () => {};
export const hubSupportsPush = () => false;
export const onRemoteChange = () => () => {};
export const onRemoteEvent = () => () => {};
export const pushTarget = () => null;
export const sessionCursor = () => 0;
export const watchCredentials = () => null;
export const mergeHistory = (_device, _key, items) => items;
export const connectStation = async () => {};
export const pairRemote = async () => {};
export const pairScannedRemoteQr = async () => {};
export const parseScannedRemoteQr = () => ({});
export const rememberAgent = async () => {};
export const reloadSavedConnections = async () => [];
export const syncRemoteConnections = async () => {};
export const loadSessions = async () => {};
export const loadMoreSessions = async () => {};
export const loadNativeSessions = async () => {};
export const loadClaudeDesktopHistory = async () => {};
export const hydrateCachedSessions = async () => {};
export const hydrateCachedThread = async () => {};
export const selectSessionDirectory = () => {};
export const hubSupportsSessionActions = () => sessionCommandsEnabled;
export const hubSupportsSessionWorkflows = () => sessionCommandsEnabled;
export const hubSupportsContext = () => contextFixture.enabled;
export const hubSupportsDiffAnnotations = () => false;
export const hubSupportsCooperation = () => false;
export const hubSupportsSideQuestions = () => false;
export const hubSupportsTemporarySideChat = () => false;
const temporaryChatUnavailable = async () => { throw new Error('本地界面预览没有连接临时聊天服务'); };
export const askTemporarySideChat = temporaryChatUnavailable;
export const readTemporarySideChat = temporaryChatUnavailable;
export const uploadTemporarySideChatImages = temporaryChatUnavailable;
export const hubSupportsWait = () => false;
export const hubSupportsSteer = () => false;
export const sessionContextScope = () => 'preview-context';
export const snapshotQuestionCommand = () => '';
export const askSessionSideQuestion = async () => ({});
export const deleteSessionSideQuestion = async () => {};
export const readSessionSideQuestion = async () => null;
export const sessionSideQuestionScope = () => 'preview-side-question';
export const sessionSideQuestionStorageScope = () => 'preview-side-question-storage';
export const sessionSideQuestionHistoryOwner = () => 'preview-owner';
export const restoreSessionSideQuestionStorageScope = async () => '';
export const loadSessionSideQuestionHistoryScopes = async () => [];
export const listProjects = async id => state.devices.find(device=>device.deviceId===id)?.projects??[];
const extensionModels=tool=>allAgentsPreview&&tool==='deepseek-harness'?['deepseek-chat','deepseek-reasoner']:allAgentsPreview&&tool==='hermes'?['示例模型','备用示例模型']:null;
export const listModels = async (_device,tool) => extensionModels(tool)?{models:extensionModels(tool)}:({ models: ['gpt-5.1','gpt-5.2'], modelCapabilities: Object.fromEntries(['gpt-5.1','gpt-5.2'].map(id=>[id,{ source: 'codex-model-list', reasoningKnown: true, reasoningEfforts: ['low', 'medium', 'high'], inputModalities: ['text', 'image'] }])) });
export const cachedModels = (_device,tool) => ({models:extensionModels(tool)||['gpt-5.1','gpt-5.2']});
export const cachedAgentFeatures = () => DEMO_AGENT_FEATURES;
export const agentFeaturesGeneration = () => 1;
export const listAgentFeatures = async () => DEMO_AGENT_FEATURES;
export const canOpenOnDesktop = () => false;
export const openOnDesktop = async () => {};
export const openSession = async () => {};
export const startSession = async(id,input) => {
 if(!outputScene||id!==deviceId||!state.devices.find(device=>device.deviceId===id)?.projects.some(project=>project.path===input.cwd))throw new Error('请先选择当前电脑的项目');
 const at=Date.now(),key=`${input.tool}:preview-new-${at}`,turnId=`local-first-${at}`;
 const session={...previewSession,sessionKey:key,title:input.prompt.trim().slice(0,24)||'新对话',tool:input.tool,cwd:input.cwd,workspaceMode:input.workspaceMode??'code',status:'idle',activeTurnId:undefined,lastTerminalTurnId:turnId,updatedAt:at+2,model:input.model??previewAgent.api.model};
 state={...state,sessions:{...state.sessions,[id]:{...state.sessions[id],list:[session,...state.sessions[id].list]}},timelines:{...state.timelines,[`${id}|${key}`]:{loading:false,snapshotAt:at+2,session,items:[
   {kind:'message',id:`local-first-user-${at}`,turnId,role:'user',text:input.prompt,final:true,ts:at,skills:input.skills,contextReferences:input.contextReferences,attachments:input.images?.map((image,index)=>({id:`att_local_${at}_${index}`,uri:image.uri,mime:image.mime,width:image.width,height:image.height}))},
   {kind:'message',id:`local-first-answer-${at}`,turnId,role:'assistant',text:'新会话已建立，首次输入已保留。这是本地交互预览，没有调用真实模型。',final:true,messagePhase:'final_answer',ts:at+1},
   {kind:'turn',id:`local-first-end-${at}`,turnId,status:'completed',ts:at+2},
 ]}}};notifyPreview();return key;
};
export const continueSession = async () => ({ sessionKey });
export const interruptSession = async () => {};
export const cancelPendingRemoteMessage = async () => {};
export const pausePendingRemoteMessage = async () => {};
export const getPendingRemoteMessage = async () => null;
export const getPendingNewSession = async () => null;
export const newSessionReceiptKey = () => 'preview-receipt';
export const retryNewSession = async () => {};
export const acknowledgeNewSession = async () => {};
let editedPreview;
export const hubSupportsLatestTurnRevert=()=>outputScene;
export const revertLatestSessionTurn=async(id,key,message)=>{
 const timeline=state.timelines[`${id}|${key}`];
 if(!outputScene||timeline.session.status!=='idle'||timeline.items.filter(item=>item.kind==='message'&&item.role==='user').at(-1)?.id!==message.id)throw new Error('本地示例消息已变化');
 editedPreview=message;
 state={...state,timelines:{...state.timelines,[`${id}|${key}`]:{...timeline,items:timeline.items.filter(item=>item.turnId!==message.turnId)}}};notifyPreview();
};
export const sendToSession = async(id,key,text,options) => {
 if(editedPreview){
  if(editOutcome==='rejected')throw new Error('本地示例：电脑拒绝发送，修改内容仍保留');
  const original=editedPreview;editedPreview=undefined;
  const timeline=state.timelines[`${id}|${key}`],turnId=`preview-edit-${Date.now()}`;
  state={...state,timelines:{...state.timelines,[`${id}|${key}`]:{...timeline,snapshotAt:Date.now(),session:{...timeline.session,status:'idle',lastTerminalTurnId:turnId},items:[...timeline.items,
   {...original,id:`edited-${Date.now()}`,turnId,text,ts:Date.now(),skills:options?.skills,contextReferences:options?.contextReferences},
   {kind:'message',id:`edited-reply-${Date.now()}`,turnId,role:'assistant',text:'已用修改后的消息重新生成。这是本地交互示例，没有调用模型。',final:true,ts:Date.now()+1},
   {kind:'turn',id:`edited-terminal-${Date.now()}`,turnId,status:'completed',ts:Date.now()+2}]}}};notifyPreview();
 }
 return {state:'sent'};
};
export const respondApproval = async () => {};
export const syncSessionEvents = async () => {};
export const loadEarlierHistory = async () => {};
export const materializeAttachment = async () => null;
export const materializeAttachmentThumbnail = async () => undefined;
export const attachMaterializedUri = async () => {};
export const applyEvent = () => {};
export const applyNativeSessionAction = async (_device, key, reading, action) => sessionCommandsFor(key).applyAction(reading, action);
export const nativeSessionActionScope = (_device, key) => sessionCommandsFor(key).scope();
export const readNativeSessionActions = async (_device, key, signal) => sessionCommandsFor(key).readActions(signal);
export const readArchivedSessions = async () => ({ sessions: [] });
export const cooperationScope = () => 'preview-cooperation';
export const cooperationReceiptOwner = () => 'preview-cooperation-owner';
export const prepareCooperation = async () => ({ ticket: '', expiresAt: 0 });
export const sendCooperation = async () => ({ state: 'sent' });
export const applySessionWorkflow = async (_device, key, reading, input) => {
  if (input?.kind !== 'review' || input.target?.type !== 'uncommittedChanges') throw new Error('本地示例仅支持未提交更改审查');
  return sessionCommandsFor(key).applyReview(reading);
};
export const readSessionWorkflows = async (_device, key, signal) => sessionCommandsFor(key).readWorkflows(signal);
export const sessionWorkflowScope = (_device, key) => sessionCommandsFor(key).scope();
export const compactSessionContext = contextFixture.compact;
export const readSessionContext = contextFixture.read;

// This local UI fixture does not execute agent tools.
export async function runTemporarySideChatTool(){throw new Error("本地预览不执行工具");}
export async function diagnoseRemoteConnection(){throw new Error('本地界面预览不连接真实电脑');}
