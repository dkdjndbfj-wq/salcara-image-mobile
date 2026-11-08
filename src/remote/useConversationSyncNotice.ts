import {useRef} from 'react';

/** Connection and task execution are separate facts. A reconnect is not proof
 * that the last running/terminal status has been synchronized. */
export function useConversationSyncNotice(scope:string,online:boolean,snapshotAt:number|undefined,loading:boolean,error:unknown) {
  const state=useRef({scope,online,needsSync:!online,baseline:snapshotAt??0});
  if(state.current.scope!==scope)state.current={scope,online,needsSync:!online,baseline:snapshotAt??0};
  if(state.current.online&&!online){state.current.needsSync=true;state.current.baseline=snapshotAt??0;}
  state.current.online=online;
  if(online&&state.current.needsSync&&!loading&&!error&&(snapshotAt??0)>state.current.baseline)state.current.needsSync=false;
  return !online?'连接中断 · 状态待同步':state.current.needsSync?(error?'同步失败 · 显示上次记录':'连接已恢复 · 正在同步'):undefined;
}
