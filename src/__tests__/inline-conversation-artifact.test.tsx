import React from 'react';
import {act,fireEvent,render,waitFor} from '@testing-library/react-native';
import {InlineConversationArtifact} from '../remote/InlineConversationArtifact';
import {ConversationArtifactPreview} from '../remote/ConversationArtifactPreview';
import {conversationArtifactRevision,validConversationArtifact} from '../remote/conversation-artifact-target';
let mockRenderer:any;
const mockSettings=new Map<string,string>();
jest.mock('../storage/database',()=>({getSetting:jest.fn(async(key:string)=>mockSettings.get(key)??null),setSetting:jest.fn(async(key:string,value:string|null)=>{if(value===null)mockSettings.delete(key);else mockSettings.set(key,value);})}));
jest.mock('../components/InteractiveArtifact',()=>({InteractiveArtifact:(props:any)=>{mockRenderer=props;return null;}}));
test('a replacement block cannot submit a selection from its previous revision',async()=>{
 const compose=jest.fn((_text:string)=>true);
 const view=await render(<InlineConversationArtifact scopeKey="pc/session" messageId="answer" index={0} source="<p>old</p>" onCompose={compose}/>);
 const oldAnnotation=mockRenderer.onAnnotate;
 await act(async()=>oldAnnotation({quote:'old',comment:'替换旧文'}));
 await view.rerender(<InlineConversationArtifact scopeKey="pc/session" messageId="answer" index={0} source="<p>new</p>" onCompose={compose}/>);
 expect(view.queryByLabelText('交互内容修改要求')).toBeNull();
 await act(async()=>oldAnnotation({quote:'old',comment:'迟到批注'}));expect(compose).not.toHaveBeenCalled();expect(view.queryByLabelText('交互内容修改要求')).toBeNull();
 await act(async()=>mockRenderer.onAnnotate({quote:''}));await fireEvent.changeText(view.getByLabelText('交互内容修改要求'),'调整新文');await waitFor(()=>expect(view.getByLabelText('保存界面批注')).not.toBeDisabled());await fireEvent.press(view.getByLabelText('保存界面批注'));expect(compose).not.toHaveBeenCalled();await fireEvent.press(view.getByLabelText('将交互内容批注添加到对话'));
 expect(compose).toHaveBeenCalledWith(expect.stringContaining('调整新文'));expect(compose.mock.calls[0][0]).not.toContain('旧文');
});

test('a generated interface exposes a preview card and only an explicit click opens its exact source',async()=>{
 const open=jest.fn(),compose=jest.fn(),source='<title>项目概览</title><main>Interactive UI</main>';
 const view=await render(<InlineConversationArtifact scopeKey="pc/api/session" messageId="result" index={1} source={source} onOpen={open} onCompose={compose}/>);
 expect(open).not.toHaveBeenCalled();expect(mockRenderer.readOnlyState).toBe(true);expect(mockRenderer.onAnnotate).toBeUndefined();
 expect(view.queryByLabelText('批注交互内容')).toBeNull();
 await fireEvent.press(view.getByLabelText('打开界面预览 项目概览'));
 expect(open).toHaveBeenCalledTimes(1);expect(validConversationArtifact(open.mock.calls[0][0],'pc/api/session')).toBe(true);
 await view.rerender(<InlineConversationArtifact scopeKey="other/session" messageId="result" index={1} source={source} onOpen={open}/>);
 await fireEvent.press(view.getByLabelText('打开界面预览 项目概览'));
 expect(open).toHaveBeenCalledTimes(2);expect(open.mock.calls[1][0].scopeKey).toBe('other/session');expect(compose).not.toHaveBeenCalled();
});

test('preview/source switches retain the live page and annotations still refer to its original message',async()=>{
 const source='<h1>UI</h1>',compose=jest.fn(()=>true),target={scopeKey:'pc/session',messageId:'result',index:0,source,title:'UI',revision:conversationArtifactRevision(source)};
 const view=await render(<ConversationArtifactPreview target={target} onCompose={compose}/>);
 expect(mockRenderer.inline).toBe(false);
 await fireEvent.press(view.getByLabelText('界面源码'));
 expect(view.getByText(source)).toBeTruthy();expect(view.getByTestId('artifact-live-preview',{includeHiddenElements:true})).toHaveStyle({display:'none'});
 await fireEvent.press(view.getByLabelText('界面预览'));
 expect(view.queryByLabelText('批注交互内容')).toBeNull();
 await act(async()=>mockRenderer.onAnnotate({quote:''}));await fireEvent.changeText(view.getByLabelText('交互内容修改要求'),'让标题小一点');
 await waitFor(()=>expect(view.getByLabelText('保存界面批注')).not.toBeDisabled());await fireEvent.press(view.getByLabelText('保存界面批注'));expect(compose).not.toHaveBeenCalled();
 await fireEvent.press(view.getByLabelText('将交互内容批注添加到对话'));
 expect(compose).toHaveBeenCalledWith(expect.stringContaining('原消息：result'));
 expect(compose).toHaveBeenCalledWith(expect.stringContaining('让标题小一点'));
 expect(validConversationArtifact({...target,source:'different'},target.scopeKey)).toBe(false);
});
