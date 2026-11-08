import {createConversationArtifacts} from './conversation-artifacts';
import { HubError, type Command } from './client';
import { requestDirect } from './direct-api';
import { directConnectionGeneration, directDeliveryScope, getDirectConnectionState, subscribeDirectConnection } from './direct-pairing';
import { EMPTY_TIMELINE, timelineKey, type RemoteState } from './store';
import type { WorkspaceFileSelection, WorkspaceRuntime } from './WorkspaceRuntimeContext';
import { parseWorkspaceFilesPage, parseWorkspaceFileText, WORKSPACE_FILE_BYTES, workspaceRelativePath } from './workspace-files';
import { parseTerminalOutput, terminalDimensions, type TerminalSelection } from './workspace-terminal';
import { isComputerLoopbackURL, parsePreviewDownload, parsePreviewFrame } from './workspace-preview';
import { captureDirectSubagents } from './subagent-controls';
import { createWorkspaceGit } from './workspace-git';
import { createWorkspaceProjectPreview } from './workspace-project-preview';
import { mergeDirectHistoryPage, parseDirectHistoryPage } from './direct-history';

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HubError('电脑返回的工作区结果无效');
  return value as Record<string, unknown>;
};
const textValid = (text: string) => new TextEncoder().encode(text).length <= WORKSPACE_FILE_BYTES && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
const revisionValid = (revision: string) => /^[a-f0-9]{64}$/.test(revision);

/** A real direct transport owner, independent of Hub credentials and state.
 * Reconnecting invalidates open handles even when the persisted pairing scope
 * stays stable. Every response is checked against the current session again. */
export function createDirectWorkspaceRuntime(getRemote: () => RemoteState, getActiveSession: () => string | null): WorkspaceRuntime {
  const scope = directDeliveryScope(), generation = directConnectionGeneration();
  function capture(selection: WorkspaceFileSelection | TerminalSelection, capability: string, onInvalidated?: () => void) {
    let disposed = false, invalidated = false;
    const info = () => {
      const state = getRemote();
      return state.timelines[timelineKey(selection.deviceId, selection.sessionKey)]?.session
        ?? state.sessions[selection.deviceId]?.list.find(item => item.sessionKey === selection.sessionKey);
    };
    const cwd = 'cwd' in selection ? selection.cwd : selection.expectedCwd ?? info()?.cwd;
    const valid = () => {
      const connection = getDirectConnectionState(), state = getRemote(), session = info();
      const device = state.devices.find(item => item.deviceId === selection.deviceId);
      return !disposed && !invalidated && Boolean(scope && cwd && directDeliveryScope() === scope
        && directConnectionGeneration() === generation && connection.status === 'connected' && connection.deviceId === selection.deviceId
        && getActiveSession() === selection.sessionKey && selection.surface === 'cli'
        && session?.sessionKey === selection.sessionKey && session.cwd === cwd && session.controlSurface !== 'desktop' && session.controlSurface !== 'read-only'
        && device?.online && device.capabilities?.includes(capability) && device.projects.some(project => project.path === cwd)
        && (!('expectedSessionKey' in selection) || selection.expectedSessionKey === undefined || selection.expectedSessionKey === selection.sessionKey)
        && (!('expectedSurface' in selection) || selection.expectedSurface === undefined || selection.expectedSurface === 'cli'));
    };
    const guard = () => { if (!valid()) throw new HubError('电脑、会话或直连授权已变化，请重新打开此标签', 499, 'workspace_scope_changed'); };
    const unsubscribe = subscribeDirectConnection(() => { if (!disposed && !invalidated && !valid()) { invalidated = true; onInvalidated?.(); } });
    const has = (name: string) => valid() && Boolean(getRemote().devices.find(item => item.deviceId === selection.deviceId)?.capabilities?.includes(name));
    const base = { sessionKey: selection.sessionKey, controlSurface: 'cli' as const, expectedCwd: cwd! };
    const send = async (type: string, payload: Record<string, unknown> = {}) => {
      guard();
      const command = { ...base, type, ...payload } as Command;
      const reply = type === 'workspace.git.mutate' || type === 'workspace.git.read' ? await requestDirect(command, {timeoutMs:100_000}) : await requestDirect(command);
      guard(); return reply;
    };
    return { cwd, valid, guard, has, send, dispose: () => { disposed = true; unsubscribe(); } };
  }
  return {
    scope,
    get remote() { return getRemote(); },
    captureProjectPreview: (selection, onInvalidated) => {
      const owner = capture(selection, 'workspace.project.preview.v1', onInvalidated);
      const profile = () => getRemote().agents[selection.deviceId]?.list.find(item => item.id === selection.agentId);
      const identity = JSON.stringify([profile()?.api, profile()?.execution]);
      const guard = () => { owner.guard(); const agent = profile();
        if (!agent || agent.execution === null || JSON.stringify([agent.api, agent.execution]) !== identity) throw new HubError('Agent 或 API 已变化，请重新打开项目预览');
      };
      return createWorkspaceProjectPreview(payload => owner.send('workspace.project.preview', payload), guard, owner.dispose);
    },
    captureProjectFiles:(selection,onInvalidated)=>{
      let disposed=false,busy=false,invalidated=false;
      const valid=()=>{
        const connection=getDirectConnectionState(),device=getRemote().devices.find(item=>item.deviceId===selection.deviceId);
        return !disposed&&!invalidated&&Boolean(scope&&scope===directDeliveryScope()&&generation===directConnectionGeneration()
          &&connection.status==='connected'&&connection.deviceId===selection.deviceId&&device?.online
          &&device.capabilities?.includes('workspace.project.files.v1')&&device.projects.some(project=>project.path===selection.cwd));
      };
      const guard=()=>{if(!valid())throw new HubError('电脑或项目授权已变化，请重新打开引用');};
      const unsubscribe=subscribeDirectConnection(()=>{if(!disposed&&!invalidated&&!valid()){invalidated=true;onInvalidated?.();}});
      const read=async<T>(kind:'list'|'read',path:string,parse:(raw:unknown,path:string)=>T,cursor?:string):Promise<T>=>{
        guard();if(busy||!workspaceRelativePath(path,kind==='list'))throw new HubError('请稍后重新读取文件');busy=true;
        try{const raw=await requestDirect({type:kind==='list'?'workspace.project.files.list':'workspace.project.files.read',tool:selection.tool,cwd:selection.cwd,expectedCwd:selection.cwd,controlSurface:'cli',path,...(cursor?{cursor}:{})});guard();return parse(raw,path);}
        finally{busy=false;}
      };
      return {cwd:selection.cwd,list:(path='',cursor)=>read('list',path,parseWorkspaceFilesPage,cursor),read:path=>read('read',path,parseWorkspaceFileText),dispose:()=>{disposed=true;unsubscribe();}};
    },
    readContextSession:async sessionKey=>{
      const parent=getActiveSession(),state=getRemote(),deviceId=getDirectConnectionState().deviceId;
      const target=deviceId?state.sessions[deviceId]?.list.find(item=>item.sessionKey===sessionKey):undefined;
      const active=deviceId&&parent?state.timelines[timelineKey(deviceId,parent)]?.session:undefined;
      const valid=()=>Boolean(parent&&getActiveSession()===parent&&scope===directDeliveryScope()&&generation===directConnectionGeneration()&&getDirectConnectionState().status==='connected'&&getDirectConnectionState().deviceId===deviceId);
      if(!valid()||!target||!active||target.tool!==active.tool||target.cwd!==active.cwd)throw new Error('引用必须来自当前电脑和项目');
      const raw=await requestDirect({type:'session.open',sessionKey,controlSurface:'cli',limit:400,messageLimit:10});
      if(!valid())throw new Error('引用来源已变化');const page=parseDirectHistoryPage(raw,deviceId!,target);
      if(page.session.cwd!==active.cwd)throw new Error('引用项目已变化');return {...mergeDirectHistoryPage(EMPTY_TIMELINE,page,[]),snapshotAt:Date.now(),loading:false};
    },
    captureSubagents: selection => captureDirectSubagents(selection, () => getActiveSession() === selection.parentSessionKey
      && getRemote().agents[selection.deviceId]?.list.find(item=>item.id===selection.agent.id)?.api.accountId===selection.agent.api.accountId),
    captureGit: (selection,onInvalidated) => { const owner=capture(selection,'workspace.git.v1',onInvalidated); return createWorkspaceGit(async(type,payload)=>{
      const check=()=>{if((payload.action==='review'||payload.action==='review-apply')&&!owner.has('workspace.git.review.v1'))throw new HubError('电脑尚未开放统一审查，请更新电脑端');if((payload.action==='repositories'||payload.repositoryPath!==undefined)&&!owner.has('workspace.git.repositories.v1'))throw new HubError('电脑尚未开放多仓库审查');};check();const result=await owner.send(type,payload);check();return result;
    },owner.guard,owner.dispose,{repositories:owner.has('workspace.git.repositories.v1')}); },
    captureArtifacts: (selection,onInvalidated) => {
      const owner=capture(selection,'workspace.artifacts.v1',onInvalidated);
      const profile=()=>getRemote().agents[selection.deviceId]?.list.find(item=>item.id===selection.agentId);
      const identity=JSON.stringify([profile()?.api,profile()?.execution]);
      const guard=()=>{owner.guard();if(!profile()||JSON.stringify([profile()?.api,profile()?.execution])!==identity||!profile()?.execution||(getRemote().timelines[timelineKey(selection.deviceId,selection.sessionKey)]?.session??getRemote().sessions[selection.deviceId]?.list.find(item=>item.sessionKey===selection.sessionKey))?.tool!==profile()?.execution?.tool)throw new HubError('Agent 或 API 已变化，请重新打开产物');};
      return createConversationArtifacts(async(type,payload)=>{guard();const result=await owner.send(type,payload);guard();return result;},guard,owner.dispose,{writable:()=>owner.has('workspace.artifacts.write.v1')});
    },
    captureFiles: (selection, onInvalidated) => {
      const owner = capture(selection, 'workspace.files.v1', onInvalidated);
      let busy = false;
      const perform = async <T>(action: () => Promise<T>): Promise<T> => {
        owner.guard(); if (busy) throw new HubError('已有文件操作正在进行'); busy = true;
        try { return await action(); } finally { busy = false; }
      };
      const mutate = async (action: 'create' | 'delete' | 'rename', path: string, payload: Record<string, string>) => perform(async () => {
        if (!owner.has('workspace.files.manage.v1')) throw new HubError('电脑尚未开放文件管理');
        if (!workspaceRelativePath(path) || action !== 'create' && !revisionValid(payload.expectedRevision)
          || action === 'create' && !textValid(payload.text)
          || action === 'rename' && (!workspaceRelativePath(payload.destination) || payload.destination.split('/').slice(0, -1).join('/') !== path.split('/').slice(0, -1).join('/'))) throw new HubError('文件操作参数无效');
        const reply = record(await owner.send('workspace.files.mutate', { action, path, ...payload }));
        if (reply.action !== action || reply.path !== path || action === 'rename' && reply.destination !== payload.destination) throw new HubError('文件操作结果未确认，请刷新目录');
        if (action === 'delete') return;
        const file = parseWorkspaceFileText(reply.file, action === 'rename' ? payload.destination : path);
        if (!file.revision || action === 'create' && file.text !== payload.text) throw new HubError('文件操作结果未确认，请刷新目录');
        return file;
      });
      return {
        cwd: owner.cwd,
        get writable() { return owner.has('workspace.files.write.v1'); },
        get manageable() { return owner.has('workspace.files.manage.v1'); },
        list: (path = '', cursor) => perform(async () => {
          if (!workspaceRelativePath(path, true)) throw new HubError('文件目录无效');
          return parseWorkspaceFilesPage(await owner.send('workspace.files.list', { path, ...(cursor ? { cursor } : {}) }), path);
        }),
        read: path => perform(async () => {
          if (!workspaceRelativePath(path)) throw new HubError('文件路径无效');
          return parseWorkspaceFileText(await owner.send('workspace.files.read', { path }), path);
        }),
        write: (path, text, expectedRevision) => perform(async () => {
          if (!owner.has('workspace.files.write.v1')) throw new HubError('电脑尚未开放文件保存');
          if (!workspaceRelativePath(path) || !revisionValid(expectedRevision) || !textValid(text)) throw new HubError('文件内容或版本无效');
          const file = parseWorkspaceFileText(await owner.send('workspace.files.write', { path, text, expectedRevision }), path);
          if (!file.revision || file.text !== text) throw new HubError('文件保存结果未确认，请重新读取后比较');
          return file;
        }),
        create: async (path, text) => (await mutate('create', path, { text }))!,
        remove: async (path, expectedRevision) => { await mutate('delete', path, { expectedRevision }); },
        rename: async (path, destination, expectedRevision) => (await mutate('rename', path, { destination, expectedRevision }))!,
        dispose: owner.dispose,
      };
    },
    captureTerminal: (selection, onInvalidated) => {
      const owner = capture(selection, 'workspace.terminal.v1', onInvalidated);
      let terminalId: string | undefined, sequence = 1, inputFailed = false, writes: Promise<void> = Promise.resolve();
      const operationId = `terminal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
      const close = async () => { if (!terminalId || !owner.valid()) return; const id = terminalId; terminalId = undefined; await owner.send('workspace.terminal.close', { terminalId: id }); };
      return {
        open: async (cols, rows) => {
          const reply = parseTerminalOutput(await owner.send('workspace.terminal.open', { operationId, ...terminalDimensions(cols, rows) }), terminalId);
          terminalId = reply.terminalId; sequence = reply.nextSequence; return reply;
        },
        read: async cursor => {
          if (!terminalId) throw new HubError('终端尚未连接');
          const reply = parseTerminalOutput(await owner.send('workspace.terminal.read', { terminalId, cursor }), terminalId);
          if (!reply.truncated && reply.startCursor !== cursor || reply.startCursor < cursor) throw new HubError('终端输出顺序无效');
          return reply;
        },
        input: data => {
          const pending = writes.then(async () => {
            owner.guard(); if (!terminalId || inputFailed || !data || new TextEncoder().encode(data).length > 16384) throw new HubError('终端输入已暂停，请重新打开终端');
            try {
              const reply = record(await owner.send('workspace.terminal.input', { terminalId, sequence, data }));
              if (reply.terminalId !== terminalId || reply.sequence !== sequence) throw new HubError('终端输入未确认'); sequence++;
            } catch (error) { inputFailed = true; throw error; }
          });
          writes = pending.catch(() => {}); return pending;
        },
        resize: async (cols, rows) => { if (terminalId) await owner.send('workspace.terminal.resize', { terminalId, ...terminalDimensions(cols, rows) }); },
        close,
        dispose: () => { void close().catch(() => {}); owner.dispose(); },
      };
    },
    capturePreview: (selection, onInvalidated) => {
      const owner = capture(selection, 'workspace.preview.v1', onInvalidated);
      let pageId: string | undefined, sequence = 1, inputFailed = false, writes: Promise<void> = Promise.resolve();
      const operationId = `preview_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
      return {
        open: async (url, width, height) => {
          if (!isComputerLoopbackURL(url)) throw new HubError('此预览只连接电脑本机网址');
          const frame = parsePreviewFrame(await owner.send('workspace.preview.open', { operationId, url, width, height }), pageId);
          pageId = frame.pageId; sequence = frame.nextSequence; return frame;
        },
        frame: async capture => { if (!pageId) throw new HubError('网页预览尚未连接'); return parsePreviewFrame(await owner.send('workspace.preview.frame', { pageId, capture }), pageId); },
        download: async (downloadId, offset) => { if (!pageId) throw new HubError('网页预览尚未连接'); return parsePreviewDownload(await owner.send('workspace.preview.file', { pageId, downloadId, offset }), pageId, downloadId, offset); },
        input: input => {
          const pending = writes.then(async () => {
            owner.guard(); if (!pageId || inputFailed) throw new HubError('网页操作未确认，请重新连接预览');
            try {
              const reply = record(await owner.send('workspace.preview.input', { pageId, sequence, input }));
              if (reply.pageId !== pageId || reply.sequence !== sequence) throw new HubError('网页操作未确认'); sequence++;
            } catch (error) { inputFailed = true; throw error; }
          });
          writes = pending.catch(() => {}); return pending;
        },
        dispose: () => {
          if (pageId && owner.valid()) void owner.send('workspace.preview.close', { pageId }).catch(() => {});
          owner.dispose();
        },
      };
    },
  };
}
