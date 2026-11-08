import React from 'react';
import { render } from '@testing-library/react-native';
import { DirectConversation } from '../remote/DirectConversation';

let mockGeneration = 1;
let mockSideChat: React.ReactElement<any> | undefined;
jest.mock('../remote/direct-pairing', () => ({
  directDeliveryScope: () => 'pairing-a', directConnectionGeneration: () => mockGeneration,
  getDirectConnectionState: () => ({ status: 'connected', deviceId: 'pc' }),
}));
jest.mock('../remote/direct-api', () => ({ requestDirect: jest.fn() }));
jest.mock('../remote/RemoteSidebar', () => ({ RemoteSidebar: (props: any) => {
  if (props.mode === 'tools') mockSideChat = props.sideChat(true, 'side-chat:7');
  return null;
} }));
jest.mock('../remote/TabletThreadFrame', () => ({ TabletThreadFrame: ({ workspace, children }: any) => <>{workspace}{children}</> }));
jest.mock('../remote/DirectComposer', () => ({ DirectComposer: () => null }));
jest.mock('../remote/thread-extras', () => ({ ImageViewer: () => null, JumpToLatest: () => null }));
jest.mock('../remote/QuestionDock', () => ({ QuestionDock: ({ children }: any) => children }));
jest.mock('../remote/thread-rows', () => ({
  ThreadUi: require('react').createContext({}), BlockRow: () => null, ApprovalCard: () => null,
  ThreadClockProvider: ({children}: any) => children, ThreadClockLabel: () => null,
}));
jest.mock('../remote/blocks', () => ({ buildBlocks: () => [], conversationBlocks: () => [], fileEdits: () => [] }));
jest.mock('../remote/thread-stats', () => ({ turnStats: () => new Map(), quoteFor: (text: string) => text, runningSince: () => undefined, runningTurnHeading: () => undefined }));

const props: any = {
  runtime: { scope: 'pairing-a', remote: { devices: [{ deviceId: 'pc', capabilities: [] }] } },
  deviceId: 'pc', profile: { id: 'codex', tool: 'codex', name: 'Codex', available: true,
    api: { accountId: 'account-a' }, capabilities: { sideQuestion: true }, execution: { mode: 'first' } },
  session: { sessionKey: 'codex:session', title: 'Task', cwd: 'C:/fixture', status: 'idle', controlSurface: 'cli' },
  timeline: { items: [] }, workspaceMode: 'code', text: '', onText: jest.fn(),
  loading: false, loadingMore: false, sending: false, canSend: true, uncertain: false, error: '',
  onSend: jest.fn(), onStop: jest.fn(), onRespond: jest.fn(), onEarlier: jest.fn(), onRefresh: jest.fn(),
  onBack: jest.fn(), onOpenSession: jest.fn(), onNew: jest.fn(),
};
beforeEach(() => { mockGeneration = 1; mockSideChat = undefined; jest.clearAllMocks(); });

test('a same-computer Direct reconnect gives the temporary chat a fresh authorization scope', async () => {
  const view = await render(<DirectConversation {...props}/>);
  const first = mockSideChat!.props.scopeKey;
  mockGeneration++;
  await view.rerender(<DirectConversation {...props}/>);
  expect(mockSideChat!.props.scopeKey).not.toBe(first);
  await view.unmount();
});

test('changing Direct execution identity invalidates the temporary chat reading', async () => {
  const view = await render(<DirectConversation {...props}/>);
  const first = mockSideChat!.props.scopeKey;
  await view.rerender(<DirectConversation {...props} profile={{ ...props.profile, execution: { mode: 'second' } }}/>);
  expect(mockSideChat!.props.scopeKey).not.toBe(first);
  await view.unmount();
});
