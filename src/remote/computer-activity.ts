import type {SessionInfo} from './client';
import type {TimelineItem} from './store';

/** Display-only metadata from an explicitly identified tool interface. */
export interface ComputerActivity {
  version: 1;
  surface: 'computer' | 'browser';
  action: 'click' | 'type' | 'scroll' | 'key' | 'move' | 'drag' | 'screenshot' | 'navigate' | 'script' | 'inspect' | 'wait';
  provider: string;
}
const actions = ['click','type','scroll','key','move','drag','screenshot','navigate','script','inspect','wait'];
const providers = ['cua_repl','computer','computer_use','playwright','puppeteer','chrome-devtools','chrome_devtools'];
export function parseComputerActivity(value: unknown): ComputerActivity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || !['computer','browser'].includes(String(raw.surface)) || !actions.includes(String(raw.action)) || !providers.includes(String(raw.provider))) return;
  const computer = ['cua_repl','computer','computer_use'].includes(String(raw.provider));
  if (raw.surface !== (computer ? 'computer' : 'browser')) return;
  return {version:1,surface:raw.surface as ComputerActivity['surface'],action:raw.action as ComputerActivity['action'],provider:raw.provider as string};
}
const labels: Record<ComputerActivity['action'], string> = {click:'点击',type:'输入文字',scroll:'滚动',key:'按键',move:'移动指针',drag:'拖动',screenshot:'获取画面',navigate:'打开网页',script:'执行操作',inspect:'查看页面',wait:'等待页面'};
export function computerActionLabel(activity: ComputerActivity) { return labels[activity.action]; }

/** A running tool from an older turn is not evidence of current computer use.
 * Each child scope needs its own observed turn; parent activity cannot revive it. */
export function liveComputerActivityIds(tools: Extract<TimelineItem,{kind:'tool'}>[], history: TimelineItem[], session?: Pick<SessionInfo,'status'|'activeTurnId'>): Set<string> {
  const ids = new Set<string>();
  if (!session || !['running','waiting_approval'].includes(session.status)) return ids;
  const turns = history.filter((item): item is Extract<TimelineItem,{kind:'turn'}> => item.kind === 'turn' && Boolean(item.turnId));
  const scopes = new Set(['', ...turns.map(item => item.parentId ?? '')]);
  const activeTurns = new Map<string,string>();
  for (const scope of scopes) {
    const scoped = turns.filter(item => (item.parentId ?? '') === scope);
    const started = [...scoped].reverse().find(item => item.status === 'started');
    const terminal = [...scoped].reverse().find(item => item.status !== 'started');
    if (started) {
      // The reducer already orders history. Sequence counters and legacy
      // timestamps have different units and cannot be compared directly.
      const startIndex = scoped.indexOf(started);
      const conflictingSession = !scope && session.activeTurnId && session.activeTurnId !== started.turnId;
      const sessionTurnFinished = scoped.some((item,index) => index < startIndex && item.turnId === session.activeTurnId && item.status !== 'started');
      if (conflictingSession && !sessionTurnFinished) continue;
      if (!scoped.some(item => item.turnId === started.turnId && item.status !== 'started') && (!terminal || startIndex > scoped.indexOf(terminal))) activeTurns.set(scope, started.turnId!);
    } else if (!scope && session.activeTurnId && !scoped.some(item => item.turnId === session.activeTurnId)) activeTurns.set(scope, session.activeTurnId);
  }
  for (const item of tools) {
    if (item.status === 'running' && item.turnId && item.turnId === activeTurns.get(item.parentId ?? '') && parseComputerActivity(item.computer)) ids.add(item.id);
  }
  return ids;
}
