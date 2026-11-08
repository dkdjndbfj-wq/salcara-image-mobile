import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { DemoWorkspaceFiles } from '../remote/DemoWorkspaceFiles';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => {}) }));
jest.mock('../components/ui', () => ({ showToast: jest.fn() }));

const rootPath = 'D:\\Projects\\salcara-web';
const files = {
  'README.md': '# Example project\n',
  'src/App.tsx': 'export const App = () => null;\n',
  'src/auth/index.ts': 'export const signIn = () => true;\n',
  'src/shared/index.ts': 'export const shared = true;\n',
};

test('wide demo browser starts empty, expands a real hierarchy and previews before opening a file tab', async () => {
  const open = jest.fn(), view = await render(<DemoWorkspaceFiles files={files} rootPath={rootPath} onOpenFile={open}/>);
  await fireEvent(view.getByTestId('workspace-file-browser'), 'layout', { nativeEvent: { layout: { width: 733, height: 800 } } });
  expect(view.getByText('从工作区目录树中选择文件')).toBeTruthy();
  expect(view.getByLabelText('当前工作区目录').props.accessibilityHint).toBe(rootPath);
  expect(view.getByLabelText('打开目录 src')).toBeTruthy();
  expect(view.getByLabelText('打开文件 README.md')).toBeTruthy();
  expect(view.queryByLabelText('打开目录 auth')).toBeNull();
  await fireEvent.press(view.getByLabelText('文件更多'));
  expect(view.queryByLabelText('在新标签页打开')).toBeNull();
  await fireEvent.press(view.getByLabelText('复制项目路径'));
  expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith(rootPath);
  expect(view.queryByTestId('workspace-file-actions')).toBeNull();
  await fireEvent.press(view.getByLabelText('打开目录 src'));
  await fireEvent.press(view.getByLabelText('打开目录 auth'));
  expect(view.getByLabelText('打开文件 README.md')).toBeTruthy();
  expect(view.getByLabelText('打开文件 App.tsx')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('打开文件 index.ts'));
  expect(view.getByTestId('demo-workspace-file-content').props.children).toBe(files['src/auth/index.ts']);
  expect(view.getByTestId('workspace-file-tree')).toBeTruthy();
  expect(open).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('文件更多'));
  await fireEvent.press(view.getByLabelText('在新标签页打开'));
  expect(open).toHaveBeenCalledWith('src/auth/index.ts');
  expect(view.queryByTestId('workspace-file-actions')).toBeNull();
  await view.unmount();
});

test('phone preview replaces the tree and returning preserves ancestor and child expansion', async () => {
  const open = jest.fn(), view = await render(<DemoWorkspaceFiles files={files} rootPath={rootPath} onOpenFile={open}/>);
  await fireEvent.press(view.getByLabelText('打开目录 src'));
  await fireEvent.press(view.getByLabelText('打开目录 auth'));
  await fireEvent.press(view.getByLabelText('打开文件 index.ts'));
  expect(view.getByLabelText('文件内容 src/auth/index.ts')).toBeTruthy();
  expect(view.queryByTestId('workspace-file-tree')).toBeNull();
  await fireEvent.press(view.getByLabelText('返回文件目录'));
  expect(view.getByLabelText('打开目录 src').props.accessibilityState).toMatchObject({ expanded: true });
  expect(view.getByLabelText('打开目录 auth').props.accessibilityState).toMatchObject({ expanded: true });
  expect(view.getByLabelText('打开文件 index.ts')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('打开目录 src'));
  expect(view.queryByLabelText('打开文件 index.ts')).toBeNull();
  await fireEvent.press(view.getByLabelText('打开目录 src'));
  expect(view.getByLabelText('打开文件 index.ts')).toBeTruthy();
  expect(open).not.toHaveBeenCalled();
  await view.unmount();
});

test('filtering nested paths selects the exact same-named file and clearing restores the collapsed tree', async () => {
  const open = jest.fn(), view = await render(<DemoWorkspaceFiles files={files} rootPath={rootPath} onOpenFile={open}/>);
  await fireEvent.changeText(view.getByLabelText('筛选文件'), 'shared/index.ts');
  expect(view.queryByLabelText('打开目录 auth')).toBeNull();
  await fireEvent.press(view.getByLabelText('打开文件 index.ts'));
  expect(view.getByTestId('demo-workspace-file-content').props.children).toBe(files['src/shared/index.ts']);
  await fireEvent.press(view.getByLabelText('文件更多'));
  await fireEvent.press(view.getByLabelText('在新标签页打开'));
  expect(open).toHaveBeenCalledWith('src/shared/index.ts');
  await fireEvent.press(view.getByLabelText('返回文件目录'));
  await fireEvent.press(view.getByLabelText('清除文件筛选'));
  expect(view.queryByLabelText('打开目录 shared')).toBeNull();
  expect(view.getByLabelText('打开目录 src').props.accessibilityState).toMatchObject({ expanded: false });
  await view.unmount();
});

test('dismissing the anchored file menu keeps the selected preview and directory filter',async()=>{
  const open=jest.fn(),view=await render(<DemoWorkspaceFiles files={files} rootPath={rootPath} onOpenFile={open}/>);
  await fireEvent.changeText(view.getByLabelText('筛选文件'),'shared/index.ts');
  await fireEvent.press(view.getByLabelText('打开文件 index.ts'));
  await fireEvent.press(view.getByLabelText('文件更多'));
  expect(view.getByLabelText('在新标签页打开')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('关闭文件操作'));
  expect(view.queryByTestId('workspace-file-actions')).toBeNull();
  expect(view.getByLabelText('文件更多').props.accessibilityState.expanded).toBe(false);
  expect(view.getByTestId('demo-workspace-file-content').props.children).toBe(files['src/shared/index.ts']);
  expect(open).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('返回文件目录'));
  expect(view.getByLabelText('筛选文件').props.value).toBe('shared/index.ts');
  await view.unmount();
});
