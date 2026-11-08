import React from 'react';
import {act, fireEvent, render} from '@testing-library/react-native';
import {ConversationChangesCard, ConversationPreviewCard, groupFileChanges} from '../remote/ConversationArtifacts';
import {BlockRow, ThreadUi} from '../remote/thread-rows';
import {buildBlocks, conversationBlocks, type FileEdit} from '../remote/blocks';

const edits:FileEdit[]=[{id:'a',path:'src/a.ts',add:20,del:5,diff:'@@ -1 +1 @@\n-old\n+new\n',status:'done'},
 {id:'b',path:'src/b.ts',add:32,del:0,diff:'@@ -1 +1 @@\n-old\n+new\n',status:'done'}];
function pressHandler(view:Awaited<ReturnType<typeof render>>,label:string){
 let fiber=view.getByLabelText(label).unstable_fiber;
 while(fiber){if(typeof fiber.memoizedProps?.onPress==='function')return fiber.memoizedProps.onPress as ()=>void;fiber=fiber.return;}
 throw new Error(`Missing handler: ${label}`);
}
test('summary preserves real per-file stats and opens the whole group or one file',async()=>{
 const review=jest.fn(),open=jest.fn();const view=await render(<ConversationChangesCard files={edits} onOpenFile={open} onReview={review}/>);
 expect(view.getByText('已编辑 2 个文件')).toBeTruthy();expect(view.getByText('+52')).toBeTruthy();
 await fireEvent.press(view.getByLabelText('查看本组文件变更'));expect(review).toHaveBeenCalledWith(edits);
 await fireEvent.press(view.getByLabelText('查看修改文件 src/a.ts'));expect(open).toHaveBeenCalledWith(edits[0]);
});
test('undo requires explicit in-app confirmation and retains partial results honestly',async()=>{
 const undo=jest.fn(async()=>({message:'已撤销 1 个文件，其余存在冲突',restoredPaths:['src/a.ts']}));
 const view=await render(<ConversationChangesCard files={edits} onOpenFile={jest.fn()} onReview={jest.fn()} onUndo={undo}/>);
 await fireEvent.press(view.getByLabelText('撤销本组文件变更'));expect(undo).not.toHaveBeenCalled();
 await fireEvent.press(view.getByLabelText('确认撤销文件变更'));
 expect(undo).toHaveBeenCalledWith(edits);expect(view.getByText('已撤销 1 个文件，其余存在冲突')).toBeTruthy();
 expect(view.queryByText('已撤销 2 个文件')).toBeNull();
});
test('incomplete changes cannot be undone and repeated paths remain a single row',async()=>{
 const undo=jest.fn();const duplicate={...edits[0],id:'later',status:'running' as const};
 const view=await render(<ConversationChangesCard files={[...edits,duplicate]} onOpenFile={jest.fn()} onReview={jest.fn()} onUndo={undo}/>);
 await fireEvent.press(view.getByLabelText('撤销本组文件变更'));expect(undo).not.toHaveBeenCalled();
 expect(view.getByText('正在编辑 2 个文件')).toBeTruthy();expect(groupFileChanges([...edits,duplicate])[0].add).toBe(40);
});
test('web preview focuses the exact page identity only after a user action',async()=>{
 const open=jest.fn();const navigation={action:'open' as const,url:'https://example.com/',pageId:'desktop:2'};
 const view=await render(<ConversationPreviewCard navigation={navigation} onOpen={open}/>);expect(open).not.toHaveBeenCalled();
 await fireEvent.press(view.getByLabelText('打开网页预览 https://example.com/'));expect(open).toHaveBeenCalledWith(navigation);
});
test('preview open menu contains only three immediate actions and dismisses outside',async()=>{
 const open=jest.fn(),navigation={action:'open' as const,url:'https://example.com/',pageId:'desktop:2'};
 const view=await render(<ConversationPreviewCard navigation={navigation} onOpen={open}/>);
 await fireEvent.press(view.getByLabelText('网页预览打开方式'));
 expect(view.getByTestId('preview-open-menu')).toBeTruthy();
 expect(view.getByRole('button',{name:'在应用内打开'})).toBeTruthy();
 expect(view.getByRole('button',{name:'在浏览器打开'})).toBeTruthy();
 expect(view.getByRole('button',{name:'复制链接'})).toBeTruthy();
 expect(view.queryByText('打开网页预览')).toBeNull();
 expect(view.queryAllByRole('radio')).toHaveLength(0);
 await fireEvent.press(view.getByTestId('preview-open-menu-backdrop'));
 expect(view.queryByTestId('preview-open-menu')).toBeNull();expect(open).not.toHaveBeenCalled();
 await fireEvent.press(view.getByLabelText('网页预览打开方式'));
 const action=pressHandler(view,'在应用内打开');
 await act(async()=>{action();action();});
 expect(open).toHaveBeenCalledTimes(1);expect(open).toHaveBeenCalledWith(navigation);
 expect(view.queryByTestId('preview-open-menu')).toBeNull();
 await fireEvent.press(view.getByLabelText('网页预览打开方式'));
 await act(async()=>action());expect(open).toHaveBeenCalledTimes(1);
});
test('preview navigation changes retire the previous menu and local-only URLs keep external opening disabled',async()=>{
 const open=jest.fn(),first={action:'open' as const,url:'https://example.com/',pageId:'desktop:2'},next={...first,url:'http://localhost:5173/',pageId:'desktop:3'};
 const view=await render(<ConversationPreviewCard navigation={first} onOpen={open}/>);
 await fireEvent.press(view.getByLabelText('网页预览打开方式'));
 const oldAction=pressHandler(view,'在应用内打开');
 await view.rerender(<ConversationPreviewCard navigation={next} onOpen={open}/>);
 expect(view.queryByTestId('preview-open-menu')).toBeNull();
 await act(async()=>oldAction());expect(open).not.toHaveBeenCalled();
 await fireEvent.press(view.getByLabelText('网页预览打开方式'));
 expect(view.getByRole('button',{name:'在浏览器打开'}).props.accessibilityState.disabled).toBe(true);
 await fireEvent.press(view.getByRole('button',{name:'在应用内打开'}));expect(open).toHaveBeenCalledWith(next);
});
test('successful structured browser tools become cards even when activity details are collapsed',async()=>{
 const open=jest.fn();const blocks=conversationBlocks(buildBlocks([{kind:'tool',id:'nav',tool:'other',title:'浏览器',status:'done',ts:1,browser:{action:'open',url:'https://example.com/'}}],false));
 const view=await render(<ThreadUi.Provider value={{openBrowser:open,openDiff:jest.fn(),openImage:jest.fn(),requestAttachment:jest.fn()}}><BlockRow block={blocks[0]} tool="codex" onOpenChild={jest.fn()}/></ThreadUi.Provider>);
 expect(view.getByTestId('conversation-preview-card')).toBeTruthy();expect(open).not.toHaveBeenCalled();
 await act(async()=>{await fireEvent.press(view.getByLabelText('打开网页预览 https://example.com/'));});expect(open).toHaveBeenCalledTimes(1);
});
