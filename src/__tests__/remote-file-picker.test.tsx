import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { RemoteFilePicker, sortWorkspaceEntries } from '../remote/RemoteFilePicker';

const mockCapture = jest.fn();
jest.mock('../remote/workspace-files', () => ({
  captureWorkspaceFiles: (...args: unknown[]) => mockCapture('session', ...args),
  captureProjectWorkspaceFiles: (...args: unknown[]) => mockCapture('project', ...args),
}));
jest.mock('../components/ui', () => ({
  Sheet: ({ children, footer }: { children: React.ReactNode; footer?: React.ReactNode }) => <>{children}{footer}</>,
}));

const root = {
  path: '',
  entries: [
    { name: 'z.ts', path: 'z.ts', kind: 'file' as const, size: 5 },
    { name: 'src', path: 'src', kind: 'directory' as const },
    { name: 'a.ts', path: 'a.ts', kind: 'file' as const, size: 3 },
  ],
  truncated: false,
};
const source = { path: 'src/app.ts', text: 'const value = 1;', size: 16, modifiedAt: 1 };

test('stable file ordering puts directories first and compares names naturally', () => {
  expect(sortWorkspaceEntries(root.entries).map(item => item.path)).toEqual(['src', 'a.ts', 'z.ts']);
});

test('computer picker navigates directories, preserves selection and adds bounded references', async () => {
  const list = jest.fn().mockResolvedValueOnce(root).mockResolvedValueOnce({ path: 'src', entries: [{ name: 'app.ts', path: 'src/app.ts', kind: 'file', size: source.size }], truncated: false });
  const read = jest.fn().mockResolvedValue(source);
  mockCapture.mockReturnValue({ list, read, dispose: jest.fn() });
  const onAdd = jest.fn();
  const view = await render(<RemoteFilePicker visible deviceId="pc" deviceName="工作电脑" sessionKey="codex:thread" agentId="codex" cwd="C:/project" scope="scope" onClose={jest.fn()} onAdd={onAdd} />);
  expect(view.getByText('src')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('打开目录 src'));
  await act(async () => undefined);
  await fireEvent.press(view.getByLabelText('选择文件 app.ts'));
  await fireEvent.press(view.getByLabelText('添加所选文件'));
  expect(read).toHaveBeenCalledWith('src/app.ts');
  expect(onAdd).toHaveBeenCalledWith([expect.objectContaining({ kind: 'file', sessionKey: 'codex:thread', path: 'src/app.ts', text: source.text, startLine: 1, endLine: 1 })]);
});
