import { randomUUID } from 'expo-crypto';
import type { ModelCatalog } from './client';
import type { RemoteImage } from './attachment-chunks';
import type { ContextReference } from './context-references';
import { reportedEfforts, reportsTextOnly, type Effort } from './effort';
import { SideQuestionNotDispatchedError, validTemporarySideQuestionInput, type SideQuestionReading, type SideQuestionResult, type TemporarySideQuestionInput } from './side-question';
import {AppState} from 'react-native';
import type {SideToolState,SideToolTransport,SideToolRequest} from './side-question-tools';
import {skillKey,validTurnFeatures,type AgentFeatures,type CollaborationMode,type SkillReference} from './agent-features';

export interface TemporarySideChatTransport {
  isCurrent(): boolean;
  read(signal: AbortSignal): Promise<SideQuestionReading>;
  ask(reading: SideQuestionReading, input: TemporarySideQuestionInput, operationId: string): Promise<SideQuestionResult>;
  models?(refresh?: boolean): Promise<ModelCatalog>;
  uploadImages?(images: RemoteImage[]): Promise<string[]>;
  tools?:SideToolTransport;
}
export interface TemporarySideChatTurn {
  operationId: string; question: string; images: RemoteImage[]; selection?: ContextReference;
  answer: string; state: 'sending' | 'completed' | 'unconfirmed' | 'failed' | 'interrupted'; error?: string;
}
export interface TemporarySideChatState {
  draft: string; images: RemoteImage[]; selection?: ContextReference; selectionNonce?: number;
  model: string; effort: Effort | ''; models?: ModelCatalog; turns: TemporarySideChatTurn[];
  reading?: SideQuestionReading; phase: 'idle' | 'loading' | 'ready' | 'sending' | 'unconfirmed' | 'unavailable'; error: string;
  permission:'read-only'|'workspace-write'; toolState?:SideToolState; toolBusy?:boolean;
  features?:AgentFeatures; featuresLoading?:boolean; featuresError?:string; skills?:SkillReference[]; collaborationMode?:CollaborationMode;
}
const initial = (): TemporarySideChatState => ({ draft: '', images: [], model: '', effort: '', turns: [], phase: 'idle', error: '',permission:'read-only' });
const message = (reason: unknown) => reason instanceof Error ? reason.message : '侧边聊天暂不可用';

/** Deliberately module memory only. There is no database, settings, AsyncStorage,
 * localStorage, draft-file or durable side-question import in this module.
 * Closing a tab only removes a subscriber; reopening it restores this instance.
 */
export class TemporarySideChatSession {
  private value = initial();
  private listeners = new Set<() => void>();
  private flight?: Promise<void>;
  private toolTransport?:TemporarySideChatTransport;
  private toolChainId?:string;
  private toolOpenOperation?:string;
  private toolTimer?:ReturnType<typeof setTimeout>;
  private polling=false;
  private submittedDrafts=new Map<string,string>();
  private submittedSkills=new Map<string,SkillReference[]|undefined>();
  constructor(readonly sessionKey: string) {}
  snapshot = () => this.value;
  subscribe = (listener: () => void) => { this.listeners.add(listener);this.scheduleTools(); return () => { this.listeners.delete(listener);if(!this.listeners.size)this.stopToolTimer(); }; };
  update(patch: Partial<TemporarySideChatState>) { this.value = { ...this.value, ...patch }; this.listeners.forEach(listener => listener()); }
  select(reference: ContextReference, nonce?: number) {
    if (reference.sessionKey !== this.sessionKey || reference.kind !== 'message' || nonce !== undefined && this.value.selectionNonce === nonce) return false;
    if (this.value.turns.length || this.value.phase === 'sending') { this.update({ error: '当前侧聊已开始，请在新侧聊中引用这段内容' }); return false; }
    this.update({ selection: { ...reference }, selectionNonce: nonce }); return true;
  }
  read(transport: TemporarySideChatTransport): Promise<void> {
    if (this.flight) return this.flight;
    if (this.value.reading || !transport.isCurrent()) return Promise.resolve();
    this.update({ phase: 'loading', error: '' });
    const controller = new AbortController();
    const flight = (async () => {
      try {
        const reading = await transport.read(controller.signal);
        if (!transport.isCurrent() || reading.value.sessionKey !== this.sessionKey) throw new Error('会话来源已改变，请重新打开侧聊');
        this.update({ reading, phase: reading.value.available ? 'ready' : 'unavailable', error: reading.value.unavailableReason ?? '' });
      } catch (reason) { this.update({ phase: 'unavailable', error: message(reason) }); }
    })();
    this.flight = flight;
    void flight.finally(() => { if (this.flight === flight) this.flight = undefined; });
    return flight;
  }
  restart() {
    if (this.flight || this.value.phase === 'sending') return false;
    if(this.toolChainId&&this.value.toolState?.state!=='closed'){this.update({error:'请先结束临时执行，再开始新的聊天'});return false;}
    this.stopToolTimer();this.toolChainId=undefined;this.toolOpenOperation=undefined;this.submittedDrafts.clear();this.submittedSkills.clear();
    // This is an explicit new chain, never an automatic resend or migration.
    this.value = { ...initial(), draft: this.value.draft, images: this.value.images };
    this.listeners.forEach(listener => listener()); return true;
  }
  hasToolExecution() { return Boolean(this.toolChainId && this.value.toolState?.state !== 'closed'); }
  send(transport: TemporarySideChatTransport): Promise<void> {
    if(this.value.permission==='workspace-write')return this.sendTools(transport);
    if (this.flight || this.value.phase !== 'ready') return this.flight ?? Promise.resolve();
    const captured = this.value, reading = captured.reading;
    if (!reading || !transport.isCurrent()) { this.update({ error: '电脑、Agent 或 API 已变化，请重新打开侧聊' }); return Promise.resolve(); }
    const options = reading.value.inputOptions, model = captured.model || options?.defaultModel || '';
    const question = captured.draft.trim(), previous = captured.turns.at(-1);
    const input: TemporarySideQuestionInput = { question, ...(previous ? { previousOperationId: previous.operationId } : captured.selection ? { selection: { ...captured.selection } } : {}),
      ...(captured.model || captured.effort ? { model } : {}), ...(captured.effort ? { effort: captured.effort } : {}) };
    const invalidModel = captured.model && !captured.models?.models.includes(captured.model);
    const invalidEffort = captured.effort && !reportedEfforts(captured.models?.modelCapabilities?.[model]).includes(captured.effort);
    const imageBytes = [...captured.images, ...captured.turns.flatMap(turn => turn.images)].reduce((sum, image) => sum + image.base64.length, 0);
    if (!validTemporarySideQuestionInput(reading, input) || invalidModel || invalidEffort || captured.images.length > 4
      || captured.images.length && (!options?.images || !transport.uploadImages) || imageBytes > 0 && reportsTextOnly(captured.models?.modelCapabilities?.[model]) || imageBytes > 512 * 1024) {
      this.update({ error: imageBytes > 512 * 1024 ? '临时聊天图片总大小请控制在 384 KB 内' : '请检查问题、模型、推理强度及图片选项；不支持的内容不会被忽略' }); return Promise.resolve();
    }
    const operationId = randomUUID(), turn: TemporarySideChatTurn = { operationId, question, images: [...captured.images], selection: input.selection, answer: '', state: 'sending' };
    this.update({ phase: 'sending', error: '', turns: [...captured.turns, turn] });
    let dispatched = false;
    const flight = (async () => {
      try {
        if (captured.images.length) input.attachments = await transport.uploadImages!([...captured.images]);
        if (input.attachments && input.attachments.length !== captured.images.length || !validTemporarySideQuestionInput(reading, input)) throw new SideQuestionNotDispatchedError('临时图片上传未完整确认，问题尚未发送');
        if (!transport.isCurrent()) throw new SideQuestionNotDispatchedError('来源已变化，临时问题尚未发送');
        dispatched = true;
        const result = await transport.ask(reading, input, operationId);
        if (!transport.isCurrent() || result.sessionKey !== this.sessionKey || result.operationId !== operationId) throw new Error('来源已改变，临时问题结果未确认');
        const completed = result.state === 'completed';
        this.update({ phase: completed ? 'ready' : 'unconfirmed', error: result.error ?? '',
          turns: this.value.turns.map(item => item.operationId === operationId ? { ...item, state: result.state, answer: result.answer, error: result.error } : item),
          ...(completed && this.value.draft === captured.draft ? { draft: '' } : {}),
          ...(completed && this.value.images === captured.images ? { images: [] } : {}), ...(completed ? { selection: undefined } : {}) });
      } catch (reason) {
        if (!dispatched || reason instanceof SideQuestionNotDispatchedError) this.update({ phase: 'ready', error: message(reason), turns: this.value.turns.filter(item => item.operationId !== operationId) });
        else this.update({ phase: 'unconfirmed', error: `${message(reason)}；不会自动重发`, turns: this.value.turns.map(item => item.operationId === operationId ? { ...item, state: 'unconfirmed', error: message(reason) } : item) });
      }
    })();
    this.flight = flight;
    void flight.finally(() => { if (this.flight === flight) this.flight = undefined; });
    return flight;
  }

  setPermission(permission:'read-only'|'workspace-write',transport?:TemporarySideChatTransport){
    if(permission===this.value.permission)return true;
    if(this.flight||this.value.turns.length||this.toolChainId){this.update({error:'请开始新的临时聊天后再切换权限'});return false;}
    if(permission==='workspace-write'&&(!this.value.reading?.value.inputOptions?.tools||!transport?.tools||!transport.isCurrent())){this.update({error:'当前电脑未开放工具型临时聊天'});return false;}
    if(permission==='workspace-write'&&(this.value.images.length||this.value.selection)){this.update({error:'当前工具模式仅支持文字，请先移除图片和引用；原内容已保留'});return false;}
    this.update({permission,error:'',...(permission==='read-only'?{skills:undefined,collaborationMode:undefined}: {})});return true;
  }
  loadToolFeatures(transport:TemporarySideChatTransport):Promise<void>{
    if(this.flight)return this.flight;
    const reading=this.value.reading;
    if(this.value.permission!=='workspace-write'||!reading?.value.inputOptions?.tools?.features||!transport.tools||!transport.isCurrent()||this.value.phase!=='ready')return Promise.resolve();
    this.toolTransport=transport;this.toolChainId??=randomUUID();this.toolOpenOperation??=randomUUID();
    this.update({features:undefined,featuresLoading:true,featuresError:''});
    let opening=false;
    const flight=(async()=>{
      try{
        if(!this.value.toolState){opening=true;const opened=await transport.tools!(reading,this.toolRequest('open',{permission:'workspace-write',operationId:this.toolOpenOperation}));opening=false;
          if(!transport.isCurrent())throw new SideQuestionNotDispatchedError('临时聊天来源已变化');
          this.update({toolState:opened});if(!opened.canSend)throw new SideQuestionNotDispatchedError(opened.error||'临时聊天尚未就绪');}
        const next=await transport.tools!(reading,this.toolRequest('features'));
        if(!transport.isCurrent()||this.value.toolState?.state==='closed')return;
        if(!next.features)throw new Error('当前电脑未返回计划模式和技能目录');
        this.acceptToolState(next);this.update({features:next.features,featuresError:''});
      }catch(reason){
        if(this.value.toolState?.state==='closed')return;
        if(opening&&!(reason instanceof SideQuestionNotDispatchedError))this.update({phase:'unconfirmed',error:'临时聊天连接待确认，请核对状态；问题尚未发送'});
        if(opening&&reason instanceof SideQuestionNotDispatchedError&&!this.value.toolState){this.toolChainId=undefined;this.toolOpenOperation=undefined;}
        this.update({features:undefined,featuresError:message(reason)});
      }finally{this.update({featuresLoading:false});}
    })();
    this.flight=flight;void flight.finally(()=>{if(this.flight===flight)this.flight=undefined;this.scheduleTools();});return flight;
  }
  observeTools(transport?:TemporarySideChatTransport){this.toolTransport=transport;if(!this.toolTimer)this.scheduleTools();}
  private stopToolTimer(){if(this.toolTimer)clearTimeout(this.toolTimer);this.toolTimer=undefined;}
  private scheduleTools(){
    this.stopToolTimer();
    if(!this.listeners.size||!this.toolChainId||!this.toolTransport?.tools||this.value.toolState?.state==='closed')return;
    this.toolTimer=setTimeout(()=>{this.toolTimer=undefined;void this.refreshTools();},this.value.phase==='sending'||this.value.phase==='unconfirmed'?3000:10000);
  }
  private toolRequest(action:SideToolRequest['action'],extra:Partial<SideToolRequest>={}):SideToolRequest{
    return {action,chainId:this.toolChainId!,expectedRevision:this.value.reading!.value.revision,...(action!=='read'?{operationId:randomUUID()}:{}),...extra};
  }
  private acceptToolState(next:SideToolState){
    const previous=this.value.toolState;
    if(previous&&next.sequence<=previous.sequence)return;
    const last=this.value.turns.at(-1),matched=Boolean(last&&last.operationId===next.lastOperationId);
    const working=['starting','running','waiting_approval'].includes(next.state);
    const closed=next.state==='closed',unconfirmed=next.state==='unconfirmed'||Boolean(last&&!matched&&last.state!=='completed'&&last.state!=='failed'&&last.state!=='interrupted');
    const phase=closed?'unavailable':unconfirmed?'unconfirmed':working?'sending':next.canSend?'ready':'unavailable';
    const turnState:TemporarySideChatTurn['state']=working?'sending':next.state==='failed'?'failed':next.state==='interrupted'||closed?'interrupted':unconfirmed?'unconfirmed':'completed';
    const sentDraft=next.lastOperationId?this.submittedDrafts.get(next.lastOperationId):undefined;
    this.update({toolState:next,phase,error:next.error??(closed?'临时执行已结束，可以开始新的聊天':unconfirmed?'临时请求尚未确认，不会自动重发':''),
      turns:this.value.turns.map(turn=>matched&&turn.operationId===next.lastOperationId?{...turn,answer:next.answer,state:turnState,error:next.error}:closed&&['sending','unconfirmed'].includes(turn.state)?{...turn,state:'interrupted',error:next.error}:turn),
      ...(matched&&sentDraft!==undefined&&this.value.draft===sentDraft?{draft:''}:{}),
      ...(matched&&this.submittedSkills.has(next.lastOperationId!)&&this.value.skills===this.submittedSkills.get(next.lastOperationId!)?{skills:undefined}:{}),
    });
    if(matched&&next.lastOperationId){this.submittedDrafts.delete(next.lastOperationId);this.submittedSkills.delete(next.lastOperationId);}
    this.scheduleTools();
  }
  private sendTools(transport:TemporarySideChatTransport):Promise<void>{
    if(this.flight||this.value.phase!=='ready'||this.value.toolBusy)return this.flight??Promise.resolve();
    const captured=this.value,reading=captured.reading,question=captured.draft.trim(),model=captured.model||reading?.value.inputOptions?.defaultModel||'';
    if(!validTurnFeatures(captured)||((captured.skills?.length||captured.collaborationMode)&&(!reading?.value.inputOptions?.tools?.features||captured.featuresLoading||captured.featuresError||!captured.features
      ||captured.skills?.some(skill=>!captured.features!.skills.some(entry=>skillKey(skill)===skillKey(entry)))||captured.collaborationMode&&!captured.features.collaborationModes.includes(captured.collaborationMode)))){
      this.update({error:'计划模式或技能目录已变化，请重新读取并选择'});return Promise.resolve();
    }
    if(!reading?.value.inputOptions?.tools||!transport.tools||!transport.isCurrent()||captured.images.length||captured.selection
      ||!validTemporarySideQuestionInput(reading,{question,...(captured.model||captured.effort?{model}:{}),...(captured.effort?{effort:captured.effort}:{})})
      ||captured.model&&!captured.models?.models.includes(captured.model)||captured.effort&&!reportedEfforts(captured.models?.modelCapabilities?.[model]).includes(captured.effort)){
      this.update({error:'请检查文字、模型和权限；工具模式不会忽略未支持的图片或引用'});return Promise.resolve();
    }
    this.toolTransport=transport;this.toolChainId??=randomUUID();this.toolOpenOperation??=randomUUID();
    const operationId=randomUUID();this.submittedDrafts.set(operationId,captured.draft);this.submittedSkills.set(operationId,captured.skills);
    this.update({phase:'sending',error:'',turns:[...captured.turns,{operationId,question,images:[],answer:'',state:'sending'}]});
    let dispatched=false,opening=false;
    const flight=(async()=>{
      try{
        if(!this.value.toolState){
          opening=true;
          const opened=await transport.tools!(reading,this.toolRequest('open',{permission:'workspace-write',operationId:this.toolOpenOperation}));
          opening=false;
          if(!transport.isCurrent())throw new SideQuestionNotDispatchedError('来源已变化，临时执行尚未发送');
          this.update({toolState:opened});
          if(!opened.canSend)throw new SideQuestionNotDispatchedError(opened.error||'临时执行尚未就绪');
        }
        if(!transport.isCurrent())throw new SideQuestionNotDispatchedError('来源已变化，临时执行尚未发送');
        dispatched=true;
        const result=await transport.tools!(reading,this.toolRequest('send',{operationId,question,...(captured.model||captured.effort?{model}:{}),...(captured.effort?{effort:captured.effort}:{}),...(captured.skills?.length?{skills:captured.skills.map(skill=>({...skill}))}:{}),...(captured.collaborationMode?{collaborationMode:captured.collaborationMode}:{})}));
        if(!transport.isCurrent()||result.lastOperationId!==operationId)throw new Error('临时执行送达结果未确认');
        this.acceptToolState(result);
      }catch(reason){
        if(this.value.toolState?.state==='closed'){
          this.submittedDrafts.delete(operationId);this.submittedSkills.delete(operationId);
          this.update({phase:'unavailable',turns:this.value.turns.map(turn=>turn.operationId===operationId?{...turn,state:'interrupted'}:turn)});return;
        }
        if(!dispatched||reason instanceof SideQuestionNotDispatchedError){
          this.submittedDrafts.delete(operationId);this.submittedSkills.delete(operationId);
          const unknownOpen=opening&&!(reason instanceof SideQuestionNotDispatchedError);
          if(opening&&!unknownOpen&&!this.value.toolState){this.toolChainId=undefined;this.toolOpenOperation=undefined;}
          this.update({phase:unknownOpen?'unconfirmed':'ready',error:unknownOpen?`${message(reason)}；尚未发送问题，请核对临时执行状态`:message(reason),turns:this.value.turns.filter(turn=>turn.operationId!==operationId)});
        }
        else this.update({phase:'unconfirmed',error:`${message(reason)}；不会自动重发`,turns:this.value.turns.map(turn=>turn.operationId===operationId?{...turn,state:'unconfirmed'}:turn)});
      }
    })();
    this.flight=flight;void flight.finally(()=>{if(this.flight===flight)this.flight=undefined;this.scheduleTools();});return flight;
  }
  async refreshTools(){
    const transport=this.toolTransport,reading=this.value.reading;
    if(this.polling||this.flight||this.value.toolBusy){this.scheduleTools();return;}
    if(!this.toolChainId||!transport?.tools||!reading||this.value.toolState?.state==='closed')return;
    if(AppState.currentState&&AppState.currentState!=='active'){this.scheduleTools();return;}
    if(!transport.isCurrent()){this.update({phase:'unconfirmed',error:'连接或来源已变化，临时执行状态待确认'});return;}
    this.polling=true;
    try{const next=await transport.tools(reading,this.toolRequest('read'));if(transport.isCurrent())this.acceptToolState(next);}
    catch(reason){if(this.snapshot().toolState?.state!=='closed')this.update({phase:'unconfirmed',error:`${message(reason)}；不会自动重发`});}
    finally{this.polling=false;this.scheduleTools();}
  }
  async controlTools(action:'stop'|'close'|'approve',approvalId?:string,decision?:'allow'|'deny'):Promise<boolean>{
    const transport=this.toolTransport,reading=this.value.reading,state=this.value.toolState;
    if(this.value.toolBusy||!this.toolChainId||!transport?.tools||!transport.isCurrent()||!reading)return false;
    if(action!=='close'&&!state?.turnId)return false;
    if(action==='approve'&&!state?.approvals.some(value=>value.approvalId===approvalId&&value.turnId===state.turnId&&value.approvalOptions?.decisions.includes(decision!)))return false;
    this.update({toolBusy:true,error:''});
    try{
      const next=await transport.tools(reading,this.toolRequest(action,{...(action!=='close'?{expectedTurnId:state!.turnId}:{}),...(action==='approve'?{approvalId,decision}:{})}));
      if(!transport.isCurrent())throw new Error('临时执行来源已变化');this.acceptToolState(next);return action==='close'?next.state==='closed':true;
    }catch(reason){this.update({phase:'unconfirmed',error:`${message(reason)}；请核对临时执行状态`});return false;}
    finally{this.update({toolBusy:false});this.scheduleTools();}
  }
  dispose(){this.stopToolTimer();this.toolTransport=undefined;}
}
const sessions = new Map<string, TemporarySideChatSession>();
export function temporarySideChatSession(scopeKey: string, sessionKey: string): TemporarySideChatSession {
  const key = JSON.stringify([scopeKey, sessionKey]);
  let value = sessions.get(key);
  if (!value) { value = new TemporarySideChatSession(sessionKey); sessions.set(key, value); }
  return value;
}
export function resetTemporarySideChatsForTests() { sessions.forEach(session=>session.dispose());sessions.clear(); }
