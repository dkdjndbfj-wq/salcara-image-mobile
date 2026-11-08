import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { ContextReferencePicker, type ContextReferencePickerHandle } from '../remote/ContextReferencePicker';
import type { WorkspaceFilesPage, WorkspaceFileText } from '../remote/workspace-files';
const mockList = jest.fn<Promise<WorkspaceFilesPage>, [string?, string?]>();
const mockRead = jest.fn<Promise<WorkspaceFileText>, [string]>();
const mockDispose = jest.fn();
let mockScope = 'source-a';
const mockSessionReader = jest.fn(() => ({ list: mockList, read: mockRead, dispose: mockDispose }));
const mockProjectReader = jest.fn(() => ({ list: mockList, read: mockRead, dispose: mockDispose }));
jest.mock('../remote/workspace-files', () => ({ captureWorkspaceFiles: (...args: unknown[]) => (mockSessionReader as jest.Mock)(...args), captureProjectWorkspaceFiles: (...args: unknown[]) => (mockProjectReader as jest.Mock)(...args) }));
jest.mock('../remote/store', () => ({ remoteDeliveryScope: () => mockScope, openSession: jest.fn(), getRemoteState: () => ({ timelines: {} }), timelineKey: (a: string, b: string) => `${a}|${b}` }));
const props = { deviceId: 'pc', sessionKey: 'codex:one', agentId: 'codex', cwd: '/project', scope: 'source-a', query: '', messages: [], sessions: [], filesAllowed: false, onClose: jest.fn() };
beforeEach(() => { mockScope = 'source-a'; jest.clearAllMocks(); });

test('message reference preview preserves the exact selected code lines and offsets', async () => {
  const onSelect = jest.fn(); const text = '说明\n```ts\nconst value = 42;\n```\n结束';
  const view = await render(<ContextReferencePicker {...props} onSelect={onSelect} initial={{ kind: 'message', sessionKey: 'codex:one', label: 'Agent', messageId: 'm-1', text }} />);
  await fireEvent.changeText(view.getByLabelText('引用起始行'), '2'); await fireEvent.changeText(view.getByLabelText('引用结束行'), '4');
  await fireEvent.press(view.getByLabelText('添加所选引用'));
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'message', messageId: 'm-1', text: '```ts\nconst value = 42;\n```', startOffset: 3, endOffset: text.length - 3 }));
  await view.unmount();
});

test('invalid ranges and oversized content remain visible and never silently truncate', async () => {
  const onSelect = jest.fn(); const view = await render(<ContextReferencePicker {...props} onSelect={onSelect} initial={{ kind: 'file', sessionKey: 'codex:one', label: 'a.ts', path: 'a.ts', text: 'x'.repeat(32769) }} />);
  await fireEvent.press(view.getByLabelText('添加所选引用')); expect(onSelect).not.toHaveBeenCalled(); expect(view.getByText(/超过 32 KB/)).toBeTruthy();
  await fireEvent.changeText(view.getByLabelText('引用起始行'), '0'); await fireEvent.press(view.getByLabelText('添加所选引用'));
  expect(onSelect).not.toHaveBeenCalled(); expect(view.getByText('引用行范围无效')).toBeTruthy(); await view.unmount();
});

test('file search traverses admitted directories and reads content only on selection', async () => {
  mockList.mockImplementation(async path => ({ path: path ?? '', truncated: false, entries: path ? [{ name: 'main.ts', path: 'src/main.ts', kind: 'file', size: 5 }] : [{ name: 'src', path: 'src', kind: 'directory' }] }));
  mockRead.mockResolvedValue({ path: 'src/main.ts', text: 'a\nb\nc', size: 5, modifiedAt: 1 });
  const onSelect = jest.fn(); const view = await render(<ContextReferencePicker {...props} filesAllowed query="main" onSelect={onSelect} />);
  await act(async () => { await Promise.resolve(); });
  expect(mockRead).not.toHaveBeenCalled(); await fireEvent.press(view.getByText('src/main.ts'));
  await fireEvent.changeText(view.getByLabelText('引用起始行'), '2'); await fireEvent.changeText(view.getByLabelText('引用结束行'), '2');
  await fireEvent.press(view.getByLabelText('添加所选引用'));
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ path: 'src/main.ts', text: 'b', startLine: 2, endLine: 2 }));
  await view.unmount(); expect(mockDispose).toHaveBeenCalled();
});

test('a source change prevents adding a previously opened reference', async () => {
  const onSelect = jest.fn(); const view = await render(<ContextReferencePicker {...props} onSelect={onSelect} initial={{ kind: 'message', sessionKey: 'codex:one', label: 'Agent', messageId: 'm-1', text: 'original' }} />);
  mockScope = 'other-source'; await fireEvent.press(view.getByLabelText('添加所选引用')); expect(onSelect).not.toHaveBeenCalled(); await view.unmount();
});

test('first-task file references preserve project provenance without a session', async () => {
  mockList.mockResolvedValue({ path: '', entries: [{ name: 'main.ts', path: 'main.ts', kind: 'file', size: 5 }], truncated: false });
  mockRead.mockResolvedValue({ path: 'main.ts', text: 'a\nb\nc', size: 5, modifiedAt: 1 });
  const onSelect = jest.fn(); const view = await render(<ContextReferencePicker {...props} sessionKey={undefined} tool="codex" filesAllowed onSelect={onSelect} />);
  await act(async () => { await Promise.resolve(); }); await fireEvent.press(view.getByText('main.ts'));
  await fireEvent.press(view.getByLabelText('添加所选引用'));
  expect(mockSessionReader).not.toHaveBeenCalled(); expect(mockProjectReader).toHaveBeenCalledWith({ deviceId: 'pc', tool: 'codex', cwd: '/project' }, expect.anything());
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'file', projectPath: '/project', path: 'main.ts', text: 'a\nb\nc' }));
  expect(onSelect.mock.calls[0][0]).not.toHaveProperty('sessionKey'); await view.unmount();
});

test('rapid duplicate file taps share one read and closing cancels that reader', async () => {
  mockList.mockResolvedValue({ path: '', entries: [{ name: 'main.ts', path: 'main.ts', kind: 'file', size: 1 }], truncated: false });
  let resolve!: (value: WorkspaceFileText) => void; mockRead.mockReturnValue(new Promise(yes => { resolve = yes; }));
  const onSelect = jest.fn(), picker = React.createRef<ContextReferencePickerHandle>(); const view = await render(<ContextReferencePicker {...props} ref={picker} filesAllowed onSelect={onSelect} />);
  await act(async () => { await Promise.resolve(); });
  await act(async () => { picker.current!.keyDown('Enter'); picker.current!.keyDown('Enter'); });
  expect(mockRead).toHaveBeenCalledTimes(1); const previousDisposes = mockDispose.mock.calls.length;
  await view.unmount(); expect(mockDispose.mock.calls.length).toBeGreaterThan(previousDisposes);
  await act(async () => { resolve({ path: 'main.ts', text: 'a', size: 1, modifiedAt: 1 }); }); expect(onSelect).not.toHaveBeenCalled();
});
