import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { PROMO } from '../promo';
import { WorkspaceNewPage, WorkspaceTabBar } from '../remote/WorkspaceTabs';

test('new tabs show three primary tools and keep optional tools in the more menu', async () => {
  const onOpen=jest.fn(), view=await render(<WorkspaceNewPage onOpen={onOpen}/>);
  expect(view.getByRole('header',{name:'工具'})).toBeTruthy();
  expect(view.getByRole('header',{name:'推荐'})).toBeTruthy();
  expect(view.getAllByRole('button',{name:/^打开.+标签$/})).toHaveLength(3);
  expect(view.queryByLabelText('打开子智能体标签')).toBeNull();
  expect(view.queryByLabelText('打开变更标签')).toBeNull();
  expect(onOpen).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('新标签页更多'));
  expect(view.getByTestId('workspace-new-page-menu')).toBeTruthy();
  expect(view.getByLabelText('打开执行记录标签')).toBeTruthy();
  expect(view.getByLabelText('打开浏览器标签')).toBeTruthy();
  expect(view.queryByLabelText('打开侧问历史标签')).toBeNull();
  await fireEvent.press(view.getByLabelText('打开子智能体标签'));
  expect(onOpen).toHaveBeenCalledWith({id:'agents',kind:'agents',title:'子智能体'});
  expect(view.queryByLabelText('打开子智能体标签')).toBeNull();
});

test.each([
  ['文件','files'],['侧边聊天','side-chat'],['终端','terminal'],
])('the %s primary tool retains its existing open callback', async (title,kind) => {
  const onOpen=jest.fn(), view=await render(<WorkspaceNewPage onOpen={onOpen}/>);
  await fireEvent.press(view.getByLabelText(`打开${title}标签`));
  expect(onOpen).toHaveBeenCalledWith({id:kind,kind,title});
});

test('history appears only when supplied and dismissing the menu opens no page', async () => {
  const onOpen=jest.fn(), view=await render(<WorkspaceNewPage onOpen={onOpen} historyAvailable/>);
  await fireEvent.press(view.getByLabelText('新标签页更多'));
  expect(view.getByLabelText('打开侧问历史标签')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('关闭新标签页更多'));
  expect(view.queryByLabelText('打开侧问历史标签')).toBeNull();
  expect(onOpen).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('新标签页更多'));
  await fireEvent.press(view.getByLabelText('打开侧问历史标签'));
  expect(onOpen).toHaveBeenCalledWith({id:'side-history',kind:'side-history',title:'侧问历史'});
});

test('new tabs omit unusable browser navigation and download controls', async () => {
  const onOpen=jest.fn(), view=await render(<WorkspaceNewPage onOpen={onOpen}/>);
  for(const label of ['网页后退','网页前进','刷新网页','网页下载']) {
    expect(view.queryByLabelText(label)).toBeNull();
  }
  expect(onOpen).not.toHaveBeenCalled();
});

test.each([
  ['example.com/docs','https://example.com/docs','web'],
  ['localhost:3000','http://localhost:3000/','local-service'],
  ['如何调试页面','https://www.google.com/search?q=%E5%A6%82%E4%BD%95%E8%B0%83%E8%AF%95%E9%A1%B5%E9%9D%A2','web'],
])('address %s opens only after explicit submission', async (address,url,kind) => {
  const onOpen=jest.fn(), view=await render(<WorkspaceNewPage onOpen={onOpen}/>);
  await fireEvent.changeText(view.getByLabelText('新标签页地址或搜索'),address);
  expect(onOpen).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('打开地址或搜索'));
  expect(onOpen).toHaveBeenCalledWith({id:'browser',kind:'preview',title:new URL(url).hostname,preview:{kind,url}});
});

test('keyboard submission validates addresses and unsafe schemes never open a page', async () => {
  const onOpen=jest.fn(), view=await render(<WorkspaceNewPage onOpen={onOpen}/>);
  const input=view.getByLabelText('新标签页地址或搜索');
  for(const address of ['','javascript:alert(1)','https://user:password@example.com']) {
    await fireEvent.changeText(input,address);
    await fireEvent(input,'submitEditing',{nativeEvent:{text:address}});
  }
  expect(onOpen).not.toHaveBeenCalled();
  await fireEvent.changeText(input,'example.com');
  await fireEvent(input,'submitEditing',{nativeEvent:{text:'example.com'}});
  expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({preview:{kind:'web',url:'https://example.com/'}}));
});

test('the recommendation uses the configured official site only when clicked', async () => {
  const onOpen=jest.fn(), view=await render(<WorkspaceNewPage onOpen={onOpen}/>);
  expect(view.getByText('Salcara AI')).toBeTruthy();
  expect(onOpen).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('打开 Salcara AI 官网'));
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onOpen).toHaveBeenCalledWith({id:'browser',kind:'preview',title:new URL(PROMO.url).hostname,preview:{kind:'web',url:new URL(PROMO.url).href}});
});

test('legacy review tabs display the new title while retaining accessibility and close behavior', async () => {
  const onSelect=jest.fn(),onClose=jest.fn(),page={id:'changes',kind:'changes' as const,title:'审查'};
  const view=await render(<WorkspaceTabBar pages={[page]} activeId="changes" onSelect={onSelect} onClose={onClose} onAdd={jest.fn()}/>);
  expect(view.getByText('变更')).toBeTruthy();
  await fireEvent.press(view.getByRole('tab',{name:'工具栏改动'}));
  expect(onSelect).toHaveBeenCalledWith(page);
  await fireEvent.press(view.getByLabelText('关闭标签 审查'));
  expect(onClose).toHaveBeenCalledWith('changes');
});
