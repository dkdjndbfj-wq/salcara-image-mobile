import React from 'react';
import {resetWorkspaceLayoutMemoryForTests} from '../remote/workspace-layout';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import { Animated, AppState, Dimensions } from 'react-native';
import { SCRUB_STEP } from '../remote/EffortScrub';
import { hapticEffort, hapticModelCommit } from '../remote/haptics';
import { REMOTE_RETRY_INDICATOR_DELAY_MS, REMOTE_STATUS_NOTICE_DELAY_MS, ThreadView } from '../remote/ThreadView';
import { diffSelectionReference, parseDiffForAnnotations } from '../remote/diff-annotations';
import type { SkillComposerInputProps } from '../remote/SkillComposerInput';
import { skillComposerPresentation, skillDisplayOffset } from '../remote/skill-composer-presentation';
import { HubError } from '../remote/client';
import type { AgentProfile, SessionInfo, ModelCatalog, Effort } from '../remote/client';
import type { RemoteState, TimelineItem, SessionContextReading } from '../remote/store';
import type { ThreadPrefs } from '../remote/thread-prefs';
import type { PendingDelivery } from '../remote/delivery';
import { DeliveryPendingError } from '../remote/delivery';
import { deliveryRetryState } from '../remote/offline-policy';
import type { RemoteImage } from '../remote/attachments';
import type { LoadedQueuedRemoteDraft } from '../remote/drafts';
import type { ComposerDraft, ComposerDraftInput } from '../remote/composer-drafts';
import type { AgentCapabilities } from '../remote/client';
import { pendingQuestionReceiptsForDevice, type QuestionReceipt } from '../remote/question-outbox';
import { rememberSideQuestionHistoryScope, restoreSideQuestionHistoryScope as mockRestoreSideQuestionHistoryScope, resetSideQuestionConversationsForTests } from '../remote/side-question-conversations';
import { resetTemporarySideChatsForTests } from '../remote/temporary-side-chat';

import type { AgentFeatures } from '../remote/agent-features';
let mockFileDrop: import('../remote/ConversationDropZone').ConversationDropZoneProps;
jest.mock('../remote/ConversationDropZone',()=>({ConversationDropZone:(props:import('../remote/ConversationDropZone').ConversationDropZoneProps)=>{mockFileDrop=props;return props.children;}}));
const mockFeatures = jest.fn(async (..._args: unknown[]): Promise<AgentFeatures> => ({ collaborationModes: ['default', 'plan'], skillsSupported: true, skills: [{ name: 'review', path: 'C:/fixture/SKILL.md', description: 'Review code' }] }));
const mockFeatureGenerations = new Map<string, number>();
let mockRemote: RemoteState;
const mockQuestionStorage = new Map<string, string>();
let mockDeliveryScope = 'paired|fixture-credential';
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockQuestionStorage.get(key) ?? null,
  setSetting: async (key: string, value: string) => { mockQuestionStorage.set(key, value); } }));
const desktopCapabilities = { list: true, read: true, send: true, interrupt: false, approval: false, attachments: false, modelOverride: false };
const mockOpen = jest.fn(async (..._args: unknown[]) => undefined);
const mockLoadEarlier = jest.fn(async (..._args: unknown[]) => undefined);
const mockStart = jest.fn(async (..._args: unknown[]) => 'codex:new');
const mockSend = jest.fn(async (..._args: unknown[]) => undefined);
const mockContinue = jest.fn(async (..._args: unknown[]) => undefined);
let mockHubSteer = false;
let mockHubContext = false;
let mockHubSideQuestion = false;
let mockHubDiffAnnotations = false;
let mockHubSessionActions = false;
let mockHubCooperation = false;
const mockPrepareCooperation = jest.fn(async (_device: string, source: string, target: string, _signal?: AbortSignal) => ({ ticket: 'a'.repeat(64), expiresAt: Date.now() + 60_000,
  source: { ...originalSession, sessionKey: source }, target: { ...originalSession, sessionKey: target, title: '目标任务' }, scope: mockContextScope('pc', source) }));
const mockReadSideQuestion = jest.fn(async (...args: unknown[]) => {
  const value = { chainId: args[2] as string, sessionKey: 'codex:original', revision: 'side-r1', available: true, contextScope: 'loadedSnapshot' as const, contextMessages: 1, contextTruncated: false, turns: [] };
  await rememberSideQuestionHistoryScope(JSON.stringify([mockDeliveryScope, 'pc', 'codex:original']), mockContextScope('pc', 'codex:original'));
  return { scope: mockContextScope('pc', 'codex:original'), value, conversation: value };
});
const mockAskSideQuestion = jest.fn(async (...args: unknown[]) => ({ sessionKey: 'codex:original', operationId: args[4] as string, state: 'completed' as const, answer: '独立解释结果', contextScope: 'loadedSnapshot' as const, contextMessages: 1, contextTruncated: false }));
const mockReadTemporarySideChat = jest.fn(async () => ({ scope: mockContextScope('pc', 'codex:original'), value: { sessionKey: 'codex:original', revision: 'temporary-r1', available: true, contextScope: 'loadedSnapshot' as const, contextMessages: 1, contextTruncated: false } }));
const mockAskTemporarySideChat = jest.fn(async (...args: unknown[]) => ({ sessionKey: 'codex:original', operationId: args[4] as string, state: 'completed' as const, answer: '临时解释结果', contextScope: 'loadedSnapshot' as const, contextMessages: 1, contextTruncated: false }));
const mockContextScope = (device: string, session: string) => JSON.stringify([mockDeliveryScope, device, session, mockRemote.agents[device]?.list[0]?.api.accountId]);
const mockContextReading = (): SessionContextReading => ({ scope: mockContextScope('pc', 'codex:original'), value: { sessionKey: 'codex:original', revision: 'r1', canCompact: true } });
const mockReadContext = jest.fn<Promise<SessionContextReading>, unknown[]>();
const mockCompactContext = jest.fn<Promise<SessionContextReading>, unknown[]>();
const mockSetApi = jest.fn();
const mockRespond = jest.fn(async (..._args: unknown[]): Promise<void> => undefined);
const mockSendSubmit: { current: () => void } = { current: () => undefined };
const mockDialogActions = new Map<string, () => void>();
const mockCancelPending = jest.fn(async (..._args: unknown[]) => undefined);
const mockOpenDesktop = jest.fn(async (..._args: unknown[]) => undefined);
const mockPickImages = jest.fn(async (): Promise<RemoteImage[]> => []);
const mockLoadAgents = jest.fn(async (..._args: unknown[]) => undefined);
const mockSaveDraft = jest.fn(async (..._args: unknown[]) => undefined);
const mockLoadQueued = jest.fn(async (_key: string): Promise<LoadedQueuedRemoteDraft[]> => []);
const mockSaveQueued = jest.fn(async (..._args: unknown[]): Promise<LoadedQueuedRemoteDraft[] | void> => undefined);
const mockRetryImages = jest.fn(async (_images: unknown[]): Promise<RemoteImage[]> => []);
let mockHubRevert=false;
const mockRevertLatest=jest.fn<Promise<void>,unknown[]>(async()=>undefined);
const mockEditBackupSave=jest.fn(async(draft:ComposerDraftInput):Promise<ComposerDraft>=>({...draft,scope:'paired|fixture-credential',imageCount:draft.images.length,revision:1,identity:'0199aaa1-1234-4678-9abc-000000000002'}));
const mockEditBackupConsume=jest.fn(async()=>true);
const mockEditBackupRestore=jest.fn(async():Promise<ComposerDraft|undefined>=>undefined);
const mockComposerRestore = jest.fn(async (_key: string): Promise<ComposerDraft | undefined> => undefined);
const mockComposerSave = jest.fn(async (_key: string, scope: string, draft: ComposerDraftInput): Promise<ComposerDraft> => ({ ...draft, scope, revision: 1, identity: '0199aaa1-1234-4678-9abc-000000000001', imageCount: draft.imageCount ?? draft.images.length }));
const mockComposerHydrate = jest.fn(async (_scope: string, draft: ComposerDraft): Promise<RemoteImage[]> => draft.images);
const mockComposerConsume = jest.fn(async (..._args: unknown[]) => true);
const mockCopyMissing = jest.fn(async (input: any): Promise<any> => ({ receipt: { scope: input.scope, sourceKey: input.sourceKey, targetKey: input.targetKey, targetRevision: 1, targetIdentity: 'restored', targetOrigin: { ...input.origin, sessionKey: undefined } }, draft: { scope: input.scope, text: '原草稿', images: [], imageCount: 0, revision: 1 } }));
const mockUndoMissing = jest.fn(async () => true);
const mockSavePrefs = jest.fn(async (..._args: unknown[]) => undefined);
const mockLoadPrefs = jest.fn(async (_key: string): Promise<ThreadPrefs> => ({}));
const mockPending = jest.fn(async (): Promise<PendingDelivery | undefined> => undefined);
const mockPendingNew = jest.fn(async (..._args: unknown[]): Promise<(PendingDelivery & { composerDraft?: { key: string; revision: number } }) | undefined> => undefined);
const mockRetryNew = jest.fn(async (..._args: unknown[]) => 'codex:recovered');
const mockAcknowledgeNew = jest.fn(async (..._args: unknown[]) => undefined);
const mockToast = jest.fn();
const mockThreadUi = jest.fn();
const mockSkillComposerProps = jest.fn((_props: SkillComposerInputProps) => undefined);
jest.mock('../remote/SkillComposerInput', () => {
  const React = require('react');
  const Actual = jest.requireActual('../remote/SkillComposerInput').SkillComposerInput;
  return { SkillComposerInput: React.forwardRef((props: SkillComposerInputProps, ref: unknown) => {
    mockSkillComposerProps(props); return React.createElement(Actual, { ...props, ref });
  }) };
});
const mockImageViewer = jest.fn();
const mockDiffViewer = jest.fn();
const mockListModels = jest.fn(async (..._args: unknown[]): Promise<ModelCatalog> => ({ models: ['gpt-fixture'], api: '主力' }));
// Only effort-specific fixtures claim capabilities. Relay ID-only fixtures stay unknown.
const reportedCatalog = (models = ['gpt-fixture'], efforts: Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh']): ModelCatalog => ({
  models, api: '主力', modelCapabilities: Object.fromEntries(models.map(id => [id,
    { source: 'codex-model-list', reasoningKnown: true, reasoningEfforts: efforts } ])),
});
const useReportedModels = () => mockListModels.mockResolvedValue(reportedCatalog());
/** Thinking effort is changed by press-and-slide on the composer chip; tests drive it with the accessibility actions. */
const scrubEffort = async (view: { getByTestId: (id: string) => unknown }, steps: number) => {
  for (let index = 0; index < Math.abs(steps); index += 1) {
    await fireEvent(view.getByTestId('remote-effort-chip') as never, 'accessibilityAction', { nativeEvent: { actionName: steps > 0 ? 'increment' : 'decrement' } });
  }
};
const mockCaptureModelBackdrop = jest.fn(async (..._args: unknown[]): Promise<string | undefined> => undefined);
jest.mock('expo-crypto', () => ({ randomUUID: () => jest.requireActual('node:crypto').randomUUID() }));
jest.mock('react-native/Libraries/AppState/AppState', () => ({ __esModule: true, default: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) } }));
// Preserve the Pressable's JS callbacks in the synthetic host, so queued-event
// tests can capture the actual handler before a scope/visibility change.
jest.mock('react-native', () => {
  const React = require('react'); const actual = jest.requireActual('react-native'); const replacement = Object.create(actual);
  Object.defineProperty(replacement, 'Pressable', { enumerable: true, value: ({ children, style, ...props }: Record<string, any>) =>
    React.createElement(actual.View, { ...props, accessible: props.accessible ?? true, accessibilityState: { ...props.accessibilityState, ...(props.disabled !== undefined ? { disabled: props.disabled } : {}) }, style: typeof style === 'function' ? style({ pressed: false }) : style }, typeof children === 'function' ? children({ pressed: false }) : children) });
  return replacement;
});

// Supply geometry only: the native test host's default measureInWindow never calls back.
jest.mock('react-native/Libraries/Components/View/View', () => {
  const React = require('react');
  const ActualView = jest.requireActual('react-native/Libraries/Components/View/View').default;
  return { __esModule: true, default: React.forwardRef((props: Record<string, unknown>, ref: unknown) => {
    React.useImperativeHandle(ref, () => ({
      measureInWindow: (callback: (x: number, y: number) => void) => callback(16, 600),
      setNativeProps: jest.fn(),
    }));
    return React.createElement(ActualView, props);
  }) };
});
jest.mock('../components/Icon', () => ({ Icon: () => null }));
jest.mock('../remote/RemoteDemoBrowser', () => {
  const React = require('react'), { TextInput } = require('react-native');
  return { RemoteDemoBrowser: ({ uri }: { uri: string }) => {
    const [value, setValue] = React.useState('');
    return React.createElement(TextInput, { accessibilityLabel: `网页表单 ${uri}`, value, onChangeText: setValue });
  } };
});
jest.mock('../remote/haptics', () => ({ hapticEffort: jest.fn(), hapticModelTick: jest.fn(), hapticModelCommit: jest.fn() }));
jest.mock('../components/MessageContent', () => {
  const React = require('react'); const { Text } = require('react-native');
  return { MessageContent: ({ text }: { text: string }) => {
    mockThreadUi(React.useContext(require('../remote/thread-rows').ThreadUi));
    return React.createElement(Text, null, text);
  } };
});
jest.mock('../remote/thread-extras', () => {
  const React = require('react'); const { View } = require('react-native');
  const actual = jest.requireActual('../remote/thread-extras');
  return { ...actual,
    ImageViewer: (props: { uri: string | null; onClose: () => void }) => {
      mockImageViewer(props);
      return props.uri ? React.createElement(View, { testID: 'dialogue-image-preview', ...props }) : null;
    },
    DiffScreen: (props: { file: { path: string } | null; onClose: () => void }) => {
      mockDiffViewer(props);
      return props.file ? React.createElement(View, { testID: 'dialogue-diff-preview', ...props }) : null;
    },
  };
});
jest.mock('../components/ui', () => {
  const React = require('react'); const { View, Text, Pressable } = require('react-native');
  const pass = ({ children }: { children: unknown }) => React.createElement(View, null, children);
  const button = ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => {
    if (label === '发送') mockSendSubmit.current = onPress;
    return React.createElement(Pressable, { accessibilityRole: 'button', accessibilityLabel: label, accessibilityState: { disabled }, disabled, onPress }, React.createElement(Text, null, label));
  };
  return {
    PrimaryButton: button, IconButton: button, Group: pass, Appear: pass,
    dismissKeyboardAndBlur: jest.fn(),
    MotionPressable: ({ children, wrapperStyle: _wrapperStyle, scaleTo: _scaleTo, ...props }: Record<string, unknown>) => React.createElement(Pressable, props, children),
    Sheet: ({ visible, title, subtitle, children, headerLeft, headerRight, footer, onClose, onSystemBack }: { visible: boolean; title: string; subtitle?: string; children: unknown; headerLeft: unknown; headerRight: unknown; footer: unknown; onClose: () => void; onSystemBack?: () => void }) => visible
      ? React.createElement(View, { testID: 'remote-thread-modal', onRequestClose: onSystemBack ?? onClose }, React.createElement(View, { testID: 'remote-sheet-header-left' }, headerLeft), React.createElement(Text, null, title), React.createElement(View, { testID: 'remote-sheet-subtitle', accessibilityLabel: subtitle }), headerRight, children, footer) : null,
    AppDialog: ({ visible, title, actions }: { visible: boolean; title: string; actions?: Array<{ label: string; onPress: () => void }> }) => {
      if (!visible) return null;
      actions?.forEach(action => mockDialogActions.set(action.label, action.onPress));
      return React.createElement(View, null, React.createElement(Text, null, title), actions?.map((action) => React.createElement(Pressable, { key: action.label, accessibilityRole: 'button', accessibilityLabel: action.label, onPress: action.onPress }, React.createElement(Text, null, action.label))));
    },
    useReducedMotion: () => true,
    showToast: (...args: unknown[]) => mockToast(...args),
  };
});
jest.mock('../remote/WorkbenchToolbar', () => {
  const React = require('react'), actual = jest.requireActual('../remote/WorkbenchToolbar');
  return { ...actual, ToolbarMenu: (props: React.ComponentProps<typeof import('../remote/WorkbenchToolbar').ToolbarMenu>) => {
    if (props.visible) props.actions.forEach(action => { if (action.onPress) mockDialogActions.set(action.label, action.onPress); });
    return React.createElement(actual.ToolbarMenu, props);
  } };
});
const mockLiveSync = jest.fn();
jest.mock('../remote/useLiveSync', () => ({ useLiveSync: (...args: unknown[]) => mockLiveSync(...args) }));
jest.mock('../remote/attachments', () => ({ MAX_REMOTE_IMAGES: 4, pickRemoteImages: () => mockPickImages() }));
jest.mock('../remote/model-backdrop', () => ({ captureModelBackdrop: (...args: unknown[]) => mockCaptureModelBackdrop(...args) }));
jest.mock('../remote/drafts', () => ({ loadRemoteDraft: async () => '原草稿', saveRemoteDraft: (...args: unknown[]) => mockSaveDraft(...args),
  remoteQueueEditable: jest.requireActual('../remote/drafts').remoteQueueEditable, remoteQueueRevision: jest.requireActual('../remote/drafts').remoteQueueRevision,
  mutateRemoteQueue: jest.fn(async () => []),
  MAX_REMOTE_QUEUE: 10, loadRemoteQueuedDrafts: (key: string) => mockLoadQueued(key), saveRemoteQueuedDrafts: (...args: unknown[]) => mockSaveQueued(...args),
  readRemoteRetryImages: (images: unknown[]) => mockRetryImages(images),
}));
jest.mock('../remote/composer-drafts', () => ({ createComposerDraftSession: (key: string, scope: string) => ({
  restore: () => key.includes('|sent-edit:')?mockEditBackupRestore():mockComposerRestore(key), save: (draft: ComposerDraftInput) => key.includes('|sent-edit:')?mockEditBackupSave(draft):mockComposerSave(key, scope, draft),
  consume: (revision: number, identity?: string) => key.includes('|sent-edit:')?mockEditBackupConsume():mockComposerConsume(key, scope, revision, identity), pruneEmpty: async () => undefined, dispose: () => undefined,
}), copyMissingComposerDraft: (input: unknown) => mockCopyMissing(input), undoMissingComposerDraft: () => mockUndoMissing(), hydrateComposerImages: (scope: string, draft: ComposerDraft) => mockComposerHydrate(scope, draft) }));
jest.mock('../remote/thread-prefs', () => ({ loadThreadPrefs: (key: string) => mockLoadPrefs(key), saveThreadPrefs: (...args: unknown[]) => mockSavePrefs(...args) }));
jest.mock('../remote/store', () => ({
  useRemote: () => mockRemote, getRemoteState: () => mockRemote,
  hubSupportsLatestTurnRevert:()=>mockHubRevert,revertLatestSessionTurn:(...args:unknown[])=>mockRevertLatest(...args),
  resetIncompleteTurnRecovery: jest.fn(),
  hydrateCachedThread: async () => undefined, hydrateCachedSessions: async () => undefined,
  EMPTY_TIMELINE: { items: [], loading: false }, timelineKey: (device: string, key: string) => `${device}|${key}`,
  listAgentFeatures: (...args: unknown[]) => mockFeatures(...args),
  agentFeaturesGeneration: (device: string, tool: string) => JSON.stringify([mockDeliveryScope, mockFeatureGenerations.get(`${device}:${tool}`) ?? 0]),
  cachedModels: () => ({ models: ['gpt-fixture'], api: '主力' }), listModels: (...args: unknown[]) => mockListModels(...args),
  getPendingRemoteMessage: () => mockPending(), openSession: (...args: unknown[]) => mockOpen(...args),
  getPendingNewSession: (...args: unknown[]) => mockPendingNew(...args),
  newSessionReceiptKey: (tool: string, desktop = false) => `${tool}:new-task-${desktop ? 'desktop' : 'cli'}`,
  retryNewSession: (...args: unknown[]) => mockRetryNew(...args),
  acknowledgeNewSession: (...args: unknown[]) => mockAcknowledgeNew(...args),
  loadEarlierHistory: (...args: unknown[]) => mockLoadEarlier(...args),
  startSession: (...args: unknown[]) => mockStart(...args), sendToSession: (...args: unknown[]) => mockSend(...args),
  loadAgentProfiles: (...args: unknown[]) => mockLoadAgents(...args), setAgentApi: (...args: unknown[]) => mockSetApi(...args),
  respondApproval: (...args: unknown[]) => mockRespond(...args),
  snapshotQuestionCommand: (target: { deviceId: string; sessionKey: string; approvalId: string }, decision: string, message?: string, answers?: unknown) => ({
    type: 'approval.respond', sessionKey: target.sessionKey, approvalId: target.approvalId, decision,
    ...(message?.trim() ? { message: message.trim() } : {}), ...(answers ? { answers } : {}),
    accountId: mockRemote.agents[target.deviceId]?.list.find(profile => profile.id === target.sessionKey.split(':')[0])?.api.accountId,
    controlSurface: 'cli',
  }),
  canOpenOnDesktop: () => true, hubSupportsWait: () => false, hubSupportsSteer: () => mockHubSteer,
  hubSupportsContext: () => mockHubContext, sessionContextScope: (device: string, session: string) => mockContextScope(device, session),
  hubSupportsSessionActions: () => mockHubSessionActions, nativeSessionActionScope: (device: string, session: string) => mockContextScope(device, session),
  readNativeSessionActions: async (device: string, session: string) => ({ scope: mockContextScope(device, session), value: {
    sessionKey: session, revision: 'r1', title: '原名称', archived: false, actions: ['rename', 'archive', 'fork'],
  } }),
  hubSupportsSideQuestions: () => mockHubSideQuestion, hubSupportsDiffAnnotations: () => mockHubDiffAnnotations, hubSupportsCooperation: () => mockHubCooperation,
  hubSupportsTemporarySideChat: () => mockHubSideQuestion, readTemporarySideChat: (...args: unknown[]) => mockReadTemporarySideChat(), askTemporarySideChat: (...args: unknown[]) => mockAskTemporarySideChat(...args), uploadTemporarySideChatImages: jest.fn(async () => []),
  cooperationScope: (device: string, session: string) => mockContextScope(device, session), cooperationReceiptOwner: (device: string) => `owner:${device}`,
  loadSessions: jest.fn(async () => undefined), prepareCooperation: (...args: [string, string, string, AbortSignal?]) => mockPrepareCooperation(...args),
  sendCooperation: jest.fn(async () => ({ state: 'sent' })), sessionSideQuestionScope: (device: string, session: string) => mockContextScope(device, session),
  sessionSideQuestionStorageScope: (device: string, session: string) => mockRemote.agents[device]?.list[0] ? mockContextScope(device, session) : '',
  sessionSideQuestionHistoryOwner: (device: string, session: string) => JSON.stringify([mockDeliveryScope, device, session]),
  restoreSessionSideQuestionStorageScope: (device: string, session: string) => mockRestoreSideQuestionHistoryScope(JSON.stringify([mockDeliveryScope, device, session])),
  deleteSessionSideQuestion: jest.fn(async () => undefined),
  readSessionSideQuestion: (...args: unknown[]) => mockReadSideQuestion(...args), askSessionSideQuestion: (...args: unknown[]) => mockAskSideQuestion(...args),
  readSessionContext: (...args: unknown[]) => mockReadContext(...args), compactSessionContext: (...args: unknown[]) => mockCompactContext(...args),
  cancelPendingRemoteMessage: (...args: unknown[]) => mockCancelPending(...args), openOnDesktop: (...args: unknown[]) => mockOpenDesktop(...args), interruptSession: jest.fn(), continueSession: (...args: unknown[]) => mockContinue(...args),
  pausePendingRemoteMessage: jest.fn(async () => undefined),
  syncSessionEvents: jest.fn(), remoteDeliveryScope: () => mockDeliveryScope, listProjects: async (deviceId: string) => mockRemote.devices.find(device => device.deviceId === deviceId)?.projects ?? [],
}));

const originalAgent: AgentProfile = {
  id: 'codex', name: 'Codex', tool: 'codex', available: true, remoteSendSupported: true, conversationApiSwitch: true,
  api: { name: '主力', model: 'gpt-fixture', protocol: 'responses', configured: true, pending: false, source: 'computer', accountId: 'api_original' },
};
const originalSession: SessionInfo = {
  sessionKey: 'codex:original', tool: 'codex', client: 'Codex App', title: '原会话', cwd: 'C:\\fixture', updatedAt: 1,
  status: 'idle', controllable: true, controlSurface: 'cli', model: 'gpt-fixture',
};

function enablePermissionModes(autoAll = true) {
  const capabilities: AgentCapabilities = { list: true, read: true, send: true, interrupt: true, approval: true, questions: true,
    subagents: true, attachments: true, imageInput: true, imageOutput: true, modelOverride: true, continue: true,
    permissionModes: ['ask', 'auto_review', 'full_access'] };
  mockRemote.agents.pc.list = [{ ...originalAgent, capabilities }]; mockRemote.agents.pc.autoAll = autoAll;
}

function setItems(items: TimelineItem[], session = originalSession) {
  mockRemote.timelines['pc|codex:original'] = { items, loading: false, session };
}
function viewThread(onCreated = jest.fn(), visible = true, onAgentSettings = jest.fn(), agentSettingsOpen = false) {
  return <ThreadView visible={visible} deviceId="pc" sessionKey="codex:original" agent={originalAgent} onClose={jest.fn()} onCreated={onCreated} onAgentSettings={onAgentSettings} agentSettingsOpen={agentSettingsOpen} />;
}

test('complete Hub history recovery restores original images and references into the current draft without sending',async()=>{
 enablePermissionModes();
 mockRemote.agents.pc.list[0].capabilities!.contextReferences=true;
 const image={uri:'file:///historical.png',mime:'image/png' as const,width:20,height:30,base64:'eA=='};
 const reference={kind:'file' as const,projectPath:'C:/fixture',path:'main.ts',label:'main.ts',text:'original code',startLine:1,endLine:1,capturedAt:1};
 const input:TimelineItem={kind:'message',id:'historical-input',role:'user',text:'Historical request',final:true,ts:1,attachments:[{id:'att_historical',...image}],contextReferences:[reference]};
 setItems([input]);mockRetryImages.mockResolvedValue([image]);
 const view=await render(viewThread());await act(async()=>{});await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'),'Keep current draft');
 await fireEvent.press(view.getByLabelText('添加到对话'));await fireEvent.press(view.getByLabelText('最近输入'));await fireEvent.press(view.getByLabelText('复用输入 historical-input'));await act(async()=>{});
 expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('Keep current draft\n\nHistorical request');
 expect(mockComposerSave.mock.calls.at(-1)?.[2]).toMatchObject({images:[image],featureIntent:{contextReferences:[reference]}});expect(mockSend).not.toHaveBeenCalled();expect(mockStart).not.toHaveBeenCalled();await view.unmount();
});

test('complete Hub history recovery preserves the draft when an original image is missing',async()=>{
 enablePermissionModes();const input:TimelineItem={kind:'message',id:'historical-missing',role:'user',text:'Historical image request',final:true,ts:1,attachments:[{id:'att_historical',uri:'file:///missing.png',mime:'image/png',width:20,height:30}]};
 setItems([input]);mockRetryImages.mockRejectedValueOnce(new Error('Original image unavailable'));
 const view=await render(viewThread());await act(async()=>{});await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'),'Keep current draft');
 await fireEvent.press(view.getByLabelText('添加到对话'));await fireEvent.press(view.getByLabelText('最近输入'));await fireEvent.press(view.getByLabelText('复用输入 historical-missing'));await act(async()=>{});
 expect(view.getByText('Original image unavailable')).toBeTruthy();expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('Keep current draft');expect(mockSend).not.toHaveBeenCalled();await view.unmount();
});

test('complete Hub history recovery rejects now-unsupported references without freezing the current composer',async()=>{
 enablePermissionModes();setItems([{kind:'message',id:'historical-unavailable',role:'user',text:'Historical reference',final:true,ts:1,contextReferences:[{kind:'file',projectPath:'C:/fixture',path:'main.ts',label:'main.ts',text:'code',startLine:1,endLine:1,capturedAt:1}]}]);
 const view=await render(viewThread());await act(async()=>{});await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'),'Keep draft');
 await fireEvent.press(view.getByLabelText('添加到对话'));await fireEvent.press(view.getByLabelText('最近输入'));await fireEvent.press(view.getByLabelText('复用输入 historical-unavailable'));
 expect(view.getByText('当前 Agent 不支持原消息中的引用或批注，当前草稿未改变')).toBeTruthy();expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('Keep draft');expect(view.getByLabelText('给电脑上的 Agent 发消息').props.editable).toBe(true);expect(mockSend).not.toHaveBeenCalled();await view.unmount();
});

test('a long task keeps bounded reply recovery alive after its foreground watch window expires', async () => {
  const partial: TimelineItem = { kind: 'message', id: 'lost-final', turnId: 'long-turn', role: 'assistant', text: '回复开头', final: false, ts: 1 };
  setItems([partial], { ...originalSession, status: 'running' });
  const view = await render(viewThread());
  await act(async () => { jest.advanceTimersByTime(120_001); });
  setItems([{ ...partial, streamState: 'terminal-unconfirmed' }], { ...originalSession, status: 'idle' });
  await view.rerender(viewThread());
  expect(mockLiveSync.mock.calls.at(-1)?.slice(0, 2)).toEqual([true, true]);
  setItems([{ ...partial, streamState: 'incomplete' }], { ...originalSession, status: 'idle' });
  await view.rerender(viewThread());
  expect(mockLiveSync.mock.calls.at(-1)?.slice(0, 2)).toEqual([true, false]);
  setItems([{ ...partial, text: '完整回复', final: true }], { ...originalSession, status: 'idle' });
  await view.rerender(viewThread());
  expect(mockLiveSync.mock.calls.at(-1)?.slice(0, 2)).toEqual([true, false]);
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
  await view.unmount();
});

test('main dialogue: live heading follows the current turn and ends when its final answer arrives', async () => {
  jest.useFakeTimers(); jest.setSystemTime(30_000);
  const items: TimelineItem[] = [
    { kind: 'turn', id: 'start', turnId: 'active', status: 'started', ts: 4_000 },
    { kind: 'message', id: 'progress', turnId: 'active', role: 'assistant', messagePhase: 'commentary', text: '正在核对正文。', final: true, ts: 5_000 },
    { kind: 'turn', id: 'old-end', turnId: 'old', status: 'completed', ts: 6_000 },
  ];
  setItems(items, { ...originalSession, status: 'running' });
  const view = await render(viewThread());
  expect(view.getByTestId('running-turn-header')).toBeTruthy();
  expect(view.getByText('已处理 26 秒')).toBeTruthy();
  setItems([...items,
    { kind: 'message', id: 'final', turnId: 'active', role: 'assistant', text: '正文核对完成。', messagePhase: 'final_answer', final: true, ts: 29_000 },
    { kind: 'turn', id: 'end', turnId: 'active', status: 'completed', durationMs: 26_000, ts: 30_000 },
  ], { ...originalSession, status: 'idle' });
  await view.rerender(viewThread());
  expect(view.queryByTestId('running-turn-header')).toBeNull();
  expect(view.getByTestId('completed-turn-header')).toBeTruthy();
  expect(view.getAllByText('用时 26 秒')).toHaveLength(1);
});

test('browser isolation: a tablet mounts only one tool workspace, including while folded', async () => {
  const original = Dimensions.get('window');
  try {
    Dimensions.set({ window: { ...original, width: 1280, height: 900 } });
    const view = await render(viewThread());
    expect(view.getAllByTestId('remote-sidebar', { includeHiddenElements: true })).toHaveLength(1);
    const fold = view.queryByLabelText('折叠工具栏');
    if (fold) await fireEvent.press(fold);
    expect(view.getAllByTestId('remote-sidebar', { includeHiddenElements: true })).toHaveLength(1);
  } finally { await act(async () => Dimensions.set({ window: original })); }
});

test('browser isolation: a direct session switch cannot import the previous conversation manual link', async () => {
  const view = await render(viewThread());
  await act(async () => mockThreadUi.mock.calls.at(-1)![0].openLink('https://old-session.example/', true));
  expect(view.getByRole('tab', { name: '网页 old-session.example' })).toBeTruthy();
  const session = { ...originalSession, sessionKey: 'codex:another-browser', title: '另一个对话' };
  mockRemote.timelines['pc|codex:another-browser'] = { session, loading: false,
    items: [{ kind: 'message', id: 'other-browser-reply', role: 'assistant', text: '另一个回复', final: true, ts: 1 }] };
  await view.rerender(<ThreadView visible deviceId="pc" sessionKey={session.sessionKey} agent={originalAgent} onClose={jest.fn()} onCreated={jest.fn()} />);
  expect(view.queryByRole('tab', { name: '网页 old-session.example', includeHiddenElements: true })).toBeNull();
});

test('browser isolation: resizing tablet to phone keeps page instances and dismissed Agent tabs', async () => {
  const original = Dimensions.get('window');
  try {
    Dimensions.set({ window: { ...original, width: 1280, height: 900 } });
    setItems([
      { kind: 'message', id: 'browser-answer', role: 'assistant', text: '网页已准备好', final: true, ts: 1 },
      { kind: 'tool', id: 'desktop-open', tool: 'mcp', title: 'browser_navigate', status: 'done', ts: 2,
        browser: { action: 'open', url: 'https://desktop.example/', pageId: 'playwright:1' } },
    ]);
    const view = await render(viewThread());
    await fireEvent.press(view.getByLabelText('关闭标签 desktop.example'));
    await act(async () => mockThreadUi.mock.calls.at(-1)![0].openLink('https://user.example/', true));
    await fireEvent.changeText(view.getByLabelText('网页表单 https://user.example/'), '未提交的网页表单');
    await fireEvent.changeText(view.getByLabelText('浏览器地址'), 'https://user.example/draft');
    await act(async () => Dimensions.set({ window: { ...original, width: 390, height: 844 } }));
    expect(view.getAllByTestId('remote-sidebar', { includeHiddenElements: true })).toHaveLength(1);
    expect(view.queryByRole('tab', { name: '网页 desktop.example', includeHiddenElements: true })).toBeNull();
    expect(view.getByLabelText('网页表单 https://user.example/').props.value).toBe('未提交的网页表单');
    expect(view.getByLabelText('浏览器地址').props.value).toBe('https://user.example/draft');
    await fireEvent.press(view.getByLabelText('返回聊天'));
    expect(view.queryByLabelText('浏览器地址')).toBeNull();
    await fireEvent.press(view.getByLabelText('打开工具栏'));
    expect(view.getByLabelText('网页表单 https://user.example/').props.value).toBe('未提交的网页表单');
    await act(async () => view.getByTestId('remote-thread-modal').props.onRequestClose());
    expect(view.queryByLabelText('浏览器地址')).toBeNull();
    await fireEvent.press(view.getByLabelText('打开工具栏'));
    expect(view.getByLabelText('网页表单 https://user.example/').props.value).toBe('未提交的网页表单');
    await act(async () => Dimensions.set({ window: { ...original, width: 1280, height: 900 } }));
    expect(view.getAllByTestId('remote-sidebar', { includeHiddenElements: true })).toHaveLength(1);
    expect(view.queryByRole('tab', { name: '网页 desktop.example', includeHiddenElements: true })).toBeNull();
    expect(view.getByLabelText('网页表单 https://user.example/').props.value).toBe('未提交的网页表单');
  } finally { await act(async () => Dimensions.set({ window: original })); }
});
async function openModels(view: Awaited<ReturnType<typeof render>>) {
  if (!view.queryByTestId('remote-model-popover')) await fireEvent.press(view.getByLabelText(/模型：/));
}

test('native tablet system Back restores split, closes tools, then leaves the conversation', async () => {
  const original = Dimensions.get('window'), close = jest.fn();
  try {
    Dimensions.set({window:{...original,width:1280,height:900}});
    setItems([]);
    const view = await render(<ThreadView visible deviceId="pc" sessionKey="codex:original" agent={originalAgent} onClose={close} onCreated={jest.fn()}/>);
    await fireEvent.press(view.getByLabelText('标签页更多'));
    await fireEvent.press(view.getByLabelText('全页查看'));
    expect(view.getByTestId('tablet-thread-center', {includeHiddenElements:true})).not.toBeVisible();
    await act(async()=>view.getByTestId('remote-thread-modal').props.onRequestClose());
    expect(view.getByTestId('tablet-thread-center')).toBeVisible();
    expect(view.getByLabelText('新标签页地址或搜索')).toBeTruthy();
    expect(close).not.toHaveBeenCalled();
    await act(async()=>view.getByTestId('remote-thread-modal').props.onRequestClose());
    expect(view.queryByLabelText('新标签页地址或搜索')).toBeNull();
    expect(close).not.toHaveBeenCalled();
    await act(async()=>view.getByTestId('remote-thread-modal').props.onRequestClose());
    expect(close).toHaveBeenCalledTimes(1);
    await view.unmount();
  } finally { await act(async()=>Dimensions.set({window:original})); }
});
async function closeModels(view: Awaited<ReturnType<typeof render>>) {
  if (view.queryByTestId('remote-model-popover')) await fireEvent.press(view.getByTestId('remote-model-popover-backdrop', { includeHiddenElements: true }));
}
// Agent configuration lives outside the conversation. These catalog tests apply
// that external result and then observe the conversation's reconciliation.
async function changeAgentApi(view: Awaited<ReturnType<typeof render>>, accountId = 'api_backup') {
  await act(async () => { await mockSetApi('pc', 'codex', accountId, '', 'codex:original'); });
  await view.rerender(viewThread());
  await openModels(view);
}


test('native hook approval offers only this request allow/deny and keeps the original desktop surface', async () => {
  mockRemote.agents.pc.list = [{ ...originalAgent, desktopLive: { expiresAt: Date.now() + 60000, sessionKeys: ['codex:original'],
    capabilities: { ...desktopCapabilities, approval: true }, approvalTransport: 'codex-hook-v1' } }];
  setItems([{ kind: 'approval', id: '11111111-2222-4333-8444-555555555555', approval: 'command', title: 'Bash', detail: 'git status',
    state: 'pending', ts: Date.now(), expiresAt: Date.now() + 60000, approvalTransport: 'codex-hook-v1' }], { ...originalSession, controlSurface: 'desktop', status: 'waiting_approval' });
  const view = await render(viewThread());
  expect(view.queryByText('本对话都允许')).toBeNull();
  await fireEvent.press(view.getByText('允许'));
  expect(mockRespond).toHaveBeenCalledWith(expect.objectContaining({ controlSurface: 'desktop', sessionKey: originalSession.sessionKey }), 'allow', undefined, undefined,
    expect.objectContaining({ requestId: expect.any(String), retrying: false }));
});

test('a pending native hook cannot enable approval after the host withdrew capability', async () => {
  mockRemote.agents.pc.list = [{ ...originalAgent, desktopLive: { expiresAt: Date.now() + 60000, sessionKeys: ['codex:original'],
    capabilities: { ...desktopCapabilities, approval: false } } }];
  setItems([{ kind: 'approval', id: '11111111-2222-4333-8444-555555555555', approval: 'command', title: 'Bash', detail: 'git status',
    state: 'pending', ts: Date.now(), expiresAt: Date.now() + 60000, approvalTransport: 'codex-hook-v1' }], { ...originalSession, controlSurface: 'desktop', status: 'waiting_approval' });
  const view = await render(viewThread());
  await fireEvent.press(view.getByText('允许'));
  expect(mockRespond).not.toHaveBeenCalled();
});

test.each(['cli', 'desktop'] as const)('a non-question %s approval owns a cancellable request when its conversation is hidden', async surface => {
  if (surface === 'desktop') mockRemote.agents.pc.list = [{ ...originalAgent, desktopLive: {
    expiresAt: Date.now() + 60000, sessionKeys: ['codex:original'],
    capabilities: { ...desktopCapabilities, approval: true }, approvalTransport: 'codex-hook-v1',
  } }];
  setItems([{ kind: 'approval', id: '11111111-2222-4333-8444-555555555555', approval: 'command', title: 'Bash', detail: 'git status',
    state: 'pending', ts: Date.now(), expiresAt: Date.now() + 60000,
    ...(surface === 'desktop' ? { approvalTransport: 'codex-hook-v1' as const } : {}),
  }], { ...originalSession, controlSurface: surface, status: 'waiting_approval' });
  let finish!: () => void;
  mockRespond.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = await render(viewThread());
  await fireEvent.press(view.getByText('允许'));
  expect(mockRespond).toHaveBeenCalledTimes(1);
  const receipt = mockRespond.mock.calls[0][4] as { requestId: string; retrying: boolean; scope: string; signal: AbortSignal };
  expect(receipt).toMatchObject({ requestId: expect.any(String), retrying: false, scope: mockDeliveryScope });
  expect(receipt.signal.aborted).toBe(false);
  await view.rerender(viewThread(undefined, false));
  expect(receipt.signal.aborted).toBe(true);
  await act(async () => { finish(); });
  expect(mockRespond).toHaveBeenCalledTimes(1);
  expect(mockToast).not.toHaveBeenCalled();
});
beforeEach(() => {
  resetWorkspaceLayoutMemoryForTests();
  resetSideQuestionConversationsForTests(); resetTemporarySideChatsForTests(); mockReadTemporarySideChat.mockClear(); mockAskTemporarySideChat.mockClear();
  mockHubSteer = false;mockHubRevert=false;mockRevertLatest.mockReset().mockResolvedValue(undefined);mockEditBackupSave.mockClear();mockEditBackupConsume.mockClear();mockEditBackupRestore.mockReset().mockResolvedValue(undefined);
  mockHubContext = false;
  mockHubSideQuestion = false; mockReadSideQuestion.mockClear(); mockAskSideQuestion.mockClear();
  mockHubDiffAnnotations = false;
  mockHubSessionActions = false;
  mockHubCooperation = false;
  mockPrepareCooperation.mockReset().mockImplementation(async (_device, source, target) => ({ ticket: 'a'.repeat(64), expiresAt: Date.now() + 60_000,
    source: { ...originalSession, sessionKey: source }, target: { ...originalSession, sessionKey: target, title: '目标任务' }, scope: mockContextScope('pc', source) }));
  mockReadContext.mockReset().mockImplementation(async () => mockContextReading());
  mockCompactContext.mockReset().mockImplementation(async () => ({ ...mockContextReading(), value: { ...mockContextReading().value, canCompact: false,
    compaction: { state: 'requested', blocking: true, startedAt: 1, updatedAt: 1 } } }));
  mockQuestionStorage.clear();
  mockFeatureGenerations.clear();
  mockDialogActions.clear();
  mockDeliveryScope = 'paired|fixture-credential';
  mockOpen.mockReset().mockResolvedValue(undefined);
  jest.clearAllMocks(); jest.useFakeTimers();
  jest.replaceProperty(AppState, 'currentState', 'active');
  // Geometry refs are synthetic; keep native animation plumbing out of the host mock.
  const animation: typeof Animated.spring = (value, config) => {
    if (value instanceof Animated.Value && typeof config.toValue === 'number') value.setValue(config.toValue);
    return { start: (callback) => callback?.({ finished: true }), stop: () => undefined, reset: () => undefined };
  };
  jest.spyOn(Animated, 'spring').mockImplementation(animation);
  jest.spyOn(Animated, 'timing').mockImplementation(animation);
  jest.spyOn(Animated, 'loop').mockImplementation(() => ({
    start: () => undefined,
    stop: () => undefined,
    reset: () => undefined,
  }));
  mockSend.mockResolvedValue(undefined);
  mockContinue.mockReset().mockResolvedValue(undefined);
  mockRespond.mockReset().mockResolvedValue(undefined);
  mockPickImages.mockReset().mockResolvedValue([]);
  mockLoadPrefs.mockReset().mockResolvedValue({});
  mockPending.mockReset().mockResolvedValue(undefined);
  mockPendingNew.mockReset().mockResolvedValue(undefined);
  mockRetryNew.mockReset().mockResolvedValue('codex:recovered');
  mockAcknowledgeNew.mockReset().mockResolvedValue(undefined);
  mockFeatures.mockReset().mockResolvedValue({ collaborationModes: ['default', 'plan'], skillsSupported: true, skills: [{ name: 'review', path: 'C:/fixture/SKILL.md', description: 'Review code' }] });
  mockStart.mockReset().mockResolvedValue('codex:new');
  mockLoadQueued.mockReset().mockResolvedValue([]);
  mockSaveQueued.mockReset().mockResolvedValue(undefined);
  mockRetryImages.mockReset().mockResolvedValue([]);
  mockComposerRestore.mockReset().mockResolvedValue(undefined);
  mockComposerSave.mockReset().mockImplementation(async (_key, scope, draft) => ({ ...draft, scope, revision: 1, identity: '0199aaa1-1234-4678-9abc-000000000001', imageCount: draft.imageCount ?? draft.images.length }));
  mockComposerHydrate.mockReset().mockImplementation(async (_scope, draft) => draft.images);
  mockComposerConsume.mockReset().mockResolvedValue(true);
  mockCopyMissing.mockClear(); mockUndoMissing.mockClear();
  mockCaptureModelBackdrop.mockReset().mockResolvedValue(undefined);
  mockListModels.mockReset().mockImplementation(async () => {
    const api = mockRemote.agents.pc.list[0].api;
    return { models: api.accountId === 'api_backup' ? ['deepseek-chat'] : ['gpt-fixture'], api: api.name };
  });
  mockRemote = {
    phase: 'ready', serviceId: null, connections: [], connectionId: 'paired', selectedHubUrl: 'https://fixture.test', probes: {}, connection: 'open',
    devices: [{ deviceId: 'pc', name: '测试电脑', os: 'windows', online: true, lastSeen: 1, tools: [], projects: [] }], devicesLoaded: true,
    sessions: { pc: { list: [originalSession], loading: false, loaded: true } },
    agents: { pc: { list: [originalAgent], apis: [{ id: 'api_backup', name: '备用', models: ['deepseek-chat'] }], loading: false, loaded: true } },
    timelines: {}, approvals: {}, signingIn: null, focus: null,
  };
  setItems([{ kind: 'message', id: 'old-reply', role: 'assistant', text: '原来的回复', final: true, ts: 1 }]);
  mockSetApi.mockImplementation(async () => {
    const changed: AgentProfile = { ...originalAgent, api: { ...originalAgent.api, name: '备用', model: '', source: 'phone', accountId: 'api_backup' } };
    mockRemote.agents.pc.list = [changed];
    return changed;
  });
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test.each(['idle', 'running'] as const)('image-only composer sends or queues the original image while %s', async status => {
  const image: RemoteImage = { uri: 'file://picker/image-only.jpg', base64: 'fixture', mime: 'image/jpeg', width: 40, height: 40 };
  mockRemote.timelines['pc|codex:original'].session = { ...originalSession, status };
  mockPickImages.mockResolvedValueOnce([image]);
  const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '');
  await fireEvent.press(view.getByRole('button', { name: '添加到对话' }));
  await fireEvent.press(view.getByLabelText('从相册选择'));
  const button = view.getByLabelText(status === 'running' ? '排队发送' : '发送');
  expect(button.props.accessibilityState.disabled).toBe(false);
  expect(view.queryByLabelText('停止')).toBeNull();
  await fireEvent.press(button);
  if (status === 'idle') {
    expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '', expect.objectContaining({ images: [image] }));
    expect(mockSend.mock.calls[0][3]).toMatchObject({ draftOwner: { kind: 'composer', revision: 1, identity: '0199aaa1-1234-4678-9abc-000000000001' } });
  } else {
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockSaveQueued.mock.calls.some(([, rows]) => (rows as LoadedQueuedRemoteDraft[]).some(row => row.text === '' && row.images.length === 1))).toBe(true);
  }
});

test('the main thread menu keeps the conversation and search without reading settings or message navigation', async () => {
  const view = await render(viewThread());
  expect(view.getByText('原来的回复')).toBeTruthy();
  expect(view.queryByTestId('conversation-reading-panel')).toBeNull();
  await fireEvent.press(view.getByLabelText('更多'));
  expect(view.getByLabelText('搜索对话')).toBeTruthy();
  expect(view.queryByLabelText('阅读设置与消息导航')).toBeNull();
  expect(view.queryByTestId('conversation-reading-panel')).toBeNull();
  await fireEvent.press(view.getByLabelText('搜索对话'));
  expect(view.getByPlaceholderText('搜索这个对话')).toBeTruthy();
  expect(view.getByText('原来的回复')).toBeTruthy();
  expect(view.queryByTestId('conversation-reading-panel')).toBeNull();
});

test('search expands a folded matching tool output', async () => {
  setItems([{ kind: 'tool', id: 'search-output', tool: 'command', title: '运行命令', output: 'unique loaded output', status: 'done', ts: 1 }]);
  const view = await render(viewThread());
  expect(view.queryByText('unique loaded output')).toBeNull();
  await fireEvent.press(view.getByLabelText('更多'));
  await fireEvent.press(view.getByLabelText('搜索对话'));
  await fireEvent.changeText(view.getByPlaceholderText('搜索这个对话'), 'unique loaded output');
  expect(view.getByText('unique loaded output')).toBeTruthy();
});

function enableSteer() {
  enablePermissionModes();
  mockHubSteer = true;
  mockRemote.agents.pc.list[0].capabilities!.steer = true;
  setItems([], { ...originalSession, status: 'running', activeTurnId: 'turn-active' });
  mockRemote.timelines['pc|codex:original'].snapshotAt = Date.now();
}

test('active-turn steering uses the exact current turn and keeps normal queue sending separate', async () => {
  enableSteer(); const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), 'focus the failing tests');
  await fireEvent.press(view.getByLabelText('引导当前轮次'));
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', 'focus the failing tests', {
    control: 'steer', expectedTurnId: 'turn-active', accountId: 'api_original', surface: 'cli', images: [], newSubmission: true,
    draftOwner: { kind: 'composer', key: `${mockDeliveryScope}|pc|codex:original`, revision: 1, identity: '0199aaa1-1234-4678-9abc-000000000001' },
  });
  expect(mockSaveQueued).not.toHaveBeenCalled();
  expect(mockComposerConsume).not.toHaveBeenCalled(); // The durable send transaction now consumes accepted drafts.
});

test('a cached running snapshot cannot enable the active-turn steering button', async () => {
  enableSteer(); mockRemote.timelines['pc|codex:original'].cachedAt = Date.now();
  const view = await render(viewThread());
  expect(view.getByLabelText('引导当前轮次').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(view.getByLabelText('引导当前轮次'));
  expect(mockSend).not.toHaveBeenCalled();
});

test('steering never silently discards a chosen next-turn thinking effort', async () => {
  enableSteer(); useReportedModels();
  const view = await render(viewThread());
  await scrubEffort(view, 2);
  await fireEvent.press(view.getByLabelText('引导当前轮次'));
  expect(mockSend).not.toHaveBeenCalled();
  expect(mockToast).toHaveBeenCalledWith(expect.stringContaining('更换设置请排队发送'), 'alert');
  expect(mockComposerConsume).not.toHaveBeenCalled();
});

test('capability withdrawal removes steering without removing the draft', async () => {
  enableSteer(); const view = await render(viewThread());
  expect(view.getByLabelText('引导当前轮次')).toBeTruthy();
  mockHubSteer = false;mockHubRevert=false;mockRevertLatest.mockReset().mockResolvedValue(undefined);mockEditBackupSave.mockClear();mockEditBackupConsume.mockClear();mockEditBackupRestore.mockReset().mockResolvedValue(undefined);
  await view.rerender(viewThread());
  expect(view.queryByLabelText('引导当前轮次')).toBeNull();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
  expect(mockSend).not.toHaveBeenCalled();
});

test.each(['unknown', 'idle'] as const)('an external Claude %s history keeps its draft but disables a new send', async status => {
  const agent: AgentProfile = { ...originalAgent, id: 'claude', tool: 'claude', name: 'Claude Code', api: { ...originalAgent.api, accountId: 'api_aaaaaaaa' } };
  const session: SessionInfo = { ...originalSession, sessionKey: 'claude:external', tool: 'claude', client: 'Claude Code', status, controllable: false };
  mockRemote.agents.pc.list = [agent];
  mockRemote.sessions.pc.list = [session];
  mockRemote.timelines = { 'pc|claude:external': { items: [], loading: false, snapshotAt: Date.now(), session } };
  const renderThread = () => <ThreadView visible deviceId="pc" sessionKey={session.sessionKey} agent={agent} onClose={jest.fn()} onCreated={jest.fn()} />;
  const view = await render(renderThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '未发送的草稿');
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  await act(async () => { mockSendSubmit.current(); });
  expect(mockSend).not.toHaveBeenCalled();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('未发送的草稿');
  mockRemote.timelines['pc|claude:external'].session = { ...session, status: 'idle', controllable: true, updatedAt: 2 };
  await view.rerender(renderThread());
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(false);
});

test.each(['claude', 'claude-desktop'] as const)('%s without an applied API retains the composer and history until API configuration is confirmed', async id => {
  const agent: AgentProfile = { ...originalAgent, id, tool: 'claude', name: id === 'claude' ? 'Claude Code' : 'Claude Desktop',
    api: { ...originalAgent.api, configured: false, source: 'tool', accountId: undefined } };
  const session: SessionInfo = { ...originalSession, sessionKey: 'claude:api-only', tool: 'claude', client: agent.name };
  mockRemote.agents.pc.list = [agent]; mockRemote.sessions.pc.list = [session];
  mockRemote.timelines = { 'pc|claude:api-only': { items: [{ kind: 'message', id: 'history', role: 'assistant', text: '保留历史', final: true, ts: 1 }], loading: false, snapshotAt: Date.now(), session } };
  const renderThread = () => <ThreadView visible deviceId="pc" sessionKey={session.sessionKey} agent={agent} onClose={jest.fn()} onCreated={jest.fn()} />;
  const view = await render(renderThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '等待 API 的草稿');
  expect(view.getByText('保留历史')).toBeTruthy();
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  await act(async () => { mockSendSubmit.current(); });
  expect(mockSend).not.toHaveBeenCalled();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('等待 API 的草稿');
  mockRemote.agents.pc.list = [{ ...agent, api: { ...agent.api, configured: true, source: 'computer', accountId: 'api_aaaaaaaa' } }];
  await view.rerender(renderThread());
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(false);
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('等待 API 的草稿');
});

test.each([false, true])('Claude with no API only recovers an already attempted receipt (attempted=%s)', async attempted => {
  const agent: AgentProfile = { ...originalAgent, id: 'claude', tool: 'claude', name: 'Claude Code',
    api: { ...originalAgent.api, configured: false, source: 'tool', accountId: undefined } };
  const session: SessionInfo = { ...originalSession, sessionKey: 'claude:receipt', tool: 'claude', client: 'Claude Code' };
  mockRemote.agents.pc.list = [agent]; mockRemote.sessions.pc.list = [session];
  mockRemote.timelines = { 'pc|claude:receipt': { items: [], loading: false, snapshotAt: Date.now(), session } };
  const requestId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  mockPending.mockResolvedValue({ scope: mockDeliveryScope, deviceId: 'pc', sessionKey: session.sessionKey, surface: 'cli', text: '原任务',
    requestId, createdAt: Date.now(), firstAttemptAt: attempted ? Date.now() : undefined, attempted, safeRetry: true,
    sendOptions: { accountId: 'api_aaaaaaaa' } });
  const view = await render(<ThreadView visible deviceId="pc" sessionKey={session.sessionKey} agent={agent} onClose={jest.fn()} onCreated={jest.fn()} />);
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '新草稿');
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(view.getByLabelText('更多')); await fireEvent.press(view.getByLabelText('重试原消息'));
  if (attempted) expect(mockSend).toHaveBeenCalledWith('pc', session.sessionKey, '原任务', { retryRequestId: requestId });
  else expect(mockSend).not.toHaveBeenCalled();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('新草稿');
});

test('opening a listed computer conversation reads its original history without starting or sending a task', async () => {
  let release!: () => void;
  const read = new Promise<void>((resolve) => { release = resolve; });
  mockRemote.timelines = { 'pc|codex:original': { items: [], loading: true, session: originalSession } };
  mockOpen.mockImplementationOnce(async () => {
    await read;
    setItems([
      { kind: 'message', id: 'computer-user', role: 'user', text: '电脑上之前发过的任务', final: true, ts: 1 },
      { kind: 'message', id: 'computer-reply', role: 'assistant', text: '电脑上之前的回答与结果', final: true, ts: 2 },
    ]);
  });
  const view = await render(viewThread());
  expect(mockOpen).toHaveBeenCalledWith('pc', 'codex:original', expect.objectContaining({ signal: expect.any(Object) }));
  expect(view.getByText('正在从电脑读取对话…')).toBeTruthy();
  await act(async () => { release(); await read; });
  await view.rerender(viewThread());
  expect(view.getByText('电脑上之前发过的任务')).toBeTruthy();
  expect(view.getByText('电脑上之前的回答与结果')).toBeTruthy();
  expect(view.queryByText('正在从电脑读取对话…')).toBeNull();
  expect(mockStart).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
  expect(mockSetApi).not.toHaveBeenCalled();
});

test('Hermes resumes its original model without a catalogue or stale override', async () => {
  const profile: AgentProfile = { ...originalAgent, id: 'hermes', tool: 'hermes', name: 'Hermes Agent', execution: { tool: 'hermes', controlSurface: 'cli' },
    capabilities: { list: true, read: true, send: true, approval: true, interrupt: true, questions: false, subagents: false, attachments: false, imageInput: false, imageOutput: false, modelOverride: false, startModelOverride: true },
    api: { ...originalAgent.api, model: 'new-default' } };
  const session: SessionInfo = { ...originalSession, sessionKey: 'hermes:original', tool: 'hermes', client: 'Hermes Agent', model: 'original-model' };
  mockRemote.agents.pc.list = [profile]; mockRemote.sessions.pc.list = [session];
  mockRemote.timelines = { 'pc|hermes:original': { items: [], session, loading: false } };
  mockLoadPrefs.mockResolvedValue({ model: 'stale-selection', effort: 'high', apiIdentity: 'computer:api_original' });
  mockListModels.mockRejectedValue(new Error('Catalog unavailable'));
  const view = await render(<ThreadView visible deviceId="pc" sessionKey={session.sessionKey} agent={profile} onClose={jest.fn()} onCreated={jest.fn()} />);
  expect(view.getByLabelText('模型：original-model')).toBeDisabled();
  await fireEvent.press(view.getByLabelText('模型：original-model'));
  expect(view.queryByTestId('remote-model-popover')).toBeNull(); expect(view.queryByTestId('remote-effort-chip')).toBeNull();
  expect(mockListModels).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('添加到对话'));
  expect(view.getByLabelText('从相册选择')).toBeDisabled(); expect(view.getByLabelText('拍照')).toBeDisabled();
  await fireEvent.press(view.getByLabelText('关闭添加到对话'));
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', session.sessionKey, '原草稿', expect.objectContaining({ model: undefined, effort: undefined }));
  await view.unmount();
});

test.each([['hermes', 'Hermes Agent', true], ['deepseek-harness', 'DeepSeek Harness', false]] as const)('%s model selection respects its creation and resume capabilities', async (id, name, creating) => {
  const profile: AgentProfile = { ...originalAgent, id, tool: id, name, execution: { tool: id, controlSurface: 'cli' },
    capabilities: { list: true, read: true, send: true, approval: true, interrupt: true, questions: false, subagents: false, attachments: false, imageInput: false, imageOutput: false, modelOverride: !creating, startModelOverride: creating },
    api: { ...originalAgent.api, model: 'model-a' } };
  const session: SessionInfo = { ...originalSession, sessionKey: `${id}:original`, tool: id, client: name, model: 'model-a' };
  mockRemote.agents.pc.list = [profile]; mockRemote.sessions.pc.list = [session];
  mockRemote.timelines = { [`pc|${session.sessionKey}`]: { items: [], session, loading: false } };
  mockRemote.devices[0].projects = [{ path: 'C:\\fixture', name: 'fixture' }];
  mockListModels.mockResolvedValue({ models: ['model-a', 'model-b'] }); mockStart.mockResolvedValue(`${id}:new`);
  const view = await render(<ThreadView visible deviceId="pc" sessionKey={creating ? null : session.sessionKey} agent={profile} onClose={jest.fn()} onCreated={jest.fn()} />);
  await openModels(view); await fireEvent.press(view.getByRole('radio', { name: 'model-b' })); await closeModels(view);
  expect(view.getByLabelText('模型：model-b')).toBeEnabled(); expect(view.queryByTestId('remote-effort-chip')).toBeNull();
  await fireEvent.press(view.getByLabelText('发送'));
  if (creating) expect(mockStart).toHaveBeenCalledWith('pc', expect.objectContaining({ tool: id, model: 'model-b', effort: undefined }));
  else expect(mockSend).toHaveBeenCalledWith('pc', session.sessionKey, '原草稿', expect.objectContaining({ model: 'model-b', effort: undefined }));
  await view.unmount();
});

test('tapping outside the model popup preserves the current choice and draft without refreshing or sending', async () => {
  useReportedModels();
  mockLoadPrefs.mockResolvedValue({ model: 'gpt-fixture', effort: 'minimal', apiIdentity: 'computer:api_original' });
  const view = await render(viewThread());
  await openModels(view);
  expect(view.getByTestId('remote-model-popover')).toBeTruthy();
  mockListModels.mockClear(); mockSavePrefs.mockClear();
  await fireEvent.press(view.getByTestId('remote-model-popover-backdrop', { includeHiddenElements: true }));
  expect(view.queryByTestId('remote-model-popover')).toBeNull();
  expect(view.getByLabelText(`模型：${'gpt-fixture'}`)).toBeTruthy();
  expect(view.getByLabelText('Minimal')).toBeTruthy();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
  expect(mockListModels).not.toHaveBeenCalled(); expect(mockSavePrefs).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
});

test('model change records appear only after dismissal and restore without duplicating', async () => {
  mockListModels.mockResolvedValue(reportedCatalog(['gpt-fixture', 'next-model']));
  const view = await render(viewThread());
  expect(view.queryByTestId('model-change-notice')).toBeNull();
  await openModels(view); mockSavePrefs.mockClear();
  await fireEvent.press(view.getByRole('radio', { name: 'next-model' }));
  expect(view.getByTestId('remote-model-popover')).toBeTruthy();
  expect(view.queryByTestId('model-change-notice')).toBeNull();
  expect(mockSavePrefs).not.toHaveBeenCalled();
  await closeModels(view);
  expect(view.getAllByTestId('model-change-notice')).toHaveLength(1);
  expect(view.getByText('模型已从 gpt-fixture 更改为 next-model。')).toBeTruthy();
  expect(mockSavePrefs).toHaveBeenCalledTimes(1);
  expect(mockRemote.timelines['pc|codex:original'].items).toHaveLength(1);
  await openModels(view);
  await fireEvent.press(view.getByRole('radio', { name: 'next-model' }));
  await closeModels(view);
  expect(view.getAllByTestId('model-change-notice')).toHaveLength(1);
  expect(mockSavePrefs).toHaveBeenCalledTimes(1);
  mockLoadPrefs.mockResolvedValue({ model: 'next-model', apiIdentity: 'computer:api_original' });
  await view.unmount();
  const reopened = await render(viewThread());
  expect(reopened.getAllByTestId('model-change-notice')).toHaveLength(1);
  expect(reopened.getByText('模型已从 gpt-fixture 更改为 next-model。')).toBeTruthy();
  expect(mockSavePrefs).toHaveBeenCalledTimes(1);
});

test('model change records do not hide failed-turn retry or change the retry prompt', async () => {
  mockListModels.mockResolvedValue(reportedCatalog(['gpt-fixture', 'next-model']));
  setItems([
    { kind: 'message', id: 'request', role: 'user', text: '重试这个任务', final: true, ts: 1, turnId: 'current' },
    { kind: 'turn', id: 'current-end', status: 'failed', ts: 2, turnId: 'current' },
  ], { ...originalSession, status: 'failed' });
  const view = await render(viewThread());
  await openModels(view);
  await fireEvent.press(view.getByRole('radio', { name: 'next-model' }));
  await closeModels(view);
  expect(view.getAllByTestId('model-change-notice')).toHaveLength(1);
  expect(mockRemote.timelines['pc|codex:original'].items).toHaveLength(2);
  await fireEvent.press(view.getByLabelText('重试上一条消息'));
  expect(mockSend).toHaveBeenCalledWith('pc', originalSession.sessionKey, '重试这个任务', expect.objectContaining({ surface: 'cli', newSubmission: true }));
});

test('choosing the same model preserves its independent thinking setting', async () => {
  useReportedModels();
  mockLoadPrefs.mockResolvedValue({ model: 'gpt-fixture', effort: 'xhigh', apiIdentity: 'computer:api_original' });
  const view = await render(viewThread());
  await openModels(view); mockSavePrefs.mockClear();
  expect(view.queryByText('推理强度')).toBeNull();
  expect(mockSavePrefs).not.toHaveBeenCalled();
  await fireEvent.press(view.getByRole('radio', { name: 'gpt-fixture' })); await closeModels(view);
  expect(view.queryByTestId('remote-model-popover')).toBeNull();
  expect(view.getByLabelText('XHigh')).toBeTruthy();
  expect(mockSavePrefs).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: 'gpt-fixture', effort: 'xhigh' }));
  expect(hapticEffort).not.toHaveBeenCalled(); expect(hapticModelCommit).not.toHaveBeenCalled();
});

test.each([true, false])('changing the model preserves thinking only when its catalog supports it: %s', async supported => {
  const next = 'second-model';
  mockLoadPrefs.mockResolvedValue({ model: 'gpt-fixture', effort: 'high', apiIdentity: 'computer:api_original' });
  const catalog = reportedCatalog(['gpt-fixture', next]);
  catalog.modelCapabilities![next] = { source: 'codex-model-list', reasoningKnown: true, reasoningEfforts: supported ? ['low', 'high'] : ['low'] };
  mockListModels.mockResolvedValue(catalog);
  const view = await render(viewThread()); await openModels(view);
  expect(view.queryByText('推理强度')).toBeNull(); await fireEvent.press(view.getByRole('radio', { name: next })); await closeModels(view);
  expect(mockSavePrefs).toHaveBeenLastCalledWith('paired|pc|codex:original', { model: next, effort: supported ? 'high' : undefined, apiIdentity: 'computer:api_original' });
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: next, effort: supported ? 'high' : undefined }));
});

test.each(['tap', 'physical scrub'] as const)('%s independently changes, persists and sends the reported reasoning strength', async gesture => {
  useReportedModels();
  mockLoadPrefs.mockResolvedValue({ model: 'gpt-fixture', effort: 'low', apiIdentity: 'computer:api_original' });
  const view = await render(viewThread());
  if (gesture === 'tap') {
    await fireEvent.press(view.getByTestId('remote-effort-chip'));
    expect(mockSavePrefs).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ effort: 'medium' }));
    await fireEvent(view.getByTestId('main-effort-slider'), 'slidingComplete', 3);
    await fireEvent.press(view.getByLabelText('关闭推理强度选择', { includeHiddenElements: true }));
  }
  else {
    await fireEvent(view.getByTestId('remote-effort-touch'), 'touchStart', { nativeEvent: { pageX: 100 } });
    await fireEvent(view.getByTestId('remote-effort-chip'), 'longPress');
    await fireEvent(view.getByTestId('remote-effort-touch'), 'touchMove', { nativeEvent: { pageX: 100 + SCRUB_STEP * 2 } });
    await fireEvent(view.getByTestId('remote-effort-touch'), 'touchEnd');
  }
  const effort = gesture === 'tap' ? 'medium' : 'high';
  expect(view.getByLabelText(gesture === 'tap' ? 'Medium' : 'High')).toBeTruthy();
  expect(mockSavePrefs).toHaveBeenLastCalledWith('paired|pc|codex:original', { model: 'gpt-fixture', effort, apiIdentity: 'computer:api_original' });
  expect(hapticEffort).toHaveBeenCalledWith(effort);
  if (gesture === 'tap') expect(mockCaptureModelBackdrop).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: 'gpt-fixture', effort }));
});

test('an ID-only relay model remains selectable but cannot invent reasoning controls or a parameter', async () => {
  mockLoadPrefs.mockResolvedValue({ model: 'gpt-fixture', effort: 'xhigh', apiIdentity: 'computer:api_original' });
  const view = await render(viewThread());
  expect(view.queryByLabelText('XHigh')).toBeNull();
  expect(view.queryByLabelText('Default')).toBeNull();
  await openModels(view);
  await fireEvent(view.getByRole('radio', { name: 'gpt-fixture' }), 'pressIn');
  expect(view.queryByTestId('remote-model-effort-preview')).toBeNull();
  await fireEvent.press(view.getByRole('radio', { name: 'gpt-fixture' })); await closeModels(view);
  expect(mockSavePrefs).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: 'gpt-fixture', effort: undefined }));
});

test.each([undefined, 'phone:api_other'])('a preference from a missing or different API identity cannot inherit XHigh: %s', async (apiIdentity) => {
  useReportedModels();
  mockLoadPrefs.mockResolvedValue({ model: 'gpt-fixture', effort: 'xhigh', apiIdentity });
  const view = await render(viewThread());
  expect(view.queryByLabelText('XHigh')).toBeNull();
  expect(view.getByLabelText('Default')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ effort: undefined }));
});

test('a refreshed same-Key group cannot retain XHigh when the new catalog only reports IDs', async () => {
  useReportedModels();
  mockLoadPrefs.mockResolvedValue({ model: 'gpt-fixture', effort: 'xhigh', apiIdentity: 'computer:api_original' });
  const view = await render(viewThread());
  expect(view.getByLabelText('XHigh')).toBeTruthy();
  await openModels(view);
  mockListModels.mockResolvedValue({ models: ['gpt-fixture'] });
  await fireEvent.press(view.getByLabelText('刷新模型列表'));
  await closeModels(view);
  expect(view.queryByLabelText('XHigh')).toBeNull();
  expect(view.queryByLabelText('Default')).toBeNull();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: 'gpt-fixture', effort: undefined }));
});

test('switching API drops XHigh even when both Keys list the same model ID', async () => {
  mockLoadPrefs.mockResolvedValue({ model: 'gpt-fixture', effort: 'xhigh', apiIdentity: 'computer:api_original' });
  mockListModels.mockImplementation(async () => mockRemote.agents.pc.list[0].api.accountId === 'api_backup' ? { models: ['gpt-fixture'] } : reportedCatalog());
  const view = await render(viewThread());
  expect(view.getByLabelText('XHigh')).toBeTruthy();
  await openModels(view);
  await changeAgentApi(view);
  await closeModels(view);
  expect(view.queryByLabelText('XHigh')).toBeNull();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: 'gpt-fixture', effort: undefined }));
});

test('a runtime effort rejection clears the old override and rechecks metadata without losing the draft', async () => {
  useReportedModels();
  mockRemote.agents.pc.list = [{ ...originalAgent, api: { ...originalAgent.api, source: 'tool', configured: false } }];
  mockLoadPrefs.mockResolvedValue({ model: 'gpt-fixture', effort: 'xhigh', apiIdentity: 'tool:api_original' });
  const view = await render(viewThread());
  expect(view.getByLabelText('XHigh')).toBeTruthy();
  mockListModels.mockResolvedValue({ models: ['gpt-fixture'] });
  mockSend.mockRejectedValueOnce(new Error('这个模型不支持该推理档位，请刷新后重选'));
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockListModels).toHaveBeenCalledTimes(2);
  expect(view.queryByLabelText('XHigh')).toBeNull();
  expect(view.queryByText(/正在检查|模型档位/)).toBeNull();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenLastCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: 'gpt-fixture', effort: undefined }));
});

test.each(['hide', 'API', 'session'] as const)('attachment menu closes when the conversation changes through %s', async change => {
  const view = await render(viewThread());
  await fireEvent.press(view.getByRole('button', { name: '添加到对话' }));
  expect(view.getByLabelText('从相册选择')).toBeTruthy();
  if (change === 'hide') {
    await view.rerender(viewThread(undefined, false));
    await view.rerender(viewThread());
  } else if (change === 'API') {
    mockRemote.agents.pc.list = [{ ...originalAgent, api: { ...originalAgent.api, accountId: 'api_backup' } }];
    await view.rerender(viewThread());
  } else {
    const session = { ...originalSession, sessionKey: 'codex:another-attachment', title: '另一个对话' };
    mockRemote.timelines[`pc|${session.sessionKey}`] = { session, items: [], loading: false };
    await view.rerender(<ThreadView visible deviceId="pc" sessionKey={session.sessionKey} agent={originalAgent} onClose={jest.fn()} onCreated={jest.fn()}/>);
  }
  expect(view.queryByLabelText('从相册选择')).toBeNull();
  expect(mockPickImages).not.toHaveBeenCalled();
});

test('an explicitly text-only model disables adding images while unknown relay metadata stays compatible', async () => {
  mockListModels.mockResolvedValue({ models: ['gpt-fixture'], modelCapabilities: {
    'gpt-fixture': { source: 'codex-model-list', reasoningKnown: false, inputModalities: ['text'] },
  } });
  const view = await render(viewThread());
  expect(view.getByRole('button', { name: '添加到对话' }).props.accessibilityState.disabled).toBe(false);
  await fireEvent.press(view.getByRole('button', { name: '添加到对话' }));
  expect(view.getByLabelText('从相册选择')).toBeDisabled(); expect(view.getByLabelText('拍照')).toBeDisabled();
  await fireEvent.press(view.getByLabelText('关闭添加到对话'));
  expect(mockPickImages).not.toHaveBeenCalled();
  mockListModels.mockResolvedValue({ models: ['gpt-fixture'] });
  await openModels(view); await closeModels(view);
  expect(view.getByRole('button', { name: '添加到对话' }).props.accessibilityState.disabled).toBe(false);
});

test('choosing a text-only model keeps the attached image and draft but refuses sending until it is removed', async () => {
  const capabilities = {
    'gpt-fixture': { source: 'codex-model-list' as const, reasoningKnown: false, inputModalities: ['text', 'image'] as Array<'text' | 'image'> },
    'text-only': { source: 'codex-model-list' as const, reasoningKnown: false, inputModalities: ['text'] as Array<'text' | 'image'> },
  };
  mockListModels.mockResolvedValue({ models: ['gpt-fixture', 'text-only'], modelCapabilities: capabilities });
  const view = await render(viewThread());
  mockPickImages.mockResolvedValueOnce([{ uri: 'fixture://kept-image', base64: 'fixture', mime: 'image/jpeg', width: 100, height: 100 }]);
  await fireEvent.press(view.getByRole('button', { name: '添加到对话' }));
  await fireEvent.press(view.getByLabelText('从相册选择'));
  await openModels(view);
  await fireEvent.press(view.getByRole('radio', { name: 'text-only' })); await closeModels(view);
  expect(view.getByRole('button', { name: '添加到对话' }).props.accessibilityState.disabled).toBe(false);
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).not.toHaveBeenCalled();
  expect(view.getByLabelText(/^移除待发送图片 /)).toBeTruthy();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
  await fireEvent.press(view.getByLabelText(/^移除待发送图片 /));
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: 'text-only', images: [] }));
});

test('late image picker results are ignored after current model metadata becomes explicitly text-only', async () => {
  let release!: (images: RemoteImage[]) => void;
  mockPickImages.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const view = await render(viewThread());
  await fireEvent.press(view.getByRole('button', { name: '添加到对话' }));
  await fireEvent.press(view.getByLabelText('从相册选择'));
  mockListModels.mockResolvedValue({ models: ['gpt-fixture'], modelCapabilities: {
    'gpt-fixture': { source: 'codex-model-list', reasoningKnown: false, inputModalities: ['text'] },
  } });
  await openModels(view); await closeModels(view);
  await act(async () => { release([{ uri: 'fixture://late-image', base64: 'fixture', mime: 'image/jpeg', width: 100, height: 100 }]); });
  expect(view.queryByLabelText(/^移除待发送图片 /)).toBeNull();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
});

test('choosing a shortened model then moving its slider saves the untouched ID and explicit effort', async () => {
  const id = 'anthropic/claude-opus-5-5-fast[1m]:thinking';
  mockListModels.mockResolvedValue(reportedCatalog([id, 'anthropic/claude-sonnet-5-5-preview']));
  const view = await render(viewThread()); await openModels(view);
  expect(view.getByText('模型 · Claude')).toBeTruthy();
  await fireEvent.press(view.getByRole('radio', { name: 'opus-5-5-fast[1m]:thinking' })); await closeModels(view);
  await fireEvent.press(view.getByTestId('remote-effort-chip')); mockSavePrefs.mockClear();
  const slider = view.getByTestId('main-effort-slider');
  await fireEvent(slider, 'valueChange', 5); expect(view.getByTestId('main-effort-preview').props.children).toBe('XHigh');
  expect(mockSavePrefs).not.toHaveBeenCalled(); await fireEvent(slider, 'slidingComplete', 5);
  expect(mockSavePrefs).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('关闭推理强度选择', { includeHiddenElements: true }));
  expect(mockSavePrefs).toHaveBeenCalledTimes(1);
  expect(mockSavePrefs).toHaveBeenLastCalledWith('paired|pc|codex:original', { model: id, effort: 'xhigh', apiIdentity: 'computer:api_original' });
  expect(view.getByLabelText('模型：opus-5-5-fast[1m]:thinking')).toBeTruthy(); expect(view.getByLabelText('XHigh')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: id, effort: 'xhigh' }));
});

test('closing the upper backdrop confirms an in-progress High preview and preserves the draft', async () => {
  useReportedModels();
  mockLoadPrefs.mockResolvedValue({ model: 'gpt-fixture', effort: 'minimal', apiIdentity: 'computer:api_original' });
  const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '还没提交的任务');
  await fireEvent.press(view.getByTestId('remote-effort-chip'));
  mockSavePrefs.mockClear();
  await fireEvent(view.getByTestId('main-effort-slider'), 'valueChange', 4);
  expect(view.getByTestId('main-effort-preview').props.children).toBe('High');
  await fireEvent.press(view.getByLabelText('关闭推理强度选择', { includeHiddenElements: true }));
  expect(view.queryByTestId('remote-model-popover')).toBeNull();
  expect(view.getByLabelText('模型：gpt-fixture')).toBeTruthy();
  expect(view.getByLabelText('High')).toBeTruthy();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('还没提交的任务');
  expect(mockSavePrefs).toHaveBeenLastCalledWith('paired|pc|codex:original', { model: 'gpt-fixture', effort: 'high', apiIdentity: 'computer:api_original' });
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
});


test.each(['close', 'Key', 'scope'] as const)('compact model settings preserve drafts after %s without capturing conversation pixels', async change => {
  const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '菜单期间保留的草稿'); await openModels(view);
  if (change === 'close') await closeModels(view);
  else if (change === 'Key') await changeAgentApi(view);
  else {
    mockRemote.agents.pc.list = [{ ...originalAgent, api: { ...originalAgent.api, accountId: 'api_backup', name: '备用', source: 'phone', model: '' } }];
    await view.rerender(viewThread());
  }
  expect(mockCaptureModelBackdrop).not.toHaveBeenCalled(); expect(view.queryByTestId('remote-model-blur')).toBeNull();
  if (change === 'close') expect(view.queryByTestId('remote-model-popover')).toBeNull();
  else { await openModels(view); expect(view.getByTestId('remote-model-popover')).toBeTruthy(); }
  await closeModels(view); expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('菜单期间保留的草稿');
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
});

test('reopening model selection never captures or persists conversation pixels', async () => {
  const view = await render(viewThread());
  await openModels(view); await closeModels(view); await openModels(view);
  expect(view.queryByTestId('remote-model-blur')).toBeNull(); expect(mockCaptureModelBackdrop).not.toHaveBeenCalled();
  await closeModels(view); expect(mockSavePrefs).not.toHaveBeenCalled();
});

test.each([
  { name: 'mixed providers', catalog: ['deepseek-chat', 'claude-opus-5-5', 'gpt-5.5'], id: 'deepseek-chat', label: 'deepseek-chat' },
  { name: 'custom deployment path', catalog: ['custom/deploy/claude-opus-5-5', 'claude-sonnet-5-5'], id: 'custom/deploy/claude-opus-5-5', label: 'custom/deploy/claude-opus-5-5' },
  { name: 'prefix collision', catalog: ['claude-opus-5-5', 'anthropic/claude-opus-5-5'], id: 'anthropic/claude-opus-5-5', label: 'anthropic/claude-opus-5-5' },
  { name: 'dated and preview suffixes', catalog: ['claude-opus-5-5-20260930-preview-thinking-200k', 'claude-sonnet-5-5-latest'], id: 'claude-opus-5-5-20260930-preview-thinking-200k', label: 'opus-5-5-20260930-preview-thinking-200k' },
])('model presentation never rewrites the outgoing ID: $name', async ({ catalog, id, label }) => {
  mockListModels.mockResolvedValue({ models: catalog, api: '主力' });
  const view = await render(viewThread());
  await openModels(view);
  const node = view.getByRole('radio', { name: label });
  expect(node.props.accessibilityHint).toBe(id);
  await fireEvent(node, 'pressIn');
  await fireEvent.press(view.getByRole('radio', { name: label })); await closeModels(view);
  expect(mockSavePrefs).toHaveBeenLastCalledWith('paired|pc|codex:original', { model: id, effort: undefined, apiIdentity: 'computer:api_original' });
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: id, effort: undefined }));
});

test('a model choice in a new conversation follows default thinking and copies the untouched ID to the created thread', async () => {
  const id = 'anthropic/claude-sonnet-5-5-preview';
  mockRemote.devices[0].projects = [{ path: 'C:\\fixture', name: 'fixture' }];
  mockListModels.mockResolvedValue(reportedCatalog([id]));
  const created = jest.fn();
  const view = await render(<ThreadView visible deviceId="pc" sessionKey={null} newProjectPath={originalSession.cwd} agent={originalAgent} onClose={jest.fn()} onCreated={created} />);
  await openModels(view);
  await fireEvent(view.getByRole('radio', { name: 'sonnet-5-5-preview' }), 'pressIn');
  await fireEvent.press(view.getByRole('radio', { name: 'sonnet-5-5-preview' })); await closeModels(view);
  expect(mockSavePrefs).toHaveBeenLastCalledWith('paired|pc|new:codex', { model: id, effort: undefined, apiIdentity: 'computer:api_original' });
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockStart).toHaveBeenCalledWith('pc', expect.objectContaining({ tool: 'codex', cwd: 'C:\\fixture', prompt: '原草稿', model: id, effort: undefined }));
  expect(mockSavePrefs).toHaveBeenLastCalledWith('paired|pc|codex:new', { model: id, effort: undefined, apiIdentity: 'computer:api_original' });
  expect(created).toHaveBeenCalledWith('codex:new'); expect(mockSend).not.toHaveBeenCalled();
});

test('Claude model selection cannot invent a Codex effort override', async () => {
  const id = 'claude-opus-5-5-fast';
  const agent: AgentProfile = { ...originalAgent, id: 'claude-desktop', name: 'Claude Desktop', tool: 'claude', api: { ...originalAgent.api, model: id, protocol: 'anthropic', accountId: 'api_aaaaaaaa' } };
  const session: SessionInfo = { ...originalSession, sessionKey: 'claude:original', tool: 'claude', client: 'Claude Desktop', model: id };
  mockRemote.agents.pc.list = [agent];
  mockRemote.sessions.pc.list = [session];
  mockRemote.timelines['pc|claude:original'] = { items: [{ kind: 'message', id: 'claude-reply', role: 'assistant', text: '原来的 Claude 回复', final: true, ts: 1 }], loading: false, session };
  mockListModels.mockResolvedValue({ models: [id], api: '主力' });
  mockLoadPrefs.mockResolvedValue({ model: id, effort: 'xhigh', apiIdentity: 'computer:api_aaaaaaaa' });
  const view = await render(<ThreadView visible deviceId="pc" sessionKey="claude:original" agent={agent} onClose={jest.fn()} onCreated={jest.fn()} />);
  await openModels(view);
  await fireEvent(view.getByRole('radio', { name: 'opus-5-5-fast' }), 'pressIn');
  expect(view.queryByTestId('remote-model-effort-preview')).toBeNull();
  await fireEvent.press(view.getByRole('radio', { name: 'opus-5-5-fast' })); await closeModels(view);
  expect(mockSavePrefs).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'claude:original', '原草稿', expect.objectContaining({ model: id, effort: undefined }));
});

test('XHigh is selected, saved for this thread and restored for the next send', async () => {
  useReportedModels();
  const view = await render(viewThread());
  expect(view.getByLabelText('Default')).toBeTruthy();
  // Default → Minimal → Low → Medium → High → XHigh
  await scrubEffort(view, 5);
  expect(view.queryByText('推理')).toBeNull();
  expect(view.queryByText('思考程度')).toBeNull();
  expect(view.getByLabelText('XHigh')).toBeTruthy();
  expect(mockSavePrefs).toHaveBeenLastCalledWith('paired|pc|codex:original', { model: 'gpt-fixture', effort: 'xhigh', apiIdentity: 'computer:api_original' });
  mockLoadPrefs.mockResolvedValue({ model: 'gpt-fixture', effort: 'xhigh', apiIdentity: 'computer:api_original' });
  await view.rerender(viewThread(jest.fn(), false));
  await view.rerender(viewThread());
  expect(view.getByLabelText('XHigh')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ effort: 'xhigh' }));
});

test('a new thread sends XHigh and copies the choice to the created thread preferences', async () => {
  useReportedModels();
  mockRemote.devices[0].projects = [{ path: 'C:\\fixture', name: 'fixture' }];
  const created = jest.fn();
  const view = await render(<ThreadView visible deviceId="pc" sessionKey={null} newProjectPath={originalSession.cwd} agent={originalAgent} onClose={jest.fn()} onCreated={created} />);
  await scrubEffort(view, 5);
  expect(mockSavePrefs).toHaveBeenLastCalledWith('paired|pc|new:codex', expect.objectContaining({ effort: 'xhigh' }));
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockStart).toHaveBeenCalledWith('pc', expect.objectContaining({ cwd: 'C:\\fixture', prompt: '原草稿', effort: 'xhigh' }));
  expect(created).toHaveBeenCalledWith('codex:new');
  expect(mockSavePrefs).toHaveBeenLastCalledWith('paired|pc|codex:new', expect.objectContaining({ effort: 'xhigh' }));
  expect(mockSend).not.toHaveBeenCalled();
});

test('a matching API Minimal preference has the correct English label and remains Minimal when sent', async () => {
  useReportedModels();
  mockLoadPrefs.mockResolvedValue({ effort: 'minimal', apiIdentity: 'computer:api_original' });
  const view = await render(viewThread());
  expect(view.getByLabelText('Minimal')).toBeTruthy();
  expect(view.queryByLabelText('推理')).toBeNull();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ effort: 'minimal' }));
});

test('Default clears the saved override and sends no Medium assumption', async () => {
  useReportedModels();
  mockLoadPrefs.mockResolvedValue({ effort: 'high', apiIdentity: 'computer:api_original' });
  const view = await render(viewThread());
  expect(view.getByLabelText('High')).toBeTruthy();
  await scrubEffort(view, -4);
  expect(mockSavePrefs).toHaveBeenLastCalledWith('paired|pc|codex:original', expect.objectContaining({ effort: undefined }));
  expect(view.getByLabelText('Default')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ effort: undefined }));
});

test.each(['matching', 'other-thread', 'expired'] as const)('desktop Live hides effort only for the active covered thread: %s', async (lease) => {
  useReportedModels();
  const identity = lease === 'matching' ? 'desktop:[null,null,null,false]' : 'computer:api_original';
  mockLoadPrefs.mockResolvedValue({ model: 'gpt-fixture', effort: 'xhigh', apiIdentity: identity });
  mockRemote.agents.pc.list = [{ ...originalAgent, desktopLive: { expiresAt: Date.now() + (lease === 'expired' ? -1 : 60_000),
    sessionKeys: [lease === 'other-thread' ? 'codex:other' : 'codex:original'], capabilities: desktopCapabilities } }];
  const view = await render(viewThread());
  if (lease === 'matching') {
    for (const label of ['Default', 'Minimal', 'Low', 'Medium', 'High', 'XHigh']) expect(view.queryByLabelText(label)).toBeNull();
    expect(view.getByLabelText('模型：选择模型')).toBeTruthy();
    await fireEvent.press(view.getByLabelText('发送'));
    expect(mockSend).not.toHaveBeenCalled();
    expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
    await openModels(view);
    expect(view.getByTestId('remote-model-popover')).toBeTruthy();
    await fireEvent.press(view.getByLabelText('使用默认模型')); await closeModels(view);
    expect(mockSavePrefs).toHaveBeenLastCalledWith('paired|pc|codex:original', { apiIdentity: identity });
    expect(view.queryByTestId('remote-model-popover')).toBeNull();
  } else expect(view.getByLabelText('XHigh')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({
    model: lease === 'matching' ? undefined : 'gpt-fixture', effort: lease === 'matching' ? undefined : 'xhigh',
  }));
});

test('Agent configuration updates the model catalog without dropping the draft or history', async () => {
  const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '尚未发送的任务');
  await changeAgentApi(view);
  expect(view.queryByTestId('remote-api-header')).toBeNull();
  expect(view.getByRole('radio', { name: 'deepseek-chat' })).toBeTruthy();
  await closeModels(view);
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('尚未发送的任务');
  expect(view.getByText('原来的回复')).toBeTruthy(); expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
});

test.each(['idle', 'running'] as const)('Agent configuration locks %s submission and restores it after closing', async state => {
  if (state === 'running') queueRunning();
  const view = await render(viewThread()), label = state === 'running' ? '排队发送' : '发送', staleSend = mockSendSubmit.current;
  expect(view.getByLabelText(label).props.accessibilityState.disabled).toBe(false);
  await view.rerender(viewThread(jest.fn(), true, jest.fn(), true));
  expect(view.getByLabelText(label).props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(view.getByLabelText(label)); await act(async () => { staleSend(); });
  expect(mockSend).not.toHaveBeenCalled(); expect(mockSaveQueued).not.toHaveBeenCalled();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
  await view.rerender(viewThread());
  expect(view.getByLabelText(label).props.accessibilityState.disabled).toBe(false); await fireEvent.press(view.getByLabelText(label));
  if (state === 'running') { expect(mockSaveQueued).toHaveBeenCalledTimes(1); expect(mockSend).not.toHaveBeenCalled(); }
  else expect(mockSend).toHaveBeenCalledTimes(1);
});

test('model settings do not expose API keys or reasoning controls', async () => {
  useReportedModels(); const view = await render(viewThread()); await openModels(view);
  expect(view.queryByTestId('remote-inline-api-picker')).toBeNull(); expect(view.queryByText('推理强度')).toBeNull();
  expect(view.queryByRole('radio', { name: '备用' })).toBeNull(); expect(view.getByRole('radio', { name: 'gpt-fixture' })).toBeTruthy();
  expect(mockSetApi).not.toHaveBeenCalled();
});
test('a provider error opens external Agent configuration without a model or API dialog', async () => {
  setItems([{ kind: 'turn', id: 'failure', status: 'failed', error: 'invalid_api_key', ts: 2 }], { ...originalSession, status: 'failed' });
  const openSettings = jest.fn(), view = await render(viewThread(jest.fn(), true, openSettings));
  await fireEvent.press(view.getByLabelText('API 出错，更换 API'));
  expect(openSettings).toHaveBeenCalledTimes(1); expect(view.queryByTestId('remote-model-popover')).toBeNull();
  expect(mockSetApi).not.toHaveBeenCalled(); expect(view.queryByTestId('remote-inline-api-picker')).toBeNull();
});
test('403 insufficient balance is visible as a quota error and opens API selection', async () => {
  setItems([{ kind: 'turn', id: 'balance', status: 'failed', error: 'unexpected status 403 Forbidden: insufficient balance, url: https://ai.hththt.top/responses, cf-ray: fixture-SIN, request id: fixture-request', errorCode: 'upstream_forbidden', ts: 2 }], { ...originalSession, status: 'failed' });
  const openSettings = jest.fn(), view = await render(viewThread(jest.fn(), true, openSettings));
  expect(view.getByText('API 余额不足，请充值或更换 API')).toBeTruthy();
  expect(view.getByLabelText('API 额度不足，更换 API')).toBeTruthy();
  expect(view.queryByText(/cf-ray: fixture-SIN/)).toBeNull();
  await fireEvent.press(view.getByLabelText('API 额度不足，更换 API'));
  expect(openSettings).toHaveBeenCalledTimes(1); expect(view.queryByTestId('remote-model-popover')).toBeNull();
});

test.each([
  ['Codex', 'error', 'Selected model is at capacity. Please try a different model.（正在重试）', 'Selected model is at capacity. Please try a different model.', 'model_capacity'],
  ['Claude', 'warn', 'API 暂时限流，正在重试（1/3）', 'API 暂时限流', 'upstream_rate_limit'],
] as const)('%s retry feedback stays in progress without offering a key or model change', async (_agent, level, text, expected, errorCode) => {
  setItems([{ kind: 'notice', id: `retrying-${_agent}`, level, text,
    errorCode, retrying: true, ts: 2 }], { ...originalSession, status: 'running' });
  const view = await render(viewThread());
  expect(view.queryByLabelText('模型容量已满，换模型或重试')).toBeNull();
  expect(view.queryByLabelText('API 出错，更换 API')).toBeNull();
  expect(view.getByLabelText('正在重试')).toBeTruthy();
  expect(view.getByText(expected)).toBeTruthy();
});

test('Codex model capacity failure points to the model picker and keeps retry semantics', async () => {
  setItems([{ kind: 'message', id: 'prompt', role: 'user', text: '继续这个任务', final: true, ts: 1 },
    { kind: 'turn', id: 'capacity', status: 'failed', error: '本轮暂时无法服务', errorCode: 'model_capacity', ts: 2 }], { ...originalSession, status: 'failed' });
  const view = await render(viewThread());
  expect(view.getByText('当前模型容量已满，可换模型或稍后重试')).toBeTruthy();
  expect(view.getByLabelText('模型容量已满，换模型或重试')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('模型容量已满，换模型或重试'));
  expect(view.getByTestId('remote-model-popover')).toBeTruthy();
  // Model capacity recovery does not change credentials or start a task.
  expect(mockSetApi).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
  expect(view.getByLabelText('重试上一条消息')).toBeTruthy();
});

test('a failed send preserves text and offers changing API, but a network failure does not', async () => {
  mockSend.mockRejectedValueOnce(new Error('insufficient_quota'));
  const openSettings = jest.fn(), view = await render(viewThread(jest.fn(), true, openSettings));
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '保留这个任务');
  await fireEvent.press(view.getByLabelText('发送'));
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('保留这个任务');
  await fireEvent.press(view.getByLabelText('API 额度不足，更换 API'));
  expect(openSettings).toHaveBeenCalledTimes(1); expect(view.queryByTestId('remote-model-popover')).toBeNull();
  expect(mockStart).not.toHaveBeenCalled();
  await view.unmount();
  mockSend.mockRejectedValueOnce(new Error('电脑不在线'));
  const networkView = await render(viewThread());
  await fireEvent.press(networkView.getByLabelText('发送'));
  expect(networkView.queryByLabelText('API 出错，更换 API')).toBeNull();
});

const queueFixture = (text: string, extra: Partial<LoadedQueuedRemoteDraft> = {}): LoadedQueuedRemoteDraft => ({
  id: `queue-${text}`, text, images: [], state: 'waiting', scope: 'paired|fixture-credential', apiIdentity: 'computer:api_original',
  sendOptions: { model: 'gpt-fixture', accountId: 'api_original', surface: 'cli' }, ...extra,
});
const queueRunning = () => setItems([{ kind: 'turn', id: 'original-turn', status: 'started', ts: 2 }], { ...originalSession, status: 'running' });
const queueIdle = () => setItems([{ kind: 'turn', id: 'original-turn', status: 'completed', ts: 3 }], originalSession);

function sendAdmissionFixture(id = 'codex') {
  enablePermissionModes();
  const tool = id === 'claude-desktop' ? 'claude' : id;
  const profile: AgentProfile = { ...originalAgent, id, tool, name: id === 'claude-desktop' ? 'Claude Desktop' : id,
    capabilities: { ...mockRemote.agents.pc.list[0].capabilities! },
    execution: { tool, controlSurface: 'cli', ...(id === 'claude-desktop' ? { entrypoint: 'claude-desktop' as const } : {}) },
    api: { ...originalAgent.api, ...(tool === 'claude' ? { accountId: 'api_aaaaaaaa' } : {}) } };
  const session: SessionInfo = { ...originalSession, tool, sessionKey: `${tool}:original`, client: profile.name };
  const siblingId = id === 'claude' ? 'claude-desktop' : 'claude';
  const sibling: AgentProfile | undefined = tool === 'claude' ? { ...profile, id: siblingId,
    execution: { tool: 'claude', controlSurface: 'cli', ...(siblingId === 'claude-desktop' ? { entrypoint: 'claude-desktop' as const } : {}) },
    api: { ...profile.api, accountId: 'api_bbbbbbbb' } } : undefined;
  const replace = (next?: AgentProfile) => { mockRemote.agents.pc.list = [...(next ? [next] : []), ...(sibling ? [sibling] : [])]; };
  replace(profile);
  mockRemote.sessions.pc.list = [session];
  mockRemote.timelines = { [`pc|${session.sessionKey}`]: { items: [oldReply], loading: false, snapshotAt: Date.now(), session } };
  mockListModels.mockResolvedValue({ models: ['gpt-fixture'], api: '主力' });
  const renderThread = () => <ThreadView visible deviceId="pc" sessionKey={session.sessionKey} agent={profile} onClose={jest.fn()} onCreated={jest.fn()} />;
  return { profile, session, replace, renderThread };
}

test.each([
  ['codex', 'unavailable'], ['codex', 'remote-send'], ['codex', 'send-capability'], ['codex', 'removed'],
  ['claude', 'unavailable'], ['claude-desktop', 'send-capability'], ['hermes', 'removed'],
] as const)('send admission follows a live %s profile after %s withdrawal and restoration', async (id, reason) => {
  const fixture = sendAdmissionFixture(id);
  const view = await render(fixture.renderThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), 'keep the exact draft');
  const staleSend = mockSendSubmit.current;
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(false);
  fixture.replace(reason === 'removed' ? undefined : { ...fixture.profile,
    ...(reason === 'unavailable' ? { available: false } : reason === 'remote-send' ? { remoteSendSupported: false }
      : { capabilities: { ...fixture.profile.capabilities!, send: false } }) });
  await view.rerender(fixture.renderThread());
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  await act(async () => { staleSend(); });
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled(); expect(mockSaveQueued).not.toHaveBeenCalled();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('keep the exact draft');
  expect(mockRemote.devices[0].online).toBe(true); expect(mockRemote.connection).toBe('open');
  fixture.replace(fixture.profile); await view.rerender(fixture.renderThread());
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(false);
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend).toHaveBeenCalledWith('pc', fixture.session.sessionKey, 'keep the exact draft', expect.objectContaining({ accountId: fixture.profile.api.accountId, newSubmission: true, surface: 'cli' }));
});

test('send admission stops an old running-turn queue callback before clearing its composer', async () => {
  const fixture = sendAdmissionFixture(); queueRunning();
  const view = await render(fixture.renderThread());
  const staleQueue = view.getByLabelText('排队发送').props.onPress as () => void;
  fixture.replace({ ...fixture.profile, remoteSendSupported: false }); await view.rerender(fixture.renderThread());
  await act(async () => { staleQueue(); });
  expect(mockSaveQueued).not.toHaveBeenCalled(); expect(mockSend).not.toHaveBeenCalled();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
  expect(view.queryByLabelText('排队中：原草稿')).toBeNull();
});

test('send admission uses the selected prop only before an authoritative directory is loaded', async () => {
  const fixture = sendAdmissionFixture(); fixture.replace(); mockRemote.agents.pc.loaded = false;
  const view = await render(fixture.renderThread());
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(false);
  mockRemote.agents.pc.loaded = true; await view.rerender(fixture.renderThread());
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
  expect(mockSend).not.toHaveBeenCalled();
});

test('send admission rejects an old Continue callback after its live send permission is withdrawn', async () => {
  const fixture = sendAdmissionFixture();
  setItems([{ kind: 'turn', id: 'terminal', turnId: 'finished-turn', status: 'completed', ts: 2, seq: 2 }],
    { ...fixture.session, lastTerminalTurnId: 'finished-turn' });
  mockRemote.timelines['pc|codex:original'].snapshotAt = Date.now();
  mockComposerRestore.mockResolvedValue({ scope: mockDeliveryScope, text: '', images: [], revision: 1, imageCount: 0 });
  const view = await render(fixture.renderThread());
  const staleContinue = view.getByLabelText('继续').props.onPress as () => void;
  fixture.replace({ ...fixture.profile, capabilities: { ...fixture.profile.capabilities!, send: false } });
  await view.rerender(fixture.renderThread()); await act(async () => { staleContinue(); });
  expect(mockContinue).not.toHaveBeenCalled(); expect(mockSend).not.toHaveBeenCalled();
  expect(view.getByLabelText('继续').props.accessibilityState.disabled).toBe(true);
  fixture.replace(fixture.profile); await view.rerender(fixture.renderThread());
  await fireEvent.press(view.getByLabelText('继续')); expect(mockContinue).toHaveBeenCalledTimes(1);
});

test('send admission withdrawal during image hydration preserves the ordinary draft without dispatch', async () => {
  const fixture = sendAdmissionFixture();
  let finish!: (images: RemoteImage[]) => void;
  mockComposerHydrate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = await render(fixture.renderThread());
  await fireEvent.press(view.getByLabelText('发送'));
  fixture.replace({ ...fixture.profile, available: false }); await view.rerender(fixture.renderThread());
  await act(async () => { finish([]); });
  expect(mockSend).not.toHaveBeenCalled(); expect(mockComposerConsume).not.toHaveBeenCalled();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
});

test('send admission holds FIFO while revoked and resumes only the exact head after restoration', async () => {
  const fixture = sendAdmissionFixture(); queueRunning();
  const entries = [queueFixture('first'), queueFixture('second')]; mockLoadQueued.mockResolvedValueOnce(entries);
  const view = await render(fixture.renderThread());
  fixture.replace({ ...fixture.profile, capabilities: { ...fixture.profile.capabilities!, send: false } }); queueIdle();
  await view.rerender(fixture.renderThread());
  expect(mockSend).not.toHaveBeenCalled(); expect(mockSaveQueued).not.toHaveBeenCalled();
  expect(view.getByLabelText('排队中：first')).toBeTruthy(); expect(view.getByText('first · 2 条')).toBeTruthy();
  fixture.replace(fixture.profile); await view.rerender(fixture.renderThread());
  expect(mockSend).toHaveBeenCalledTimes(1); expect(mockSend.mock.calls[0][2]).toBe('first');
  expect(mockSaveQueued.mock.calls.at(-1)?.[1]).toMatchObject([{ id: entries[1].id, text: 'second', state: 'waiting', afterTurn: expect.any(String) }]);
  setItems([{ kind: 'turn', id: 'first-finished', status: 'completed', ts: 5 }], fixture.session);
  await view.rerender(fixture.renderThread());
  expect(mockSend).toHaveBeenCalledTimes(2); expect(mockSend.mock.calls[1][2]).toBe('second');
});

test('send admission withdrawal during queue persistence blocks the original FIFO without an automatic replay', async () => {
  const fixture = sendAdmissionFixture();
  const entries = [queueFixture('first'), queueFixture('second')]; mockLoadQueued.mockResolvedValueOnce(entries);
  let finish!: () => void;
  mockSaveQueued.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(undefined); }));
  const view = await render(fixture.renderThread());
  fixture.replace({ ...fixture.profile, available: false }); await view.rerender(fixture.renderThread());
  await act(async () => { finish(); });
  expect(mockSend).not.toHaveBeenCalled();
  expect(mockSaveQueued.mock.calls.at(-1)?.[1]).toMatchObject([{ id: entries[0].id, text: 'first', state: 'blocked' }, { id: entries[1].id, text: 'second' }]);
  fixture.replace(fixture.profile); await view.rerender(fixture.renderThread());
  expect(mockSend).not.toHaveBeenCalled(); expect(view.getByLabelText('排队中：first')).toBeTruthy();
});

test('send admission keeps native desktop send independent from a disabled CLI profile', async () => {
  const fixture = sendAdmissionFixture();
  fixture.replace({ ...fixture.profile, available: false, remoteSendSupported: false, execution: null,
    capabilities: { ...fixture.profile.capabilities!, send: false }, desktopLive: {
      expiresAt: Date.now() + 60_000, sessionKeys: ['codex:original'], capabilities: desktopCapabilities,
    } });
  setItems([oldReply], { ...fixture.session, controlSurface: 'desktop' });
  const view = await render(fixture.renderThread());
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(false);
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ surface: 'desktop', newSubmission: true }));
});

test('send admission withdrawal does not interrupt a command already dispatched to the computer', async () => {
  const fixture = sendAdmissionFixture();
  let finish!: () => void; mockSend.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(undefined); }));
  const view = await render(fixture.renderThread()); await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledTimes(1);
  fixture.replace({ ...fixture.profile, available: false }); await view.rerender(fixture.renderThread());
  await act(async () => { finish(); });
  expect(mockSend).toHaveBeenCalledTimes(1); expect(mockSend.mock.calls[0][3]).toHaveProperty('draftOwner');
  expect(jest.requireMock('../remote/store').interruptSession).not.toHaveBeenCalled(); expect(mockCancelPending).not.toHaveBeenCalled();
});

test('send admission withdrawal preserves an uncertain UUID for explicit original-message recovery', async () => {
  const fixture = sendAdmissionFixture();
  const receipt: PendingDelivery = { scope: mockDeliveryScope, deviceId: 'pc', sessionKey: 'codex:original', surface: 'cli', text: 'unconfirmed original',
    requestId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', createdAt: Date.now(), firstAttemptAt: Date.now(), lastObservedAt: Date.now(), attempted: true, safeRetry: true,
    sendOptions: { model: 'gpt-frozen', effort: 'high' } };
  mockPending.mockResolvedValue(receipt);
  const view = await render(fixture.renderThread());
  fixture.replace({ ...fixture.profile, remoteSendSupported: false }); await view.rerender(fixture.renderThread());
  expect(mockSend).not.toHaveBeenCalled(); expect(mockCancelPending).not.toHaveBeenCalled(); expect(mockComposerConsume).not.toHaveBeenCalled();
  expect(await mockPending()).toBe(receipt);
  fixture.replace(fixture.profile); await view.rerender(fixture.renderThread());
  await fireEvent.press(view.getByLabelText('更多')); await fireEvent.press(view.getByLabelText('重试原消息'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', 'unconfirmed original', { retryRequestId: receipt.requestId });
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
});

test.each(['failed', 'interrupted'] as const)('a %s current turn pauses queued follow-ups without sending them', async status => {
  queueRunning(); mockLoadQueued.mockResolvedValueOnce([queueFixture('first'), queueFixture('second')]);
  const view = await render(viewThread());
  setItems([{ kind: 'turn', id: 'original-turn', status, ts: 3, ...(status === 'failed' ? { error: '暂时无法服务', errorCode: 'model_capacity' } : {}) }], originalSession);
  await view.rerender(viewThread());
  expect(mockSend).not.toHaveBeenCalled();
  expect(mockSaveQueued.mock.calls.at(-1)?.[1]).toMatchObject([{ text: 'first', state: 'blocked' }, { text: 'second' }]);
  expect(view.getByLabelText('排队中：first')).toBeTruthy();
  expect(view.getByText('已暂停，取回后核对再发送')).toBeTruthy();
});

test('busy submissions remain distinct FIFO entries and each retains all four images', async () => {
  queueRunning();
  const view = await render(viewThread());
  for (const prompt of ['first', 'second']) {
    mockPickImages.mockResolvedValueOnce(Array.from({ length: 4 }, (_, index) => ({ uri: `file://${prompt}-${index}.jpg`, base64: 'fixture', mime: 'image/jpeg', width: 100, height: 100 })));
    await fireEvent.press(view.getByRole('button', { name: '添加到对话' }));
    await fireEvent.press(view.getByLabelText('从相册选择'));
    await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), prompt);
    await fireEvent.press(view.getByLabelText('排队发送'));
  }
  const entries = mockSaveQueued.mock.calls.at(-1)?.[1] as LoadedQueuedRemoteDraft[];
  expect(entries.map(item => item.text)).toEqual(['first', 'second']);
  expect(entries.map(item => item.images.length)).toEqual([4, 4]);
  expect(entries.map(item => item.sendOptions?.accountId)).toEqual(['api_original', 'api_original']);
  expect(mockSend).not.toHaveBeenCalled();
});

test('queue storage rejection preserves the composer and never accepts a phantom queued submission', async () => {
  queueRunning(); mockSaveQueued.mockRejectedValueOnce(new Error('storage full'));
  const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), 'keep this');
  await fireEvent.press(view.getByLabelText('排队发送'));
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('keep this');
  expect(view.queryByLabelText('排队中：keep this')).toBeNull();
  expect(mockSend).not.toHaveBeenCalled();
});

test('busy queue state adopts durable metadata rather than retaining earlier image payloads in memory', async () => {
  queueRunning();
  mockSaveQueued.mockImplementation(async (_key, entries) => (entries as LoadedQueuedRemoteDraft[]).map(entry => ({ ...entry,
    images: entry.images.map(image => ({ ...image, uri: `file://durable/${entry.id}.jpg`, base64: '' })) })));
  const view = await render(viewThread());
  mockPickImages.mockResolvedValueOnce([{ uri: 'file://picker/current.jpg', base64: 'fixture-bytes', mime: 'image/jpeg', width: 40, height: 40 }]);
  await fireEvent.press(view.getByRole('button', { name: '添加到对话' })); await fireEvent.press(view.getByLabelText('从相册选择'));
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), 'first'); await fireEvent.press(view.getByLabelText('排队发送'));
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), 'second'); await fireEvent.press(view.getByLabelText('排队发送'));
  const saved = mockSaveQueued.mock.calls.at(-1)?.[1] as LoadedQueuedRemoteDraft[];
  expect(saved[0].images[0]).toMatchObject({ uri: expect.stringContaining('file://durable/'), base64: '' });
  expect(mockRetryImages).not.toHaveBeenCalled(); expect(mockSend).not.toHaveBeenCalled();
});

test('restored queues lazily read only the sending head and preserve its exact images', async () => {
  queueRunning();
  const image = { uri: 'file://durable/head.jpg', mime: 'image/jpeg' as const, width: 40, height: 40, base64: '' };
  mockLoadQueued.mockResolvedValueOnce([queueFixture('first', { images: [image], imageCount: 1 }),
    queueFixture('second', { images: [{ ...image, uri: 'file://durable/tail.jpg' }], imageCount: 1 })]);
  mockRetryImages.mockResolvedValueOnce([{ ...image, base64: 'head-payload' }]);
  const view = await render(viewThread()); expect(mockRetryImages).not.toHaveBeenCalled();
  queueIdle(); await view.rerender(viewThread());
  expect(mockRetryImages).toHaveBeenCalledTimes(1);
  expect(mockRetryImages).toHaveBeenCalledWith([{ uri: image.uri, mime: image.mime, width: image.width, height: image.height }]);
  expect(mockSend).toHaveBeenCalledWith('pc', originalSession.sessionKey, 'first', expect.objectContaining({ images: [{ ...image, base64: 'head-payload' }] }));
  expect(mockSaveQueued.mock.calls.at(-1)?.[1]).toMatchObject([{ text: 'second', images: [{ base64: '' }] }]);
});

test('image read failure pauses the queued head without text-only replay or automatic retry', async () => {
  mockLoadQueued.mockResolvedValueOnce([queueFixture('image task', { images: [{ uri: 'file://durable/head.jpg', mime: 'image/jpeg', width: 40, height: 40, base64: '' }], imageCount: 1 })]);
  mockRetryImages.mockRejectedValueOnce(new Error('missing image'));
  const view = await render(viewThread()); expect(mockSend).not.toHaveBeenCalled();
  expect(view.getByText('已暂停，取回后核对再发送')).toBeTruthy();
  await view.rerender(viewThread()); expect(mockRetryImages).toHaveBeenCalledTimes(1); expect(mockSend).not.toHaveBeenCalled();
});

test('changing API while lazy image bytes are loading cannot send the original queued task through the new route', async () => {
  mockLoadQueued.mockResolvedValueOnce([queueFixture('image task', { images: [{ uri: 'file://durable/head.jpg', mime: 'image/jpeg', width: 40, height: 40, base64: '' }], imageCount: 1 })]);
  let release!: (images: RemoteImage[]) => void;
  const reading = new Promise<RemoteImage[]>(resolve => { release = resolve; }); mockRetryImages.mockImplementationOnce(() => reading);
  const view = await render(viewThread());
  mockRemote.agents.pc.list = [{ ...originalAgent, api: { ...originalAgent.api, accountId: 'api_other' } }]; await view.rerender(viewThread());
  await act(async () => { release([{ uri: 'file://durable/head.jpg', mime: 'image/jpeg', width: 40, height: 40, base64: 'fixture' }]); await reading; });
  expect(mockSend).not.toHaveBeenCalled();
  expect(mockSaveQueued.mock.calls.at(-1)?.[1]).toMatchObject([{ text: 'image task', state: 'blocked' }]);
});

test('private draft and queue lookups are credential-scoped while preferences keep their station key', async () => {
  await render(viewThread());
  expect(mockLoadQueued).toHaveBeenCalledWith('paired|fixture-credential|pc|codex:original');
  expect(mockLoadPrefs).toHaveBeenCalledWith('paired|pc|codex:original');
});

test('ordinary draft restores image metadata and hydrates every original image only when submitted', async () => {
  const image = { uri: 'file://private/original.jpg', mime: 'image/jpeg' as const, width: 40, height: 40, base64: '' };
  mockComposerRestore.mockResolvedValueOnce({ scope: mockDeliveryScope, revision: 2, text: 'Requires image', images: [image], imageCount: 1 });
  mockComposerHydrate.mockResolvedValueOnce([{ ...image, base64: 'synthetic-pixels' }]);
  const view = await render(viewThread()); expect(mockComposerHydrate).not.toHaveBeenCalled();
  expect(view.getAllByLabelText(/^移除待发送图片 /)).toHaveLength(1);
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', 'Requires image', expect.objectContaining({ images: [{ ...image, base64: 'synthetic-pixels' }] }));
  expect(mockSend.mock.calls[0][3]).toMatchObject({ draftOwner: { kind: 'composer', key: `${mockDeliveryScope}|pc|codex:original`, revision: 1 } });
});

test('missing unsent images block ordinary sends without degrading the prompt to text only', async () => {
  mockComposerRestore.mockResolvedValueOnce({ scope: mockDeliveryScope, revision: 2, text: 'Requires image', images: [], imageCount: 1, missingImages: true });
  const view = await render(viewThread()); await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled(); expect(mockComposerSave).not.toHaveBeenCalled();
  expect(mockToast).toHaveBeenCalledWith('请重新选择全部原图片，不会只发送文字', 'alert');
});

test('unreadable queue restoration is not marked checked and does not overwrite it or submit fresh work', async () => {
  mockLoadQueued.mockRejectedValueOnce(new Error('synthetic storage read failure'));
  const view = await render(viewThread()); await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled(); expect(mockSaveQueued).not.toHaveBeenCalled();
});

test('unreadable pending-receipt restoration is not a successful absence and cannot enable fresh sending', async () => {
  mockPending.mockRejectedValueOnce(new Error('synthetic receipt storage read failure'));
  const view = await render(viewThread());
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(view.getByLabelText('发送')); expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
});

test('an initially backgrounded FIFO cannot submit work before foreground resumes', async () => {
  jest.replaceProperty(AppState, 'currentState', 'background'); mockLoadQueued.mockResolvedValueOnce([queueFixture('Queued follow-up')]);
  const view = await render(viewThread()); expect(mockSend).not.toHaveBeenCalled();
  const listeners = (AppState.addEventListener as jest.Mock).mock.calls.map(call => call[1] as (state: string) => void);
  await act(async () => { jest.replaceProperty(AppState, 'currentState', 'active'); listeners.forEach(change => change('active')); });
  expect(mockSend).toHaveBeenCalledTimes(1); expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', 'Queued follow-up', expect.any(Object));
});

test('backgrounding during FIFO image hydration preserves waiting work without dispatching until foreground', async () => {
  const image = { uri: 'file://durable/head.jpg', mime: 'image/jpeg' as const, width: 40, height: 40, base64: '' };
  mockLoadQueued.mockResolvedValueOnce([queueFixture('Queued image task', { images: [image], imageCount: 1 })]);
  let release!: (images: RemoteImage[]) => void;
  mockRetryImages.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const view = await render(viewThread());
  const listeners = (AppState.addEventListener as jest.Mock).mock.calls.map(call => call[1] as (state: string) => void);
  await act(async () => { jest.replaceProperty(AppState, 'currentState', 'background'); listeners.forEach(change => change('background')); release([{ ...image, base64: 'pixels' }]); });
  expect(mockSend).not.toHaveBeenCalled(); expect(mockSaveQueued.mock.calls.at(-1)?.[1]).toMatchObject([{ text: 'Queued image task', state: 'waiting' }]);
  mockRetryImages.mockResolvedValueOnce([{ ...image, base64: 'pixels' }]);
  await act(async () => { jest.replaceProperty(AppState, 'currentState', 'active'); listeners.forEach(change => change('active')); });
  expect(mockSend).toHaveBeenCalledTimes(1);
});

test('a delayed ordinary restore cannot overwrite freshly typed text or freshly picked images', async () => {
  let release!: (draft: ComposerDraft) => void;
  mockComposerRestore.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const fresh = { uri: 'file://picker/new.jpg', mime: 'image/jpeg' as const, width: 40, height: 40, base64: 'fresh-bytes' };
  const view = await render(viewThread()); await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), 'Fresh prompt');
  mockPickImages.mockResolvedValueOnce([fresh]); await fireEvent.press(view.getByRole('button', { name: '添加到对话' })); await fireEvent.press(view.getByLabelText('从相册选择'));
  await act(async () => { release({ scope: mockDeliveryScope, revision: 1, text: 'Old prompt', images: [{ ...fresh, uri: 'file://private/old.jpg', base64: '' }], imageCount: 1 }); });
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('Fresh prompt'); expect(view.getAllByLabelText(/^移除待发送图片 /)).toHaveLength(1);
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', 'Fresh prompt', expect.objectContaining({ images: [fresh] }));
});

test.each(['API', 'scope', 'hide', 'lease'] as const)('a delayed ordinary image hydration after %s cannot dispatch through the changed owner', async change => {
  let release!: (images: RemoteImage[]) => void;
  mockComposerHydrate.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  if (change === 'lease') mockRemote.agents.pc.list = [{ ...originalAgent, desktopLive: { expiresAt: Date.now() + 60000, sessionKeys: ['codex:original'], capabilities: desktopCapabilities } }];
  const view = await render(viewThread()); await fireEvent.press(view.getByLabelText('发送'));
  if (change === 'API') mockRemote.agents.pc.list = [{ ...originalAgent, api: { ...originalAgent.api, accountId: 'api_other' } }];
  else if (change === 'scope') mockDeliveryScope = 'paired|renewed';
  else if (change === 'lease') mockRemote.agents.pc.list[0].desktopLive!.expiresAt = Date.now() - 1;
  await view.rerender(viewThread(jest.fn(), change !== 'hide'));
  await act(async () => { release([]); });
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
});

test('accepted sending after closing clears only the original durable draft and cannot alter a replacement thread', async () => {
  let release!: () => void;
  mockSend.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(undefined); }));
  const view = await render(viewThread()); await fireEvent.press(view.getByLabelText('发送'));
  await view.rerender(viewThread(jest.fn(), false));
  await act(async () => { release(); });
  expect(mockSend.mock.calls[0][3]).toMatchObject({ draftOwner: { kind: 'composer', key: `${mockDeliveryScope}|pc|codex:original`, revision: 1 } });
  expect(mockStart).not.toHaveBeenCalled();
});

test('ordinary image persistence failure retains input and cannot submit a fragile picker URI', async () => {
  mockComposerSave.mockRejectedValueOnce(new Error('synthetic disk full'));
  const view = await render(viewThread()); await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
});

test('restored CLI image drafts cannot cross into a native desktop lease lacking attachment support', async () => {
  const image = { uri: 'file://private/original.jpg', mime: 'image/jpeg' as const, width: 40, height: 40, base64: '' };
  mockComposerRestore.mockResolvedValueOnce({ scope: mockDeliveryScope, revision: 2, text: 'Requires image', images: [image], imageCount: 1 });
  mockRemote.agents.pc.list = [{ ...originalAgent, desktopLive: { expiresAt: Date.now() + 60000, sessionKeys: ['codex:original'], capabilities: desktopCapabilities } }];
  const view = await render(viewThread()); await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('Requires image'); expect(view.getAllByLabelText(/^移除待发送图片 /)).toHaveLength(1);
});

test('duplicate captured send callbacks cannot dispatch twice while image snapshots are being prepared', async () => {
  let release!: (draft: ComposerDraft) => void;
  mockComposerSave.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const view = await render(viewThread()); const submit = mockSendSubmit.current;
  await act(async () => { submit(); submit(); }); expect(mockComposerSave).toHaveBeenCalledTimes(1); expect(mockSend).not.toHaveBeenCalled();
  await act(async () => { release({ scope: mockDeliveryScope, revision: 3, text: '原草稿', images: [], imageCount: 0 }); });
  expect(mockSend).toHaveBeenCalledTimes(1);
});

test('successful new task navigates once even if accepted draft cleanup fails', async () => {
  mockRemote.devices[0].projects = [{ path: 'C:\\fixture', name: 'fixture' }];
  mockComposerConsume.mockRejectedValueOnce(new Error('synthetic accepted cleanup failure')); const created = jest.fn();
  const view = await render(<ThreadView visible deviceId="pc" sessionKey={null} newProjectPath={originalSession.cwd} agent={originalAgent} onClose={jest.fn()} onCreated={created} />);
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockStart).toHaveBeenCalledTimes(1); expect(created).toHaveBeenCalledWith('codex:new');
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('');
});

test('new Claude Desktop composers do not look up or replay Claude Code new-task drafts or queue entries', async () => {
  const desktopAgent: AgentProfile = { ...originalAgent, id: 'claude-desktop', name: 'Claude Desktop', tool: 'claude', api: { ...originalAgent.api, source: 'tool' } };
  mockRemote.agents.pc.list = [desktopAgent];
  await render(<ThreadView visible deviceId="pc" sessionKey={null} newProjectPath={originalSession.cwd} agent={desktopAgent} onClose={jest.fn()} onCreated={jest.fn()} />);
  expect(mockComposerRestore.mock.calls.every(([key]) => key.startsWith(`${mockDeliveryScope}|pc|new:claude-desktop:code:`))).toBe(true);
  expect(mockLoadQueued.mock.calls.every(([key]) => String(key).startsWith(`${mockDeliveryScope}|pc|new:claude-desktop:code:`))).toBe(true);
  expect(mockLoadQueued).not.toHaveBeenCalledWith(`${mockDeliveryScope}|pc|new:claude`);
});

test('closing while an attempting marker is being saved cannot dispatch the queued task through a new screen', async () => {
  mockLoadQueued.mockResolvedValueOnce([queueFixture('saved task')]);
  let release!: () => void;
  const write = new Promise<void>(resolve => { release = resolve; });
  mockSaveQueued.mockImplementationOnce(() => write);
  const view = await render(viewThread());
  await view.rerender(viewThread(jest.fn(), false));
  await act(async () => { release(); await write; });
  expect(mockSend).not.toHaveBeenCalled();
});

test('API identity changes during queue persistence pause dispatch before sending the frozen old payload', async () => {
  mockLoadQueued.mockResolvedValueOnce([queueFixture('saved task')]);
  let release!: () => void;
  const write = new Promise<void>(resolve => { release = resolve; });
  mockSaveQueued.mockImplementationOnce(() => write);
  const view = await render(viewThread());
  mockRemote.agents.pc.list = [{ ...originalAgent, api: { ...originalAgent.api, accountId: 'api_other' } }];
  await view.rerender(viewThread());
  await act(async () => { release(); await write; });
  expect(mockSend).not.toHaveBeenCalled();
  expect(mockSaveQueued.mock.calls.at(-1)?.[1]).toMatchObject([{ text: 'saved task', state: 'blocked' }]);
});

test('queue cleanup failure cannot reinsert a task already accepted by the computer as a fresh send', async () => {
  mockLoadQueued.mockResolvedValueOnce([queueFixture('accepted')]);
  mockSaveQueued.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('cleanup failed'));
  const view = await render(viewThread());
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(view.queryByLabelText('排队中：accepted')).toBeNull();
  await view.rerender(viewThread()); expect(mockSend).toHaveBeenCalledTimes(1);
});

test('queue consumption during auto-send persistence cannot substitute the next submission', async () => {
  const next = queueFixture('next untouched', { state: 'blocked' });
  mockLoadQueued.mockResolvedValueOnce([queueFixture('already accepted'), next]);
  mockSaveQueued.mockResolvedValueOnce([next]);
  const view = await render(viewThread());
  expect(mockSend).not.toHaveBeenCalled();
  expect(view.queryByLabelText('排队中：already accepted')).toBeNull();
  expect(view.getByLabelText('排队中：next untouched')).toBeTruthy();
});

test('queue consumption during take-back cannot restore the accepted prompt with next-row images', async () => {
  const next = queueFixture('next untouched', { state: 'blocked', images: [{ uri: 'file://private/next.jpg', mime: 'image/jpeg', width: 40, height: 40, base64: '' }], imageCount: 1 });
  mockLoadQueued.mockResolvedValueOnce([queueFixture('already accepted', { state: 'blocked' }), next]);
  const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '');
  mockSaveQueued.mockResolvedValueOnce([next]);
  await fireEvent.press(view.getByLabelText('取消排队，放回输入框'));
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('');
  expect(view.queryAllByLabelText(/^移除待发送图片 /)).toHaveLength(0);
  expect(view.queryByLabelText('排队中：already accepted')).toBeNull();
  expect(view.getByLabelText('排队中：next untouched')).toBeTruthy();
  expect(mockSend).not.toHaveBeenCalled();
});

test('queue consumption during edited repair cannot send using the next submission owner', async () => {
  const next = queueFixture('next untouched', { state: 'blocked' });
  mockLoadQueued.mockResolvedValueOnce([queueFixture('already accepted', { state: 'blocked' }), next]);
  const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '');
  await fireEvent.press(view.getByLabelText('取消排队，放回输入框'));
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), 'edited accepted prompt');
  mockSaveQueued.mockResolvedValueOnce([next]);
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).not.toHaveBeenCalled();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('edited accepted prompt');
  expect(view.queryByLabelText('排队中：already accepted')).toBeNull();
  expect(view.getByLabelText('排队中：next untouched')).toBeTruthy();
});

test('stop adopts the filtered queue after accepted receipt cleanup', async () => {
  enableFeatures(); Object.assign(mockRemote.agents.pc.list[0].capabilities!, { preciseInterrupt: true });
  setItems([], { ...originalSession, status: 'running', activeTurnId: 'stop-turn' });
  mockRemote.timelines['pc|codex:original'].snapshotAt = Date.now();
  const next = queueFixture('next untouched', { state: 'blocked' });
  mockLoadQueued.mockResolvedValueOnce([queueFixture('already accepted'), next]);
  const interrupt = jest.requireMock('../remote/store').interruptSession;
  interrupt.mockResolvedValueOnce({ status: 'requested', turnId: 'stop-turn' });
  const view = await render(viewThread());
  mockSaveQueued.mockResolvedValueOnce([next]);
  await fireEvent.press(view.getByLabelText('更多'));
  await fireEvent.press(view.getByLabelText('停止任务'));
  expect(view.queryByLabelText('排队中：already accepted')).toBeNull();
  expect(view.getByLabelText('排队中：next untouched')).toBeTruthy();
  expect(interrupt).toHaveBeenCalledWith('pc', 'codex:original', 'stop-turn');
  expect(mockSend).not.toHaveBeenCalled();
});

test('stopping a repaired queue submission cannot delete the next row when accepted cleanup returns late', async () => {
  enableFeatures(); Object.assign(mockRemote.agents.pc.list[0].capabilities!, { preciseInterrupt: true });
  const next = queueFixture('next untouched');
  mockLoadQueued.mockResolvedValueOnce([queueFixture('repair accepted', { state: 'blocked' }), next]);
  let finish!: () => void;
  mockSend.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(undefined); }));
  const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '');
  await fireEvent.press(view.getByLabelText('取消排队，放回输入框'));
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledTimes(1);
  setItems([], { ...originalSession, status: 'running', activeTurnId: 'repair-turn' });
  mockRemote.timelines['pc|codex:original'].snapshotAt = Date.now();
  await view.rerender(viewThread());
  const interrupt = jest.requireMock('../remote/store').interruptSession;
  interrupt.mockResolvedValueOnce({ status: 'requested', turnId: 'repair-turn' });
  mockSaveQueued.mockResolvedValueOnce([{ ...next, state: 'blocked' }]);
  await fireEvent.press(view.getByLabelText('更多'));
  await fireEvent.press(view.getByLabelText('停止任务'));
  expect(view.getByLabelText('排队中：next untouched')).toBeTruthy();
  expect(view.queryByLabelText('排队中：repair accepted')).toBeNull();
  const savesAfterStop = mockSaveQueued.mock.calls.length;
  await act(async () => { finish(); });
  expect(view.getByLabelText('排队中：next untouched')).toBeTruthy();
  expect(mockSaveQueued).toHaveBeenCalledTimes(savesAfterStop);
  expect(mockSend).toHaveBeenCalledTimes(1);
});

test('a definitive queued rejection pauses the same submission without looping or clearing it', async () => {
  queueRunning(); mockLoadQueued.mockResolvedValueOnce([queueFixture('queued')]);
  mockSend.mockRejectedValueOnce(new Error('insufficient_quota'));
  const view = await render(viewThread());
  queueIdle(); await view.rerender(viewThread());
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(view.getByLabelText('排队中：queued')).toBeTruthy();
  expect(mockSaveQueued.mock.calls.at(-1)?.[1]).toMatchObject([{ text: 'queued', state: 'blocked' }]);
  await act(async () => { jest.advanceTimersByTime(10_000); });
  await view.rerender(viewThread());
  expect(mockSend).toHaveBeenCalledTimes(1);
});

test('an uncertain queued send transfers only its head to the existing receipt and holds later submissions', async () => {
  queueRunning(); mockLoadQueued.mockResolvedValueOnce([queueFixture('first'), queueFixture('second')]);
  const view = await render(viewThread());
  mockPending.mockResolvedValue({ scope: mockDeliveryScope, deviceId: 'pc', sessionKey: originalSession.sessionKey, surface: 'cli', text: 'first',
    requestId: '0199aaa1-1234-4678-9abc-000000000001', createdAt: Date.now(), attempted: true, safeRetry: true });
  mockSend.mockRejectedValueOnce(new DeliveryPendingError('confirming', true, '0199aaa1-1234-4678-9abc-000000000001', true));
  queueIdle(); await view.rerender(viewThread());
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSaveQueued.mock.calls.at(-1)?.[1]).toMatchObject([{ text: 'second', afterTurn: expect.any(String) }]);
  expect(view.queryByLabelText('排队中：first')).toBeNull();
  await view.rerender(viewThread()); expect(mockSend).toHaveBeenCalledTimes(1);
});

test.each(['missing', 'different', 'reused'] as const)('an uncertain receipt with %s ownership never consumes a same-text queued submission', async ownership => {
  queueRunning(); mockLoadQueued.mockResolvedValueOnce([queueFixture('same text'), queueFixture('later')]);
  const view = await render(viewThread());
  mockPending.mockResolvedValue({ scope: mockDeliveryScope, deviceId: 'pc', sessionKey: originalSession.sessionKey, surface: 'cli', text: 'same text',
    requestId: '0199aaa1-1234-4678-9abc-000000000001', createdAt: Date.now(), attempted: true, safeRetry: true,
    sendOptions: { accountId: 'api_old', model: 'old-model' } });
  mockSend.mockRejectedValueOnce(new DeliveryPendingError('confirming', false,
    ownership === 'missing' ? undefined : ownership === 'different' ? '0199aaa1-1234-4678-9abc-000000000002' : '0199aaa1-1234-4678-9abc-000000000001',
    ownership !== 'reused'));
  queueIdle(); await view.rerender(viewThread());
  expect(mockSend).toHaveBeenCalledWith('pc', originalSession.sessionKey, 'same text', expect.objectContaining({ newSubmission: true }));
  expect(view.getByLabelText('排队中：same text')).toBeTruthy();
  expect(mockSaveQueued.mock.calls.at(-1)?.[1]).toMatchObject([{ text: 'same text', state: 'blocked' }, { text: 'later' }]);
  await view.rerender(viewThread()); expect(mockSend).toHaveBeenCalledTimes(1);
});

test('FIFO advancement waits for a newly observed finished turn rather than the previous idle status', async () => {
  queueRunning(); mockLoadQueued.mockResolvedValueOnce([queueFixture('first'), queueFixture('second')]);
  const view = await render(viewThread());
  queueIdle(); await view.rerender(viewThread());
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend.mock.calls[0][2]).toBe('first');
  await view.rerender(viewThread()); expect(mockSend).toHaveBeenCalledTimes(1);
  setItems([{ kind: 'turn', id: 'first-queued-turn', status: 'started', ts: 4 }], { ...originalSession, status: 'running' });
  await view.rerender(viewThread()); expect(mockSend).toHaveBeenCalledTimes(1);
  setItems([{ kind: 'turn', id: 'first-queued-turn', status: 'completed', ts: 5 }], originalSession);
  await view.rerender(viewThread());
  expect(mockSend).toHaveBeenCalledTimes(2); expect(mockSend.mock.calls[1][2]).toBe('second');
});

test.each(['identity', 'scope'] as const)('a restored queue with changed %s cannot auto-send through a different source', async changed => {
  mockLoadQueued.mockResolvedValueOnce([queueFixture('private', changed === 'scope' ? { scope: 'old-pairing' } : { apiIdentity: 'computer:api_other' })]);
  const view = await render(viewThread());
  expect(view.getByLabelText('排队中：private')).toBeTruthy();
  expect(mockSend).not.toHaveBeenCalled();
});

test('taking a queued prompt back preserves its durable row and prevents later messages overtaking the edit', async () => {
  mockLoadQueued.mockResolvedValueOnce([queueFixture('first', { state: 'blocked' }), queueFixture('second')]);
  const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '');
  await fireEvent.press(view.getByLabelText('取消排队，放回输入框'));
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('first');
  expect(mockSaveQueued.mock.calls.at(-1)?.[1]).toMatchObject([{ text: 'first', state: 'blocked' }, { text: 'second' }]);
  expect(mockSend).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledTimes(1); expect(mockSend.mock.calls[0][2]).toBe('first');
  expect(mockSaveQueued.mock.calls.at(-1)?.[1]).toMatchObject([{ text: 'second', afterTurn: expect.any(String) }]);
});

test('missing queued images require explicit complete re-selection and never degrade into a text-only send', async () => {
  mockLoadQueued.mockResolvedValueOnce([queueFixture('with image', { state: 'blocked', missingImages: true, imageCount: 1 })]);
  const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '');
  await fireEvent.press(view.getByLabelText('取消排队，放回输入框'));
  await fireEvent.press(view.getByLabelText('发送')); expect(mockSend).not.toHaveBeenCalled();
  mockPickImages.mockResolvedValueOnce([{ uri: 'file://replacement.jpg', base64: 'fixture', mime: 'image/jpeg', width: 100, height: 100 }]);
  await fireEvent.press(view.getByRole('button', { name: '添加到对话' })); await fireEvent.press(view.getByLabelText('从相册选择'));
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', originalSession.sessionKey, 'with image', expect.objectContaining({ images: [expect.objectContaining({ uri: 'file://replacement.jpg' })] }));
});

test.each([false, true])('failed-turn retry never resends a delegation or falls back to an older prompt (older=%s)', async older => {
  setItems([
    ...(older ? [{ kind: 'message' as const, id: 'older-request', role: 'user' as const, text: '先前的用户请求', final: true, ts: 1, turnId: 'previous' },
      { kind: 'turn' as const, id: 'previous-end', status: 'completed' as const, ts: 2, turnId: 'previous' }] : []),
    { kind: 'message', id: 'delegated-request', role: 'user', text: '其他任务发来的协作指令', final: true, ts: 3, turnId: 'current', messageOrigin: { kind: 'delegation' } },
    { kind: 'turn', id: 'current-end', status: 'failed', ts: 4, turnId: 'current' },
  ], { ...originalSession, status: 'failed' });
  const view = await render(viewThread());
  expect(view.queryByLabelText('重试上一条消息')).toBeNull();
  expect(mockSend).not.toHaveBeenCalled();
});

test.each(['completed-boundary', 'different-turn', 'local-pending'] as const)('failed-turn retry does not select an unrelated prompt: %s', async scenario => {
  setItems([
    { kind: 'message', id: 'request', role: 'user', text: '不属于本次失败的请求', final: true, ts: 1,
      ...(scenario === 'different-turn' ? { turnId: 'older' } : {}), ...(scenario === 'local-pending' ? { local: true } : {}) },
    ...(scenario === 'completed-boundary' ? [{ kind: 'turn' as const, id: 'previous-end', status: 'completed' as const, ts: 2 }] : []),
    { kind: 'turn', id: 'current-end', status: 'failed', ts: 3, ...(scenario === 'different-turn' ? { turnId: 'current' } : {}) },
  ], { ...originalSession, status: 'failed' });
  const view = await render(viewThread());
  expect(view.queryByLabelText('重试上一条消息')).toBeNull();
  expect(mockSend).not.toHaveBeenCalled();
});

test('failed-turn retry preserves a real user prompt even if its text mentions delegation', async () => {
  setItems([
    { kind: 'message', id: 'request', role: 'user', text: '请检查来自另一个任务的 delegation 消息', final: true, ts: 1, turnId: 'current' },
    { kind: 'message', id: 'child-request', role: 'user', text: '子任务内部输入', final: true, ts: 2, parentId: 'spawn' },
    { kind: 'turn', id: 'current-end', status: 'failed', ts: 3, turnId: 'current' },
  ], { ...originalSession, status: 'failed' });
  const view = await render(viewThread());
  await fireEvent.press(view.getByLabelText('重试上一条消息'));
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend).toHaveBeenCalledWith('pc', originalSession.sessionKey, '请检查来自另一个任务的 delegation 消息', expect.any(Object));
});

test('failed-turn retry rejects a stale click after the message is classified as a delegation', async () => {
  const request: TimelineItem = { kind: 'message', id: 'request', role: 'user', text: 'later classified', final: true, ts: 1 };
  const failed: TimelineItem = { kind: 'turn', id: 'end', status: 'failed', ts: 2 };
  setItems([request, failed], { ...originalSession, status: 'failed' });
  const view = await render(viewThread());
  const staleRetry = view.getByLabelText('重试上一条消息').props.onPress;
  setItems([{ ...request, messageOrigin: { kind: 'delegation' } }, failed], { ...originalSession, status: 'failed' });
  await view.rerender(viewThread());
  await act(async () => { staleRetry(); });
  expect(mockSend).not.toHaveBeenCalled();
});

test('failed-turn retry cancels image recovery if a newer turn replaces its target', async () => {
  let finishImages!: (images: RemoteImage[]) => void;
  mockRetryImages.mockImplementationOnce(() => new Promise(resolve => { finishImages = resolve; }));
  const image: RemoteImage = { uri: 'file://original.png', base64: 'original-bytes', mime: 'image/png', width: 100, height: 120 };
  setItems([{ kind: 'message', id: 'image-prompt', role: 'user', text: 'image task', final: true, ts: 1,
    attachments: [{ id: `att_${'a'.repeat(32)}`, mime: image.mime, width: image.width, height: image.height, uri: image.uri }] },
    { kind: 'turn', id: 'failed', status: 'failed', ts: 2 }], { ...originalSession, status: 'failed' });
  const view = await render(viewThread());
  await fireEvent.press(view.getByLabelText('重试上一条消息'));
  expect(mockRetryImages).toHaveBeenCalledTimes(1);
  setItems([{ kind: 'message', id: 'next-prompt', role: 'user', text: '新的请求', final: true, ts: 3 },
    { kind: 'turn', id: 'next-failed', status: 'failed', ts: 4 }], { ...originalSession, status: 'failed' });
  await view.rerender(viewThread());
  await act(async () => { finishImages([image]); });
  expect(mockSend).not.toHaveBeenCalled();
});

test('failed-turn retry admits only one dispatch from repeated queued clicks', async () => {
  let finishSend!: () => void;
  mockSend.mockImplementationOnce(() => new Promise<undefined>(resolve => { finishSend = () => resolve(undefined); }));
  setItems([{ kind: 'message', id: 'request', role: 'user', text: 'retry once', final: true, ts: 1 },
    { kind: 'turn', id: 'failed', status: 'failed', ts: 2 }], { ...originalSession, status: 'failed' });
  const view = await render(viewThread());
  const click = view.getByLabelText('重试上一条消息').props.onPress;
  await act(async () => { click(); click(); });
  expect(mockSend).toHaveBeenCalledTimes(1);
  await act(async () => { finishSend(); });
});

test('retrying an image-bearing failed prompt rehydrates all original image bytes', async () => {
  const image: RemoteImage = { uri: 'file://original.png', base64: 'original-bytes', mime: 'image/png', width: 100, height: 120 };
  mockRetryImages.mockResolvedValue([image]);
  setItems([{ kind: 'message', id: 'image-prompt', role: 'user', text: 'image task', final: true, ts: 1,
    attachments: [{ id: `att_${'a'.repeat(32)}`, mime: image.mime, width: image.width, height: image.height, uri: image.uri }] },
    { kind: 'turn', id: 'failed', status: 'failed', ts: 2 }], { ...originalSession, status: 'failed' });
  const view = await render(viewThread()); await fireEvent.press(view.getByLabelText('重试上一条消息'));
  expect(mockRetryImages).toHaveBeenCalledWith([{ uri: image.uri, mime: image.mime, width: image.width, height: image.height }]);
  expect(mockSend).toHaveBeenCalledWith('pc', originalSession.sessionKey, 'image task', expect.objectContaining({ images: [image] }));
});

test('a legacy image prompt without recoverable attachment metadata cannot be retried as text only', async () => {
  setItems([{ kind: 'message', id: 'image-prompt', role: 'user', text: 'image task', final: true, images: ['file://legacy.jpg'], ts: 1 },
    { kind: 'turn', id: 'failed', status: 'failed', ts: 2 }], { ...originalSession, status: 'failed' });
  const view = await render(viewThread()); await fireEvent.press(view.getByLabelText('重试上一条消息'));
  expect(mockSend).not.toHaveBeenCalled(); expect(mockToast).toHaveBeenCalledWith('原消息的图片无法恢复，请重新选择全部原图片', 'alert');
});

test('Codex subagent details navigate to the actual child session and expose its result', async () => {
  setItems([
    { kind: 'tool', id: 'spawn', tool: 'subagent', title: '启动子智能体', detail: '检查代码', status: 'done', childSessionKeys: ['codex:real-child'], ts: 1 },
    { kind: 'tool', id: 'spawn:child:real-child', parentId: 'spawn', tool: 'subagent', title: '子智能体', output: '全部测试通过', status: 'done', childSessionKeys: ['codex:real-child'], ts: 2 },
  ]);
  const created = jest.fn(); const view = await render(viewThread(created));
  expect(view.getByLabelText('启动子智能体：子任务详情')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('启动子智能体：子任务详情'));
  await fireEvent.press(view.getByLabelText('打开子智能体对话 1'));
  expect(created).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('打开子智能体'));
  expect(created).toHaveBeenCalledWith('codex:real-child');
  expect(mockStart).not.toHaveBeenCalled();
  await fireEvent.press(view.getByText('子智能体'));
  expect(view.getByText('全部测试通过')).toBeTruthy();
});

test('the child sidebar keeps its active row distinct and closes from the backdrop', async () => {
  const child = { ...originalSession, sessionKey: 'codex:real-child', title: '子智能体', parentSessionKey: originalSession.sessionKey };
  mockRemote.sessions.pc.list = [originalSession, child];
  setItems([
    { kind: 'tool', id: 'spawn', tool: 'subagent', title: '启动子智能体', status: 'done', childSessionKeys: [child.sessionKey], ts: 1 },
    { kind: 'tool', id: 'spawn:child:real-child', parentId: 'spawn', tool: 'subagent', title: '子智能体', status: 'done', output: '子任务结果', childSessionKeys: [child.sessionKey], ts: 2 },
  ]);
  const view = await render(viewThread(jest.fn()));
  await fireEvent.press(view.getByLabelText('启动子智能体：子任务详情'));
  await fireEvent.press(view.getByLabelText('打开子智能体对话 1'));
  expect(view.getByText('子智能体 · Codex · real-child')).toBeTruthy();
  expect(view.getByLabelText('打开子智能体')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('关闭侧边栏背景'));
  expect(view.queryByText('子智能体 · Codex · real-child')).toBeNull();
});

test('phone session navigation sits beside back in the left header and opens without the more menu', async () => {
  const close = jest.fn();
  const view = await render(<ThreadView visible deviceId="pc" sessionKey="codex:original" agent={originalAgent} onClose={close} onCreated={jest.fn()} />);
  const headerLeft = within(view.getByTestId('remote-sheet-header-left'));
  expect(headerLeft.getAllByRole('button').map(button => button.props.accessibilityLabel)).toEqual(['返回', '打开会话导航']);
  expect(view.queryByTestId('conversation-actions-menu')).toBeNull();
  await fireEvent.press(headerLeft.getByLabelText('打开会话导航'));
  expect(view.getByTestId('remote-sidebar-sessions')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('关闭侧边栏背景'));
  await fireEvent.press(view.getByLabelText('更多'));
  expect(within(view.getByTestId('conversation-actions-menu')).queryByLabelText('打开会话导航')).toBeNull();
  await fireEvent.press(view.getByLabelText('关闭对话菜单'));
  await fireEvent.press(headerLeft.getByLabelText('返回'));
  expect(close).toHaveBeenCalledTimes(1);
});

test('the thread separates its right code tools from the left session navigation', async () => {
  setItems([
    { kind: 'tool', id: 'spawn-sidebar', tool: 'subagent', title: '启动子智能体', detail: '检查侧栏', status: 'done', childSessionKeys: ['codex:sidebar-child'], ts: 1 },
  ]);
  const view = await render(viewThread());
  await fireEvent.press(view.getByLabelText('打开工具栏'));
  expect(view.getByTestId('remote-sidebar')).toBeTruthy();
  expect(view.getByTestId('remote-new-tab')).toBeTruthy();
  expect(view.queryByTestId('remote-sidebar-agents')).toBeNull();
  await fireEvent.press(view.getByLabelText('返回聊天'));
  await fireEvent.press(view.getByLabelText('打开会话导航'));
  expect(view.getByTestId('remote-sidebar')).toBeTruthy();
  expect(view.getByTestId('remote-sidebar-agents')).toBeTruthy();
  expect(view.queryByLabelText('搜索侧边栏会话')).toBeNull();
  expect(view.getByLabelText('打开子智能体')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('关闭侧边栏背景'));
  expect(view.queryByTestId('remote-sidebar')).toBeNull();
});

test('scrolling away from the latest message reveals the return-to-latest control', async () => {
  setItems([{ kind: 'message', id: 'reply', role: 'assistant', text: '最新回复', final: true, ts: 1 }]);
  const view = await render(viewThread());
  const list = view.getByTestId('remote-conversation');
  await fireEvent.scroll(list, { nativeEvent: { layoutMeasurement: { height: 500 }, contentOffset: { y: 0 }, contentSize: { height: 1000 } } });
  expect(view.getByLabelText('回到最新')).toBeTruthy();
  await fireEvent.scroll(list, { nativeEvent: { layoutMeasurement: { height: 500 }, contentOffset: { y: 500 }, contentSize: { height: 1000 } } });
  expect(view.queryByLabelText('回到最新')).toBeNull();
});

test('returning to a native parent first checks the sidebar lease instead of routing an unknown parent to CLI', async () => {
  setItems([], { ...originalSession, controlSurface: 'desktop', parentSessionKey: 'codex:unknown-parent' });
  mockRemote.agents.pc.list = [{ ...originalAgent, desktopLive: { expiresAt: Date.now() + 100_000, sessionKeys: ['codex:original'], capabilities: desktopCapabilities } }];
  const created = jest.fn();
  const view = await render(viewThread(created));
  await fireEvent.press(view.getByLabelText('返回主任务'));
  expect(created).not.toHaveBeenCalled();
  expect(view.getByTestId('remote-sidebar')).toBeTruthy();
  expect(view.getByRole('button', { name: '主任务' }).props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(view.getByRole('button', { name: '主任务' })); expect(created).not.toHaveBeenCalled();
});

test('the sidebar new action opens a fresh editor without sending, restarting or mutating the current task', async () => {
  const create = jest.fn();
  const view = await render(<ThreadView visible deviceId="pc" sessionKey="codex:original" agent={originalAgent} onClose={jest.fn()} onCreated={jest.fn()} onNew={create} />);
  await fireEvent.press(view.getByLabelText('打开会话导航'));
  expect(view.queryByLabelText('侧边栏 Work')).toBeNull();
  await fireEvent.press(view.getByLabelText('新建 Code 对话'));
  expect(create).toHaveBeenCalledWith('code', originalSession.cwd); expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
});

test('a native capacity failure offers the computer action, not an unsupported phone model override', async () => {
  setItems([{ kind: 'turn', id: 'native-capacity', status: 'failed', error: 'Selected model is at capacity.', errorCode: 'model_capacity', ts: 1 }], { ...originalSession, controlSurface: 'desktop' });
  mockRemote.agents.pc.list = [{ ...originalAgent, desktopLive: { expiresAt: Date.now() + 100_000, sessionKeys: ['codex:original'], capabilities: desktopCapabilities } }];
  const view = await render(viewThread());
  expect(view.queryByLabelText('模型容量已满，换模型或重试')).toBeNull();
  await fireEvent.press(view.getByLabelText('在电脑处理当前错误'));
  expect(view.queryByTestId('remote-model-popover')).toBeNull();
  expect(mockDialogActions.has('在电脑的 Codex 里打开')).toBe(true);
  expect(mockSend).not.toHaveBeenCalled();
});

test('an expired first question cannot hide the next live form and answers retain their exact labels', async () => {
  setItems([
    { kind: 'approval', id: 'expired', approval: 'question', title: '旧问题', state: 'pending', expiresAt: Date.now() - 1, ts: 1, questions: [{ id: 'old', question: '旧选项', options: [{ label: '旧答案' }] }] },
    { kind: 'approval', id: 'live', approval: 'question', title: '新问题', state: 'pending', expiresAt: Date.now() + 60_000, ts: 2,
      questions: [{ id: 'choice', question: '选方案', required: true, options: [{ label: ' A ' }, { label: 'B' }] }, { id: 'extra', question: '补充', required: true, allowCustom: true }] },
  ]);
  const view = await render(viewThread());
  expect(view.queryByRole('radio', { name: '旧答案' })).toBeNull();
  await fireEvent.press(view.getByRole('radio', { name: ' A ' }));
  await fireEvent.press(view.getByLabelText('下一题'));
  await fireEvent.changeText(view.getByLabelText('补充：回答'), '我的要求');
  await fireEvent.press(view.getByLabelText('提交回答'));
  expect(mockRespond).toHaveBeenCalledWith({ approvalId: 'live', deviceId: 'pc', sessionKey: 'codex:original' }, 'allow', undefined, { choice: [' A '], extra: ['我的要求'] }, expect.objectContaining({ requestId: expect.any(String), retrying: false }));
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
});

test('expiry while the view stays open advances to the next actionable question', async () => {
  setItems([
    { kind: 'approval', id: 'short', approval: 'question', title: '先问', state: 'pending', expiresAt: Date.now() + 100, ts: 1, questions: [{ id: 'one', question: '先选', options: [{ label: '即将过期' }] }] },
    { kind: 'approval', id: 'next', approval: 'question', title: '后问', state: 'pending', expiresAt: Date.now() + 60_000, ts: 2, questions: [{ id: 'two', question: '再选', options: [{ label: '有效回答' }], required: true }] },
  ]);
  const view = await render(viewThread());
  expect(view.getByRole('radio', { name: '即将过期' })).toBeTruthy();
  await act(async () => { jest.advanceTimersByTime(1100); });
  expect(view.queryByRole('radio', { name: '即将过期' })).toBeNull();
  await fireEvent.press(view.getByRole('radio', { name: '有效回答' }));
  await fireEvent.press(view.getByLabelText('提交回答'));
  expect(mockRespond).toHaveBeenCalledWith({ approvalId: 'next', deviceId: 'pc', sessionKey: 'codex:original' }, 'allow', undefined, { two: ['有效回答'] }, expect.objectContaining({ retrying: false }));
});

test('reopening after a question expires while hidden selects the next question without changing session', async () => {
  setItems([
    { kind: 'approval', id: 'hidden-expiry', approval: 'question', title: '旧问题', state: 'pending', expiresAt: Date.now() + 100, ts: 1, questions: [{ id: 'one', question: '先选', options: [{ label: '关闭期间过期' }] }] },
    { kind: 'approval', id: 'after-reopen', approval: 'question', title: '新问题', state: 'pending', expiresAt: Date.now() + 60_000, ts: 2, questions: [{ id: 'two', question: '再选', options: [{ label: '重新打开的回答' }], required: true }] },
  ]);
  const created = jest.fn(); const view = await render(viewThread(created));
  expect(view.getByRole('radio', { name: '关闭期间过期' })).toBeTruthy();
  await view.rerender(viewThread(created, false));
  await act(async () => { jest.advanceTimersByTime(1100); });
  await view.rerender(viewThread(created));
  expect(view.queryByRole('radio', { name: '关闭期间过期' })).toBeNull();
  await fireEvent.press(view.getByRole('radio', { name: '重新打开的回答' }));
  await fireEvent.press(view.getByLabelText('提交回答'));
  expect(mockRespond).toHaveBeenCalledWith({ approvalId: 'after-reopen', deviceId: 'pc', sessionKey: 'codex:original' }, 'allow', undefined, { two: ['重新打开的回答'] }, expect.objectContaining({ retrying: false }));
  expect(created).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
});

test('a late preference read cannot restore the previous API model after switching', async () => {
  let release!: (prefs: ThreadPrefs) => void;
  mockLoadPrefs.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '使用新 API 模型');
  await openModels(view);
  await changeAgentApi(view);
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  await act(async () => { release({ model: 'gpt-fixture', apiIdentity: 'computer:api_original' }); });
  await openModels(view);
  expect(view.queryByRole('radio', { name: 'gpt-fixture' })).toBeNull();
  await fireEvent.press(view.getByRole('radio', { name: 'deepseek-chat' })); await closeModels(view);
  expect(view.getByLabelText(`模型：${'deepseek-chat'}`)).toBeTruthy();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('使用新 API 模型');
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '使用新 API 模型', expect.objectContaining({ model: 'deepseek-chat' }));
  expect(mockStart).not.toHaveBeenCalled();
});

test('reopening with empty preferences requires a new API model, never the old session default', async () => {
  const created = jest.fn(); const view = await render(viewThread(created));
  await openModels(view);
  await changeAgentApi(view);
  expect(mockRemote.timelines['pc|codex:original'].session?.model).toBe('gpt-fixture');
  await view.rerender(viewThread(created, false));
  await view.rerender(viewThread(created));
  expect(mockLoadPrefs).toHaveBeenCalledTimes(2);
  await openModels(view);
  expect(view.queryByRole('radio', { name: '默认' })).toBeNull();
  expect(view.queryByRole('radio', { name: 'gpt-fixture' })).toBeNull();
  await fireEvent.press(view.getByRole('radio', { name: 'deepseek-chat' })); await closeModels(view);
  expect(view.getByLabelText(`模型：${'deepseek-chat'}`)).toBeTruthy();
  expect(view.getByText('原来的回复')).toBeTruthy();
  expect(created).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '用新的默认模型');
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '用新的默认模型', expect.objectContaining({ model: 'deepseek-chat' }));
});

test('a pending receipt blocks changing model, effort or API without clearing the draft', async () => {
  useReportedModels();
  mockPending.mockResolvedValue({ scope: 'fixture', deviceId: 'pc', sessionKey: 'codex:original', surface: 'cli', text: '待确认任务',
    requestId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', createdAt: Date.now(), firstAttemptAt: Date.now(), lastObservedAt: Date.now(), attempted: true, safeRetry: true });
  setItems([{ kind: 'turn', id: 'pending-error', status: 'failed', error: 'invalid_api_key', ts: 2 }], { ...originalSession, status: 'failed' });
  const openSettings = jest.fn(), view = await render(viewThread(jest.fn(), true, openSettings));
  await openModels(view);
  expect(view.getByRole('radio', { name: 'gpt-fixture' }).props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(view.getByRole('radio', { name: 'gpt-fixture' })); await closeModels(view);
  expect(mockSavePrefs).not.toHaveBeenCalled();
  await closeModels(view);
  await scrubEffort(view, 4);
  expect(mockSavePrefs).not.toHaveBeenCalled();
  expect(view.getAllByLabelText('Default').length).toBeGreaterThan(0);
  await fireEvent.press(view.getByLabelText('API 出错，更换 API'));
  expect(openSettings).toHaveBeenCalledTimes(1);
  expect(mockSetApi).not.toHaveBeenCalled(); expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
});

test('a transient delivery failure stays quiet, then shows a small spinner and a concise delayed status', async () => {
  const requestId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', createdAt = Date.now();
  mockPending.mockResolvedValue({ scope: mockDeliveryScope, deviceId: 'pc', sessionKey: 'codex:original', surface: 'cli', text: '待确认内容',
    requestId, createdAt, firstAttemptAt: createdAt, lastObservedAt: createdAt, attempted: true, safeRetry: true });
  setItems([{ kind: 'message', id: 'local:pending-delivery', role: 'user', text: '待确认内容', final: true, ts: createdAt, local: true, clientId: requestId }]);
  const view = await render(viewThread());
  expect(view.getByTestId('remote-delivery-spinner')).toBeTruthy();
  expect(view.queryByText('等待送达确认 · 自动重试')).toBeNull();
  expect(mockToast).not.toHaveBeenCalled();
  await act(async () => { jest.advanceTimersByTime(REMOTE_STATUS_NOTICE_DELAY_MS - 1); });
  expect(view.queryByText('等待送达确认 · 自动重试')).toBeNull();
  await act(async () => { jest.advanceTimersByTime(1); });
  expect(view.getByText('等待送达确认 · 自动重试')).toBeTruthy();
});

test('a sustained computer disconnect remains visible even while its Agent last appeared active', async () => {
  mockRemote.devices[0].online = false;
  setItems([{ kind: 'turn', id: 'turn:active:started', turnId: 'active', status: 'started', ts: Date.now() }],
    { ...originalSession, status: 'running', activeTurnId: 'active' });
  const view = await render(viewThread());
  await act(async () => { jest.advanceTimersByTime(REMOTE_STATUS_NOTICE_DELAY_MS * 2); });
  expect(view.getByTestId('conversation-sync-notice')).toBeTruthy();
  expect(mockRemote.timelines['pc|codex:original'].session?.status).toBe('running');
  expect(view.queryByText('电脑离线')).toBeNull();

  setItems([], { ...originalSession, status: 'idle' });
  await view.rerender(viewThread());
  expect(view.getByTestId('conversation-sync-notice')).toBeTruthy();
});

test('pending delivery feedback stays hidden while the computer agent is working', async () => {
  const requestId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', createdAt = Date.now();
  mockPending.mockResolvedValue({ scope: mockDeliveryScope, deviceId: 'pc', sessionKey: 'codex:original', surface: 'cli', text: '工作期间的确认消息',
    requestId, createdAt, firstAttemptAt: createdAt, lastObservedAt: createdAt, attempted: true, safeRetry: true });
  setItems([{ kind: 'message', id: 'local:working-delivery', role: 'user', text: '工作期间的确认消息', final: true, ts: createdAt, local: true, clientId: requestId }],
    { ...originalSession, status: 'running', activeTurnId: 'agent-working' });
  const view = await render(viewThread());
  expect(view.queryByTestId('remote-delivery-spinner')).toBeNull();
  await act(async () => { jest.advanceTimersByTime(REMOTE_STATUS_NOTICE_DELAY_MS * 2); });
  expect(view.queryByTestId('remote-delivery-spinner')).toBeNull();
  expect(view.queryByText('等待送达确认 · 自动重试')).toBeNull();
  expect(mockToast).not.toHaveBeenCalled();
});

test('pending delivery feedback stays quiet while an incomplete reasoning update shows work', async () => {
  const requestId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', createdAt = Date.now();
  mockPending.mockResolvedValue({ scope: mockDeliveryScope, deviceId: 'pc', sessionKey: 'codex:original', surface: 'cli', text: '消息待确认',
    requestId, createdAt, firstAttemptAt: createdAt, lastObservedAt: createdAt, attempted: true, safeRetry: true });
  setItems([
    { kind: 'message', id: 'local:reasoning-delivery', role: 'user', text: '消息待确认', final: true, ts: createdAt, local: true, clientId: requestId },
    { kind: 'reasoning', id: 'reasoning-live', text: '正在分析', final: false, ts: createdAt + 1 },
  ], originalSession);
  const view = await render(viewThread());
  expect(view.queryByTestId('remote-delivery-spinner')).toBeNull();
  await act(async () => { jest.advanceTimersByTime(REMOTE_STATUS_NOTICE_DELAY_MS * 2); });
  expect(view.queryByTestId('remote-delivery-spinner')).toBeNull();
  expect(view.queryByText('等待送达确认 · 自动重试')).toBeNull();
});

test('a brief history transport error does not show a connection spinner during active work', async () => {
  setItems([], { ...originalSession, status: 'idle' });
  mockRemote.timelines['pc|codex:original'].error = 'Network request failed';
  mockRemote.timelines['pc|codex:original'].items = [{ kind: 'turn', id: 'turn:active:started', turnId: 'active', status: 'started', ts: Date.now() }];
  const view = await render(viewThread());
  expect(view.queryByLabelText('正在重试连接')).toBeNull();
  await act(async () => { jest.advanceTimersByTime(REMOTE_STATUS_NOTICE_DELAY_MS - 1); });
  expect(view.queryByLabelText('正在重试连接')).toBeNull();
});

test.each(['Network request failed', '连不上中转站，请检查网络', '响应未接收完整，保留原请求等待重试'])(
  'a sustained history transport error shows retry progress before the delayed warning: %s', async message => {
  setItems([oldReply]);
  mockRemote.timelines['pc|codex:original'].error = message;
  const view = await render(viewThread());
  expect(view.queryByLabelText('正在重试连接')).toBeNull();
  expect(view.queryByText(/显示的是上次的记录/)).toBeNull();
  await act(async () => { jest.advanceTimersByTime(REMOTE_RETRY_INDICATOR_DELAY_MS - 1); });
  expect(view.queryByLabelText('正在重试连接')).toBeNull();
  await act(async () => { jest.advanceTimersByTime(1); });
  expect(view.getByLabelText('正在重试连接')).toBeTruthy();
  await act(async () => { jest.advanceTimersByTime(REMOTE_STATUS_NOTICE_DELAY_MS - REMOTE_RETRY_INDICATOR_DELAY_MS - 1); });
  expect(view.queryByText(/显示的是上次的记录/)).toBeNull();
  await act(async () => { jest.advanceTimersByTime(1); });
  expect(view.getByText(`${message}，显示的是上次的记录`)).toBeTruthy();
  mockRemote.timelines['pc|codex:original'].error = undefined;
  await view.rerender(viewThread());
  expect(view.queryByText(/显示的是上次的记录/)).toBeNull();
  expect(view.queryByLabelText('正在重试连接')).toBeNull();
  await view.unmount();
});

test('a shared model is retained only after the new Key catalog confirms it', async () => {
  mockListModels.mockImplementation(async () => ({ models: ['gpt-fixture', 'deepseek-chat'] }));
  const view = await render(viewThread());
  await openModels(view);
  await changeAgentApi(view);
  expect(view.getByTestId('remote-model-popover')).toBeTruthy();
  await closeModels(view);
  expect(view.getByLabelText(`模型：${'gpt-fixture'}`)).toBeTruthy();
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(false);
  expect(mockSavePrefs).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: 'gpt-fixture' }));
  expect(mockStart).not.toHaveBeenCalled();
});

test('an empty new catalog cannot use an obsolete configured default or lose the draft', async () => {
  mockListModels.mockImplementation(async () => ({ models: mockRemote.agents.pc.list[0].api.accountId === 'api_backup' ? [] : ['gpt-fixture'] }));
  mockSetApi.mockImplementation(async () => {
    const changed: AgentProfile = { ...originalAgent, api: { ...originalAgent.api, name: '备用', model: 'retired-model', source: 'phone', accountId: 'api_backup' } };
    mockRemote.agents.pc.list = [changed]; return changed;
  });
  const view = await render(viewThread());
  await openModels(view);
  await changeAgentApi(view);
  expect(view.getByTestId('remote-model-popover')).toBeTruthy();
  expect(view.getByText('暂无可用模型')).toBeTruthy();
  await closeModels(view);
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  expect(view.getByLabelText('模型：选择模型')).toBeTruthy();
  expect(view.queryByText('暂无可用模型')).toBeNull();
  expect(mockToast).not.toHaveBeenCalled();
  await openModels(view);
  expect(view.getByText('暂无可用模型')).toBeTruthy();
  expect(view.queryByRole('radio', { name: '默认' })).toBeNull();
  expect(view.queryByRole('radio', { name: 'retired-model' })).toBeNull();
  expect(view.queryByRole('radio', { name: 'gpt-fixture' })).toBeNull();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
  expect(view.getByText('原来的回复')).toBeTruthy();
});

test('a saved default absent from a nonempty catalog requires a real model choice', async () => {
  mockListModels.mockResolvedValue({ models: ['deepseek-chat'] });
  mockLoadPrefs.mockResolvedValue({ model: 'gpt-fixture', apiIdentity: 'computer:api_original' });
  const view = await render(viewThread());
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  await openModels(view);
  expect(view.queryByRole('radio', { name: '默认' })).toBeNull();
  expect(view.queryByRole('radio', { name: 'gpt-fixture' })).toBeNull();
  await fireEvent.press(view.getByRole('radio', { name: 'deepseek-chat' })); await closeModels(view);
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: 'deepseek-chat' }));
});

test('a failed refresh revokes the earlier catalog and a successful retry restores the same draft', async () => {
  const view = await render(viewThread());
  await openModels(view);
  mockListModels.mockRejectedValueOnce(new Error('fixture network failure'));
  await fireEvent.press(view.getByLabelText('刷新模型列表'));
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  expect(view.getByText('加载失败')).toBeTruthy();
  expect(mockToast).not.toHaveBeenCalled();
  expect(view.queryByRole('radio', { name: 'gpt-fixture' })).toBeNull();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('刷新模型列表'));
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(false);
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: 'gpt-fixture' }));
});

test('a late old API catalog cannot replace the new Key model selection', async () => {
  const release: Array<(value: { models: string[] }) => void> = [];
  mockListModels.mockImplementation(async () => mockRemote.agents.pc.list[0].api.accountId === 'api_backup'
    ? { models: ['deepseek-chat'] } : new Promise((resolve) => { release.push(resolve); }));
  const view = await render(viewThread());
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  await openModels(view);
  await changeAgentApi(view);
  await openModels(view);
  await fireEvent.press(view.getByRole('radio', { name: 'deepseek-chat' })); await closeModels(view);
  await act(async () => { release.forEach((finish) => finish({ models: ['gpt-fixture'] })); });
  expect(view.getByLabelText(`模型：${'deepseek-chat'}`)).toBeTruthy();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: 'deepseek-chat' }));
});

test('the original tool login does not require a vault catalog or override its resumed model', async () => {
  mockRemote.agents.pc.list = [{ ...originalAgent, api: { ...originalAgent.api, source: 'tool', configured: false, model: '' } }];
  const view = await render(viewThread());
  expect(mockListModels).toHaveBeenCalledWith('pc', 'codex', true);
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(false);
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: undefined }));
});

test('a native desktop lease keeps its own send route without requiring the background API catalog', async () => {
  mockRemote.agents.pc.list = [{ ...originalAgent, desktopLive: { expiresAt: Date.now() + 60_000, sessionKeys: ['codex:original'], capabilities: desktopCapabilities } }];
  const view = await render(viewThread());
  expect(mockListModels).not.toHaveBeenCalled();
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(false);
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledTimes(1);
});

test('a retained receipt can still retry its frozen payload when the catalog is unavailable', async () => {
  mockListModels.mockRejectedValue(new Error('catalog unavailable'));
  mockPending.mockResolvedValue({ scope: 'fixture', deviceId: 'pc', sessionKey: 'codex:original', surface: 'cli', text: '待确认任务',
    requestId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', createdAt: Date.now(), firstAttemptAt: Date.now(), lastObservedAt: Date.now(), attempted: true, safeRetry: true,
    sendOptions: { model: 'gpt-frozen', effort: 'high' } });
  const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '另外的新草稿');
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(view.getByLabelText('更多'));
  await fireEvent.press(view.getByLabelText('重试原消息'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '待确认任务', { retryRequestId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' });
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('另外的新草稿');
  expect(mockSetApi).not.toHaveBeenCalled();
});

test('a newly discovered same-text receipt cannot clear fresh composer images or turn them into an old retry', async () => {
  const view = await render(viewThread());
  const image: RemoteImage = { uri: 'file://fresh-image.jpg', base64: 'fresh-payload', mime: 'image/jpeg', width: 40, height: 40 };
  mockPickImages.mockResolvedValueOnce([image]);
  await fireEvent.press(view.getByRole('button', { name: '添加到对话' })); await fireEvent.press(view.getByLabelText('从相册选择'));
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), 'same prompt');
  mockPending.mockResolvedValue({ scope: mockDeliveryScope, deviceId: 'pc', sessionKey: originalSession.sessionKey, surface: 'cli', text: 'same prompt',
    requestId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', createdAt: Date.now(), attempted: true, safeRetry: true });
  mockSend.mockRejectedValueOnce(new DeliveryPendingError('先核对原消息', false));
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', originalSession.sessionKey, 'same prompt', expect.objectContaining({ newSubmission: true, images: [image] }));
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('same prompt');
  expect(view.getByLabelText(/^移除待发送图片 /)).toBeTruthy();
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(view.getByLabelText('更多')); await fireEvent.press(view.getByLabelText('重试原消息'));
  expect(mockSend).toHaveBeenLastCalledWith('pc', originalSession.sessionKey, 'same prompt', { retryRequestId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' });
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('same prompt');
  expect(view.getByLabelText(/^移除待发送图片 /)).toBeTruthy();
});

test('a backend model rejection revokes stale UI validation and restores the unsent task', async () => {
  mockSend.mockRejectedValueOnce(new Error('这个 API 不支持该模型，请刷新后重选模型'));
  const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '不能丢失的任务');
  await fireEvent.press(view.getByLabelText('发送'));
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('不能丢失的任务');
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  expect(view.getByLabelText('模型：选择模型')).toBeTruthy();
  expect(view.queryByText('请选择模型')).toBeNull();
  mockListModels.mockResolvedValue({ models: ['deepseek-chat'] });
  await openModels(view);
  expect(view.queryByRole('radio', { name: 'gpt-fixture' })).toBeNull();
  await fireEvent.press(view.getByRole('radio', { name: 'deepseek-chat' })); await closeModels(view);
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenLastCalledWith('pc', 'codex:original', '不能丢失的任务', expect.objectContaining({ model: 'deepseek-chat' }));
  expect(mockStart).not.toHaveBeenCalled();
});

test('following the original tool again does not keep a phone-picked model override', async () => {
  mockRemote.agents.pc.list = [{ ...originalAgent, api: { ...originalAgent.api, source: 'phone' } }];
  mockLoadPrefs.mockResolvedValue({ model: 'gpt-fixture', apiIdentity: 'phone:api_original' });
  const view = await render(viewThread());
  mockSetApi.mockImplementation(async () => {
    const changed: AgentProfile = { ...originalAgent, api: { ...originalAgent.api, model: '', source: 'tool', configured: false } };
    mockRemote.agents.pc.list = [changed]; return changed;
  });
  await openModels(view);
  await changeAgentApi(view, '');
  expect(view.getByTestId('remote-model-popover')).toBeTruthy();
  expect(mockSetApi).toHaveBeenCalledWith('pc', 'codex', '', '', 'codex:original');
  await closeModels(view);
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: undefined }));
});

test('a pending but unapplied computer card does not impose its model on the tool login', async () => {
  mockRemote.agents.pc.list = [{ ...originalAgent, api: { ...originalAgent.api, source: 'computer', configured: false, pending: true, model: 'not-applied-model' } }];
  const view = await render(viewThread());
  expect(mockListModels).toHaveBeenCalledWith('pc', 'codex', true);
  expect(view.getByLabelText(`模型：${'gpt-fixture'}`)).toBeTruthy();
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(false);
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: undefined }));
});

test('a new API effort cannot be selected until its exact model metadata arrives', async () => {
  let release!: (value: ModelCatalog) => void;
  mockListModels.mockImplementation(async () => mockRemote.agents.pc.list[0].api.accountId === 'api_backup'
    ? new Promise((resolve) => { release = resolve; }) : reportedCatalog());
  const view = await render(viewThread());
  await openModels(view);
  await changeAgentApi(view);
  await closeModels(view);
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  expect(view.queryByLabelText('Default')).toBeNull();
  expect(view.queryByLabelText('High')).toBeNull();
  expect(mockSavePrefs).not.toHaveBeenCalled();
  await act(async () => { release(reportedCatalog(['gpt-fixture', 'deepseek-chat'])); });
  await scrubEffort(view, 4);
  expect(mockSavePrefs).toHaveBeenLastCalledWith('paired|pc|codex:original', expect.objectContaining({ model: 'gpt-fixture', effort: 'high', apiIdentity: 'phone:api_backup' }));
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: 'gpt-fixture', effort: 'high' }));
});

test('conversation entry forces a fresh catalog once, not on typing, elapsed time or each turn', async () => {
  const view = await render(viewThread());
  expect(mockListModels).toHaveBeenCalledTimes(1);
  expect(mockListModels).toHaveBeenLastCalledWith('pc', 'codex', true);
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '第一次任务');
  await fireEvent.press(view.getByLabelText('发送'));
  await act(async () => { jest.advanceTimersByTime(10 * 60_000); });
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '第二次任务');
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockListModels).toHaveBeenCalledTimes(1);
  await openModels(view);
  expect(mockListModels).toHaveBeenLastCalledWith('pc', 'codex', false);
});

test.each(['valid', 'empty', 'failed'] as const)('automatic catalog checks stay out of the conversation UI: %s', async (outcome) => {
  mockListModels.mockImplementation(async () => {
    if (outcome === 'failed') throw new Error('internal catalog check details');
    return { models: outcome === 'empty' ? [] : ['gpt-fixture'] };
  });
  const view = await render(viewThread());
  expect(mockListModels).toHaveBeenCalledWith('pc', 'codex', true);
  expect(mockToast).not.toHaveBeenCalled();
  expect(view.queryByText(/正在检查|模型列表读取|internal catalog/)).toBeNull();
  expect(view.queryByText('加载失败')).toBeNull();
  expect(view.queryByText('暂无可用模型')).toBeNull();
  expect(view.queryByLabelText('更换对话 API')).toBeNull();
  expect(view.queryByLabelText('选择当前 API 的模型')).toBeNull();
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(outcome !== 'valid');
  expect(view.getByText('原来的回复')).toBeTruthy();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
  if (outcome !== 'valid') {
    await openModels(view);
    expect(view.getByText(outcome === 'failed' ? '加载失败' : '暂无可用模型')).toBeTruthy();
    expect(mockToast).not.toHaveBeenCalled();
  }
});

test('a pending background catalog check does not open a popup or add a progress banner', async () => {
  let release!: (value: { models: string[] }) => void;
  mockListModels.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const view = await render(viewThread());
  expect(view.queryByText(/正在检查|检查成功|模型目录/)).toBeNull();
  expect(view.queryByLabelText('更换对话 API')).toBeNull();
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  expect(mockToast).not.toHaveBeenCalled();
  await act(async () => { release({ models: ['gpt-fixture'] }); });
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(false);
  expect(view.getByLabelText(`模型：${'gpt-fixture'}`)).toBeTruthy();
  expect(mockToast).not.toHaveBeenCalled();
});

test('reopening the same conversation detects a new group even when API handle and Key are unchanged', async () => {
  let group = ['gpt-fixture'];
  mockListModels.mockImplementation(async () => ({ models: group, api: '主力' }));
  mockLoadPrefs.mockResolvedValue({ model: 'gpt-fixture', apiIdentity: 'computer:api_original' });
  const created = jest.fn(), view = await render(viewThread(created));
  const identity = mockRemote.agents.pc.list[0].api;
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(false);
  await view.rerender(viewThread(created, false));
  group = ['claude-sonnet-new'];
  await view.rerender(viewThread(created));
  expect(mockRemote.agents.pc.list[0].api).toBe(identity);
  expect(mockListModels).toHaveBeenCalledTimes(2);
  expect(mockListModels).toHaveBeenLastCalledWith('pc', 'codex', true);
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  expect(view.getByLabelText('模型：选择模型')).toBeTruthy();
  expect(mockToast).not.toHaveBeenCalled();
  expect(view.getByText('原来的回复')).toBeTruthy();
  await openModels(view);
  expect(view.queryByRole('radio', { name: 'gpt-fixture' })).toBeNull();
  await fireEvent.press(view.getByRole('radio', { name: 'claude-sonnet-new' })); await closeModels(view);
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: 'claude-sonnet-new' }));
  expect(mockSetApi).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled(); expect(created).not.toHaveBeenCalled();
});

test('same-Key entry failure cannot authorize the old cached model or lose the conversation', async () => {
  const view = await render(viewThread());
  await view.rerender(viewThread(undefined, false));
  mockListModels.mockRejectedValueOnce(new Error('fixture permission changed'));
  await view.rerender(viewThread());
  expect(mockListModels).toHaveBeenLastCalledWith('pc', 'codex', true);
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
  expect(view.getByText('原来的回复')).toBeTruthy();
});

test('a late catalog from the previous entry cannot restore an old group after reopening', async () => {
  let release!: (value: { models: string[] }) => void;
  mockListModels.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const view = await render(viewThread());
  await view.rerender(viewThread(undefined, false));
  mockListModels.mockResolvedValue({ models: ['deepseek-chat'] });
  await view.rerender(viewThread());
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  await openModels(view);
  await fireEvent.press(view.getByRole('radio', { name: 'deepseek-chat' })); await closeModels(view);
  await act(async () => { release({ models: ['gpt-fixture'] }); });
  expect(view.getByLabelText(`模型：${'deepseek-chat'}`)).toBeTruthy();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ model: 'deepseek-chat' }));
});

test('a new conversation checks its unchanged Key group before starting any task', async () => {
  mockRemote.devices[0].projects = [{ name: '项目', path: 'C:\\fixture' }];
  mockListModels.mockResolvedValue({ models: ['claude-sonnet-new'] });
  const created = jest.fn();
  const view = await render(<ThreadView visible deviceId="pc" sessionKey={null} newProjectPath={originalSession.cwd} agent={originalAgent} onClose={jest.fn()} onCreated={created} />);
  expect(mockListModels).toHaveBeenLastCalledWith('pc', 'codex', true);
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  expect(mockStart).not.toHaveBeenCalled();
  await openModels(view);
  await fireEvent.press(view.getByRole('radio', { name: 'claude-sonnet-new' })); await closeModels(view);
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockStart).toHaveBeenCalledWith('pc', expect.objectContaining({ tool: 'codex', cwd: 'C:\\fixture', prompt: '原草稿', model: 'claude-sonnet-new' }));
  expect(created).toHaveBeenCalledWith('codex:new');
  expect(mockSetApi).not.toHaveBeenCalled(); expect(mockSend).not.toHaveBeenCalled();
});

const compactQuestion = (id = 'compact'): TimelineItem => ({ kind: 'approval', id, approval: 'question', title: '选一下', state: 'pending', ts: 2,
  questions: [{ id: 'choice', question: '选方案', required: true, options: [{ label: 'A' }, { label: 'B' }] }] });
const oldReply: TimelineItem = { kind: 'message', id: 'old', role: 'assistant', text: '原来的回复', final: true, ts: 1 };

test('live approval queue changes count without stealing the selected form or its unfinished answers', async () => {
  setItems([oldReply, compactQuestion('first')]);
  const view = await render(viewThread());
  await fireEvent.press(view.getByRole('radio', { name: 'B' }));
  setItems([oldReply, compactQuestion('first'), compactQuestion('second')]);
  await view.rerender(viewThread());
  expect(view.getByText('待处理 2 项')).toBeTruthy();
  expect(view.getByRole('radio', { name: 'B' }).props.accessibilityState.checked).toBe(true);
  await fireEvent.press(view.getByLabelText('下一个待处理请求'));
  expect(view.getByRole('radio', { name: 'B' }).props.accessibilityState.checked).toBe(false);
  await fireEvent.press(view.getByRole('radio', { name: 'A' }));
  // Even an earlier-sorted late event must not change the active request ID.
  setItems([oldReply, compactQuestion('earlier'), compactQuestion('first'), compactQuestion('second'), compactQuestion('fourth')]);
  await view.rerender(viewThread());
  expect(view.getByText('待处理 4 项')).toBeTruthy();
  expect(view.getByRole('radio', { name: 'A' }).props.accessibilityState.checked).toBe(true);
  await fireEvent.press(view.getByLabelText('上一个待处理请求'));
  expect(view.getByRole('radio', { name: 'B' }).props.accessibilityState.checked).toBe(true);
  await fireEvent.press(view.getByLabelText('提交回答'));
  expect(mockRespond).toHaveBeenCalledWith(expect.objectContaining({ approvalId: 'first' }), 'allow', undefined, { choice: ['B'] }, expect.anything());
});

test('withdrawal removes only the matching queue entry and drafts never cross renewed pairing', async () => {
  setItems([oldReply, compactQuestion('first'), compactQuestion('second')]);
  const view = await render(viewThread());
  await fireEvent.press(view.getByRole('radio', { name: 'B' }));
  await fireEvent.press(view.getByLabelText('下一个待处理请求'));
  await fireEvent.press(view.getByRole('radio', { name: 'A' }));
  setItems([oldReply, compactQuestion('first'), { ...compactQuestion('second'), state: 'deny' } as TimelineItem]);
  await view.rerender(viewThread());
  expect(view.queryByTestId('remote-approval-queue')).toBeNull();
  expect(view.getByRole('radio', { name: 'B' }).props.accessibilityState.checked).toBe(true);
  mockDeliveryScope = 'paired|renewed-fixture';
  await view.rerender(viewThread());
  expect(view.getByRole('radio', { name: 'B' }).props.accessibilityState.checked).toBe(false);
  expect(mockRespond).not.toHaveBeenCalled();
});

test('mixed Agent approval queue exposes only actions declared by the adapter', async () => {
  const request: TimelineItem = { kind: 'approval', id: 'tool', approval: 'tool', title: 'Synthetic tool', state: 'pending', ts: 2,
    approvalOptions: { version: 1, decisions: ['allow', 'deny'] } };
  setItems([oldReply, compactQuestion('question'), request]);
  const view = await render(viewThread());
  await fireEvent.press(view.getByRole('radio', { name: 'B' }));
  await fireEvent.press(view.getByLabelText('下一个待处理请求'));
  expect(view.getByText('Synthetic tool')).toBeTruthy();
  expect(view.queryByText('会话内允许')).toBeNull();
  await fireEvent.press(view.getByLabelText('上一个待处理请求'));
  expect(view.getByRole('radio', { name: 'B' }).props.accessibilityState.checked).toBe(true);
  await fireEvent.press(view.getByLabelText('下一个待处理请求'));
  setItems([oldReply, compactQuestion('question'), { ...request, approvalOptions: { version: 2, decisions: ['allow'] } }]);
  await view.rerender(viewThread());
  expect(view.queryByText('允许')).toBeNull();
  expect(view.getByText('请在电脑处理')).toBeTruthy();
  expect(mockRespond).not.toHaveBeenCalled();
});

test.each([false, true])('a deny-only question remains cancellable without exposing allow: cancels turn=%s', async cancelTurn => {
  setItems([oldReply, { ...compactQuestion(), approvalOptions: { version: 1, decisions: ['deny'], ...(cancelTurn ? { denyEffect: 'cancel_turn' } : {}) } } as TimelineItem]);
  const view = await render(viewThread());
  expect(view.getByLabelText('提交回答').props.accessibilityState.disabled).toBe(true);
  const label = cancelTurn ? '取消本轮' : '取消回答';
  expect(view.getByLabelText(label).props.accessibilityState.disabled).toBe(false);
  if (cancelTurn) expect(view.getByText('取消本轮')).toBeTruthy();
  await fireEvent.press(view.getByLabelText(label));
  expect(mockRespond).toHaveBeenCalledWith(expect.objectContaining({ approvalId: 'compact' }), 'deny', undefined, undefined, expect.anything());
});

test('a deny-only question stays blocked offline and its stale cancel handler cannot send', async () => {
  setItems([oldReply, { ...compactQuestion(), approvalOptions: { version: 1, decisions: ['deny'] } } as TimelineItem]);
  const view = await render(viewThread());
  const cancel = view.getByLabelText('取消回答').props.onPress;
  mockRemote.devices[0].online = false;
  await view.rerender(viewThread());
  expect(view.getByLabelText('取消回答').props.accessibilityState.disabled).toBe(true);
  await act(async () => { cancel(); });
  expect(mockRespond).not.toHaveBeenCalled();
});

test('session approval is offered only when explicitly advertised, not from Agent identity', async () => {
  const request: TimelineItem = { kind: 'approval', id: 'tool', approval: 'command', title: 'Synthetic command', state: 'pending', ts: 2,
    approvalOptions: { version: 1, decisions: ['allow_session', 'deny'] } };
  setItems([oldReply, request]);
  const view = await render(viewThread());
  expect(view.queryByText('允许')).toBeNull();
  await fireEvent.press(view.getByText('会话内允许'));
  expect(mockRespond).toHaveBeenCalledWith(expect.objectContaining({ approvalId: 'tool' }), 'allow_session', undefined, undefined,
    expect.objectContaining({ requestId: expect.any(String), retrying: false }));
});

test.each(['allow', 'deny'] as const)('submitting %s restores the draft and attachments immediately, with delivery progress only in the main conversation', async (decision) => {
  const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '未发送的新任务');
  mockPickImages.mockResolvedValueOnce([{ uri: 'fixture://draft-image', base64: 'fixture', mime: 'image/jpeg', width: 100, height: 100 }]);
  await fireEvent.press(view.getByRole('button', { name: '添加到对话' }));
  await fireEvent.press(view.getByLabelText('从相册选择'));
  expect(view.getByLabelText(/^移除待发送图片 /)).toBeTruthy();
  setItems([oldReply, compactQuestion()]);
  await view.rerender(viewThread());
  expect(view.queryByLabelText('给电脑上的 Agent 发消息')).toBeNull();
  expect(view.queryByLabelText(/^移除待发送图片 /)).toBeNull();
  expect(view.getByTestId('remote-question-dialog')).toBeTruthy();
  expect(within(view.getByTestId('remote-conversation')).queryByLabelText('回答 Agent 的问题')).toBeNull();
  expect(view.getByText('原来的回复')).toBeTruthy();
  if (decision === 'allow') {
    await fireEvent.press(view.getByRole('radio', { name: 'B' }));
    await fireEvent.press(view.getByLabelText('提交回答'));
  } else await fireEvent.press(view.getByLabelText('取消回答'));
  expect(mockRespond).toHaveBeenCalledWith({ approvalId: 'compact', deviceId: 'pc', sessionKey: 'codex:original' }, decision, undefined, decision === 'allow' ? { choice: ['B'] } : undefined, expect.objectContaining({ requestId: expect.any(String), retrying: false }));
  // Locally dismiss the card; do not claim approval.resolved before the real receipt.
  expect(view.queryByTestId('remote-question-dialog')).toBeNull();
  expect(within(view.getByTestId('remote-conversation')).getByTestId('remote-answer-delivery')).toBeTruthy();
  expect(mockRemote.timelines['pc|codex:original'].items.at(-1)).toMatchObject({ state: 'pending' });
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('未发送的新任务');
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.placeholder).toBe('发送下一条消息…');
  expect(view.getByLabelText(/^移除待发送图片 /)).toBeTruthy();
  expect(view.queryByLabelText('提交回答')).toBeNull();
  setItems([oldReply, { ...compactQuestion(), state: decision } as TimelineItem]);
  await view.rerender(viewThread());
  expect(view.queryByTestId('remote-question-dialog')).toBeNull();
  expect(view.queryByTestId('remote-answer-delivery')).toBeNull();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('未发送的新任务');
  expect(view.getByLabelText(/^移除待发送图片 /)).toBeTruthy();
  expect(view.getByText('原来的回复')).toBeTruthy();
  expect(mockStart).not.toHaveBeenCalled(); expect(mockSend).not.toHaveBeenCalled();
});

test('definitive question rejection restores the answer for correction without losing the draft', async () => {
  setItems([oldReply, compactQuestion()]); mockRespond.mockRejectedValueOnce(new Error('fixture disconnected'));
  const view = await render(viewThread());
  await fireEvent.press(view.getByRole('radio', { name: 'A' }));
  await fireEvent.press(view.getByLabelText('提交回答'));
  expect(view.getByRole('radio', { name: 'A' }).props.accessibilityState.checked).toBe(true);
  expect(view.queryByLabelText('给电脑上的 Agent 发消息')).toBeNull();
  mockRemote.devices[0].online = false;
  await view.rerender(viewThread());
  expect(view.getByLabelText('提交回答').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(view.getByLabelText('提交回答')); await fireEvent.press(view.getByLabelText('取消回答'));
  expect(mockRespond).toHaveBeenCalledTimes(1);
  mockRemote.devices[0].online = true;
  await view.rerender(viewThread());
  expect(view.getByRole('radio', { name: 'A' }).props.accessibilityState.checked).toBe(true);
  await fireEvent.press(view.getByLabelText('提交回答'));
  expect(mockRespond).toHaveBeenCalledTimes(2);
  expect(mockRespond).toHaveBeenLastCalledWith({ approvalId: 'compact', deviceId: 'pc', sessionKey: 'codex:original' }, 'allow', undefined, { choice: ['A'] }, expect.objectContaining({ retrying: false }));
});

test('a lost question acknowledgement leaves the input usable and retries the frozen answer from main-conversation progress', async () => {
  setItems([oldReply, compactQuestion()]);
  mockRespond.mockRejectedValueOnce(new HubError('fixture disconnected'));
  const view = await render(viewThread());
  await fireEvent.press(view.getByRole('radio', { name: 'A' }));
  await fireEvent.press(view.getByLabelText('提交回答'));
  expect(view.queryByRole('radio', { name: 'A' })).toBeNull();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
  expect(view.getByTestId('remote-answer-delivery')).toBeTruthy();
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '等待时先写下一步');
  const send = view.getByLabelText(/^(发送|排队发送)$/);
  expect(send.props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(send); expect(mockSend).not.toHaveBeenCalled();
  expect(mockToast).not.toHaveBeenCalled();
  await act(async () => { jest.advanceTimersByTime(2000); });
  expect(mockRespond).toHaveBeenCalledTimes(2);
  expect(mockRespond.mock.calls[1].slice(0, 4)).toEqual(mockRespond.mock.calls[0].slice(0, 4));
  expect(mockRespond.mock.calls[1][4]).toMatchObject({ requestId: (mockRespond.mock.calls[0][4] as { requestId: string }).requestId, retrying: true });
  // Even a successful transport cannot claim delivery before a resolved event.
  expect(view.getByTestId('remote-answer-delivery')).toBeTruthy();
  setItems([oldReply, { ...compactQuestion(), state: 'allow' } as TimelineItem]);
  await view.rerender(viewThread());
  expect(view.queryByTestId('remote-question-dialog')).toBeNull();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('等待时先写下一步');
});

test.each(['command_receipt_missing', 'command_receipt_pending'])('an uncertain question receipt preserves its original UUID without allowing a fresh answer: %s', async code => {
  setItems([oldReply, compactQuestion()]);
  mockRespond.mockRejectedValueOnce(new HubError('Synthetic lost acknowledgement'))
    .mockRejectedValueOnce(new HubError('原回答尚未确认', 409, code));
  const view = await render(viewThread());
  await fireEvent.press(view.getByRole('radio', { name: 'A' }));
  await fireEvent.press(view.getByLabelText('提交回答'));
  const original = JSON.parse(mockQuestionStorage.get('remote_question_outbox_v1')!)[0] as QuestionReceipt;
  await act(async () => { jest.advanceTimersByTime(2000); });
  expect(mockRespond).toHaveBeenCalledTimes(2);
  expect(mockRespond.mock.calls[1][4]).toMatchObject({ requestId: original.requestId, retrying: true, command: original.command });
  expect(JSON.parse(mockQuestionStorage.get('remote_question_outbox_v1')!)).toEqual([
    expect.objectContaining({ requestId: original.requestId, blocked: code, command: original.command }),
  ]);
  expect(view.getByLabelText('提交回答').props.accessibilityState.disabled).toBe(true);
  mockRemote.timelines['pc|codex:original'].snapshotAt = Date.now();
  mockRemote.timelines['pc|codex:original'].snapshotStartedAt = Date.now();
  await view.rerender(viewThread(jest.fn(), false)); await view.rerender(viewThread());
  expect(view.getByLabelText('提交回答').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(view.getByLabelText('提交回答'));
  expect(mockRespond).toHaveBeenCalledTimes(2);
});

test('rapid duplicate presses submit once and a late old-session failure cannot unlock the new question', async () => {
  let rejectOld!: (reason: Error) => void, finishNew!: () => void;
  mockRespond.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectOld = reject; }))
    .mockImplementationOnce(() => new Promise<void>((resolve) => { finishNew = resolve; }));
  setItems([oldReply, compactQuestion('old-question')]);
  const view = await render(viewThread());
  await fireEvent.press(view.getByRole('radio', { name: 'A' }));
  const submit = view.getByLabelText('提交回答').props.onPress as () => void;
  await act(async () => { submit(); submit(); });
  expect(mockRespond).toHaveBeenCalledTimes(1);
  const otherSession = { ...originalSession, sessionKey: 'codex:other', title: '另一会话' };
  mockRemote.sessions.pc.list.push(otherSession);
  mockRemote.timelines['pc|codex:other'] = { items: [compactQuestion('new-question')], loading: false, session: otherSession };
  const other = <ThreadView visible deviceId="pc" sessionKey="codex:other" agent={originalAgent} onClose={jest.fn()} onCreated={jest.fn()} />;
  await view.rerender(other);
  expect(view.getByLabelText('提交回答').props.accessibilityState.disabled).toBe(false);
  await fireEvent.press(view.getByRole('radio', { name: 'B' }));
  await fireEvent.press(view.getByLabelText('提交回答'));
  expect(mockRespond).toHaveBeenCalledTimes(2);
  expect((mockRespond.mock.calls[1][4] as { requestId: string }).requestId).not.toBe((mockRespond.mock.calls[0][4] as { requestId: string }).requestId);
  await act(async () => { rejectOld(new Error('obsolete request error')); });
  expect(mockToast).not.toHaveBeenCalled();
  expect(view.getByTestId('remote-answer-delivery')).toBeTruthy();
  expect(view.queryByLabelText('提交回答')).toBeNull();
  await act(async () => { finishNew(); });
  expect(view.getByTestId('remote-answer-delivery')).toBeTruthy();
  expect(view.queryByLabelText('提交回答')).toBeNull();
  expect(mockRespond).toHaveBeenLastCalledWith({ approvalId: 'new-question', deviceId: 'pc', sessionKey: 'codex:other' }, 'allow', undefined, { choice: ['B'] }, expect.objectContaining({ retrying: false }));
});

test('three subagents have separate visible rows and preserve independent disclosures during updates', async () => {
  const tasks = ['a', 'b', 'c'].flatMap<TimelineItem>((id, index) => [
    { kind: 'tool', id, tool: 'subagent', title: `检查 ${id}`, detail: `任务 ${id} 的要求`, childSessionKeys: [`codex:child-${id}`], status: 'done', ts: index * 2 + 2 },
    { kind: 'tool', id: `${id}:state`, tool: 'subagent', title: `子智能体 ${id}`, parentId: id, childSessionKeys: [`codex:child-${id}`], status: id === 'a' ? 'done' : id === 'b' ? 'running' : 'failed', output: `${id} 的进度`, ts: index * 2 + 3 },
  ]);
  setItems([oldReply, ...tasks]);
  const created = jest.fn(), view = await render(viewThread(created));
  expect(view.queryByLabelText('展开处理摘要')).toBeNull();
  expect(view.getByTestId('execution-row:b')).toBeTruthy();
  expect(view.getByLabelText('检查 a：子任务详情')).toBeTruthy(); expect(view.queryByText('a 的进度')).toBeNull();
  expect(view.getByText('原来的回复')).toBeTruthy();
  expect(view.getByLabelText('检查 a：子任务详情')).toBeTruthy(); expect(view.getByLabelText('检查 b：子任务详情')).toBeTruthy(); expect(view.getByLabelText('检查 c：子任务详情')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('检查 a：子任务详情'));
  expect(view.getByText('任务 a 的要求')).toBeTruthy(); expect(view.queryByText('任务 b 的要求')).toBeNull();
  await fireEvent.press(view.getByText('子智能体 a'));
  expect(view.getByText('a 的进度')).toBeTruthy();
  setItems([oldReply, ...tasks.map((item) => item.id === 'b:state' ? { ...item, status: 'done', output: 'b 已完成' } as TimelineItem : item)]);
  await view.rerender(viewThread(created));
  expect(view.getByLabelText('检查 a：子任务详情').props.accessibilityState.expanded).toBe(true); expect(view.getByText('a 的进度')).toBeTruthy();
  expect(within(view.getByTestId('execution-row:b')).getByText(/已完成/)).toBeTruthy();
  expect(within(view.getByTestId('execution-row:c')).getByText(/失败/)).toBeTruthy();
  await fireEvent.press(view.getByLabelText('打开子智能体对话 1'));
  expect(created).not.toHaveBeenCalled();
  await fireEvent.press(view.getByText('子智能体 · Codex · child-a'));
  expect(created).toHaveBeenCalledWith('codex:child-a');
  await fireEvent.press(view.getByLabelText('检查 a：子任务详情'));
  expect(view.getByLabelText('检查 a：子任务详情')).toBeTruthy(); expect(view.queryByText('a 的进度')).toBeNull();
  expect(mockStart).not.toHaveBeenCalled();
});

test('live coding activity labels identify the current file edit and command in the conversation', async () => {
  setItems([
    { kind: 'message', id: 'request', role: 'user', text: '修复并验证', final: true, ts: 1 },
    { kind: 'tool', id: 'edit-live', tool: 'file_change', title: '修改 src/app.ts',
      diff: 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n-old\n+new', status: 'running', ts: 2 },
  ], { ...originalSession, status: 'running', activeTurnId: 'turn-live' });
  const view = await render(viewThread());
  expect(within(view.getByTestId('execution-row:edit-live')).getByText('正在编辑 src/app.ts')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('查看文件编辑：修改 src/app.ts'));
  expect(view.getByLabelText('查看修改文件 src/app.ts')).toBeTruthy();

  setItems([
    { kind: 'message', id: 'request', role: 'user', text: '修复并验证', final: true, ts: 1 },
    { kind: 'tool', id: 'test-live', tool: 'command', title: '运行 pnpm test', detail: 'pnpm test', status: 'running', ts: 3 },
  ], { ...originalSession, status: 'running', activeTurnId: 'turn-live' });
  await view.rerender(viewThread());
  expect(view.getByText('正在运行 pnpm test')).toBeTruthy();
  expect(view.queryByLabelText('展开处理摘要')).toBeNull();
  await fireEvent.press(view.getByLabelText('查看命令详情：运行 pnpm test'));
  expect(within(view.getByTestId('command-output-frame')).getByText('$ pnpm test')).toBeTruthy();
  expect(view.queryByLabelText('在大窗口查看命令：运行 pnpm test')).toBeNull();
  expect(view.queryByLabelText('关闭命令详情')).toBeNull();
  expect(view.queryByLabelText('正在处理')).toBeNull();
  await fireEvent.press(view.getByLabelText('查看命令详情：运行 pnpm test'));
  expect(view.queryByTestId('command-output-frame')).toBeNull();
  expect(view.getByLabelText('查看命令详情：运行 pnpm test').props.accessibilityState.expanded).toBe(false);
});

test('a streaming assistant response has a quiet textual status alongside its live caret', async () => {
  setItems([{ kind: 'message', id: 'stream', role: 'assistant', text: '正在生成一段回复', final: false, ts: 2 }],
    { ...originalSession, status: 'running', activeTurnId: 'turn-stream' });
  const view = await render(viewThread());
  expect(view.getByLabelText('正在回复')).toBeTruthy();
  expect(view.getByText('正在回复')).toBeTruthy();
});

test('a terminal but unreconciled assistant prefix stops animating and is clearly marked incomplete', async () => {
  setItems([{ kind: 'message', id: 'stream', role: 'assistant', text: '一起', final: false, streamState: 'incomplete', ts: 2 }],
    { ...originalSession, status: 'idle' });
  const view = await render(viewThread());
  expect(view.getByTestId('remote-incomplete-reply')).toBeTruthy();
  expect(view.getByLabelText('回复未完整')).toBeTruthy();
  expect(view.queryByLabelText('正在回复')).toBeNull();
});

test('child edits and plans stay inside the task details and pending child questions are not marked answered', async () => {
  setItems([
    oldReply,
    { kind: 'tool', id: 'task', tool: 'subagent', title: '子任务', status: 'done', childSessionKeys: ['codex:child'], ts: 2 },
    { kind: 'tool', id: 'child-edit', tool: 'file_change', title: '修改 child.ts', diff: '--- a/child.ts\n+++ b/child.ts\n-old\n+new', status: 'done', parentId: 'task', ts: 3 },
    { kind: 'tool', id: 'child-plan', tool: 'plan', title: '计划', output: '✓ 子任务分析\n○ 子任务验证', status: 'running', parentId: 'task', ts: 4 },
    { ...compactQuestion('child-question'), title: '子任务提问', parentId: 'task' } as TimelineItem,
  ]);
  const view = await render(viewThread());
  expect(view.queryByText('child.ts')).toBeNull(); expect(view.queryByText('子任务分析')).toBeNull();
  expect(view.queryByText('child.ts')).toBeNull();
  await fireEvent.press(view.getByLabelText('子任务：子任务详情'));
  expect(view.getByText('child.ts')).toBeTruthy(); expect(view.getByText('子任务分析')).toBeTruthy(); expect(view.getByText('子任务验证')).toBeTruthy();
  expect(view.getByText('等待回答：子任务提问')).toBeTruthy();
  expect(view.queryByText('已回答：子任务提问')).toBeNull();
  expect(view.getByTestId('remote-question-dialog')).toBeTruthy();
  expect(within(view.getByTestId('remote-conversation')).queryByLabelText('提交回答')).toBeNull();
});

test('restored answers wait for a fresh snapshot and then reuse the journaled UUID', async () => {
  const receipt = { scope: 'paired|fixture-credential', deviceId: 'pc', sessionKey: 'codex:original', approvalId: 'restored',
    decision: 'allow', answers: { choice: ['B'] }, requestId: '0199aaa1-1234-4678-9abc-000000000007', createdAt: Date.now() - 1000, lastObservedAt: Date.now() - 1000, attempted: true,
    command: { type: 'approval.respond', sessionKey: 'codex:original', approvalId: 'restored', decision: 'allow', answers: { choice: ['B'] }, controlSurface: 'cli' } };
  mockQuestionStorage.set('remote_question_outbox_v1', JSON.stringify([receipt]));
  setItems([oldReply, compactQuestion('restored')]); mockRemote.timelines['pc|codex:original'].snapshotAt = Date.now() - 5000;
  let read!: () => void; const opening = new Promise<undefined>(resolve => { read = () => resolve(undefined); }); mockOpen.mockReturnValue(opening);
  let acknowledge!: () => void; const response = new Promise<void>(resolve => { acknowledge = resolve; }); mockRespond.mockReturnValue(response);
  const view = await render(viewThread()); expect(mockRespond).not.toHaveBeenCalled();
  await act(async () => { read(); await opening; });
  expect(mockRespond).toHaveBeenCalledWith({ approvalId: 'restored', deviceId: 'pc', sessionKey: 'codex:original' }, 'allow', undefined,
    { choice: ['B'] }, expect.objectContaining({ requestId: receipt.requestId, retrying: true }));
  expect(view.getByTestId('remote-answer-delivery')).toBeTruthy();
  setItems([oldReply, { ...compactQuestion('restored'), state: 'allow' } as TimelineItem]); mockRemote.timelines['pc|codex:original'].snapshotAt = Date.now();
  await view.rerender(viewThread()); await act(async () => { acknowledge(); await response; });
  expect(mockSend).not.toHaveBeenCalled(); expect(mockRespond).toHaveBeenCalledTimes(1);
});

function holdQuestionHttpReceipt() {
  let finish!: () => void;
  mockRespond.mockImplementationOnce((...args: unknown[]) => new Promise<void>((resolve, reject) => {
    finish = resolve;
    const receipt = args[4] as { signal: AbortSignal };
    receipt.signal.addEventListener('abort', () => reject(new HubError('Synthetic cancelled read', 499, 'aborted')), { once: true });
  }));
  return { finish: () => finish() };
}

function pendingQuestionWithOlderSnapshot(id: string, expiresAt = Date.now() + 60000) {
  const snapshotStartedAt = Date.now() - 1000;
  const approval = { ...compactQuestion(id), ts: Date.now() - 500, seq: 10, expiresAt } as Extract<TimelineItem, { kind: 'approval' }>;
  setItems([oldReply, approval]);
  Object.assign(mockRemote.timelines['pc|codex:original'], { snapshotStartedAt, snapshotAt: snapshotStartedAt + 1 });
  return { approval, snapshotStartedAt };
}

test.each(['phone', 'desktop'] as const)('incremental question resolution before its HTTP receipt clears only that answer and allows API switching: %s', async by => {
  const { approval, snapshotStartedAt } = pendingQuestionWithOlderSnapshot(`early-resolved-${by}`);
  const response = holdQuestionHttpReceipt();
  const view = await render(viewThread());
  await fireEvent.press(view.getByText('B')); await fireEvent.press(view.getByLabelText('提交回答'));
  const receipt = JSON.parse(mockQuestionStorage.get('remote_question_outbox_v1')!)[0] as QuestionReceipt;
  expect(receipt.createdAt).toBeGreaterThan(snapshotStartedAt); expect(receipt.attempted).toBe(true);
  mockRemote.timelines['pc|codex:original'].items = [oldReply, { ...approval, state: 'allow', by, ts: Date.now(), seq: 11 }];
  await view.rerender(viewThread());
  await act(async () => { response.finish(); });
  expect(mockRemote.timelines['pc|codex:original'].snapshotStartedAt).toBe(snapshotStartedAt);
  expect(await pendingQuestionReceiptsForDevice(mockDeliveryScope, 'pc')).toEqual([]);
  expect(JSON.parse(mockQuestionStorage.get('remote_question_outbox_v1')!)).toEqual([]);
  expect(mockRespond).toHaveBeenCalledTimes(1); expect(mockToast).not.toHaveBeenCalled();
  // The real device-level API guard consumes this exact persistent listing.
  mockSetApi.mockImplementationOnce(async () => {
    if ((await pendingQuestionReceiptsForDevice(mockDeliveryScope, 'pc')).length) throw new Error('先核对待确认消息，再换 API');
    const changed = { ...originalAgent, api: { ...originalAgent.api, accountId: 'api_backup', source: 'phone' as const, name: '备用', model: '' } };
    mockRemote.agents.pc.list = [changed]; return changed;
  });
  await openModels(view); await changeAgentApi(view);
  expect(mockSetApi).toHaveBeenCalledWith('pc', 'codex', 'api_backup', '', 'codex:original');
  expect(mockRemote.agents.pc.list[0].api.accountId).toBe('api_backup');
});

test.each(['hide', 'expiry', 'missing', 'timeout', 'stale-terminal', 'older-sequence', 'same-sequence', 'older-time', 'missing-source', 'different-question', 'different-kind'] as const)('cancelling an in-flight answer without current resolution proof retains its UUID: %s', async reason => {
  const { approval } = pendingQuestionWithOlderSnapshot(`unconfirmed-${reason}`, Date.now() + 1000);
  const response = holdQuestionHttpReceipt();
  const view = await render(viewThread());
  await fireEvent.press(view.getByText('B')); await fireEvent.press(view.getByLabelText('提交回答'));
  const receipt = JSON.parse(mockQuestionStorage.get('remote_question_outbox_v1')!)[0] as QuestionReceipt;
  if (reason === 'hide') await view.rerender(viewThread(undefined, false));
  else if (reason === 'expiry') await act(async () => { jest.advanceTimersByTime(1001); });
  else {
    const terminal: Extract<TimelineItem, { kind: 'approval' }> = { ...approval, state: 'deny', by: 'phone', ts: Date.now(), seq: 11 };
    if (reason === 'timeout') terminal.by = 'timeout';
    if (reason === 'stale-terminal' || reason === 'older-sequence') terminal.seq = 9;
    if (reason === 'same-sequence') terminal.seq = 10;
    if (reason === 'stale-terminal' || reason === 'older-time') terminal.ts = approval.ts - 1;
    if (reason === 'missing-source') terminal.by = undefined;
    if (reason === 'different-question') terminal.id = 'another-question';
    if (reason === 'different-kind') terminal.approval = 'tool';
    mockRemote.timelines['pc|codex:original'].items = reason === 'missing' ? [oldReply] : [oldReply, terminal];
    await view.rerender(viewThread());
  }
  await act(async () => { response.finish(); });
  expect(JSON.parse(mockQuestionStorage.get('remote_question_outbox_v1')!)).toEqual([expect.objectContaining({ requestId: receipt.requestId, scope: receipt.scope })]);
  expect(mockRespond).toHaveBeenCalledTimes(1); expect(mockToast).not.toHaveBeenCalled();
});

test.each(['superseded', 'new-binding'] as const)('an early resolved old answer cannot clear another receipt owner: %s', async change => {
  const { approval } = pendingQuestionWithOlderSnapshot(`old-owner-${change}`);
  const response = holdQuestionHttpReceipt();
  const view = await render(viewThread());
  await fireEvent.press(view.getByText('B')); await fireEvent.press(view.getByLabelText('提交回答'));
  const receipt = JSON.parse(mockQuestionStorage.get('remote_question_outbox_v1')!)[0] as QuestionReceipt;
  const newer = { ...receipt, requestId: '0199aaa1-1234-4678-9abc-000000009999',
    scope: change === 'new-binding' ? 'paired|renewed-question-fixture' : receipt.scope };
  const records = change === 'new-binding' ? [receipt, newer] : [newer];
  mockQuestionStorage.set('remote_question_outbox_v1', JSON.stringify(records));
  if (change === 'new-binding') mockDeliveryScope = newer.scope;
  mockRemote.timelines['pc|codex:original'].items = [oldReply, { ...approval, state: 'allow', by: 'phone', ts: Date.now(), seq: 11 }];
  await view.rerender(viewThread()); await act(async () => { response.finish(); });
  expect(JSON.parse(mockQuestionStorage.get('remote_question_outbox_v1')!)).toEqual(records);
  expect(mockRespond).toHaveBeenCalledTimes(1); expect(mockToast).not.toHaveBeenCalled();
});

test.each(['hide', 'unmount', 'withdraw'])('a queued question submit after %s cannot create a receipt or send', async mode => {
  setItems([oldReply, compactQuestion('stale-question')]);
  const view = await render(viewThread()); await fireEvent.press(view.getByText('B'));
  const submit = view.getByLabelText('提交回答').props.onPress as () => void;
  if (mode === 'hide') await view.rerender(viewThread(jest.fn(), false));
  else if (mode === 'unmount') await view.unmount();
  else { setItems([oldReply]); await view.rerender(viewThread()); }
  await act(async () => { submit(); });
  expect(mockRespond).not.toHaveBeenCalled(); expect(JSON.parse(mockQuestionStorage.get('remote_question_outbox_v1') ?? '[]')).toEqual([]);
});

test('a queued old send callback after closing cannot dispatch', async () => {
  const view = await render(viewThread()); const send = mockSendSubmit.current;
  await view.rerender(viewThread(jest.fn(), false)); await act(async () => { await send(); });
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
});

test('a late new-thread acknowledgement cannot clear or navigate a newly selected conversation', async () => {
  let finish!: (key: string) => void; mockStart.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  mockRemote.devices[0].projects = [{ path: 'C:\\fixture', name: 'fixture' }]; const created = jest.fn();
  const view = await render(<ThreadView visible deviceId="pc" sessionKey={null} newProjectPath={originalSession.cwd} agent={originalAgent} onClose={jest.fn()} onCreated={created} />);
  await act(async () => { fireEvent.press(view.getByLabelText('发送')); }); expect(mockStart).toHaveBeenCalledTimes(1);
  await view.rerender(viewThread()); await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '新会话草稿');
  await act(async () => { finish('codex:created-earlier'); });
  expect(created).not.toHaveBeenCalled(); expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('新会话草稿');
  expect(mockToast).not.toHaveBeenCalled();
});

test('renewed pairing credentials cancel the old answer spinner even for the same connection and thread', async () => {
  setItems([oldReply, compactQuestion('credential-question')]); mockRespond.mockReturnValue(new Promise(() => undefined));
  const view = await render(viewThread()); await fireEvent.press(view.getByText('B')); await fireEvent.press(view.getByLabelText('提交回答'));
  expect(view.getByTestId('remote-answer-delivery')).toBeTruthy();
  mockDeliveryScope = 'paired|new-fixture-credential'; await view.rerender(viewThread());
  expect(view.queryByTestId('remote-answer-delivery')).toBeNull(); expect(view.getByLabelText('提交回答').props.accessibilityState.disabled).toBe(false);
  expect(mockRespond).toHaveBeenCalledTimes(1); expect(mockOpen).toHaveBeenCalledTimes(2);
});

test('local form expiry cannot reconcile away its UUID tombstone or replay after clock rollback', async () => {
  const now = Date.now(), approval = { ...compactQuestion('local-expiry'), expiresAt: now + 500 };
  const receipt = { scope: mockDeliveryScope, deviceId: 'pc', sessionKey: 'codex:original', approvalId: approval.id,
    decision: 'allow', answers: { choice: ['B'] }, requestId: '0199aaa1-1234-4678-9abc-000000000007', createdAt: now - 1000, lastObservedAt: now - 1000, expiresAt: approval.expiresAt, attempted: true };
  mockQuestionStorage.set('remote_question_outbox_v1', JSON.stringify([receipt])); mockRemote.devices[0].online = false;
  setItems([oldReply, approval]); mockRemote.timelines['pc|codex:original'].snapshotAt = now; mockRemote.timelines['pc|codex:original'].snapshotStartedAt = now;
  const view = await render(viewThread()); await act(async () => { jest.advanceTimersByTime(600); });
  expect(JSON.parse(mockQuestionStorage.get('remote_question_outbox_v1')!)[0]).toMatchObject({ requestId: receipt.requestId, blocked: 'question_expired' });
  jest.setSystemTime(now + 100); await view.rerender(viewThread(jest.fn(), false)); await view.rerender(viewThread());
  expect(mockRespond).not.toHaveBeenCalled(); expect(JSON.parse(mockQuestionStorage.get('remote_question_outbox_v1')!)[0].requestId).toBe(receipt.requestId);
});

test('a blocked receipt for the second question cannot disable the first question', async () => {
  const now = Date.now(); setItems([oldReply, compactQuestion('first-question'), compactQuestion('second-question')]);
  mockRemote.timelines['pc|codex:original'].snapshotAt = now; mockRemote.timelines['pc|codex:original'].snapshotStartedAt = now;
  mockQuestionStorage.set('remote_question_outbox_v1', JSON.stringify([{ scope: mockDeliveryScope, deviceId: 'pc', sessionKey: 'codex:original', approvalId: 'second-question', decision: 'allow',
    answers: { choice: ['B'] }, requestId: '0199aaa1-1234-4678-9abc-000000000007', createdAt: now - 1000, lastObservedAt: now - 1000, attempted: true, blocked: 'command_delivery_uncertain' }]));
  const view = await render(viewThread()); expect(view.queryByText('请在电脑核对回答')).toBeNull();
  await fireEvent.press(view.getByText('B')); expect(view.getByLabelText('提交回答').props.accessibilityState.disabled).toBe(false);
  await fireEvent.press(view.getByLabelText('提交回答')); expect(mockRespond.mock.calls[0][0]).toMatchObject({ approvalId: 'first-question' });
});

test('queued old menu actions cannot cancel or open anything through renewed pairing credentials', async () => {
  mockPending.mockResolvedValue({ scope: mockDeliveryScope, deviceId: 'pc', sessionKey: 'codex:original', surface: 'cli', text: '待确认任务',
    requestId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', createdAt: Date.now(), attempted: true, safeRetry: true });
  const view = await render(viewThread()); await fireEvent.press(view.getByLabelText('更多'));
  const cancel = mockDialogActions.get('已核对，停止重发')!, open = mockDialogActions.get('在电脑的 Codex 里打开')!, retryOriginal = mockDialogActions.get('重试原消息')!;
  expect(typeof cancel).toBe('function'); expect(typeof open).toBe('function');
  expect(typeof retryOriginal).toBe('function');
  mockDeliveryScope = 'paired|renewed'; await view.rerender(viewThread());
  await act(async () => { cancel(); open(); retryOriginal(); });
  expect(mockCancelPending).not.toHaveBeenCalled(); expect(mockOpenDesktop).not.toHaveBeenCalled(); expect(mockSend).not.toHaveBeenCalled();
});

test('an expired native lease cannot silently turn the same screen into a background sender', async () => {
  mockRemote.agents.pc.list = [{ ...originalAgent, desktopLive: { expiresAt: Date.now() + 60000, sessionKeys: ['codex:original'], capabilities: desktopCapabilities } }];
  const view = await render(viewThread()); expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(false);
  mockRemote.agents.pc.list[0].desktopLive!.expiresAt = Date.now() - 1;
  await view.rerender(viewThread()); await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).not.toHaveBeenCalled(); expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  // Local draft/history tools remain available; they do not grant a new native lease.
  await fireEvent.press(view.getByRole('button', { name: '添加到对话' }));
  expect(view.getByRole('button', { name: '添加本地文件' })).toBeEnabled();
  expect(view.getByRole('button', { name: '从相册选择' })).toBeDisabled();
  expect(view.getByRole('button', { name: '拍照' })).toBeDisabled();
  await fireEvent.press(view.getByRole('button', { name: '从相册选择' }));
  expect(mockPickImages).not.toHaveBeenCalled(); expect(mockSend).not.toHaveBeenCalled();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
  await view.unmount();
});

test('earlier-history action reads the same thread without moving the scroll to the live tail', async () => {
  mockRemote.timelines['pc|codex:original'].nextCursor = 'older';
  const view = await render(viewThread()); await fireEvent.press(view.getByLabelText('加载更早记录'));
  expect(mockLoadEarlier).toHaveBeenCalledWith('pc', 'codex:original', expect.any(Object)); expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
});

test('backgrounding cancels the first history read and foreground retries without resetting the draft', async () => {
  let release!: () => void;
  const pending = new Promise<undefined>(resolve => { release = () => resolve(undefined); });
  mockOpen.mockImplementationOnce(() => pending);
  const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '未发送的文字');
  const signal = (mockOpen.mock.calls[0][2] as { signal: AbortSignal }).signal;
  const listeners = (AppState.addEventListener as jest.Mock).mock.calls.map((call) => call[1] as (state: string) => void);
  await act(async () => { jest.replaceProperty(AppState, 'currentState', 'background'); listeners.forEach(change => change('background')); });
  expect(signal.aborted).toBe(true);
  await act(async () => { release(); await pending; });
  await act(async () => { jest.replaceProperty(AppState, 'currentState', 'active'); listeners.forEach(change => change('active')); });
  expect(mockOpen).toHaveBeenCalledTimes(2);
  expect((mockOpen.mock.calls[1][2] as { signal: AbortSignal }).signal.aborted).toBe(false);
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('未发送的文字');
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
});

test.each(['inactive', 'background'] as const)('entering %s commits the latest composer before its debounce and restores it after remount', async next => {
  let durable: ComposerDraft | undefined;
  mockComposerSave.mockImplementation(async (_key, scope, draft) => {
    durable = { ...draft, scope, revision: 1, identity: '0199aaa1-1234-4678-9abc-000000000001', imageCount: draft.imageCount ?? draft.images.length };
    return durable;
  });
  mockComposerRestore.mockImplementation(async () => durable);
  const image = { uri: 'file://picker/latest.jpg', mime: 'image/jpeg' as const, width: 40, height: 40, base64: 'latest-bytes' };
  const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '锁屏前最后输入');
  mockPickImages.mockResolvedValueOnce([image]);
  await fireEvent.press(view.getByRole('button', { name: '添加到对话' })); await fireEvent.press(view.getByLabelText('从相册选择'));
  expect(mockComposerSave).not.toHaveBeenCalled();
  const listeners = (AppState.addEventListener as jest.Mock).mock.calls.map(call => call[1] as (state: string) => void);
  await act(async () => { jest.replaceProperty(AppState, 'currentState', next); listeners.forEach(change => change(next)); });
  expect(durable).toMatchObject({ text: '锁屏前最后输入', images: [image] });
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
  // Capture the durable snapshot before cleanup: process termination does not
  // run an unmount callback, so the background transition must already own it.
  const beforeTermination = durable;
  await view.unmount();
  durable = beforeTermination;
  jest.replaceProperty(AppState, 'currentState', 'active');
  const reopened = await render(viewThread());
  expect(reopened.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('锁屏前最后输入');
  expect(reopened.getAllByLabelText(/^移除待发送图片 /)).toHaveLength(1);
  await reopened.unmount();
});

test('a failed background draft commit preserves visible input and retries after foreground without sending', async () => {
  mockComposerSave.mockRejectedValueOnce(new Error('synthetic disk full'));
  const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '尚未成功落盘');
  const listeners = (AppState.addEventListener as jest.Mock).mock.calls.map(call => call[1] as (state: string) => void);
  await act(async () => { jest.replaceProperty(AppState, 'currentState', 'background'); listeners.forEach(change => change('background')); });
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('尚未成功落盘');
  expect(view.getByText(/草稿尚未保存.*synthetic disk full/)).toBeTruthy();
  await act(async () => { jest.replaceProperty(AppState, 'currentState', 'active'); listeners.forEach(change => change('active')); jest.advanceTimersByTime(400); });
  await act(async () => { jest.advanceTimersByTime(400); });
  expect(mockComposerSave).toHaveBeenLastCalledWith(expect.any(String), mockDeliveryScope, expect.objectContaining({ text: '尚未成功落盘' }));
  expect(view.queryByText(/草稿尚未保存/)).toBeNull();
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
  await view.unmount();
});

test('backgrounding an admitted submission does not save over its frozen draft receipt', async () => {
  let complete!: () => void;
  mockSend.mockImplementationOnce(() => new Promise(resolve => { complete = () => resolve(undefined); }));
  const view = await render(viewThread()); await fireEvent.press(view.getByLabelText('发送'));
  const saves = mockComposerSave.mock.calls.length;
  const listeners = (AppState.addEventListener as jest.Mock).mock.calls.map(call => call[1] as (state: string) => void);
  await act(async () => { jest.replaceProperty(AppState, 'currentState', 'background'); listeners.forEach(change => change('background')); });
  expect(mockComposerSave).toHaveBeenCalledTimes(saves);
  expect(mockSend).toHaveBeenCalledTimes(1);
  await act(async () => { complete(); }); await view.unmount();
});

test('a draft restore finishing in background commits text typed before restoration without waiting for timers', async () => {
  let restore!: (value: ComposerDraft) => void;
  mockComposerRestore.mockImplementationOnce(() => new Promise(resolve => { restore = resolve; }));
  const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '读取旧草稿时的新编辑');
  const listeners = (AppState.addEventListener as jest.Mock).mock.calls.map(call => call[1] as (state: string) => void);
  await act(async () => { jest.replaceProperty(AppState, 'currentState', 'background'); listeners.forEach(change => change('background')); });
  expect(mockComposerSave).not.toHaveBeenCalled();
  await act(async () => { restore({ scope: mockDeliveryScope, text: '旧输入', revision: 1, images: [], imageCount: 0 }); });
  expect(mockComposerSave).toHaveBeenCalledWith(expect.any(String), mockDeliveryScope, expect.objectContaining({ text: '读取旧草稿时的新编辑' }));
  expect(mockSend).not.toHaveBeenCalled(); await view.unmount();
});

test('a pending receipt retains its identity while its notice receives a fresh foreground grace', async () => {
  const requestId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', createdAt = Date.now();
  mockPending.mockResolvedValue({ scope: mockDeliveryScope, deviceId: 'pc', sessionKey: 'codex:original', surface: 'cli', text: '等待原回执',
    requestId, createdAt, firstAttemptAt: createdAt, lastObservedAt: createdAt, attempted: true, safeRetry: true });
  const view = await render(viewThread());
  const listeners = (AppState.addEventListener as jest.Mock).mock.calls.map(call => call[1] as (state: string) => void);
  await act(async () => { jest.replaceProperty(AppState, 'currentState', 'inactive'); listeners.forEach(change => change('inactive')); });
  await act(async () => { jest.advanceTimersByTime(10 * 60_000); });
  expect(view.queryByText('等待送达确认 · 自动重试')).toBeNull();
  await act(async () => { jest.replaceProperty(AppState, 'currentState', 'active'); listeners.forEach(change => change('active')); });
  expect(view.queryByText('等待送达确认 · 自动重试')).toBeNull();
  await act(async () => { jest.advanceTimersByTime(REMOTE_STATUS_NOTICE_DELAY_MS - 1); });
  expect(view.queryByText('等待送达确认 · 自动重试')).toBeNull();
  await act(async () => { jest.advanceTimersByTime(1); });
  expect(view.getByText('等待送达确认 · 自动重试')).toBeTruthy();
  expect(mockCancelPending).not.toHaveBeenCalled(); expect(mockSend).not.toHaveBeenCalled();
  await view.unmount();
});

test('a definite history denial remains visible immediately after foreground returns', async () => {
  mockRemote.timelines['pc|codex:original'].error = '当前配对没有读取权限';
  const view = await render(viewThread());
  expect(view.getByText('当前配对没有读取权限，显示的是上次的记录')).toBeTruthy();
  const listeners = (AppState.addEventListener as jest.Mock).mock.calls.map(call => call[1] as (state: string) => void);
  await act(async () => { jest.replaceProperty(AppState, 'currentState', 'background'); listeners.forEach(change => change('background')); });
  expect(view.queryByText('当前配对没有读取权限，显示的是上次的记录')).toBeNull();
  await act(async () => { jest.replaceProperty(AppState, 'currentState', 'active'); listeners.forEach(change => change('active')); });
  expect(view.getByText('当前配对没有读取权限，显示的是上次的记录')).toBeTruthy();
  await view.unmount();
});

test.each(['offline', 'history'] as const)('a long background interval gives %s warnings and retry progress a fresh foreground grace', async kind => {
  if (kind === 'offline') mockRemote.devices[0].online = false;
  else mockRemote.timelines['pc|codex:original'].error = 'Network request failed';
  const view = await render(viewThread());
  await act(async () => { jest.advanceTimersByTime(5_000); });
  const listeners = (AppState.addEventListener as jest.Mock).mock.calls.map(call => call[1] as (state: string) => void);
  await act(async () => { jest.replaceProperty(AppState, 'currentState', 'background'); listeners.forEach(change => change('background')); });
  await act(async () => { jest.advanceTimersByTime(10 * 60_000); });
  expect(view.queryByTestId('conversation-sync-notice')).toBeNull();
  expect(view.queryByLabelText('正在重试连接')).toBeNull();
  await act(async () => { jest.replaceProperty(AppState, 'currentState', 'active'); listeners.forEach(change => change('active')); });
  expect(view.queryByText(/显示的是上次的记录/)).toBeNull();
  expect(view.queryByTestId('conversation-sync-notice')).toBeNull();
  await act(async () => { jest.advanceTimersByTime(REMOTE_RETRY_INDICATOR_DELAY_MS - 1); });
  expect(view.queryByLabelText('正在重试连接')).toBeNull();
  await act(async () => { jest.advanceTimersByTime(1); });
  if (kind === 'history') expect(view.getByLabelText('正在重试连接')).toBeTruthy();
  await act(async () => { jest.advanceTimersByTime(REMOTE_STATUS_NOTICE_DELAY_MS - REMOTE_RETRY_INDICATOR_DELAY_MS - 1); });
  expect(view.queryByText(/显示的是上次的记录/)).toBeNull();
  await act(async () => { jest.advanceTimersByTime(1); });
  if (kind === 'history') expect(view.getByText(/显示的是上次的记录/)).toBeTruthy();
  else expect(view.getByTestId('conversation-sync-notice')).toBeTruthy();
  await view.unmount();
});

test('an initially backgrounded thread defers its first history read until foreground', async () => {
  jest.replaceProperty(AppState, 'currentState', 'background');
  const view = await render(viewThread());
  expect(mockOpen).not.toHaveBeenCalled();
  const listeners = (AppState.addEventListener as jest.Mock).mock.calls.map((call) => call[1] as (state: string) => void);
  await act(async () => { jest.replaceProperty(AppState, 'currentState', 'active'); listeners.forEach(change => change('active')); });
  expect(mockOpen).toHaveBeenCalledTimes(1);
  await view.unmount();
});

test('backgrounding cancels an earlier-history read as well as the initial snapshot', async () => {
  mockRemote.timelines['pc|codex:original'].nextCursor = 'older';
  mockLoadEarlier.mockImplementationOnce(() => new Promise(() => undefined));
  const view = await render(viewThread()); await fireEvent.press(view.getByLabelText('加载更早记录'));
  const signal = mockLoadEarlier.mock.calls[0][2] as AbortSignal;
  const listeners = (AppState.addEventListener as jest.Mock).mock.calls.map((call) => call[1] as (state: string) => void);
  await act(async () => { jest.replaceProperty(AppState, 'currentState', 'background'); listeners.forEach(change => change('background')); });
  expect(signal.aborted).toBe(true);
  await view.unmount();
});

test('native Claude readonly history shows its original replies without composer, models, stop or approval actions', async () => {
  const key = 'claude-desktop:local_0199aaa1-1234-4678-9abc-000000000001';
  mockRemote.timelines[`pc|${key}`] = { items: [oldReply], loading: false, session: { ...originalSession, sessionKey: key, tool: 'claude', client: 'Claude Desktop', controlSurface: 'read-only', controllable: false, sessionScope: 'desktop-chat' } };
  const view = await render(<ThreadView visible deviceId="pc" sessionKey={key} agent={originalAgent} onClose={jest.fn()} onCreated={jest.fn()} />);
  expect(view.getByText('原来的回复')).toBeTruthy(); expect(view.getByTestId('remote-readonly-footer')).toBeTruthy();
  expect(view.queryByLabelText('发送')).toBeNull(); expect(view.queryByLabelText('给电脑上的 Agent 发消息')).toBeNull();
  expect(view.queryByLabelText('停止')).toBeNull(); expect(mockListModels).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled(); expect(mockRespond).not.toHaveBeenCalled();
});

const newTaskReceipt = (): PendingDelivery & { composerDraft?: { key: string; revision: number; identity?: string } } => ({
  scope: mockDeliveryScope, deviceId: 'pc', sessionKey: 'codex:new-task-cli', surface: 'cli', text: '原来待确认的新任务',
  requestId: '0199aaa1-1234-4678-9abc-000000000009', createdAt: Date.now(), attempted: true, safeRetry: true,
  composerDraft: { key: `${mockDeliveryScope}|pc|new:codex:code:${encodeURIComponent(originalSession.cwd)}`, revision: 7, identity: '0199aaa1-1234-4678-9abc-000000000001' },
});
const newTaskView = (created = jest.fn(), visible = true, agent = originalAgent) => {
  // These receipt scenarios own the fixture project. The empty-directory
  // scenario below uses ThreadView directly and must not restore a draft.
  if (!mockRemote.devices[0].projects?.length) mockRemote.devices[0].projects = [{ path: originalSession.cwd, name: 'fixture' }];
  return <ThreadView visible={visible} deviceId="pc" sessionKey={null} newProjectPath={originalSession.cwd} agent={agent} onClose={jest.fn()} onCreated={created} />;
};
const openNewTaskMenu = async (view: Awaited<ReturnType<typeof render>>) => {
  await act(async () => { jest.advanceTimersByTime(REMOTE_STATUS_NOTICE_DELAY_MS); });
  await fireEvent.press(view.getByText(deliveryRetryState(newTaskReceipt()).message));
};

test('legacy new-task acceptance without draft identity preserves local edits instead of guessing by revision', async () => {
  const receipt = newTaskReceipt(); delete receipt.composerDraft!.identity;
  mockPendingNew.mockResolvedValue(receipt);
  mockComposerRestore.mockResolvedValue({ scope: mockDeliveryScope, revision: 7, identity: '0199aaa1-1234-4678-9abc-000000000002', text: 'new local draft', images: [], imageCount: 0 });
  const created = jest.fn(), view = await render(newTaskView(created));
  await openNewTaskMenu(view); await fireEvent.press(view.getByLabelText('重试原消息'));
  expect(created).toHaveBeenCalledWith('codex:recovered'); expect(mockComposerConsume).not.toHaveBeenCalled();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('new local draft');
});

test('new composer waits for its durable new-task receipt read and keeps a read failure blocked', async () => {
  mockRemote.devices[0].projects = [{ path: 'C:\\fixture', name: 'fixture' }];
  mockPendingNew.mockRejectedValue(new Error('synthetic receipt read failure'));
  const view = await render(newTaskView());
  expect(mockPendingNew).toHaveBeenCalledWith('pc', 'codex', false);
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockStart).not.toHaveBeenCalled(); expect(mockRetryNew).not.toHaveBeenCalled();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
});

test('new composer cannot send before a delayed receipt read proves no prior task', async () => {
  mockRemote.devices[0].projects = [{ path: 'C:\\fixture', name: 'fixture' }];
  let finish!: () => void;
  mockPendingNew.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(undefined); }));
  const view = await render(newTaskView());
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  await act(async () => { mockSendSubmit.current!(); });
  expect(mockStart).not.toHaveBeenCalled();
  await act(async () => { finish(); });
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(false);
});

test('an old delayed new-task receipt read cannot enable a renewed pairing after its own read fails', async () => {
  mockRemote.devices[0].projects = [{ path: 'C:\\fixture', name: 'fixture' }];
  let finish!: () => void;
  mockPendingNew.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(undefined); }))
    .mockRejectedValueOnce(new Error('synthetic new pairing read failure'));
  const view = await render(newTaskView());
  mockDeliveryScope = 'paired|renewed'; await view.rerender(newTaskView());
  await act(async () => { finish(); });
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  expect(mockStart).not.toHaveBeenCalled(); expect(mockRetryNew).not.toHaveBeenCalled();
});

test('new-task restoration exposes the existing pending menu but never automatically starts or retries', async () => {
  mockRemote.devices[0].projects = [{ path: 'C:\\fixture', name: 'fixture' }];
  mockPendingNew.mockResolvedValue(newTaskReceipt());
  const created = jest.fn(), view = await render(newTaskView(created));
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  await act(async () => { jest.advanceTimersByTime(180_000); });
  expect(mockStart).not.toHaveBeenCalled(); expect(mockRetryNew).not.toHaveBeenCalled(); expect(created).not.toHaveBeenCalled();
  await openNewTaskMenu(view);
  expect(view.getByLabelText('重试原消息')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('已核对，停止重发'));
  expect(mockCancelPending).toHaveBeenCalledWith('pc', 'codex:new-task-cli', mockDeliveryScope);
});

test('unknown new-task response blocks a fresh UUID and manual retry navigates to the original accepted task', async () => {
  mockRemote.devices[0].projects = [{ path: 'C:\\fixture', name: 'fixture' }];
  const receipt = newTaskReceipt(); receipt.composerDraft!.revision = 1;
  mockPendingNew.mockResolvedValueOnce(undefined).mockResolvedValue(receipt);
  mockStart.mockRejectedValueOnce(new DeliveryPendingError('synthetic unknown acceptance', true, receipt.requestId, true));
  const created = jest.fn(), view = await render(newTaskView(created));
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockStart).toHaveBeenCalledTimes(1); expect(created).not.toHaveBeenCalled();
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
  await openNewTaskMenu(view); await fireEvent.press(view.getByLabelText('重试原消息'));
  expect(mockRetryNew).toHaveBeenCalledWith('pc', 'codex', false, receipt.requestId);
  expect(mockStart).toHaveBeenCalledTimes(1); expect(mockSend).not.toHaveBeenCalled();
  expect(created).toHaveBeenCalledTimes(1); expect(created).toHaveBeenCalledWith('codex:recovered');
  expect(mockComposerConsume).toHaveBeenCalledWith(`${mockDeliveryScope}|pc|new:codex:code:${encodeURIComponent(originalSession.cwd)}`, mockDeliveryScope, 1, '0199aaa1-1234-4678-9abc-000000000001');
});

test('restored new-task retry preserves a newer edited draft and uses only the receipt original version', async () => {
  mockRemote.devices[0].projects = [{ path: originalSession.cwd, name: 'fixture' }];
  const receipt = newTaskReceipt(); mockPendingNew.mockResolvedValue(receipt);
  mockComposerRestore.mockResolvedValue({ scope: mockDeliveryScope, revision: 8, text: '较新的草稿', images: [], imageCount: 0 });
  mockComposerSave.mockImplementation(async (_key, scope, draft) => ({ ...draft, scope, revision: 9, imageCount: draft.images.length }));
  mockComposerConsume.mockResolvedValue(false);
  const created = jest.fn(), view = await render(newTaskView(created));
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '等待确认期间的新编辑');
  await openNewTaskMenu(view); await fireEvent.press(view.getByLabelText('重试原消息'));
  expect(created).toHaveBeenCalledWith('codex:recovered');
  expect(mockComposerConsume).toHaveBeenCalledWith(`${mockDeliveryScope}|pc|new:codex:code:${encodeURIComponent(originalSession.cwd)}`, mockDeliveryScope, 7, '0199aaa1-1234-4678-9abc-000000000001');
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('等待确认期间的新编辑');
  expect(mockComposerSave).toHaveBeenCalledWith(`${mockDeliveryScope}|pc|new:codex:code:${encodeURIComponent(originalSession.cwd)}`, mockDeliveryScope,
    expect.objectContaining({ text: '等待确认期间的新编辑' }));
  expect(mockAcknowledgeNew).not.toHaveBeenCalled();
});

test('accepted new-task acknowledgement waits for original CAS cleanup but survives same-pair navigation', async () => {
  mockRemote.devices[0].projects = [{ path: 'C:\\fixture', name: 'fixture' }];
  const originalScope = mockDeliveryScope;
  let finish!: (consumed: boolean) => void;
  mockComposerConsume.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const created = jest.fn(), view = await render(newTaskView(created));
  await act(async () => { fireEvent.press(view.getByLabelText('发送')); });
  expect(created).toHaveBeenCalledWith('codex:new');
  expect(mockAcknowledgeNew).not.toHaveBeenCalled();
  await view.rerender(viewThread(created));
  await act(async () => { finish(true); });
  expect(mockSaveDraft).toHaveBeenCalledWith(`${originalScope}|pc|new:codex:code:${encodeURIComponent(originalSession.cwd)}`, '', originalScope);
  expect(mockAcknowledgeNew).toHaveBeenCalledWith('pc', 'codex', false, 'codex:new', originalScope);
  expect(mockAcknowledgeNew).toHaveBeenCalledTimes(1);
});

test('accepted new-task local cleanup failure does not acknowledge or prevent navigation', async () => {
  mockRemote.devices[0].projects = [{ path: 'C:\\fixture', name: 'fixture' }];
  mockComposerConsume.mockRejectedValueOnce(new Error('synthetic original draft cleanup failure'));
  const created = jest.fn(), view = await render(newTaskView(created));
  await fireEvent.press(view.getByLabelText('发送'));
  expect(created).toHaveBeenCalledWith('codex:new');
  expect(mockAcknowledgeNew).not.toHaveBeenCalled();
  expect(mockStart).toHaveBeenCalledTimes(1);
});

test('accepted new-task cleanup cannot acknowledge a renewed pairing', async () => {
  mockRemote.devices[0].projects = [{ path: 'C:\\fixture', name: 'fixture' }];
  let finish!: (consumed: boolean) => void;
  mockComposerConsume.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const created = jest.fn(), view = await render(newTaskView(created));
  await act(async () => { fireEvent.press(view.getByLabelText('发送')); });
  expect(created).toHaveBeenCalledWith('codex:new');
  mockDeliveryScope = 'paired|new-owner';
  await view.rerender(newTaskView(created));
  await act(async () => { finish(true); });
  expect(mockAcknowledgeNew).not.toHaveBeenCalled();
});

test('accepted new-task cannot consume its old draft after preserving a newer edit fails', async () => {
  mockRemote.devices[0].projects = [{ path: 'C:\\fixture', name: 'fixture' }];
  let accepted!: (key: string) => void;
  mockStart.mockReturnValueOnce(new Promise(resolve => { accepted = resolve; }));
  const created = jest.fn(), view = await render(newTaskView(created));
  await act(async () => { fireEvent.press(view.getByLabelText('发送')); });
  const delayedChange = view.getByLabelText('给电脑上的 Agent 发消息').props.onChangeText as (text: string) => void;
  await act(async () => { delayedChange('新编辑必须保留'); });
  mockComposerSave.mockRejectedValueOnce(new Error('synthetic preservation failure'));
  await act(async () => { accepted('codex:original-accepted'); });
  expect(created).toHaveBeenCalledWith('codex:original-accepted');
  expect(mockComposerConsume).not.toHaveBeenCalled();
  expect(mockAcknowledgeNew).not.toHaveBeenCalled();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('新编辑必须保留');
});

test('a late accepted new-task response cannot clear newer edits in the same mounted composer', async () => {
  mockRemote.devices[0].projects = [{ path: 'C:\\fixture', name: 'fixture' }];
  let accepted!: (key: string) => void;
  mockStart.mockReturnValueOnce(new Promise(resolve => { accepted = resolve; }));
  let revision = 0;
  mockComposerSave.mockImplementation(async (_key, scope, draft) => ({ ...draft, scope, revision: ++revision, identity: '0199aaa1-1234-4678-9abc-000000000001', imageCount: draft.images.length }));
  mockComposerConsume.mockResolvedValue(false);
  const created = jest.fn(), view = await render(newTaskView(created));
  await act(async () => { fireEvent.press(view.getByLabelText('发送')); });
  expect(mockStart).toHaveBeenCalledWith('pc', expect.objectContaining({ composerDraft: { key: `${mockDeliveryScope}|pc|new:codex:code:${encodeURIComponent(originalSession.cwd)}`, revision: 1, identity: '0199aaa1-1234-4678-9abc-000000000001' } }));
  // A queued native change event can arrive after editable=false; verify the
  // handler remains safe without relying only on the visible disabled flag.
  const delayedChange = view.getByLabelText('给电脑上的 Agent 发消息').props.onChangeText as (text: string) => void;
  await act(async () => { delayedChange('较晚的新草稿'); });
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('较晚的新草稿');
  await act(async () => { accepted('codex:accepted-original'); });
  expect(created).toHaveBeenCalledTimes(1); expect(created).toHaveBeenCalledWith('codex:accepted-original');
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('较晚的新草稿');
  expect(mockComposerSave).toHaveBeenCalledWith(`${mockDeliveryScope}|pc|new:codex:code:${encodeURIComponent(originalSession.cwd)}`, mockDeliveryScope, expect.objectContaining({ text: '较晚的新草稿' }));
  expect(mockComposerConsume).toHaveBeenCalledWith(`${mockDeliveryScope}|pc|new:codex:code:${encodeURIComponent(originalSession.cwd)}`, mockDeliveryScope, 1, '0199aaa1-1234-4678-9abc-000000000001');
});

test('new-task retry checks foreground again after slow local draft preservation', async () => {
  mockRemote.devices[0].projects = [{ path: originalSession.cwd, name: 'fixture' }];
  mockPendingNew.mockResolvedValue(newTaskReceipt());
  const view = await render(newTaskView());
  await act(async () => { jest.advanceTimersByTime(REMOTE_STATUS_NOTICE_DELAY_MS); });
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '保留这个新编辑');
  let finish!: () => void;
  mockComposerSave.mockImplementationOnce(async (_key, scope, draft) => {
    await new Promise<void>(resolve => { finish = resolve; });
    return { ...draft, scope, revision: 9, imageCount: draft.images.length };
  });
  await fireEvent.press(view.getByText(deliveryRetryState(newTaskReceipt()).message));
  await act(async () => { fireEvent.press(view.getByLabelText('重试原消息')); });
  expect(mockRetryNew).not.toHaveBeenCalled();
  await act(async () => { jest.replaceProperty(AppState, 'currentState', 'background'); finish(); });
  expect(mockRetryNew).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('保留这个新编辑');
});

test('captured double new-task retries cannot run two transport calls before React commits sending', async () => {
  mockPendingNew.mockResolvedValue(newTaskReceipt());
  let finish!: (key: string) => void;
  mockRetryNew.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const created = jest.fn(), view = await render(newTaskView(created));
  await openNewTaskMenu(view); const retry = mockDialogActions.get('重试原消息')!;
  await act(async () => { retry(); retry(); });
  expect(mockRetryNew).toHaveBeenCalledTimes(1); expect(mockStart).not.toHaveBeenCalled();
  await act(async () => { finish('codex:recovered'); });
  expect(created).toHaveBeenCalledTimes(1);
});

test('an expired but durably accepted new-task receipt supports manual local recovery while its computer is offline', async () => {
  const receipt = { ...newTaskReceipt(), acceptedSessionKey: 'codex:recovered', createdAt: Date.now() - 10 * 86_400_000,
    firstAttemptAt: Date.now() - 10 * 86_400_000, reviewReason: 'expired' as const, uncertain: true };
  expect(deliveryRetryState(receipt).retryable).toBe(false);
  mockPendingNew.mockResolvedValue(receipt); mockRemote.devices[0].online = false;
  const created = jest.fn(), view = await render(newTaskView(created));
  await fireEvent.press(view.getByText('消息已送达，手机确认记录未能清理，请先核对原会话'));
  await fireEvent.press(view.getByLabelText('重试原消息'));
  expect(mockRetryNew).toHaveBeenCalledWith('pc', 'codex', false, receipt.requestId);
  expect(created).toHaveBeenCalledWith('codex:recovered');
  expect(mockStart).not.toHaveBeenCalled(); expect(mockSend).not.toHaveBeenCalled();
});

test('manual local accepted recovery still cannot cross renewed pairing or background fences', async () => {
  mockPendingNew.mockResolvedValue({ ...newTaskReceipt(), acceptedSessionKey: 'codex:recovered' });
  mockRemote.devices[0].online = false;
  const created = jest.fn(), view = await render(newTaskView(created));
  await fireEvent.press(view.getByText('消息已送达，手机确认记录未能清理，请先核对原会话'));
  const retry = mockDialogActions.get('重试原消息')!;
  await act(async () => { jest.replaceProperty(AppState, 'currentState', 'background'); retry(); });
  expect(mockRetryNew).not.toHaveBeenCalled();
  jest.replaceProperty(AppState, 'currentState', 'active'); mockDeliveryScope = 'paired|renewed';
  await view.rerender(newTaskView(created)); await act(async () => { retry(); });
  expect(mockRetryNew).not.toHaveBeenCalled(); expect(created).not.toHaveBeenCalled();
});

test.each(['background', 'pairing', 'hide'] as const)('captured new-task retry is rejected after %s instead of running in a new owner', async change => {
  mockPendingNew.mockResolvedValue(newTaskReceipt()); const created = jest.fn(), view = await render(newTaskView(created));
  await openNewTaskMenu(view); const retry = mockDialogActions.get('重试原消息')!;
  expect(typeof retry).toBe('function');
  if (change === 'background') jest.replaceProperty(AppState, 'currentState', 'background');
  else if (change === 'pairing') { mockDeliveryScope = 'paired|renewed'; await view.rerender(newTaskView(created)); }
  else await view.rerender(newTaskView(created, false));
  await act(async () => { retry(); });
  expect(mockRetryNew).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled(); expect(created).not.toHaveBeenCalled();
});

test('new Claude Desktop receipt ownership is separate from Claude Code', async () => {
  const desktop: AgentProfile = { ...originalAgent, id: 'claude-desktop', name: 'Claude Desktop', tool: 'claude', api: { ...originalAgent.api, source: 'tool' } };
  mockRemote.agents.pc.list = [desktop];
  await render(newTaskView(jest.fn(), true, desktop));
  expect(mockPendingNew).toHaveBeenCalledWith('pc', 'claude', true);
  expect(mockPendingNew).not.toHaveBeenCalledWith('pc', 'claude', false);
});

test('Continue controls the same verified Codex session and does not call ordinary send', async () => {
  const capabilities = { list: true, read: true, send: true, interrupt: true, preciseInterrupt: true, continue: true, approval: false,
    questions: false, subagents: true, attachments: false, imageInput: false, imageOutput: true, modelOverride: true };
  mockRemote.agents.pc.list = [{ ...originalAgent, capabilities }];
  setItems([{ kind: 'turn', id: 'turn:terminal:terminal', turnId: 'turn-terminal', status: 'completed', ts: 2, seq: 2, orderSeq: 2 }],
    { ...originalSession, status: 'idle', lastTerminalTurnId: 'turn-terminal' });
  mockRemote.timelines['pc|codex:original'].snapshotAt = Date.now();
  mockComposerRestore.mockResolvedValue({ scope: 'paired|fixture-credential', text: '', images: [], revision: 1, imageCount: 0 });
  const view = await render(viewThread());
  expect(view.getByLabelText('继续')).toBeTruthy();
  await act(async () => { fireEvent.press(view.getByLabelText('继续')); });
  expect(mockContinue).toHaveBeenCalledWith('pc', 'codex:original', expect.objectContaining({ accountId: 'api_original' }));
  expect(mockSend).not.toHaveBeenCalled();
});

test('an old Codex conversation chooses a next-message permission without pretending the current host policy changed', async () => {
  enablePermissionModes(); setItems([], { ...originalSession, permissionMode: 'ask' });
  const view = await render(viewThread());
  await fireEvent.press(view.getByLabelText('请求批准'));
  await fireEvent.press(view.getByText('帮我批准'));
  expect(mockSend).not.toHaveBeenCalled(); expect(mockRemote.timelines['pc|codex:original'].session?.permissionMode).toBe('ask');
  expect(view.getByLabelText('帮我批准')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ permissionMode: 'auto_review' }));
  expect(view.getByLabelText('请求批准')).toBeTruthy();
});

test.each(['claude', 'claude-desktop'] as const)('%s composer transmits native approval only after explicit idle selection', async id => {
  const capabilities: AgentCapabilities = { list: true, read: true, send: true, interrupt: true, approval: true, questions: true,
    subagents: true, attachments: true, imageInput: true, imageOutput: true, modelOverride: true, continue: true,
    approvalModes: ['ask', 'auto_edits', 'auto_all'] };
  const agent: AgentProfile = { ...originalAgent, id, tool: 'claude', name: id === 'claude' ? 'Claude Code' : 'Claude Desktop', capabilities,
    api: { ...originalAgent.api, accountId: 'api_aaaaaaaa' } };
  const session: SessionInfo = { ...originalSession, sessionKey: 'claude:fixture', tool: 'claude', client: agent.name, approvalMode: 'ask' };
  mockRemote.agents.pc.list = [agent]; mockRemote.agents.pc.autoAll = true;
  mockRemote.sessions.pc.list = [session];
  mockRemote.timelines = { 'pc|claude:fixture': { items: [], loading: false, snapshotAt: Date.now(), session } };
  const renderThread = () => <ThreadView visible deviceId="pc" sessionKey={session.sessionKey} agent={agent} onClose={jest.fn()} onCreated={jest.fn()} />;
  const view = await render(renderThread());
  await fireEvent.press(view.getByLabelText('每步询问'));
  await fireEvent.press(view.getByText('全部自动'));
  expect(mockSend).not.toHaveBeenCalled(); expect(session.approvalMode).toBe('ask');
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), 'explicit native choice');
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', session.sessionKey, 'explicit native choice', expect.objectContaining({ approval: 'auto_all', permissionMode: undefined }));
  expect(view.getByLabelText('每步询问')).toBeTruthy();
  mockRemote.timelines['pc|claude:fixture'].session = { ...session, status: 'running', activeTurnId: 'active' };
  await view.rerender(renderThread());
  expect(view.getByLabelText('每步询问').props.accessibilityState.disabled).toBe(true);
});

test('old untouched and native desktop sessions do not send a permission override', async () => {
  enablePermissionModes(); const view = await render(viewThread());
  expect(view.getByLabelText('权限')).toBeTruthy(); await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend.mock.calls[0][3]).toEqual(expect.objectContaining({ permissionMode: undefined }));
  await view.unmount(); mockSend.mockClear();
  setItems([], { ...originalSession, controlSurface: 'desktop' });
  mockRemote.agents.pc.list[0].desktopLive = { expiresAt: Date.now() + 60000, sessionKeys: ['codex:original'], capabilities: desktopCapabilities };
  const native = await render(viewThread());
  expect(native.getByLabelText('权限').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(native.getByLabelText('发送'));
  expect(mockSend.mock.calls[0][3]).toEqual(expect.objectContaining({ permissionMode: undefined, surface: 'desktop' }));
});

test('new Codex tasks show Request approval by default and all three negotiated choices', async () => {
  enablePermissionModes(); const view = await render(newTaskView(jest.fn()));
  await fireEvent.press(view.getByLabelText('请求批准'));
  expect(view.getByRole('radio', { name: '请求批准' })).toBeTruthy(); expect(view.getByText('帮我批准')).toBeTruthy(); expect(view.getByText('完全访问权限')).toBeTruthy();
  expect(mockStart).not.toHaveBeenCalled();
});

test('missing desktop full-access consent disables Full access without changing legacy auto-edits semantics', async () => {
  enablePermissionModes(); mockRemote.agents.pc.autoAll = undefined;
  const view = await render(viewThread()); await fireEvent.press(view.getByLabelText('权限'));
  const option = view.getByRole('radio', { name: /完全访问权限/ });
  expect(option.props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(option); expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
});

test('a removed host confirmation clears the old permission label', async () => {
  enablePermissionModes(); setItems([], { ...originalSession, permissionMode: 'full_access' });
  const view = await render(viewThread()); expect(view.getByLabelText('完全访问权限')).toBeTruthy();
  setItems([], originalSession); await view.rerender(viewThread());
  expect(view.queryByLabelText('完全访问权限')).toBeNull(); expect(view.getByLabelText('权限')).toBeTruthy();
});

test('a queued message freezes its permission while the next composer returns to the host policy', async () => {
  enablePermissionModes(); setItems([{ kind: 'turn', id: 'busy', turnId: 'busy', status: 'started', ts: 1 }], { ...originalSession, status: 'running' });
  const view = await render(viewThread()); await fireEvent.press(view.getByLabelText('权限'));
  await fireEvent.press(view.getByText('帮我批准')); await fireEvent.press(view.getByLabelText('排队发送'));
  expect(mockSaveQueued).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining([expect.objectContaining({ sendOptions: expect.objectContaining({ permissionMode: 'auto_review' }) })]));
  expect(view.getByLabelText('权限')).toBeTruthy(); expect(mockSend).not.toHaveBeenCalled();
});

test('negotiated native model selection uses the applied desktop source without exposing API or permission overrides', async () => {
  useReportedModels(); enablePermissionModes();
  setItems([], { ...originalSession, controlSurface: 'desktop' });
  mockRemote.agents.pc.list[0].desktopLive = { expiresAt: Date.now() + 60000, sessionKeys: ['codex:original'],
    capabilities: { ...desktopCapabilities, modelOverride: true }, modelOverrideTransport: 'codex-tool-schema-v1',
    modelOptions: { model: true, thinking: ['low', 'high'] }, accountId: 'api_native', apiName: '桌面当前 API', apiModel: 'gpt-fixture' };
  const view = await render(viewThread()); await openModels(view);
  expect(mockListModels).toHaveBeenLastCalledWith('pc', 'codex', false, { controlSurface: 'desktop', sessionKey: 'codex:original' });
  expect(view.queryByTestId('remote-api-header')).toBeNull();
  await fireEvent.press(view.getByRole('radio', { name: 'gpt-fixture' })); await closeModels(view);
  expect(view.getByLabelText('Default')).toBeTruthy();
  expect(view.getByLabelText('权限').props.accessibilityState.disabled).toBe(true);
  await scrubEffort(view, 2); expect(view.getByLabelText('High')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ surface: 'desktop', accountId: 'api_native',
    model: 'gpt-fixture', effort: 'high', permissionMode: undefined }));
});

test('a native model boolean without the verified schema transport cannot open model choices', async () => {
  useReportedModels(); setItems([], { ...originalSession, controlSurface: 'desktop' });
  mockRemote.agents.pc.list = [{ ...originalAgent, api: { ...originalAgent.api } }];
  mockRemote.agents.pc.list[0].desktopLive = { expiresAt: Date.now() + 60000, sessionKeys: ['codex:original'],
    capabilities: { ...desktopCapabilities, modelOverride: true }, accountId: 'api_native' };
  const view = await render(viewThread()); await openModels(view);
  expect(mockListModels).not.toHaveBeenCalled(); expect(view.queryByRole('radio', { name: 'gpt-fixture' })).toBeNull();
  expect(view.getByLabelText('使用默认模型')).toBeTruthy();
});

test.each([false, true])('conversation title keeps Agent context without repeating its project name: new=%s', async fresh => {
  const view = await render(fresh ? newTaskView(jest.fn()) : viewThread());
  expect(view.getByTestId('remote-sheet-subtitle').props.accessibilityLabel).toBe('Codex');
  // The task still owns a cwd; removing a repeated title is not a workspace mutation.
  expect(mockRemote.timelines['pc|codex:original'].session?.cwd).toBe(originalSession.cwd);
});

test('new conversation retains the exact inherited cwd even when another project is listed first', async () => {
  mockRemote.devices[0].projects = [{ path: 'C:/Projects/Other', name: 'Other' }, { path: originalSession.cwd, name: 'fixture' }];
  const view = await render(newTaskView());
  expect(view.getByText(originalSession.cwd!)).toBeTruthy();
  expect(view.queryByText('Other')).toBeNull();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockStart).toHaveBeenCalledWith('pc', expect.objectContaining({ tool: 'codex', cwd: originalSession.cwd, prompt: '原草稿' }));
});

test('changing the applied native source resets to Follow computer without inheriting the CLI default', async () => {
  useReportedModels(); setItems([], { ...originalSession, controlSurface: 'desktop' });
  mockRemote.agents.pc.list = [{ ...originalAgent, api: { ...originalAgent.api } }];
  mockRemote.agents.pc.list[0].api.model = 'unrelated-cli-default';
  mockRemote.agents.pc.list[0].desktopLive = { expiresAt: Date.now() + 60000, sessionKeys: ['codex:original'],
    capabilities: { ...desktopCapabilities, modelOverride: true }, modelOverrideTransport: 'codex-tool-schema-v1',
    modelOptions: { model: true, thinking: ['low', 'high'] }, accountId: 'api_native', apiName: '桌面当前 API' };
  const view = await render(viewThread()); await openModels(view);
  await fireEvent.press(view.getByRole('radio', { name: 'gpt-fixture' })); await closeModels(view);
  expect(view.getByLabelText('模型：gpt-fixture')).toBeTruthy();
  mockRemote.agents.pc.list[0].desktopLive!.accountId = 'api_native_replacement';
  await view.rerender(viewThread());
  expect(view.getByLabelText('模型：选择模型')).toBeTruthy();
  expect(view.queryByLabelText('模型：unrelated-cli-default')).toBeNull();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '原草稿', expect.objectContaining({ accountId: 'api_native_replacement', model: undefined, effort: undefined }));
});


test.each([false, true])('thread menu gates session management and cooperation on the active capabilities: supported=%s', async supported => {
  mockHubSessionActions = supported;
  mockHubCooperation = supported;
  mockRemote.agents.pc.list = [{ ...originalAgent, capabilities: { sessionActions: supported, send: supported } as AgentCapabilities }];
  mockRemote.sessions.pc.list = [originalSession, { ...originalSession, sessionKey: 'codex:target', title: '目标任务' }];
  const view = await render(<ThreadView visible deviceId="pc" sessionKey="codex:original" agent={mockRemote.agents.pc.list[0]} onClose={jest.fn()} onCreated={jest.fn()} />);
  await fireEvent.press(view.getByLabelText('更多'));
  expect(view.queryByLabelText('手机别名')).toBeNull();
  if (supported) {
    await fireEvent.press(view.getByLabelText('管理会话'));
    await fireEvent.press(view.getByLabelText('重命名'));
    expect(view.getByText('重命名对话')).toBeTruthy();
    await fireEvent.press(view.getByLabelText('更多'));
    await fireEvent.press(view.getByLabelText('发送到另一任务'));
    expect(view.getByText('发送到另一任务')).toBeTruthy();
  } else expect(view.queryByLabelText('发送到另一任务')).toBeNull();
  expect(view.queryByLabelText('回复到另一任务')).toBeNull();
  if (!supported) expect(view.queryByLabelText('管理会话')).toBeNull();
});

test.each([
  { caseName: 'Hub capability missing', hub: false, send: true },
  { caseName: 'Agent send capability missing', hub: true, send: false },
])('cooperation entry stays hidden when $caseName', async ({ hub, send }) => {
  mockHubCooperation = hub;
  mockRemote.agents.pc.list = [{ ...originalAgent, capabilities: { send } as AgentCapabilities }];
  const view = await render(viewThread());
  await fireEvent.press(view.getByLabelText('更多'));
  expect(view.queryByLabelText('发送到另一任务')).toBeNull();
  expect(view.queryByLabelText('回复到另一任务')).toBeNull();
});

test('a verified cross-task receipt offers a scoped reply to its exact source task', async () => {
  mockHubCooperation = true;
  mockRemote.agents.pc.list = [{ ...originalAgent, capabilities: { send: true } as AgentCapabilities }];
  mockRemote.sessions.pc.list = [originalSession, { ...originalSession, sessionKey: 'codex:source', title: '来源任务' }];
  setItems([{ kind: 'message', id: 'cross-task', role: 'user', text: '请检查这个问题', final: true, ts: 2,
    messageOrigin: { kind: 'user_cross_task', verification: 'bridge_receipt', sourceSessionKey: 'codex:source', sourceTitle: '来源任务',
      targetSessionKey: 'codex:original', receiptId: '11111111-2222-4333-8444-555555555555' } }]);
  const view = await render(viewThread());
  await fireEvent.press(view.getByLabelText('回复到另一任务'));
  expect(view.getByText('回复到另一任务')).toBeTruthy();
  expect(mockPrepareCooperation).toHaveBeenCalledWith('pc', 'codex:original', 'codex:source', expect.anything());
});

test.each([
  { label: 'message-target mismatch', targetSessionKey: 'codex:someone-else', verification: 'bridge_receipt', sourceSessionKey: 'codex:source', receiptId: '11111111-2222-4333-8444-555555555555' },
  { label: 'unverified event', targetSessionKey: 'codex:original', verification: 'native_reported', sourceSessionKey: 'codex:source', receiptId: '11111111-2222-4333-8444-555555555555' },
] as const)('does not offer a cross-task reply for $label', async origin => {
  mockHubCooperation = true;
  mockRemote.agents.pc.list = [{ ...originalAgent, capabilities: { send: true } as AgentCapabilities }];
  setItems([{ kind: 'message', id: 'cross-task-invalid', role: 'user', text: '外部消息', final: true, ts: 2,
    messageOrigin: { kind: 'user_cross_task', ...origin } } as TimelineItem]);
  const view = await render(viewThread());
  expect(view.queryByLabelText('回复到另一任务')).toBeNull();
  expect(mockPrepareCooperation).not.toHaveBeenCalled();
});

test.each(['hidden', 'credential', 'thread'] as const)('image preview ownership rejects stale open and close after %s', async change => {
  const uri = 'file:///app/cache/shared-preview.png';
  const view = await render(viewThread());
  const originalUi = mockThreadUi.mock.calls.at(-1)![0];
  await act(async () => { originalUi.openImage(uri); });
  expect(view.getByTestId('dialogue-image-preview').props.uri).toBe(uri);
  const oldClose = mockImageViewer.mock.calls.at(-1)![0].onClose;
  let currentThread = viewThread();
  if (change === 'hidden') {
    await view.rerender(viewThread(jest.fn(), false));
    expect(view.queryByTestId('dialogue-image-preview')).toBeNull();
    await act(async () => { originalUi.openImage(uri); });
  } else if (change === 'credential') {
    mockDeliveryScope = 'paired|credential:replacement-preview';
  } else {
    const session = { ...originalSession, sessionKey: 'codex:another', title: '另一个对话' };
    mockRemote.timelines['pc|codex:another'] = { session, loading: false,
      items: [{ kind: 'message', id: 'other-reply', role: 'assistant', text: '另一个回复', final: true, ts: 1 }] };
    currentThread = <ThreadView visible deviceId="pc" sessionKey={session.sessionKey} agent={originalAgent} onClose={jest.fn()} onCreated={jest.fn()} />;
  }
  mockImageViewer.mockClear();
  await view.rerender(currentThread);
  // The old URI must not flash in the new owner before passive reset effects.
  expect(mockImageViewer.mock.calls.every(([props]) => props.uri === null)).toBe(true);
  expect(view.queryByTestId('dialogue-image-preview')).toBeNull();
  await act(async () => { originalUi.openImage(uri); });
  expect(view.queryByTestId('dialogue-image-preview')).toBeNull();
  const currentUi = mockThreadUi.mock.calls.at(-1)![0];
  await act(async () => { currentUi.openImage(uri); });
  expect(view.getByTestId('dialogue-image-preview').props.uri).toBe(uri);
  await act(async () => { oldClose(); });
  expect(view.getByTestId('dialogue-image-preview').props.uri).toBe(uri);
  await act(async () => { mockImageViewer.mock.calls.at(-1)![0].onClose(); });
  expect(view.queryByTestId('dialogue-image-preview')).toBeNull();
});

test.each(['image', 'diff'] as const)('an old %s close cannot dismiss a reopened preview of the same content', async kind => {
  const view = await render(viewThread());
  const ui = mockThreadUi.mock.calls.at(-1)![0];
  const file = { path: 'C:\\fixture\\preview.ts', diff: '-old\n+new', add: 1, del: 1 };
  const preview = kind === 'image' ? mockImageViewer : mockDiffViewer;
  const id = kind === 'image' ? 'dialogue-image-preview' : 'remote-diff-tool';
  const open = () => kind === 'image' ? ui.openImage('file:///app/cache/shared-preview.png') : ui.openDiff(file);
  await act(async () => { open(); });
  const oldClose = kind === 'image' ? preview.mock.calls.at(-1)![0].onClose : undefined;
  if (oldClose) await act(async () => { oldClose(); });
  else await act(async () => { fireEvent.press(view.getByLabelText('返回工具栏')); });
  expect(view.queryByTestId(id)).toBeNull();
  await act(async () => { open(); });
  expect(view.getByTestId(id)).toBeTruthy();
  if (oldClose) await act(async () => { oldClose(); });
  expect(view.getByTestId(id)).toBeTruthy();
  if (kind === 'image') await act(async () => { preview.mock.calls.at(-1)![0].onClose(); });
  else await act(async () => { fireEvent.press(view.getByLabelText('返回工具栏')); });
  expect(view.queryByTestId(id)).toBeNull();
});

test('diff preview ownership rejects a previous pairing without flashing its file', async () => {
  const view = await render(viewThread());
  const originalUi = mockThreadUi.mock.calls.at(-1)![0];
  const file = { path: 'C:\\fixture\\preview.ts', diff: '-old\n+new', add: 1, del: 1 };
  await act(async () => { originalUi.openDiff(file); });
  expect(view.getByTestId('remote-diff-tool')).toBeTruthy();
  mockDeliveryScope = 'paired|credential:replacement-diff';
  await view.rerender(viewThread());
  expect(view.queryByTestId('remote-diff-tool')).toBeNull();
  await act(async () => { originalUi.openDiff(file); });
  expect(view.queryByTestId('remote-diff-tool')).toBeNull();
  const currentUi = mockThreadUi.mock.calls.at(-1)![0];
  await act(async () => { currentUi.openDiff(file); });
  expect(view.getByTestId('remote-diff-tool')).toBeTruthy();
});

function enableFeatures() { enablePermissionModes(); mockRemote.agents.pc.list[0].capabilities!.features = true; }
const featureComposerText = (view: Awaited<ReturnType<typeof render>>) => {
  const props = view.getByLabelText('给电脑上的 Agent 发消息').props;
  return (props.value ?? props.accessibilityValue?.text) as string;
};
async function editFeatureComposer(view: Awaited<ReturnType<typeof render>>, text: string, caret = text.length) {
  // These fixtures express canonical drafts. Native change/selection events
  // carry the visible names, with the invocation prefix owned by metadata.
  const before = mockSkillComposerProps.mock.calls.at(-1)![0];
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), skillComposerPresentation(text, before.mentions).text);
  const after = mockSkillComposerProps.mock.calls.at(-1)![0];
  const displayCaret = skillDisplayOffset(skillComposerPresentation(after.value, after.mentions), caret);
  await fireEvent(view.getByLabelText('给电脑上的 Agent 发消息'), 'selectionChange', { nativeEvent: { selection: { start: displayCaret, end: displayCaret } } });
}
const changedFeatures = (skills: AgentFeatures['skills']): AgentFeatures => ({ collaborationModes: ['default', 'plan'], skillsSupported: true, skills });
const advanceFeatureGeneration = (tool = 'codex', device = 'pc') => {
  const key = `${device}:${tool}`;
  mockFeatureGenerations.set(key, (mockFeatureGenerations.get(key) ?? 0) + 1);
};
test.each(['codex', 'claude'])('feature change: %s notification hides an open directory until its fresh response', async tool => {
  const fixture = sendAdmissionFixture(tool); fixture.profile.capabilities!.features = true; fixture.replace(fixture.profile);
  const view = await render(fixture.renderThread());
  await editFeatureComposer(view, '/skills ');
  expect(view.getByLabelText('选择技能 review，/review')).toBeTruthy();
  let finish!: (value: AgentFeatures) => void;
  mockFeatures.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const calls = mockFeatures.mock.calls.length;
  advanceFeatureGeneration(tool); await view.rerender(fixture.renderThread());
  expect(mockFeatures).toHaveBeenCalledTimes(calls + 1);
  expect(view.queryByLabelText('选择技能 review，/review')).toBeNull();
  expect(view.getByLabelText('正在读取快捷命令')).toBeTruthy();
  expect(featureComposerText(view)).toBe('/skills ');
  await act(async () => { finish(changedFeatures([{ name: 'fresh', description: 'New remote skill' }])); });
  expect(view.getByLabelText('选择技能 fresh，/fresh')).toBeTruthy();
  expect(mockSend).not.toHaveBeenCalled();
});
test('feature change: captured menu, keyboard and submit callbacks reject a notification before React rerenders', async () => {
  enableFeatures(); const view = await render(viewThread());
  await editFeatureComposer(view, '/skills review');
  const choose = view.getByLabelText('选择技能 review，/review').props.onPress;
  const keyPress = view.getByLabelText('给电脑上的 Agent 发消息').props.onKeyPress;
  const submit = view.getByLabelText('选择命令').props.onPress;
  advanceFeatureGeneration();
  await act(async () => { choose(); keyPress({ nativeEvent: { key: 'Enter' }, preventDefault: jest.fn() }); submit(); });
  expect(featureComposerText(view)).toBe('/skills review');
  expect(mockSend).not.toHaveBeenCalled();
});
test.each(['success', 'failure'] as const)('feature change: a retired %s promise cannot publish before the next render', async outcome => {
  enableFeatures(); const view = await render(viewThread());
  await editFeatureComposer(view, '/skills ');
  let finish!: (value: AgentFeatures) => void, fail!: (error: Error) => void;
  mockFeatures.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  advanceFeatureGeneration(); await view.rerender(viewThread());
  // The next control event is already in the store but React has not observed it.
  advanceFeatureGeneration();
  await act(async () => {
    if (outcome === 'success') finish(changedFeatures([{ name: 'retired', description: 'Old generation' }]));
    else fail(new Error('retired catalog failure'));
  });
  expect(view.queryByLabelText('选择技能 retired，/retired')).toBeNull();
  expect(view.queryByText('retired catalog failure')).toBeNull();
  mockFeatures.mockResolvedValue(changedFeatures([{ name: 'current', description: 'Current generation' }]));
  await view.rerender(viewThread());
  expect(view.getByLabelText('选择技能 current，/current')).toBeTruthy();
  expect(view.queryByText('retired catalog failure')).toBeNull();
});
test('feature change: other tools and computers do not invalidate this open catalog', async () => {
  enableFeatures(); const view = await render(viewThread()); await editFeatureComposer(view, '/skills ');
  const calls = mockFeatures.mock.calls.length;
  advanceFeatureGeneration('claude'); advanceFeatureGeneration('codex', 'another-pc');
  await view.rerender(viewThread());
  expect(mockFeatures).toHaveBeenCalledTimes(calls);
  expect(view.getByLabelText('选择技能 review，/review')).toBeTruthy();
});
test.each(['manual', 'ttl'] as const)('feature change: %s refresh retires old row callbacks even without a control notification', async refresh => {
  enableFeatures(); const view = await render(viewThread()); await editFeatureComposer(view, '/skills ');
  const choose = view.getByLabelText('选择技能 review，/review').props.onPress;
  const reload = view.getByLabelText('重新读取快捷命令').props.onPress;
  mockFeatures.mockResolvedValue(changedFeatures([{ name: 'renamed', description: 'Renamed skill' }]));
  await act(async () => {
    if (refresh === 'manual') reload(); else jest.advanceTimersByTime(30_000);
    choose();
  });
  expect(featureComposerText(view)).toBe('/skills ');
  expect(view.getByLabelText('选择技能 renamed，/renamed')).toBeTruthy();
  await act(async () => { choose(); });
  expect(featureComposerText(view)).toBe('/skills '); expect(mockSend).not.toHaveBeenCalled();
  if (refresh === 'manual') expect(mockFeatures).toHaveBeenLastCalledWith('pc', 'codex', { sessionKey: 'codex:original' }, { force: true });
});
test('feature change: moved same-name skill preserves the exact selection and literal text until explicitly cleared', async () => {
  enableFeatures(); const view = await render(viewThread());
  await editFeatureComposer(view, '/review 检查正文中的 $review', 7);
  await fireEvent.press(view.getByLabelText('选择技能 review，/review'));
  const originalText = featureComposerText(view), submit = mockSendSubmit.current;
  mockFeatures.mockResolvedValue(changedFeatures([{ name: 'review', path: 'C:/fixture/moved/SKILL.md', description: 'Moved' }]));
  advanceFeatureGeneration();
  await act(async () => { submit(); });
  expect(mockSend).not.toHaveBeenCalled(); expect(featureComposerText(view)).toBe(originalText);
  await view.rerender(viewThread());
  expect(featureComposerText(view)).toBe(originalText);
  expect(view.getByLabelText('清除不可用的模式和技能')).toBeTruthy();
  await act(async () => { mockSendSubmit.current(); jest.advanceTimersByTime(450); });
  expect(mockSend).not.toHaveBeenCalled();
  expect(mockComposerSave.mock.calls.at(-1)![2].featureIntent?.skills).toEqual([{ name: 'review', path: 'C:/fixture/SKILL.md' }]);
  await fireEvent.press(view.getByLabelText('清除不可用的模式和技能'));
  expect(featureComposerText(view)).toBe('  检查正文中的 $review');
  await dismissFeatureMenu(view);
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '检查正文中的 $review', expect.not.objectContaining({ skills: expect.anything() }));
});
test('feature change: a removed selection becomes sendable only when the same exact path returns', async () => {
  enableFeatures(); const view = await render(viewThread());
  await editFeatureComposer(view, '/review 检查', 7); await fireEvent.press(view.getByLabelText('选择技能 review，/review'));
  const originalText = featureComposerText(view);
  mockFeatures.mockResolvedValue(changedFeatures([])); advanceFeatureGeneration(); await view.rerender(viewThread());
  expect(view.getByLabelText('清除不可用的模式和技能')).toBeTruthy();
  expect(featureComposerText(view)).toBe(originalText);
  mockFeatures.mockResolvedValue(changedFeatures([{ name: 'review', path: 'C:/fixture/SKILL.md', description: 'Returned' }]));
  advanceFeatureGeneration(); await view.rerender(viewThread());
  expect(view.queryByLabelText('清除不可用的模式和技能')).toBeNull();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '检查', expect.objectContaining({ skills: [{ name: 'review', path: 'C:/fixture/SKILL.md' }] }));
});
test('feature change: an obsolete clear action cannot replace a newer edited draft', async () => {
  enableFeatures(); const view = await render(viewThread());
  await editFeatureComposer(view, '/review 检查', 7); await fireEvent.press(view.getByLabelText('选择技能 review，/review'));
  mockFeatures.mockResolvedValue(changedFeatures([])); advanceFeatureGeneration(); await view.rerender(viewThread());
  const clear = view.getByLabelText('清除不可用的模式和技能').props.onPress;
  await editFeatureComposer(view, featureComposerText(view) + ' 新内容');
  const edited = featureComposerText(view);
  await act(async () => { clear(); });
  expect(featureComposerText(view)).toBe(edited);
  await fireEvent.press(view.getByLabelText('清除不可用的模式和技能'));
  expect(featureComposerText(view)).toBe('  检查 新内容');
});
test('feature change: clearing owns exact intent even when a new skill path produces the same text', async () => {
  enableFeatures(); const view = await render(viewThread());
  await editFeatureComposer(view, '/review 检查', 7); await fireEvent.press(view.getByLabelText('选择技能 review，/review'));
  const originalText = featureComposerText(view);
  mockFeatures.mockResolvedValue(changedFeatures([])); advanceFeatureGeneration(); await view.rerender(viewThread());
  const oldClear = view.getByLabelText('清除不可用的模式和技能').props.onPress;
  // A directory notification alone does not take away the right to clear.
  advanceFeatureGeneration(); await act(async () => { oldClear(); });
  expect(featureComposerText(view)).toBe('  检查');
  const moved = { name: 'review', path: 'C:/fixture/moved/SKILL.md', description: 'Moved' };
  mockFeatures.mockResolvedValue(changedFeatures([moved])); advanceFeatureGeneration(); await view.rerender(viewThread());
  await editFeatureComposer(view, '/review 检查', 7); await fireEvent.press(view.getByLabelText('选择技能 review，/review'));
  expect(featureComposerText(view)).toBe(originalText);
  await act(async () => { oldClear(); });
  expect(featureComposerText(view)).toBe(originalText);
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '检查', expect.objectContaining({ skills: [{ name: moved.name, path: moved.path }] }));
});
test('feature change: a notification during draft persistence prevents dispatch and preserves the unsent selection', async () => {
  enableFeatures(); const view = await render(viewThread());
  await editFeatureComposer(view, '/review 检查', 7); await fireEvent.press(view.getByLabelText('选择技能 review，/review'));
  let finish!: () => void;
  mockComposerSave.mockImplementationOnce((_key, scope, draft) => new Promise(resolve => {
    finish = () => resolve({ ...draft, scope, revision: 2, imageCount: draft.images.length });
  }));
  const originalText = featureComposerText(view);
  await act(async () => { mockSendSubmit.current(); });
  expect(finish).toEqual(expect.any(Function));
  advanceFeatureGeneration(); await act(async () => { finish(); });
  expect(mockSend).not.toHaveBeenCalled(); expect(mockComposerConsume).not.toHaveBeenCalled();
  expect(featureComposerText(view)).toBe(originalText);
});
test('feature change: a catalog read from the old API cannot replace the new source or consume its text', async () => {
  enableFeatures(); const view = await render(viewThread()); await editFeatureComposer(view, '/skills ');
  const choose = view.getByLabelText('选择技能 review，/review').props.onPress;
  let finish!: (value: AgentFeatures) => void;
  mockFeatures.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  advanceFeatureGeneration(); await view.rerender(viewThread());
  mockRemote.agents.pc.list = [{ ...mockRemote.agents.pc.list[0], api: { ...originalAgent.api, accountId: 'api_backup' } }];
  mockFeatures.mockResolvedValue(changedFeatures([{ name: 'source-b', description: 'New account' }]));
  await view.rerender(viewThread());
  await act(async () => { finish(changedFeatures([{ name: 'source-a', description: 'Old account' }])); choose(); });
  expect(featureComposerText(view)).toBe('/skills ');
  expect(view.getByLabelText('选择技能 source-b，/source-b')).toBeTruthy();
  expect(view.queryByLabelText('选择技能 source-a，/source-a')).toBeNull();
  expect(mockSend).not.toHaveBeenCalled();
});
test('slash composer searches Chinese mode names and preserves the task until explicit send', async () => {
  enableFeatures(); const view = await render(viewThread());
  await editFeatureComposer(view, '/计划 检查同步', 3);
  expect(view.getByTestId('remote-slash-menu')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('选择计划模式，/plan'));
  expect(view.queryByTestId('remote-slash-menu')).toBeNull();
  expect(featureComposerText(view)).toBe(' 检查同步');
  expect(view.getByLabelText('关闭计划模式')).toBeTruthy(); expect(mockSend).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '检查同步', expect.objectContaining({ collaborationMode: 'plan' }));
});

test('compact shortcut invokes native control once, preserves the draft and blocks sending while occupied', async () => {
  enableFeatures(); mockHubContext = true;
  Object.assign(mockRemote.agents.pc.list[0].capabilities!, { context: true, compact: true });
  const view = await render(viewThread()); await act(async () => { jest.advanceTimersByTime(150); });
  await editFeatureComposer(view, '/compact 后续任务', 8);
  await fireEvent.press(view.getByLabelText('选择压缩上下文，/compact'));
  expect(mockCompactContext).toHaveBeenCalledTimes(1);
  expect(featureComposerText(view)).toBe(' 后续任务'); expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
  await act(async () => { mockSendSubmit.current(); }); expect(mockSend).not.toHaveBeenCalled();
  expect(view.getByLabelText(/上下文状态，.*等待压缩/)).toBeTruthy();
  await view.unmount();
});

test('queued compact shortcut cannot consume the draft or dispatch after the account changes', async () => {
  enableFeatures(); mockHubContext = true;
  Object.assign(mockRemote.agents.pc.list[0].capabilities!, { context: true, compact: true });
  const view = await render(viewThread()); await act(async () => { jest.advanceTimersByTime(150); });
  await editFeatureComposer(view, '/compact 后续任务', 8);
  const choose = view.getByLabelText('选择压缩上下文，/compact').props.onPress;
  mockRemote.agents.pc.list[0].api = { ...originalAgent.api, accountId: 'api_changed' };
  await act(async () => { choose(); });
  expect(mockCompactContext).not.toHaveBeenCalled(); expect(featureComposerText(view)).toBe('/compact 后续任务');
  await view.unmount();
});

test('native compaction occupancy does not hide an owned running turns precise stop', async () => {
  enableFeatures(); mockHubContext = true;
  Object.assign(mockRemote.agents.pc.list[0].capabilities!, { context: true, compact: true, preciseInterrupt: true });
  setItems([], { ...originalSession, status: 'running', activeTurnId: 'compact-turn' });
  mockRemote.timelines['pc|codex:original'].snapshotAt = Date.now();
  mockReadContext.mockImplementation(async () => ({ ...mockContextReading(), value: { ...mockContextReading().value, canCompact: false,
    compaction: { state: 'running', blocking: true, startedAt: 1, updatedAt: 1 } } }));
  const interrupt = jest.requireMock('../remote/store').interruptSession;
  interrupt.mockResolvedValueOnce({ status: 'requested', turnId: 'compact-turn' });
  const view = await render(viewThread()); await act(async () => { jest.advanceTimersByTime(150); });
  expect(view.getByLabelText(/上下文状态，.*压缩中/).props.accessibilityState.busy).toBe(true);
  await fireEvent.press(view.getByLabelText('更多'));
  await fireEvent.press(view.getByLabelText('停止任务'));
  expect(interrupt).toHaveBeenCalledWith('pc', 'codex:original', 'compact-turn');
  expect(mockSend).not.toHaveBeenCalled(); expect(mockCompactContext).not.toHaveBeenCalled();
  await view.unmount();
});
test.each(['command', 'indicator'] as const)('plan toggle closes through %s without changing permission policy or sending', async closeWith => {
  enableFeatures(); const view = await render(viewThread());
  await editFeatureComposer(view, '/plan'); await fireEvent.press(view.getByLabelText('选择计划模式，/plan'));
  expect(view.getByLabelText('关闭计划模式')).toBeTruthy();
  expect(view.queryByLabelText('工作模式')).toBeNull(); expect(view.queryByLabelText('Skills')).toBeNull();
  if (closeWith === 'indicator') await fireEvent.press(view.getByLabelText('关闭计划模式'));
  else { await editFeatureComposer(view, '/plan'); expect(view.getByText('关闭计划模式')).toBeTruthy(); await fireEvent.press(view.getByLabelText('选择计划模式，/plan')); }
  expect(view.queryByLabelText('关闭计划模式')).toBeNull(); expect(mockSend).not.toHaveBeenCalled();
  await editFeatureComposer(view, '实施检查'); await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '实施检查', expect.objectContaining({ collaborationMode: 'default' }));
  expect((mockSend.mock.calls[0][3] as { permissionMode?: string }).permissionMode).toBeUndefined();
});
test('skill command inserts at the middle caret and retains both sides and the exact path', async () => {
  enableFeatures(); const view = await render(viewThread());
  await editFeatureComposer(view, '先检查 /review 再修复', 11);
  await fireEvent.press(view.getByLabelText('选择技能 review，/review'));
  expect(featureComposerText(view)).toBe('先检查 $review  再修复'); expect(mockSend).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '先检查   再修复', expect.objectContaining({ skills: [{ name: 'review', path: 'C:/fixture/SKILL.md' }] }));
});
test('backspacing a skill token removes its full text and cancels native skill invocation', async () => {
  enableFeatures(); const view = await render(viewThread());
  await editFeatureComposer(view, '/review 检查代码', 7); await fireEvent.press(view.getByLabelText('选择技能 review，/review'));
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), 'revie  检查代码');
  expect(featureComposerText(view)).toBe('  检查代码');
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '检查代码', expect.not.objectContaining({ skills: expect.anything() }));
});
test.each(['codex', 'claude'])('multiple skill selection retains Codex references and refuses a second Claude skill: %s', async tool => {
  const fixture = sendAdmissionFixture(tool); fixture.profile.capabilities!.features = true; fixture.replace(fixture.profile);
  const skills = ['review', 'test'].map(name => ({ name, ...(tool === 'codex' ? { path: `C:/fixture/${name}/SKILL.md` } : {}), description: name }));
  mockFeatures.mockResolvedValue({ collaborationModes: ['default', 'plan'], skillsSupported: true, skills });
  const view = await render(fixture.renderThread());
  await editFeatureComposer(view, '/review 检查', 7); await fireEvent.press(view.getByLabelText('选择技能 review，/review'));
  await editFeatureComposer(view, featureComposerText(view) + ' $test');
  await fireEvent.press(view.getByLabelText('选择技能 test，/test'));
  expect(mockSend).not.toHaveBeenCalled();
  if (tool === 'claude') {
    expect(mockToast).toHaveBeenCalledWith('Claude Code 每条消息支持一个技能，请先删除已选技能', 'code');
    expect(featureComposerText(view)).toBe('$review  检查 $test');
    await editFeatureComposer(view, '$review  检查');
  } else expect(featureComposerText(view)).toBe('$review  检查 $test ');
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', fixture.session.sessionKey, '检查', expect.objectContaining({
    skills: skills.slice(0, tool === 'claude' ? 1 : 2).map(({ description: _description, ...skill }) => skill),
  }));
});
test.each(['codex', 'claude'])('slash composer provides the same skill invocation for %s', async tool => {
  const fixture = sendAdmissionFixture(tool); fixture.profile.capabilities!.features = true; fixture.replace(fixture.profile);
  const skill = { name: 'review', ...(tool === 'codex' ? { path: 'C:/fixture/SKILL.md' } : {}) };
  mockFeatures.mockResolvedValue({ collaborationModes: ['default', 'plan'], skillsSupported: true, skills: [{ ...skill, description: 'Review code' }] });
  const view = await render(fixture.renderThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '/');
  await fireEvent.press(view.getByLabelText('浏览技能命令'));
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('/skills ');
  await editFeatureComposer(view, '/skills review\n检查代码', 14);
  await fireEvent.press(view.getByLabelText('选择技能 review，/review'));
  expect(featureComposerText(view)).toBe('$review \n检查代码'); expect(mockSend).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', fixture.session.sessionKey, '检查代码', expect.objectContaining({ skills: [skill] }));
});
test('slash composer rejects a stale selection after API change without deleting new text', async () => {
  enableFeatures(); const view = await render(viewThread());
  await editFeatureComposer(view, '/review old', 7);
  const choose = view.getByLabelText('选择技能 review，/review').props.onPress;
  mockRemote.agents.pc.list = [{ ...mockRemote.agents.pc.list[0], api: { ...originalAgent.api, accountId: 'api_backup' } }];
  await view.rerender(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), 'new source text');
  await act(async () => { choose(); });
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('new source text');
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend.mock.calls.every(call => !(call[3] as { skills?: unknown }).skills)).toBe(true);
});
test('slash composer keeps unknown commands literal after explicit dismissal', async () => {
  enableFeatures(); const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '/unknown literal');
  expect(view.getByLabelText('选择命令').props.accessibilityState.disabled).toBe(true);
  expect(mockSend).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('关闭快捷命令'));
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('/unknown literal');
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend.mock.calls[0][2]).toBe('/unknown literal');
});
test('slash composer keeps unsupported native commands literal after dismissal', async () => {
  enableFeatures(); setItems([], { ...originalSession, controlSurface: 'desktop' });
  mockRemote.agents.pc.list[0].desktopLive = { expiresAt: Date.now() + 60000, sessionKeys: ['codex:original'], capabilities: desktopCapabilities };
  const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '/plan literal native');
  expect(view.getByTestId('remote-slash-menu')).toBeTruthy(); expect(view.queryByLabelText('选择计划模式，/plan')).toBeNull();
  await fireEvent.press(view.getByLabelText('关闭快捷命令'));
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend.mock.calls[0][2]).toBe('/plan literal native');
  expect(mockSend.mock.calls[0][3]).not.toHaveProperty('collaborationMode');
});
test('slash composer keyboard navigation selects without sending and escape retains text', async () => {
  enableFeatures(); const view = await render(viewThread());
  await editFeatureComposer(view, '/\nkeep body', 1);
  await fireEvent(view.getByLabelText('给电脑上的 Agent 发消息'), 'keyPress', { nativeEvent: { key: 'ArrowDown' }, preventDefault: jest.fn() });
  await fireEvent(view.getByLabelText('给电脑上的 Agent 发消息'), 'keyPress', { nativeEvent: { key: 'ArrowUp' }, preventDefault: jest.fn() });
  await fireEvent(view.getByLabelText('给电脑上的 Agent 发消息'), 'keyPress', { nativeEvent: { key: 'Enter' }, preventDefault: jest.fn() });
  expect(view.getByLabelText('关闭模型选择')).toBeTruthy(); expect(mockSend).not.toHaveBeenCalled();
  expect(featureComposerText(view)).toBe('\nkeep body');
  await fireEvent.press(view.getByLabelText('关闭模型选择'));
  await editFeatureComposer(view, '/review task', 7);
  await fireEvent(view.getByLabelText('给电脑上的 Agent 发消息'), 'keyPress', { nativeEvent: { key: 'Escape' }, preventDefault: jest.fn() });
  expect(view.queryByTestId('remote-slash-menu')).toBeNull();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('/review task');
});
test('slash model action stays usable when the remote skill catalog fails', async () => {
  enableFeatures(); mockFeatures.mockRejectedValue(new Error('技能目录暂不可用'));
  const view = await render(viewThread());
  await editFeatureComposer(view, '/model\n保留任务', 6);
  expect(view.getByText('技能目录暂不可用')).toBeTruthy();
  expect(view.getByLabelText('选择模型，/model').props.accessibilityState.disabled).toBe(false);
  await fireEvent.press(view.getByLabelText('选择模型，/model'));
  expect(view.getByTestId('remote-model-popover')).toBeTruthy();
  expect(view.getByRole('radio', { name: 'gpt-fixture' })).toBeTruthy();
  expect(featureComposerText(view)).toBe('\n保留任务');
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled(); expect(mockComposerConsume).not.toHaveBeenCalled();
  await view.unmount();
});

test('slash reasoning action opens only its dedicated control and confirms on outside dismissal', async () => {
  enablePermissionModes(); useReportedModels();
  const view = await render(viewThread());
  await editFeatureComposer(view, '/reasoning');
  await fireEvent.press(view.getByLabelText('选择推理强度，/reasoning'));
  expect(view.queryByTestId('remote-model-popover')).toBeNull();
  await fireEvent(view.getByTestId('main-effort-slider'), 'valueChange', 4);
  expect(view.getByTestId('main-effort-preview').props.children).toBe('High');
  await fireEvent.press(view.getByLabelText('关闭推理强度选择', { includeHiddenElements: true }));
  expect(view.getByTestId('remote-effort-chip').props.accessibilityLabel).toBe('High');
  expect(featureComposerText(view)).toBe(''); expect(mockFeatures).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled(); await view.unmount();
});

test('slash permissions action keeps the compact menu and enforced approval policy', async () => {
  enablePermissionModes(false);
  const view = await render(viewThread());
  await editFeatureComposer(view, '/permissions');
  await fireEvent.press(view.getByLabelText('选择权限，/permissions'));
  expect(view.getByTestId('composer-permission-menu')).toBeTruthy();
  expect(view.getByRole('radio', { name: /完全访问权限/ }).props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(view.getByText('帮我批准'));
  expect(view.queryByTestId('composer-permission-menu')).toBeNull(); expect(view.getByLabelText('帮我批准')).toBeTruthy();
  expect(featureComposerText(view)).toBe(''); expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
  await view.unmount();
});

test('slash init prepares an editable project instruction draft without consuming surrounding text or sending', async () => {
  enableFeatures(); const view = await render(viewThread()), draft = '已有要求\n/init\n后续事项';
  await editFeatureComposer(view, draft, draft.indexOf('/init') + 5);
  await fireEvent.press(view.getByLabelText('选择初始化，/init'));
  const result = featureComposerText(view);
  expect(result.startsWith('已有要求\n')).toBe(true); expect(result.endsWith('\n后续事项')).toBe(true);
  expect(result).toContain('创建或完善 AGENTS.md'); expect(result).toContain('保留仍然有效的内容'); expect(result).not.toContain('/init');
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled(); expect(mockComposerConsume).not.toHaveBeenCalled();
  await view.unmount();
});

test.each([['/model', '选择模型，/model'], ['/init', '选择初始化，/init']] as const)('queued local slash action %s cannot act on an API that changed before rerender', async (command, label) => {
  enableFeatures(); const view = await render(viewThread());
  await editFeatureComposer(view, command + '\n保留草稿', command.length);
  const choose = view.getByLabelText(label).props.onPress, before = featureComposerText(view);
  mockRemote.agents.pc.list = [{ ...mockRemote.agents.pc.list[0], api: { ...originalAgent.api, accountId: 'api_backup' } }];
  await act(async () => { choose(); });
  expect(featureComposerText(view)).toBe(before); expect(view.queryByTestId('remote-model-popover')).toBeNull();
  await view.rerender(viewThread());
  await editFeatureComposer(view, '新来源的草稿'); await act(async () => { choose(); });
  expect(featureComposerText(view)).toBe('新来源的草稿'); expect(view.queryByTestId('remote-model-popover')).toBeNull();
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled(); expect(mockComposerConsume).not.toHaveBeenCalled();
  await view.unmount();
});

test('slash new action navigates once with the current workspace and rejects the old callback', async () => {
  enableFeatures(); const onNew = jest.fn();
  const props = { visible: true, deviceId: 'pc', sessionKey: 'codex:original', agent: originalAgent, workspaceMode: 'work' as const, onClose: jest.fn(), onCreated: jest.fn(), onNew };
  const view = await render(<ThreadView {...props} />);
  await editFeatureComposer(view, '/new');
  const choose = view.getByLabelText('选择新聊天，/new').props.onPress;
  await editFeatureComposer(view, '后来输入的草稿'); await act(async () => { choose(); });
  expect(onNew).not.toHaveBeenCalled(); expect(featureComposerText(view)).toBe('后来输入的草稿');
  await editFeatureComposer(view, '/new'); await fireEvent.press(view.getByLabelText('选择新聊天，/new'));
  expect(onNew).toHaveBeenCalledTimes(1); expect(onNew).toHaveBeenCalledWith('work', originalSession.cwd);
  expect(featureComposerText(view)).toBe(''); expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled(); await view.unmount();
});

test('slash menu advertises available actions without pet or companion entries', async () => {
  enableFeatures(); const view = await render(viewThread());
  await editFeatureComposer(view, '/');
  expect(view.getByLabelText('选择模型，/model')).toBeTruthy(); expect(view.getByLabelText('选择初始化，/init')).toBeTruthy();
  expect(view.queryAllByLabelText(/选择.*(?:宠物|伴侣|pet|companion)/i)).toHaveLength(0);
  await editFeatureComposer(view, '/pet');
  expect(view.getByLabelText('选择命令').props.accessibilityState.disabled).toBe(true);
  expect(featureComposerText(view)).toBe('/pet'); expect(mockSend).not.toHaveBeenCalled(); await view.unmount();
});

test('queued feature recovery refuses resending after the API changes again', async () => {
  enableFeatures(); mockLoadQueued.mockResolvedValueOnce([queueFixture('recover then change API', { state: 'blocked',
    sendOptions: { surface: 'cli', collaborationMode: 'plan', skills: [{ name: 'review', path: 'C:/fixture/SKILL.md' }] } })]);
  const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '');
  await fireEvent.press(view.getByLabelText('取消排队，放回输入框')); mockSaveQueued.mockClear();
  mockRemote.agents.pc.list = [{ ...mockRemote.agents.pc.list[0], api: { ...originalAgent.api, accountId: 'api_backup' } }];
  await view.rerender(viewThread()); await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).not.toHaveBeenCalled(); expect(mockSaveQueued).not.toHaveBeenCalled();
  expect(view.getByLabelText('排队中：recover then change API')).toBeTruthy();
});
test('selected plan and skill cannot be silently dropped by active-turn steering', async () => {
  enableSteer(); mockRemote.agents.pc.list[0].capabilities!.features = true;
  const view = await render(viewThread());
  await editFeatureComposer(view, '/plan next', 5); await fireEvent.press(view.getByLabelText('选择计划模式，/plan'));
  await editFeatureComposer(view, '/review next', 7); await fireEvent.press(view.getByLabelText('选择技能 review，/review'));
  await fireEvent.press(view.getByLabelText('引导当前轮次'));
  expect(mockSend).not.toHaveBeenCalled(); expect(view.getByLabelText('关闭计划模式')).toBeTruthy(); expect(featureComposerText(view)).toBe('$review  next');
});
test('slash selection sends real plan and exact skill options independently of permissions', async () => {
  enableFeatures(); const view = await render(viewThread());
  expect(mockFeatures).toHaveBeenCalledWith('pc', 'codex', { sessionKey: 'codex:original' });
  await editFeatureComposer(view, '/plan'); await fireEvent.press(view.getByLabelText('选择计划模式，/plan'));
  await editFeatureComposer(view, '/review 检查代码', 7); await fireEvent.press(view.getByLabelText('选择技能 review，/review'));
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', 'codex:original', '检查代码', expect.objectContaining({ collaborationMode: 'plan', skills: [{ name: 'review', path: 'C:/fixture/SKILL.md' }] }));
  expect((mockSend.mock.calls[0][3] as { permissionMode?: string }).permissionMode).toBeUndefined();
});
test('feature selection freezes into queued submission', async () => {
  enableFeatures(); setItems([], { ...originalSession, status: 'running', activeTurnId: 'turn-live' });
  const view = await render(viewThread());
  await editFeatureComposer(view, '/plan'); await fireEvent.press(view.getByLabelText('选择计划模式，/plan'));
  await editFeatureComposer(view, '/review 下一轮计划', 7); await fireEvent.press(view.getByLabelText('选择技能 review，/review'));
  await fireEvent.press(view.getByLabelText('排队发送'));
  expect(mockSend).not.toHaveBeenCalled();
  expect(mockSaveQueued.mock.calls.some(([, rows]) => (rows as LoadedQueuedRemoteDraft[]).some(row => row.sendOptions?.collaborationMode === 'plan' && row.sendOptions.skills?.[0].name === 'review'))).toBe(true);
});
test('stale skill command callback cannot select a skill after API changed', async () => {
  enableFeatures(); const view = await render(viewThread());
  await editFeatureComposer(view, '$review');
  const oldChoose = view.getByLabelText('选择技能 review，/review').props.onPress;
  const changed = { ...mockRemote.agents.pc.list[0], api: { ...originalAgent.api, accountId: 'api_backup' } };
  mockRemote.agents.pc.list = [changed];
  await view.rerender(viewThread()); await act(async () => { oldChoose(); });
  expect(featureComposerText(view)).toBe('$review');
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '新来源'); await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend.mock.calls.every(call => !(call[3] as { skills?: unknown }).skills)).toBe(true);
});
test.each(['mode', 'skill'] as const)('same-tick %s selection cannot change a submitting composer', async kind => {
  enableFeatures();
  let release!: () => void;
  mockSend.mockImplementationOnce(() => new Promise<undefined>(resolve => { release = () => resolve(undefined); }));
  const view = await render(viewThread());
  await editFeatureComposer(view, kind === 'mode' ? '/plan' : '$review');
  const choose = view.getByLabelText(kind === 'mode' ? '选择计划模式，/plan' : '选择技能 review，/review').props.onPress;
  await fireEvent.press(view.getByLabelText('关闭快捷命令'));
  const send = view.getByLabelText('发送').props.onPress;
  await act(async () => { void send(); choose(); });
  expect(view.queryByLabelText('关闭计划模式')).toBeNull();
  expect(mockSend.mock.calls[0][3]).not.toHaveProperty('collaborationMode');
  expect(mockSend.mock.calls[0][3]).not.toHaveProperty('skills');
  await act(async () => { release(); });
});
test('proposed plan is visible outside folded work and preview follows authoritative content', async () => {
  const plan: TimelineItem = { kind: 'tool', tool: 'plan', planKind: 'proposal', id: 'proposal-1', title: '方案', output: '# 第一个方案\n调查后再实施', status: 'running', ts: 1 };
  setItems([plan]); const view = await render(viewThread());
  await fireEvent.press(view.getByLabelText('查看完整计划'));
  expect(view.getByText('计划详情')).toBeTruthy();
  setItems([{ ...plan, output: '# 最终方案\n已确认的完整内容', status: 'done', outputFinal: true }]);
  await view.rerender(viewThread());
  expect(view.getAllByText('# 最终方案\n已确认的完整内容').length).toBeGreaterThan(0);
  await view.rerender(viewThread(undefined, false));
  expect(view.queryByText('计划详情')).toBeNull();
});

test('queued feature recovery preserves plan and exact skill when taken back and resent', async () => {
  enableFeatures();
  const selection = { collaborationMode: 'plan' as const, skills: [{ name: 'review', path: 'C:/fixture/SKILL.md' }] };
  mockLoadQueued.mockResolvedValueOnce([queueFixture('recover selected features', {
    state: 'blocked', sendOptions: { surface: 'cli', accountId: 'api_original', ...selection },
  })]);
  const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '');
  await fireEvent.press(view.getByLabelText('取消排队，放回输入框'));
  expect(featureComposerText(view)).toBe('$review recover selected features');
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', originalSession.sessionKey, 'recover selected features', expect.objectContaining(selection));
});

test.each(['scope', 'api', 'surface'] as const)('queued feature recovery blocks a different %s without replacing the draft', async mismatch => {
  enableFeatures();
  const waiting = queueFixture('private selected features', { state: 'blocked',
    sendOptions: { surface: mismatch === 'surface' ? 'desktop' : 'cli', collaborationMode: 'plan', skills: [{ name: 'review', path: 'C:/fixture/SKILL.md' }] },
    ...(mismatch === 'scope' ? { scope: 'old-pairing' } : mismatch === 'api' ? { apiIdentity: 'computer:api_other' } : {}),
  });
  mockLoadQueued.mockResolvedValueOnce([waiting]);
  const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '');
  await fireEvent.press(view.getByLabelText('取消排队，放回输入框'));
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('');
  expect(view.getByLabelText('排队中：private selected features')).toBeTruthy();
  expect(mockSaveQueued).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
  expect(mockToast).toHaveBeenCalledWith('排队消息的工作模式、技能和引用仍保留，请回原来源取回', 'alert');
});

test('queued feature recovery rechecks the API after its durable storage wait', async () => {
  enableFeatures();
  mockLoadQueued.mockResolvedValueOnce([queueFixture('private selected features', { state: 'blocked',
    sendOptions: { surface: 'cli', collaborationMode: 'plan', skills: [{ name: 'review', path: 'C:/fixture/SKILL.md' }] },
  })]);
  let release!: () => void;
  mockSaveQueued.mockImplementationOnce((...args) => new Promise(resolve => { release = () => resolve(args[1] as LoadedQueuedRemoteDraft[]); }));
  const view = await render(viewThread());
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '');
  const takeBack = view.getByLabelText('取消排队，放回输入框').props.onPress;
  await act(async () => { void takeBack(); });
  mockRemote.agents.pc.list = [{ ...mockRemote.agents.pc.list[0], api: { ...originalAgent.api, accountId: 'api_backup' } }];
  await view.rerender(viewThread());
  await act(async () => { release(); });
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('');
  expect(view.getByLabelText('排队中：private selected features')).toBeTruthy();
  expect(mockSend).not.toHaveBeenCalled();
  expect(mockToast).toHaveBeenCalledWith('排队消息的工作模式、技能和引用仍保留，请回原来源取回', 'alert');
});

const featureDraftFixture = (modeOnly = false): ComposerDraft => {
  const skill = { name: 'review', path: 'C:/fixture/SKILL.md' };
  return { scope: mockDeliveryScope, revision: 3, text: modeOnly ? '' : '$review 解释 $review 语法', images: [], imageCount: 0,
    featureIntent: { version: 1, source: { scope: mockDeliveryScope, deviceId: 'pc', tool: 'codex', runtimeId: 'codex',
      surface: 'cli', apiIdentity: 'computer:api_original', cwd: originalSession.cwd! }, collaborationMode: 'plan',
    ...(modeOnly ? {} : { skills: [skill], mentions: [{ start: 0, end: 7, skill }] }) } };
};
async function dismissFeatureMenu(view: Awaited<ReturnType<typeof render>>) {
  if (view.queryByLabelText('关闭快捷命令')) await fireEvent.press(view.getByLabelText('关闭快捷命令'));
}

test('feature regression: a rejected native skill send preserves literal same-name text on retry', async () => {
  enableFeatures(); mockSend.mockRejectedValueOnce(new Error('synthetic native rejection'));
  const view = await render(viewThread());
  await editFeatureComposer(view, '/review 解释 $review 语法', 7);
  await fireEvent.press(view.getByLabelText('选择技能 review，/review'));
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend.mock.calls[0][2]).toBe('解释 $review 语法');
  expect(featureComposerText(view)).toBe('$review 解释 $review 语法');
  await dismissFeatureMenu(view); await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledTimes(2);
  expect(mockSend).toHaveBeenLastCalledWith('pc', originalSession.sessionKey, '解释 $review 语法', expect.objectContaining({
    skills: [{ name: 'review', path: 'C:/fixture/SKILL.md' }],
  }));
});

test('feature regression: a recovered queue keeps literal same-name text and clears skills before an image-only send', async () => {
  enableFeatures();
  mockLoadQueued.mockResolvedValueOnce([queueFixture('解释 $review 语法', { state: 'blocked', sendOptions: {
    surface: 'cli', collaborationMode: 'plan', skills: [{ name: 'review', path: 'C:/fixture/SKILL.md' }],
  } })]);
  const view = await render(viewThread());
  await editFeatureComposer(view, ''); await fireEvent.press(view.getByLabelText('取消排队，放回输入框'));
  expect(featureComposerText(view)).toBe('$review 解释 $review 语法');
  await dismissFeatureMenu(view); await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenLastCalledWith('pc', originalSession.sessionKey, '解释 $review 语法', expect.objectContaining({
    collaborationMode: 'plan', skills: [{ name: 'review', path: 'C:/fixture/SKILL.md' }],
  }));
  expect(featureComposerText(view)).toBe(''); expect(view.queryByLabelText('关闭计划模式')).toBeNull();
  const image: RemoteImage = { uri: 'file://picker/after-repair.jpg', base64: 'fixture', mime: 'image/jpeg', width: 40, height: 40 };
  mockPickImages.mockResolvedValueOnce([image]);
  await fireEvent.press(view.getByRole('button', { name: '添加到对话' })); await fireEvent.press(view.getByLabelText('从相册选择'));
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledTimes(2); expect(mockSend.mock.calls[1][2]).toBe('');
  expect(mockSend.mock.calls[1][3]).toMatchObject({ images: [image] });
  expect(mockSend.mock.calls[1][3]).not.toHaveProperty('skills'); expect(mockSend.mock.calls[1][3]).not.toHaveProperty('collaborationMode');
});

test('feature regression: quoting a reply preserves its identity beside a skill through the next edit', async () => {
  enableFeatures(); mockRemote.agents.pc.list[0].capabilities!.contextReferences = true;
  const view = await render(viewThread());
  await editFeatureComposer(view, '/review 检查代码', 7); await fireEvent.press(view.getByLabelText('选择技能 review，/review'));
  await fireEvent.press(view.getByLabelText('引用回复')); await fireEvent.press(view.getByLabelText('添加所选引用'));
  const quoted = featureComposerText(view); expect(quoted).not.toContain('原来的回复'); expect(quoted).toContain('$review');
  await editFeatureComposer(view, `${quoted}\n保留这句`); await dismissFeatureMenu(view);
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend.mock.calls[0][2]).toContain('保留这句'); expect(mockSend.mock.calls[0][2]).not.toContain('$review');
  expect(mockSend.mock.calls[0][3]).toMatchObject({ skills: [{ name: 'review', path: 'C:/fixture/SKILL.md' }], contextReferences: [expect.objectContaining({ kind: 'message', sessionKey: 'codex:original', text: '原来的回复' })] });
});

test('reference regression: adding and removing a quote without typing persists each draft revision', async () => {
  enableFeatures(); mockRemote.agents.pc.list[0].capabilities!.contextReferences = true;
  const view = await render(viewThread());
  await editFeatureComposer(view, ''); await dismissFeatureMenu(view);
  await fireEvent.press(view.getByLabelText('引用回复')); await fireEvent.press(view.getByLabelText('添加所选引用'));
  await act(async () => { jest.advanceTimersByTime(450); });
  const saved = mockComposerSave.mock.calls.at(-1)?.[2];
  expect(saved?.text).toBe(''); expect(saved?.featureIntent?.contextReferences).toEqual([expect.objectContaining({ kind: 'message', sessionKey: 'codex:original', text: '原来的回复' })]);
  await fireEvent.press(view.getByLabelText('移除引用 当前对话 · Agent'));
  await act(async () => { jest.advanceTimersByTime(450); });
  expect(mockComposerSave.mock.calls.at(-1)?.[2].featureIntent).toBeUndefined();
});

test('diff annotation regression: multiple comments persist and submit only with explicit main send', async () => {
  enableFeatures(); mockHubDiffAnnotations = true; Object.assign(mockRemote.agents.pc.list[0].capabilities!, { contextReferences: true, contextDiffAnnotations: true });
  setItems([{ kind: 'tool', id: 'edit', tool: 'file_change', title: 'a.ts', diff: '@@ -1 +1 @@\n-old\n+new', status: 'done', ts: 1 }, { kind: 'message', id: 'reply', role: 'assistant', text: '已修改', final: true, ts: 2 }]);
  const view = await render(viewThread()); await editFeatureComposer(view, ''); await dismissFeatureMenu(view);
  const file = { id: 'edit', path: 'a.ts', diff: '@@ -1 +1 @@\n-old\n+new', add: 1, del: 1, status: 'done' };
  await act(async () => mockThreadUi.mock.calls.at(-1)![0].openDiff(file));
  const p = parseDiffForAnnotations(file.path, file.diff), refs = [diffSelectionReference(p, originalSession.sessionKey, 'old', 1, 1, '旧行问题'), diffSelectionReference(p, originalSession.sessionKey, 'new', 1, 1, '新行问题')];
  for (const ref of refs) await act(async () => { expect(mockDiffViewer.mock.calls.at(-1)![0].onAddAnnotation(ref)).toBe(true); });
  expect(mockSend).not.toHaveBeenCalled(); await act(async () => { jest.advanceTimersByTime(450); });
  expect(mockComposerSave.mock.calls.at(-1)?.[2].featureIntent?.contextReferences).toEqual(refs);
  await fireEvent.press(view.getByLabelText('返回聊天')); await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', originalSession.sessionKey, '', expect.objectContaining({ contextReferences: refs })); expect(mockContinue).not.toHaveBeenCalled();
});

test('diff annotation regression: queued old-version review is retained and blocked before main send', async () => {
  enableFeatures(); mockHubDiffAnnotations = true; Object.assign(mockRemote.agents.pc.list[0].capabilities!, { contextReferences: true, contextDiffAnnotations: true });
  const reference = diffSelectionReference(parseDiffForAnnotations('a.ts', '@@ -1 +1 @@\n-old\n+new'), originalSession.sessionKey, 'old', 1, 1, '保留旧版意见');
  const queued = queueFixture('审查批注', { sendOptions: { surface: 'cli', accountId: 'api_original', contextReferences: [reference] } });
  mockLoadQueued.mockResolvedValueOnce([queued]);
  setItems([{ kind: 'tool', id: 'edit', tool: 'file_change', title: 'a.ts', diff: '@@ -1 +1 @@\n-new\n+changed', status: 'done', ts: 1 }]);
  const view = await render(viewThread());
  expect(mockSend).not.toHaveBeenCalled(); expect(mockSaveQueued.mock.calls.at(-1)?.[1]).toMatchObject([{ text: '审查批注', state: 'blocked', sendOptions: { contextReferences: [reference] } }]);
  expect(view.getByLabelText('排队中：审查批注')).toBeTruthy(); await view.unmount();
});

test('reference regression: a quote alone is a sendable message and does not invoke Continue', async () => {
  enableFeatures(); mockRemote.agents.pc.list[0].capabilities!.contextReferences = true;
  const view = await render(viewThread()); await editFeatureComposer(view, ''); await dismissFeatureMenu(view);
  await fireEvent.press(view.getByLabelText('引用回复')); await fireEvent.press(view.getByLabelText('添加所选引用'));
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', originalSession.sessionKey, '', expect.objectContaining({ contextReferences: [expect.objectContaining({ text: '原来的回复' })] }));
  expect(mockContinue).not.toHaveBeenCalled();
});

test.each(['user', 'assistant'] as const)('annotation regression: true %s text selection and optional comment survive draft and send', async role => {
  enableFeatures(); Object.assign(mockRemote.agents.pc.list[0].capabilities!, { contextReferences: true, contextAnnotations: true });
  setItems([{ kind: 'message', id: 'selection-source', role, text: '前段😀\n后段代码', final: true, ts: 1 }]);
  const view = await render(viewThread()); await editFeatureComposer(view, ''); await dismissFeatureMenu(view);
  await fireEvent.press(view.getByLabelText('选择文本'));
  await fireEvent(view.getByLabelText('选择消息正文'), 'selectionChange', { nativeEvent: { selection: { start: 2, end: 7 } } });
  await fireEvent.press(view.getByText('添加到对话'));
  expect(mockSend).not.toHaveBeenCalled();
  await fireEvent.changeText(view.getByLabelText('注释 1 的评论'), '解释这部分');
  await act(async () => { jest.advanceTimersByTime(450); });
  expect(mockComposerSave.mock.calls.at(-1)?.[2].featureIntent?.contextReferences).toEqual([expect.objectContaining({
    messageId: 'selection-source', text: '😀\n后段', startOffset: 2, endOffset: 7, textBasis: 'source', annotation: '解释这部分', sourceRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
  })]);
  await fireEvent.press(view.getByLabelText('完成编辑注释 1'));
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledWith('pc', originalSession.sessionKey, '', expect.objectContaining({ contextReferences: [expect.objectContaining({
    messageId: 'selection-source', text: '😀\n后段', annotation: '解释这部分',
  })] }));
  expect(mockContinue).not.toHaveBeenCalled();
});

test('annotation regression: selecting transcript text preserves an existing composer @ query', async () => {
  enableFeatures(); Object.assign(mockRemote.agents.pc.list[0].capabilities!, { contextReferences: true, contextAnnotations: true });
  const view = await render(viewThread()); await editFeatureComposer(view, '保留 @file');
  await fireEvent.press(view.getByLabelText('选择文本'));
  await fireEvent(view.getByLabelText('选择消息正文'), 'selectionChange', { nativeEvent: { selection: { start: 0, end: 2 } } });
  await fireEvent.press(view.getByText('添加到对话'));
  expect(featureComposerText(view)).toBe('保留 @file'); expect(mockSend).not.toHaveBeenCalled();
});

test('annotation regression: older Bridge does not expose a selection action it cannot preserve', async () => {
  enableFeatures(); mockRemote.agents.pc.list[0].capabilities!.contextReferences = true;
  const view = await render(viewThread());
  expect(view.queryByLabelText('选择文本')).toBeNull();
});

async function openSideQuestionWorkspace(view: Awaited<ReturnType<typeof render>>, history = false) {
  if (view.queryByLabelText('打开工具栏')) await fireEvent.press(view.getByLabelText('打开工具栏'));
  if (history) { await fireEvent.press(view.getByLabelText('添加工具标签')); await fireEvent.press(view.getByLabelText('新标签页更多')); await fireEvent.press(view.getByLabelText('打开侧问历史标签')); return; }
  if (view.queryByRole('tab', { name: '侧边聊天' })) { await fireEvent.press(view.getByRole('tab', { name: '侧边聊天' })); return; }
  await fireEvent.press(view.getByLabelText('添加工具标签'));
  await fireEvent.press(view.getByLabelText('打开侧边聊天标签'));
}

test('side question regression: selected text opens independent questions without changing composer or main timeline', async () => {
  enableFeatures(); mockHubSideQuestion = true;
  Object.assign(mockRemote.agents.pc.list[0].capabilities!, { contextReferences: true, contextAnnotations: true, sideQuestion: true });
  const view = await render(viewThread()); await editFeatureComposer(view, '保留主对话草稿');
  await fireEvent.press(view.getByLabelText('选择文本'));
  await fireEvent(view.getByLabelText('选择消息正文'), 'selectionChange', { nativeEvent: { selection: { start: 0, end: 2 } } });
  await fireEvent.press(view.getByText('在侧边聊天中提问'));
  expect(mockReadTemporarySideChat).toHaveBeenCalledTimes(1); expect(mockAskTemporarySideChat).not.toHaveBeenCalled(); expect(mockReadSideQuestion).not.toHaveBeenCalled();
  expect(view.getAllByLabelText('临时侧边聊天输入', { includeHiddenElements: true })).toHaveLength(1);
  expect(view.getByText('侧边聊天是临时聊天，关闭应用后会消失。')).toBeTruthy();
  await fireEvent.changeText(view.getByLabelText('临时侧边聊天输入'), '解释所选片段');
  await fireEvent.press(view.getByLabelText('发送临时聊天'));
  expect(mockAskTemporarySideChat).toHaveBeenCalledWith('pc', 'codex:original', expect.anything(), expect.objectContaining({
    question: '解释所选片段', selection: expect.objectContaining({ text: '原来', textBasis: 'source', messageId: 'old-reply' }),
  }), expect.any(String));
  expect(view.getByText('临时解释结果')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('返回聊天'));
  expect(featureComposerText(view)).toBe('保留主对话草稿'); expect(mockSend).not.toHaveBeenCalled(); expect(mockContinue).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
});

test('side question regression: source change isolates the temporary sidebar conversation', async () => {
  enableFeatures(); mockHubSideQuestion = true;
  Object.assign(mockRemote.agents.pc.list[0].capabilities!, { contextReferences: true, contextAnnotations: true, sideQuestion: true });
  const view = await render(viewThread());
  await fireEvent.press(view.getByLabelText('选择文本'));
  await fireEvent(view.getByLabelText('选择消息正文'), 'selectionChange', { nativeEvent: { selection: { start: 0, end: 2 } } });
  await fireEvent.press(view.getByText('在侧边聊天中提问'));
  await fireEvent.changeText(view.getByLabelText('临时侧边聊天输入'), '原API临时草稿');
  mockRemote.agents.pc.list[0].api = { ...mockRemote.agents.pc.list[0].api, accountId: 'api_backup' };
  await view.rerender(viewThread());
  expect(view.queryByDisplayValue('原API临时草稿')).toBeNull(); expect(mockAskTemporarySideChat).not.toHaveBeenCalled();
});

test('side question regression: offline cold page restores private history without cached profiles or send authority', async () => {
  enableFeatures(); mockHubSideQuestion = true;
  Object.assign(mockRemote.agents.pc.list[0].capabilities!, { contextReferences: true, contextAnnotations: true, sideQuestion: true });
  let view = await render(viewThread()); await openSideQuestionWorkspace(view, true); await fireEvent.press(view.getByLabelText('新建侧问'));
  await fireEvent.changeText(view.getByLabelText('侧问问题'), '保存侧问'); await fireEvent.press(view.getByLabelText('发送侧问'));
  await fireEvent.changeText(view.getByLabelText('侧问问题'), '未发送侧问草稿'); await view.unmount();
  resetSideQuestionConversationsForTests(); mockRemote.agents = {}; mockRemote.connection = 'error'; mockRemote.devices = mockRemote.devices.map(device => ({ ...device, online: false }));
  mockReadSideQuestion.mockClear();
  view = await render(viewThread()); await openSideQuestionWorkspace(view, true);
  expect(view.getByText('独立解释结果')).toBeTruthy(); expect(view.getByLabelText('侧问问题').props.value).toBe('未发送侧问草稿');
  await fireEvent.press(view.getByLabelText('发送侧问')); expect(mockAskSideQuestion).toHaveBeenCalledTimes(1); expect(mockReadSideQuestion).not.toHaveBeenCalled();
  mockDeliveryScope = 'paired|different-credential'; await view.rerender(viewThread());
  expect(view.queryByText('独立解释结果')).toBeNull(); expect(view.queryByLabelText('侧问问题')).toBeNull();
});

test('side question regression: one sidebar owner survives resizing and keeps hidden drafts without background reads', async () => {
  const original = Dimensions.get('window');
  try {
    Dimensions.set({ window: { ...original, width: 390, height: 844 } });
    enableFeatures(); mockHubSideQuestion = true;
    Object.assign(mockRemote.agents.pc.list[0].capabilities!, { contextReferences: true, contextAnnotations: true, sideQuestion: true });
    const view = await render(viewThread()); await editFeatureComposer(view, '主聊草稿');
    await fireEvent.press(view.getByLabelText('选择文本'));
    await fireEvent(view.getByLabelText('选择消息正文'), 'selectionChange', { nativeEvent: { selection: { start: 0, end: 2 } } });
    await fireEvent.press(view.getByText('在侧边聊天中提问'));
    expect(mockReadTemporarySideChat).toHaveBeenCalledTimes(1);
    await fireEvent.changeText(view.getByLabelText('临时侧边聊天输入'), '侧栏未发送草稿');
    await act(async () => Dimensions.set({ window: { ...original, width: 1280, height: 900 } }));
    expect(view.getAllByLabelText('临时侧边聊天输入', { includeHiddenElements: true })).toHaveLength(1);
    expect(view.getByLabelText('临时侧边聊天输入').props.value).toBe('侧栏未发送草稿'); expect(mockReadTemporarySideChat).toHaveBeenCalledTimes(1);
    await act(async () => Dimensions.set({ window: { ...original, width: 390, height: 844 } }));
    expect(mockReadTemporarySideChat).toHaveBeenCalledTimes(1);
    const staleSend = view.getByLabelText('发送临时聊天').props.onPress;
    await fireEvent.press(view.getByLabelText('添加工具标签'));
    expect(view.queryByLabelText('临时侧边聊天输入')).toBeNull(); expect(mockReadTemporarySideChat).toHaveBeenCalledTimes(1);
    await act(async () => staleSend()); expect(mockAskTemporarySideChat).not.toHaveBeenCalled();
    await fireEvent.press(view.getByRole('tab', { name: '侧边聊天' }));
    expect(view.getByLabelText('临时侧边聊天输入').props.value).toBe('侧栏未发送草稿'); expect(mockReadTemporarySideChat).toHaveBeenCalledTimes(1);
    expect(view.queryByTestId('remote-conversation')).toBeNull(); expect(mockSend).not.toHaveBeenCalled(); expect(mockAskTemporarySideChat).not.toHaveBeenCalled();
    await fireEvent.press(view.getByLabelText('返回聊天'));
    expect(featureComposerText(view)).toBe('主聊草稿');
    expect(view.queryByLabelText('临时侧边聊天输入')).toBeNull(); expect(mockReadTemporarySideChat).toHaveBeenCalledTimes(1);
    await view.unmount();
  } finally { await act(async () => Dimensions.set({ window: original })); }
});

test('side question regression: a bridge or hub missing support keeps only the annotation action', async () => {
  enableFeatures(); Object.assign(mockRemote.agents.pc.list[0].capabilities!, { contextReferences: true, contextAnnotations: true, sideQuestion: true });
  const view = await render(viewThread());
  await fireEvent.press(view.getByLabelText('选择文本'));
  await fireEvent(view.getByLabelText('选择消息正文'), 'selectionChange', { nativeEvent: { selection: { start: 0, end: 2 } } });
  expect(view.queryByText('在侧边聊天中提问')).toBeNull(); expect(view.getByText('添加到对话')).toBeTruthy(); expect(mockReadSideQuestion).not.toHaveBeenCalled();
});

test('feature regression: pending receipt recovery cannot leak the previous skill into an image-only send', async () => {
  enableFeatures(); const view = await render(viewThread());
  await editFeatureComposer(view, '/review 原任务', 7); await fireEvent.press(view.getByLabelText('选择技能 review，/review'));
  const requestId = '0199aaa1-1234-4678-9abc-000000000001';
  mockPending.mockResolvedValue({ scope: mockDeliveryScope, deviceId: 'pc', sessionKey: originalSession.sessionKey, surface: 'cli', text: '原任务',
    requestId, createdAt: Date.now(), attempted: true, safeRetry: true });
  mockSend.mockRejectedValueOnce(new DeliveryPendingError('confirming', true, requestId, true));
  await fireEvent.press(view.getByLabelText('发送'));
  expect(featureComposerText(view)).toBe(''); expect(mockComposerConsume).toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('更多')); await fireEvent.press(view.getByLabelText('重试原消息'));
  expect(mockSend).toHaveBeenLastCalledWith('pc', originalSession.sessionKey, '原任务', { retryRequestId: requestId });
  const image: RemoteImage = { uri: 'file://picker/after-pending.jpg', base64: 'fixture', mime: 'image/jpeg', width: 40, height: 40 };
  mockPickImages.mockResolvedValueOnce([image]);
  await fireEvent.press(view.getByRole('button', { name: '添加到对话' })); await fireEvent.press(view.getByLabelText('从相册选择'));
  await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenCalledTimes(3); expect(mockSend.mock.calls[2][2]).toBe('');
  expect(mockSend.mock.calls[2][3]).toMatchObject({ images: [image] }); expect(mockSend.mock.calls[2][3]).not.toHaveProperty('skills');
});

test('feature regression: closing and reopening the same composer restores selected path and plan metadata', async () => {
  enableFeatures();
  const first = { name: 'review', path: 'C:/fixture/first/SKILL.md', description: 'First review' };
  const second = { name: 'review', path: 'C:/fixture/second/SKILL.md', description: 'Second review' };
  mockFeatures.mockResolvedValue({ collaborationModes: ['default', 'plan'], skillsSupported: true, skills: [first, second] });
  let persisted: ComposerDraft | undefined;
  mockComposerSave.mockImplementation(async (_key, scope, draft) => {
    persisted = JSON.parse(JSON.stringify({ ...draft, scope, revision: 4, imageCount: draft.images.length })) as ComposerDraft;
    return persisted;
  });
  const view = await render(viewThread());
  await editFeatureComposer(view, '/plan'); await fireEvent.press(view.getByLabelText('选择计划模式，/plan'));
  await editFeatureComposer(view, '/review 解释 $review 语法', 7);
  await fireEvent.press(view.getByLabelText(`选择技能 review，/review，${second.path}`));
  const expectedText = featureComposerText(view);
  await view.rerender(viewThread(undefined, false));
  expect(persisted?.featureIntent).toMatchObject({ collaborationMode: 'plan', skills: [{ name: 'review', path: second.path }],
    mentions: [{ start: 0, end: 7, skill: { name: 'review', path: second.path } }] });
  mockComposerRestore.mockResolvedValueOnce(persisted);
  await view.rerender(viewThread());
  expect(featureComposerText(view)).toBe(expectedText); expect(view.getByLabelText('关闭计划模式')).toBeTruthy();
  await dismissFeatureMenu(view); await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenLastCalledWith('pc', originalSession.sessionKey, '解释 $review 语法', expect.objectContaining({
    collaborationMode: 'plan', skills: [{ name: 'review', path: second.path }],
  }));
});

test.each(['restored', 'selected'] as const)('feature regression: %s intent blocks API migration and works again only at its original source', async origin => {
  enableFeatures(); const originalProfile = mockRemote.agents.pc.list[0];
  if (origin === 'restored') mockComposerRestore.mockResolvedValueOnce(featureDraftFixture());
  const view = await render(viewThread());
  if (origin === 'selected') {
    await editFeatureComposer(view, '/review 解释 $review 语法', 7); await fireEvent.press(view.getByLabelText('选择技能 review，/review'));
  }
  const before = featureComposerText(view);
  const oldEdit = view.getByLabelText('给电脑上的 Agent 发消息').props.onChangeText;
  mockRemote.agents.pc.list = [{ ...originalProfile, api: { ...originalProfile.api, accountId: 'api_backup' } }];
  await view.rerender(viewThread());
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.editable).toBe(false);
  expect(view.getByLabelText('清除其他来源的模式、技能和引用')).toBeTruthy();
  await act(async () => { oldEdit('cannot replace the frozen source'); });
  await fireEvent.press(view.getByLabelText('发送'));
  expect(featureComposerText(view)).toBe(before); expect(mockSend).not.toHaveBeenCalled();
  mockRemote.agents.pc.list = [originalProfile]; await view.rerender(viewThread());
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.editable).toBe(true);
  expect(view.queryByLabelText('清除其他来源的模式、技能和引用')).toBeNull();
  await dismissFeatureMenu(view); await fireEvent.press(view.getByLabelText('发送'));
  expect(mockSend).toHaveBeenLastCalledWith('pc', originalSession.sessionKey, '解释 $review 语法', expect.objectContaining({
    skills: [{ name: 'review', path: 'C:/fixture/SKILL.md' }],
  }));
});

test('feature regression: explicitly clearing mismatched restored intent keeps literal body and persists the removal', async () => {
  enableFeatures(); mockComposerRestore.mockResolvedValueOnce(featureDraftFixture());
  mockRemote.agents.pc.list[0] = { ...mockRemote.agents.pc.list[0], api: { ...originalAgent.api, accountId: 'api_backup' } };
  const view = await render(viewThread());
  expect(featureComposerText(view)).toBe('$review 解释 $review 语法');
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.editable).toBe(false);
  await fireEvent.press(view.getByLabelText('清除其他来源的模式、技能和引用'));
  expect(featureComposerText(view)).toBe(' 解释 $review 语法');
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.editable).toBe(true);
  await act(async () => { jest.advanceTimersByTime(450); });
  const saved = mockComposerSave.mock.calls.at(-1)?.[2];
  expect(saved?.text).toBe(' 解释 $review 语法'); expect(saved?.featureIntent).toBeUndefined();
});

test('feature regression: an API change during restore preserves the original source and blocks its late metadata', async () => {
  enableFeatures(); let release!: (draft: ComposerDraft) => void;
  mockComposerRestore.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const view = await render(viewThread());
  mockRemote.agents.pc.list[0] = { ...mockRemote.agents.pc.list[0], api: { ...originalAgent.api, accountId: 'api_backup' } };
  await view.rerender(viewThread()); await act(async () => { release(featureDraftFixture()); });
  expect(featureComposerText(view)).toBe('$review 解释 $review 语法');
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.editable).toBe(false);
  await fireEvent.press(view.getByLabelText('发送')); expect(mockSend).not.toHaveBeenCalled();
});

test('feature regression: continuing a restored mode-only draft durably clears its consumed mode', async () => {
  enableFeatures(); mockComposerRestore.mockResolvedValueOnce(featureDraftFixture(true));
  setItems([{ kind: 'turn', id: 'turn:terminal', turnId: 'turn-terminal', status: 'completed', ts: 2, seq: 2 }],
    { ...originalSession, status: 'idle', lastTerminalTurnId: 'turn-terminal' });
  mockRemote.timelines['pc|codex:original'].snapshotAt = Date.now();
  const view = await render(viewThread());
  expect(view.getByLabelText('关闭计划模式')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('继续'));
  expect(mockContinue).toHaveBeenCalledWith('pc', originalSession.sessionKey, expect.objectContaining({ collaborationMode: 'plan' }));
  expect(view.queryByLabelText('关闭计划模式')).toBeNull();
  await act(async () => { jest.advanceTimersByTime(450); });
  expect(mockComposerSave).toHaveBeenCalled();
  const saved = mockComposerSave.mock.calls.at(-1)?.[2];
  expect(saved).toMatchObject({ text: '', images: [] }); expect(saved?.featureIntent).toBeUndefined();
});


test('confirmed missing session restores the same project and mode only after persisting the draft, without sending', async () => {
  mockRemote.devices[0].projects = [{ path: originalSession.cwd, name: 'fixture' }];
  const timeline = mockRemote.timelines['pc|codex:original'];
  timeline.error = '找不到这个会话'; timeline.readErrorCode = 'session_not_found';
  const onNew = jest.fn();
  const view = await render(<ThreadView visible deviceId="pc" sessionKey="codex:original" agent={originalAgent} workspaceMode="work" onClose={jest.fn()} onCreated={jest.fn()} onNew={onNew} />);
  await fireEvent.press(view.getByLabelText('恢复草稿到新对话'));
  expect(mockCopyMissing).toHaveBeenCalledWith(expect.objectContaining({ sourceKey: `${mockDeliveryScope}|pc|codex:original`,
    targetKey: `${mockDeliveryScope}|pc|new:codex:work:${encodeURIComponent(originalSession.cwd)}`,
    origin: expect.objectContaining({ deviceId: 'pc', agentId: 'codex', cwd: originalSession.cwd, mode: 'work', sessionKey: 'codex:original' }) }));
  expect(onNew).toHaveBeenCalledWith('work', originalSession.cwd); expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
});
test('a connection failure never offers to move the draft to a different session', async () => {
  mockRemote.timelines['pc|codex:original'].error = '电脑离线';
  const view = await render(viewThread());
  expect(view.queryByLabelText('恢复草稿到新对话')).toBeNull(); expect(mockCopyMissing).not.toHaveBeenCalled();
});

test('missing-session recovery refuses a removed project and leaves the source draft intact', async () => {
  mockRemote.timelines['pc|codex:original'].readErrorCode = 'session_not_found';
  const onNew = jest.fn();
  const view = await render(<ThreadView visible deviceId="pc" sessionKey="codex:original" agent={originalAgent} onClose={jest.fn()} onCreated={jest.fn()} onNew={onNew} />);
  await fireEvent.press(view.getByLabelText('恢复草稿到新对话'));
  expect(view.getByText('原项目当前不可用，草稿已保留，请先在电脑恢复该项目')).toBeTruthy();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
  expect(mockCopyMissing).not.toHaveBeenCalled(); expect(onNew).not.toHaveBeenCalled(); expect(mockSend).not.toHaveBeenCalled();
});

test.each([false, true])('restored Hub draft keeps undo until a later user edit (edited=%s)', async edited => {
  mockRemote.devices[0].projects = [{ path: originalSession.cwd, name: 'fixture' }];
  mockRemote.timelines['pc|codex:original'].readErrorCode = 'session_not_found';
  const onNew = jest.fn();
  const props = { visible: true, deviceId: 'pc', agent: originalAgent, onClose: jest.fn(), onCreated: jest.fn(), onNew };
  const view = await render(<ThreadView {...props} sessionKey="codex:original" />);
  await fireEvent.press(view.getByLabelText('恢复草稿到新对话'));
  expect(onNew).toHaveBeenCalledWith('code', originalSession.cwd);
  mockComposerRestore.mockResolvedValue({ scope: mockDeliveryScope, text: '原草稿', images: [], imageCount: 0, revision: 1, identity: 'restored' });
  await view.rerender(<ThreadView {...props} sessionKey={null} newProjectPath={originalSession.cwd} />);
  mockComposerSave.mockClear();
  await act(async () => { jest.advanceTimersByTime(1000); });
  expect(mockComposerSave).not.toHaveBeenCalled();
  if (edited) await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'), '后续编辑');
  await fireEvent.press(view.getByLabelText('撤销草稿恢复'));
  if (edited) {
    expect(mockUndoMissing).not.toHaveBeenCalled();
    expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('后续编辑');
  } else {
    expect(mockUndoMissing).toHaveBeenCalledTimes(1);
    expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('');
  }
  expect(mockSend).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
});

test('approval expands full selectable details without deciding, and resets for the next request', async () => {
  const approval: TimelineItem = { kind: 'approval', id: 'approval-full', approval: 'command', title: '检查项目', detail: 'git status\n'.repeat(12), state: 'pending', ts: Date.now(), expiresAt: Date.now() + 60000 };
  setItems([approval], { ...originalSession, status: 'waiting_approval' });
  const view = await render(viewThread());
  expect(view.queryByTestId('approval-full-details')).toBeNull();
  await fireEvent.press(view.getByLabelText('查看完整审批详情'));
  expect(view.getByTestId('approval-full-details')).toBeTruthy();
  expect(mockRespond).not.toHaveBeenCalled();
  setItems([{ ...approval, id: 'approval-next', detail: 'git diff\n'.repeat(12) }], { ...originalSession, status: 'waiting_approval' });
  await view.rerender(viewThread());
  expect(view.queryByTestId('approval-full-details')).toBeNull();
  expect(view.getByLabelText('查看完整审批详情')).toBeTruthy(); expect(mockRespond).not.toHaveBeenCalled();
});

test('a new task without a project never chooses the first folder, restores an unscoped draft or enables sending', async () => {
  mockRemote.devices[0].projects = [{ path: 'C:/Projects/Other', name: 'Other' }];
  const onClose = jest.fn();
  const view = await render(<ThreadView visible deviceId="pc" sessionKey={null} agent={originalAgent} onClose={onClose} onCreated={jest.fn()} />);
  expect(mockComposerRestore).not.toHaveBeenCalled(); expect(mockPendingNew).not.toHaveBeenCalled();
  expect(view.getByLabelText('发送').props.accessibilityState.disabled).toBe(true);
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('');
  await fireEvent.press(view.getByLabelText('返回项目目录'));
  expect(onClose).toHaveBeenCalledTimes(1); expect(mockStart).not.toHaveBeenCalled();
});

test.each(['save', 'copy'] as const)('switching API during missing-draft %s cancels navigation and rolls back only a completed copy', async stage => {
  mockRemote.devices[0].projects = [{ path: originalSession.cwd, name: 'fixture' }];
  mockRemote.timelines['pc|codex:original'].readErrorCode = 'session_not_found';
  let finish!: () => void;
  const onNew = jest.fn(), props = { visible: true, deviceId: 'pc', sessionKey: 'codex:original', agent: originalAgent, onClose: jest.fn(), onCreated: jest.fn(), onNew };
  const view = await render(<ThreadView {...props} />);
  if (stage === 'save') mockComposerSave.mockImplementationOnce(async (_key, scope, draft) => {
    await new Promise<void>(resolve => { finish = resolve; });
    return { ...draft, scope, revision: 2, identity: 'saved', imageCount: draft.images.length };
  });
  else mockCopyMissing.mockImplementationOnce(async input => {
    await new Promise<void>(resolve => { finish = resolve; });
    return { receipt: { scope: input.scope, sourceKey: input.sourceKey, targetKey: input.targetKey, targetRevision: 1, targetIdentity: 'restored', targetOrigin: { ...input.origin, sessionKey: undefined } }, draft: { text: '原草稿', images: [], imageCount: 0 } };
  });
  await fireEvent.press(view.getByLabelText('恢复草稿到新对话'));
  expect(finish).toBeDefined();
  mockRemote.agents.pc.list = [{ ...originalAgent, api: { ...originalAgent.api, accountId: 'other-api' } }];
  await view.rerender(<ThreadView {...props} />);
  await act(async () => { finish(); });
  expect(onNew).not.toHaveBeenCalled(); expect(mockSend).not.toHaveBeenCalled();
  if (stage === 'copy') expect(mockUndoMissing).toHaveBeenCalledTimes(1);
  else expect(mockCopyMissing).not.toHaveBeenCalled();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
});


test('local file import preserves whitespace-only edits arriving during durable save',async()=>{
 const view=await render(viewThread());await act(async()=>{});const input=view.getByLabelText('给电脑上的 Agent 发消息');
 await fireEvent.changeText(input,'原草稿');
 let finish!:(value:ComposerDraft)=>void;const pending=new Promise<ComposerDraft>(resolve=>{finish=resolve;});mockComposerSave.mockImplementationOnce(()=>pending);
 let operation!:Promise<boolean>;await act(async()=>{operation=mockFileDrop.onFiles({texts:[{name:'notes.md',text:'exact file'}],images:[]});});const outcome=operation.catch(reason=>reason);
 const saved=mockComposerSave.mock.calls.find(([, ,draft])=>draft.text.includes('notes.md'))![2];
 await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'),'原草稿  \n');
 await act(async()=>finish({...saved,imageCount:saved.imageCount??saved.images.length,scope:mockDeliveryScope,revision:4,identity:'import'}));
 expect((await outcome).message).toContain('草稿已变化');expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿  \n');
 expect(mockComposerSave.mock.calls.at(-1)![2].text).toBe('原草稿  \n');expect(mockSend).not.toHaveBeenCalled();await view.unmount();
});

test('local file import opens existing file chips without sending or replacing the instruction',async()=>{
 const view=await render(viewThread());await act(async()=>{});await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'),'保留指令');
 let accepted=false;await act(async()=>{accepted=await mockFileDrop.onFiles({texts:[{name:'file.ts',text:'  const x=1;\n'}],images:[]});});
 expect(accepted).toBe(true);expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('保留指令');expect(view.getByLabelText('预览文本附件 file.ts')).toBeTruthy();expect(mockSend).not.toHaveBeenCalled();await view.unmount();
});

function enableLatestEdit(){
 mockHubRevert=true;enablePermissionModes();mockRemote.agents.pc.list[0].capabilities!.latestTurnRevert=true;
 const message:Extract<TimelineItem,{kind:'message'}>={kind:'message',id:'edit-user',turnId:'edit-turn',role:'user',text:'original prompt',final:true,ts:2};
 setItems([message,{kind:'message',id:'edit-answer',role:'assistant',text:'original answer',turnId:'edit-turn',final:true,ts:3},{kind:'turn',id:'edit-end',turnId:'edit-turn',status:'completed',ts:4}],{...originalSession,latestTurnRevert:true});
 mockRemote.timelines['pc|codex:original'].snapshotAt=Date.now();return message;
}
test('latest message edit backs up first, reverts then resends without replacing the main draft',async()=>{
 const message=enableLatestEdit(),view=await render(viewThread());await act(async()=>{});
 const signal=new AbortController();let accepted=false;
 mockRevertLatest.mockImplementationOnce(async()=>{signal.abort();});
 await act(async()=>{accepted=await mockThreadUi.mock.calls.at(-1)![0].onEditMessage(message,'revised prompt',signal.signal);});
 expect(accepted).toBe(true);expect(mockRevertLatest).toHaveBeenCalledTimes(1);expect(mockSend).toHaveBeenCalledWith('pc','codex:original','revised prompt',expect.objectContaining({newSubmission:true,accountId:'api_original'}));
 expect(mockEditBackupSave.mock.calls.map(([draft])=>JSON.parse(draft.text).phase)).toEqual(['prepared','reverting','reverted','sending']);
 expect(mockEditBackupSave.mock.invocationCallOrder[1]).toBeLessThan(mockRevertLatest.mock.invocationCallOrder[0]);
 expect(mockRevertLatest.mock.invocationCallOrder[0]).toBeLessThan(mockSend.mock.invocationCallOrder[0]);
 expect(mockEditBackupConsume).toHaveBeenCalledTimes(1);expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('原草稿');
 await view.unmount();
});
test('latest message edit never resends after an unconfirmed revert and retains the revised text',async()=>{
 const message=enableLatestEdit();mockRevertLatest.mockRejectedValueOnce(new Error('回退结果未确认'));
 const view=await render(viewThread());await act(async()=>{});let failure:unknown;
 await act(async()=>{try{await mockThreadUi.mock.calls.at(-1)![0].onEditMessage(message,'keep revised',new AbortController().signal);}catch(error){failure=error;}});
 expect(String(failure)).toContain('未确认');expect(mockSend).not.toHaveBeenCalled();expect(mockEditBackupConsume).not.toHaveBeenCalled();
 expect(JSON.parse(mockEditBackupSave.mock.calls.at(-1)![0].text)).toMatchObject({text:'keep revised',phase:'reverting'});
 expect(view.getByLabelText('查看未完成的消息编辑')).toBeTruthy();await view.unmount();
});
test('latest message edit cannot continue on another API after remote revert completes',async()=>{
 const message=enableLatestEdit();let finish!:()=>void;mockRevertLatest.mockImplementationOnce(()=>new Promise<void>(resolve=>{finish=resolve;}));
 const view=await render(viewThread());await act(async()=>{});let operation!:Promise<boolean>;
 await act(async()=>{operation=mockThreadUi.mock.calls.at(-1)![0].onEditMessage(message,'keep revised',new AbortController().signal);});
 mockRemote.agents.pc.list=[{...mockRemote.agents.pc.list[0],api:{...originalAgent.api,accountId:'api_other'}}];await view.rerender(viewThread());
 await act(async()=>finish());expect(await operation).toBe(false);expect(mockSend).not.toHaveBeenCalled();expect(mockEditBackupConsume).not.toHaveBeenCalled();await view.unmount();
});


test('edit recovery restores text, original image and context without replacing the current draft or sending',async()=>{
 enableLatestEdit();
 const op='b3d117de-91f8-4850-b1a7-425848c809f2';
 const image={uri:'file:///saved-revision.png',mime:'image/png' as const,width:20,height:20,base64:'eA=='};
 mockEditBackupRestore.mockResolvedValue({scope:mockDeliveryScope,revision:3,identity:'backup',imageCount:1,images:[image],text:JSON.stringify({version:1,text:'保留的修改',features:{skills:[{name:'review',path:'C:/fixture/SKILL.md'}]},phase:'reverted',messageId:'user',turnId:'turn',operationId:op})});
 const view=await render(viewThread());await act(async()=>{});
 await fireEvent.press(view.getByLabelText('查看未完成的消息编辑'));await fireEvent.press(view.getByLabelText('恢复修改到输入框'));await act(async()=>{});
 expect(mockSkillComposerProps.mock.calls.at(-1)![0].value).toContain('原草稿\n\n保留的修改');
 expect(mockComposerSave.mock.calls.some(([, ,row])=>row.lastRestoredEdit===op&&row.images[0]?.uri===image.uri&&row.featureIntent?.skills?.[0]?.name==='review')).toBe(true);
 expect(mockEditBackupConsume).toHaveBeenCalledTimes(1);expect(mockSend).not.toHaveBeenCalled();await view.unmount();
});

test('latest message edit restores a definitively rejected send as an unsent backup',async()=>{
 const message=enableLatestEdit();mockSend.mockRejectedValueOnce(new Error('API rejected this request'));
 const view=await render(viewThread());await act(async()=>{});
 await act(async()=>{await expect(mockThreadUi.mock.calls.at(-1)![0].onEditMessage(message,'Keep revised',new AbortController().signal)).rejects.toThrow('电脑未接收修正版');});
 expect(JSON.parse(mockEditBackupSave.mock.calls.at(-1)![0].text).phase).toBe('reverted');expect(mockEditBackupConsume).not.toHaveBeenCalled();await view.unmount();
});

test('latest message edit retains an unknown delivery backup even when its receipt cannot be loaded',async()=>{
 const message=enableLatestEdit();mockSend.mockRejectedValueOnce(new DeliveryPendingError('送达状态未确认',false,'0199aaa1-1234-4678-9abc-000000000001',true));
 const view=await render(viewThread());await act(async()=>{});
 await act(async()=>{await expect(mockThreadUi.mock.calls.at(-1)![0].onEditMessage(message,'Keep uncertain revision',new AbortController().signal)).rejects.toThrow('尚未确认送达');});
 expect(JSON.parse(mockEditBackupSave.mock.calls.at(-1)![0].text).phase).toBe('sending');expect(mockEditBackupConsume).not.toHaveBeenCalled();
 await fireEvent.press(view.getByLabelText('查看未完成的消息编辑'));expect(view.queryByLabelText('恢复修改到输入框')).toBeNull();expect(view.getByLabelText('核对消息编辑状态')).toBeTruthy();await view.unmount();
});

test('edit recovery shows the authoritative restored draft even when the legacy text mirror fails',async()=>{
 enableLatestEdit();
 const op='b3d117de-91f8-4850-b1a7-425848c809f2';
 mockEditBackupRestore.mockResolvedValue({scope:mockDeliveryScope,revision:3,identity:'backup',imageCount:0,images:[],text:JSON.stringify({version:1,text:'恢复我的修改',features:{},phase:'reverted',messageId:'user',turnId:'turn',operationId:op})});
 const view=await render(viewThread());await act(async()=>{});
 mockSaveDraft.mockRejectedValueOnce(new Error('Legacy mirror unavailable'));
 await fireEvent.press(view.getByLabelText('查看未完成的消息编辑'));await fireEvent.press(view.getByLabelText('恢复修改到输入框'));await act(async()=>{});
 expect(mockSkillComposerProps.mock.calls.at(-1)![0].value).toBe('原草稿\n\n恢复我的修改');expect(mockEditBackupConsume).toHaveBeenCalledTimes(1);expect(mockSend).not.toHaveBeenCalled();await view.unmount();
});

test('edit recovery preserves whitespace typed while the restored snapshot is saving',async()=>{
 enableLatestEdit();
 const op='b3d117de-91f8-4850-b1a7-425848c809f2';
 mockEditBackupRestore.mockResolvedValue({scope:mockDeliveryScope,revision:3,identity:'backup',imageCount:0,images:[],text:JSON.stringify({version:1,text:'恢复我的修改',features:{},phase:'reverted',messageId:'user',turnId:'turn',operationId:op})});
 const view=await render(viewThread());await act(async()=>{});
 let finish!:()=>void;mockComposerSave.mockImplementationOnce(async(_key,scope,draft)=>{await new Promise<void>(resolve=>{finish=resolve;});return {...draft,scope,revision:4,identity:'restored',imageCount:0};});
 await fireEvent.press(view.getByLabelText('查看未完成的消息编辑'));await fireEvent.press(view.getByLabelText('恢复修改到输入框'));
 await act(async()=>{mockSkillComposerProps.mock.calls.at(-1)![0].onChangeText?.('原草稿  \n');});
 await act(async()=>finish());
 expect(mockSkillComposerProps.mock.calls.at(-1)![0].value).toBe('原草稿  \n');expect(mockEditBackupConsume).not.toHaveBeenCalled();
 expect(mockComposerSave).toHaveBeenLastCalledWith(expect.any(String),mockDeliveryScope,expect.objectContaining({text:'原草稿  \n',lastRestoredEdit:''}));await view.unmount();
});
