import type {SessionInfo, SessionStatus} from './client';
import {sessionWorkspaceMode} from './projection';
import type {Timeline, TimelineItem} from './store';

type Turn = Extract<TimelineItem,{kind:'turn'}>;
const surface = (session:SessionInfo)=>session.controlSurface??'cli';
const terminalStatus = (turn:Turn):SessionStatus=>turn.status==='failed'?'failed':'idle';
function newerThanSession(turn:Turn,session:SessionInfo,sessionSeq?:number):boolean {
  const sequence=turn.orderSeq??turn.seq;
  // Sequence counters and timestamps are separate units, including in Direct.
  if(sequence!==undefined&&sessionSeq!==undefined)return sequence>sessionSeq;
  return Number.isFinite(turn.ts)&&turn.ts>session.updatedAt;
}

/** The caller selects the timeline by deviceId + sessionKey; this changes only row presentation. */
export function sidebarSessionStatus(row:SessionInfo,timeline:Timeline|undefined):SessionStatus {
  const observed=timeline?.session;
  if(!timeline?.snapshotAt||!Number.isFinite(timeline.snapshotAt)||timeline.cachedAt!==undefined||timeline.error||!observed
    ||observed.sessionKey!==row.sessionKey||observed.tool!==row.tool||surface(observed)!==surface(row)
    ||surface(row)==='read-only'&&observed.sessionScope!==row.sessionScope
    ||sessionWorkspaceMode(observed)!==sessionWorkspaceMode(row)
    ||!Number.isFinite(observed.updatedAt)||observed.updatedAt<row.updatedAt)return row.status;

  if(observed.status==='waiting_approval'||timeline.items.some(item=>item.kind==='approval'&&item.state==='pending'
    &&(!item.expiresAt||item.expiresAt>Date.now())))return 'waiting_approval';

  const turns=timeline.items.filter((item):item is Turn=>item.kind==='turn'&&!item.parentId);
  const started=[...turns].reverse().find(turn=>turn.status==='started');
  if(started&&newerThanSession(started,observed,timeline.sessionSeq)) {
    const terminal=[...turns].reverse().find(turn=>turn.status!=='started'&&(started.turnId
      ?turn.turnId===started.turnId:turns.indexOf(turn)>turns.indexOf(started)));
    return terminal?terminalStatus(terminal):'running';
  }

  if(observed.status!=='running')return observed.status;
  const terminal=[...turns].reverse().find(turn=>turn.status!=='started'
    &&(observed.activeTurnId?turn.turnId===observed.activeTurnId:newerThanSession(turn,observed,timeline.sessionSeq)));
  // A matching terminal stops a stale running field even when Direct has no cursor.
  // A different turn's late completion cannot stop an explicitly identified new run.
  return terminal?terminalStatus(terminal):observed.status;
}
