import { isDirectEvent, mergeDirectHistoryPage, normalizeDirectEvent, parseDirectHistoryPage, parseDirectProjects, parseDirectWorkspaceCapabilities, parseDirectSessionPage, parseDirectStartReceipt } from '../remote/direct-history';
import { applyEvent, EMPTY_TIMELINE } from '../remote/store';
import { liveComputerActivityIds } from '../remote/computer-activity';

const session = {
  sessionKey: 'codex:thread-1', tool: 'codex', client: 'Codex CLI', title: 'Direct thread', cwd: 'C:/work',
  updatedAt: 10, status: 'idle', controllable: true, controlSurface: 'cli' as const,
};
const message = (deviceId = 'pc', sessionKey = session.sessionKey, tool = 'codex') => ({
  type: 'message', deviceId, sessionKey, tool, ts: 10, seq: 2, id: 'message-1', role: 'assistant', text: 'hello', final: true,
});

test('parses an opaque older-history cursor and keeps only events for the requested direct session', () => {
  const page = parseDirectHistoryPage({ session, events: [message(), message('other-pc'), message('pc', 'claude:thread-2', 'claude')], nextCursor: 'opaque-cursor' }, 'pc', session);
  expect(page).toEqual({ session, events: [message()], nextCursor: 'opaque-cursor' });
});

test('rejects mismatched sessions, oversized pages and cursors that do not advance', () => {
  expect(() => parseDirectHistoryPage({ session: { ...session, sessionKey: 'claude:thread-2' }, events: [] }, 'pc', session)).toThrow();
  expect(() => parseDirectHistoryPage({ session, events: Array.from({ length: 801 }, () => message()) }, 'pc', session)).toThrow();
  expect(() => parseDirectHistoryPage({ session, events: [], nextCursor: 'same' }, 'pc', session, 'same')).toThrow('没有推进');
  expect(() => parseDirectHistoryPage({ session, events: [], nextCursor: 'x'.repeat(4097) }, 'pc', session)).toThrow('读取位置无效');
});

test('rejects a desktop-surface history response on the direct CLI route', () => {
  expect(() => parseDirectHistoryPage({ session: { ...session, controlSurface: 'desktop' }, events: [] }, 'pc', session)).toThrow();
});

test('validates direct session paging cursors and filters sessions to the requested agent', () => {
  const page = parseDirectSessionPage({ sessions: [session, { ...session, sessionKey: 'claude:other', tool: 'claude' }], nextCursor: 'page-2' }, 'codex');
  expect(page).toEqual({ sessions: [session], nextCursor: 'page-2' });
  expect(() => parseDirectSessionPage({ sessions: [session], nextCursor: 'same' }, 'codex', 'same')).toThrow('没有推进');
  expect(() => parseDirectSessionPage({ sessions: [session], nextCursor: 42 }, 'codex')).toThrow('读取位置无效');
  expect(() => parseDirectSessionPage({ sessions: Array.from({ length: 21 }, () => session) }, 'codex')).toThrow('目录无效');
});

test('validates direct project directory bounds, identity and path text', () => {
  expect(parseDirectProjects({ projects: [{ path: 'C:/work', name: 'Work' }] })).toEqual([{ path: 'C:/work', name: 'Work' }]);
  expect(() => parseDirectProjects({ projects: [{ path: 'C:/work\nC:/secret', name: 'Work' }] })).toThrow('无效');
  expect(() => parseDirectProjects({ projects: [{ path: 'C:/work', name: 'Work' }, { path: 'C:/work', name: 'Duplicate' }] })).toThrow('重复');
  expect(() => parseDirectProjects({ projects: [{ path: 'x'.repeat(8193), name: 'Large' }] })).toThrow('无效');
  expect(() => parseDirectProjects({ projects: Array.from({ length: 513 }, (_, index) => ({ path: `C:/work/${index}`, name: 'Work' })) })).toThrow('无效');
  expect(() => parseDirectProjects({ projects: [{ path: 'C:/work', name: 'Work', token: 'unexpected' }] })).toThrow('无效');
});

test('accepts only a correlated direct session-start receipt for the selected Agent', () => {
  expect(parseDirectStartReceipt({ sessionKey: 'codex:thread-2' }, 'codex')).toBe('codex:thread-2');
  expect(() => parseDirectStartReceipt({ sessionKey: 'claude:thread-2' }, 'codex')).toThrow('归属');
  expect(() => parseDirectStartReceipt({ sessionKey: 'codex:thread-2', extra: true }, 'codex')).toThrow('身份无效');
  expect(() => parseDirectStartReceipt({ sessionKey: 'codex:'.concat('x'.repeat(513)) }, 'codex')).toThrow('身份无效');
});

test('realtime session updates buffered during history paging win over an older snapshot', () => {
  const page = parseDirectHistoryPage({ session, events: [] }, 'pc', session, 'older');
  const latest = { ...session, updatedAt: 20, status: 'running' as const };
  const queued = [{ type: 'session.updated' as const, deviceId: 'pc', sessionKey: session.sessionKey, tool: 'codex', ts: 20, session: latest }];

  const merged = mergeDirectHistoryPage(EMPTY_TIMELINE, page, queued);
  expect(merged.session).toEqual(latest);
});

test('direct workspace controls require public explicit capabilities', () => {
  const raw={projects:[],capabilities:['workspace.files.v1','agents.status','workspace.files.v1']};
  expect(parseDirectProjects(raw)).toEqual([]);expect(parseDirectWorkspaceCapabilities(raw)).toEqual(['workspace.files.v1']);
  expect(parseDirectWorkspaceCapabilities({projects:[]})).toEqual([]);
  expect(()=>parseDirectWorkspaceCapabilities({capabilities:['workspace.files.v1',{}]})).toThrow();
});
test('direct browser activities retain host page identities and reject executable links', () => {
  const activity={type:'tool',deviceId:'pc',sessionKey:session.sessionKey,tool:'codex',ts:12,id:'browser',kind:'web',title:'Open page',status:'done',browser:{action:'open',url:'https://example.com/',pageId:'page-1'}};
  const page=parseDirectHistoryPage({session,events:[activity,{...activity,id:'bad',browser:{action:'open',url:'javascript:alert(1)'}}]},'pc',session);
  expect(page.events).toEqual([activity]);
});

test.each([
  {version:1, surface:'computer', action:'click', provider:'cua_repl'},
  {version:1, surface:'browser', action:'navigate', provider:'playwright'},
])('Direct retains $provider activity through history, live completion and screenshot delivery', computer => {
  const activeSession = {...session, status:'running', activeTurnId:'turn-1'};
  const started = {type:'turn', deviceId:'pc', sessionKey:session.sessionKey, tool:'codex', ts:11, seq:3, turnId:'turn-1', status:'started'};
  const running = {type:'tool', deviceId:'pc', sessionKey:session.sessionKey, tool:'codex', ts:12, seq:4, turnId:'turn-1',
    id:'computer-step', kind:'mcp', title:'Operate page', status:'running', computer};
  const screenshot = {id:`att_${'a'.repeat(32)}`, mime:'image/png', size:100, sha256:'b'.repeat(64), width:800, height:600};
  const completed = {...running, ts:15, seq:5, status:'done', output:'Clicked the control', attachments:[screenshot]};
  const page = parseDirectHistoryPage({session:activeSession, events:[started, running]}, 'pc', session);
  expect(page.events).toEqual([started, running]);
  const history = mergeDirectHistoryPage(EMPTY_TIMELINE, page, []);
  const tools = history.items.filter(item => item.kind === 'tool');
  expect(liveComputerActivityIds(tools, history.items, page.session)).toEqual(new Set(['computer-step']));

  // Exercise the same gate used by DirectExperience's realtime subscription.
  expect(isDirectEvent(completed, 'pc', session.sessionKey)).toBe(true);
  if (!isDirectEvent(completed, 'pc', session.sessionKey)) throw new Error('Direct dropped computer completion');
  const live = applyEvent(history, normalizeDirectEvent(completed, 'pc'));
  const expected = {kind:'tool', id:'computer-step', status:'done', computer, attachments:[screenshot], output:'Clicked the control'};
  expect(live.items.find(item => item.id === running.id)).toMatchObject(expected);
  expect(liveComputerActivityIds(live.items.filter(item => item.kind === 'tool'), live.items, page.session)).toEqual(new Set());
  expect(mergeDirectHistoryPage(EMPTY_TIMELINE, page, [normalizeDirectEvent(completed, 'pc')]).items.find(item => item.id === running.id)).toMatchObject(expected);

  const reopened = parseDirectHistoryPage({session, events:[completed]}, 'pc', session);
  expect(mergeDirectHistoryPage(EMPTY_TIMELINE, reopened, []).items.find(item => item.id === running.id)).toMatchObject(expected);
  expect(isDirectEvent(completed, 'other-pc', session.sessionKey)).toBe(false);
  expect(isDirectEvent(completed, 'pc', 'codex:other-thread')).toBe(false);
});

test.each([
  null,
  {version:2, surface:'computer', action:'click', provider:'cua_repl'},
  {version:1, surface:'browser', action:'click', provider:'cua_repl'},
  {version:1, surface:'computer', action:'execute-anything', provider:'computer'},
  {version:1, surface:'browser', action:'click', provider:'unknown'},
])('Direct rejects unsupported computer metadata: %j', computer => {
  const event = {type:'tool', deviceId:'pc', sessionKey:session.sessionKey, tool:'codex', ts:12,
    id:'computer-step', kind:'mcp', title:'Operate page', status:'done', computer};
  expect(isDirectEvent(event, 'pc', session.sessionKey)).toBe(false);
});

test('Direct preserves all 64 host output images without losing the containing message', () => {
  const attachments = Array.from({length:64}, (_, index) => ({id:`att_${index.toString(16).padStart(32, '0')}`, mime:'image/png'}));
  const event = {...message(), text:'Generated images', attachments};
  const page = parseDirectHistoryPage({session, events:[event]}, 'pc', session);
  expect(page.events).toEqual([event]);
  const merged = mergeDirectHistoryPage(EMPTY_TIMELINE, page, []);
  expect(merged.items.find(item => item.kind === 'message')).toMatchObject({text:'Generated images', attachments});
  expect(isDirectEvent({...event, attachments:[...attachments, {id:`att_${'f'.repeat(32)}`, mime:'image/png'}]}, 'pc', session.sessionKey)).toBe(false);
});


test('projectless capability and verified session label survive direct parsing',()=>{
 expect(parseDirectWorkspaceCapabilities({capabilities:['session.projectless.v1','unrelated.capability']})).toEqual(['session.projectless.v1']);
 const independent={...session,projectless:true,workspaceMode:'work'};
 expect(parseDirectSessionPage({sessions:[independent]},'codex').sessions).toEqual([independent]);
 expect(parseDirectSessionPage({sessions:[{...independent,projectless:'true'}]},'codex').sessions).toEqual([]);
});
