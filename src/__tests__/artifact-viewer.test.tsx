import React from 'react';
import {act,fireEvent,render,waitFor} from '@testing-library/react-native';
import {ArtifactViewer} from '../components/ArtifactViewer';
import type {ArtifactPayload} from '../remote/conversation-artifacts';
let mockInteractive:any;
jest.mock('../components/InteractiveArtifact',()=>({InteractiveArtifact:(props:any)=>{mockInteractive=props;return null;}}));
jest.mock('../remote/artifact-export',()=>({exportArtifact:jest.fn()}));
jest.mock('../storage/database',()=>({getSetting:jest.fn(async()=>null),setSetting:jest.fn(async()=>{})}));
const first:ArtifactPayload={artifact:{id:'artifact_text',path:'report.txt',name:'report.txt',kind:'text',mime:'text/plain',size:8,revision:'a'.repeat(64),updatedAt:1},encoding:'utf8',content:'Original'};
const next:ArtifactPayload={...first,artifact:{...first.artifact,revision:'b'.repeat(64),size:6},content:'Edited'};

test('preview selection opens one native annotation editor and requires explicit draft handoff',async()=>{
 const onAnnotate=jest.fn();const view=await render(<ArtifactViewer artifact={first.artifact} scopeKey="selection-editor" load={async()=>first} onAnnotate={onAnnotate}/>);
 await waitFor(()=>expect(mockInteractive?.onAnnotate).toBeDefined());
 await act(async()=>mockInteractive.onAnnotate({quote:'Original'}));
 expect(onAnnotate).not.toHaveBeenCalled();expect(view.getByLabelText('文件批注')).toBeTruthy();
 await fireEvent.changeText(view.getByLabelText('文件批注'),'改小标题');await fireEvent.press(view.getByLabelText('将文件批注添加到对话'));
 expect(onAnnotate).toHaveBeenCalledWith(expect.objectContaining({quote:'Original',comment:'改小标题',revision:first.artifact.revision}));
});
test('a conflicting save keeps local editing, blocks stale annotations, and confirms discarding before reload',async()=>{
 const load=jest.fn(async()=>first),save=jest.fn(async()=>{throw Error('revision conflict');}),onClose=jest.fn(),onAnnotate=jest.fn();
 const view=await render(<ArtifactViewer artifact={first.artifact} scopeKey="conflict" load={load} save={save} onClose={onClose} onAnnotate={onAnnotate}/>);
 await waitFor(()=>expect(view.getByText('源码')).toBeTruthy());await fireEvent.press(view.getByText('源码'));await fireEvent.changeText(view.getByLabelText('文件源码'),'Edited');
 expect(view.queryByLabelText('文件批注')).toBeNull();await fireEvent.press(view.getByLabelText('保存文件'));expect(save).toHaveBeenCalledWith(first.artifact,'Edited',first.artifact.revision,expect.any(AbortSignal));
 expect(view.getByText('revision conflict')).toBeTruthy();expect(view.getByLabelText('文件源码').props.value).toBe('Edited');
 await fireEvent.press(view.getByLabelText('关闭文件预览'));expect(onClose).not.toHaveBeenCalled();await fireEvent.press(view.getByText('继续编辑'));
 load.mockResolvedValueOnce(next);await fireEvent.press(view.getByLabelText('文件预览更多'));await fireEvent.press(view.getByLabelText('重新读取文件'));await fireEvent.press(view.getByText('放弃草稿并重新读取'));await waitFor(()=>expect(view.queryByText('revision conflict')).toBeNull());expect(load).toHaveBeenCalledTimes(2);
 expect(onAnnotate).not.toHaveBeenCalled();
});
test('confirmed save updates annotation revision and current content',async()=>{
 const annotate=jest.fn(),dirty=jest.fn();const view=await render(<ArtifactViewer artifact={first.artifact} scopeKey="saved" load={async()=>first} save={async()=>next} onAnnotate={annotate} onDirtyChange={dirty}/>);
 await waitFor(()=>expect(view.getByText('源码')).toBeTruthy());await fireEvent.press(view.getByText('源码'));await fireEvent.changeText(view.getByLabelText('文件源码'),'Edited');await fireEvent.press(view.getByLabelText('保存文件'));
 expect(view.getByText('已保存到电脑')).toBeTruthy();await fireEvent.changeText(view.getByLabelText('文件批注'),'更新摘要');await fireEvent.press(view.getByText('加入对话'));expect(annotate).toHaveBeenCalledWith(expect.objectContaining({revision:next.artifact.revision,path:'report.txt',comment:'更新摘要'}));expect(dirty).toHaveBeenLastCalledWith(false);
});
test('a late load from a replaced computer cannot overwrite the new viewer',async()=>{
 let finish!:(value:ArtifactPayload)=>void;const deferred=new Promise<ArtifactPayload>(resolve=>{finish=resolve;});
 const view=await render(<ArtifactViewer artifact={first.artifact} scopeKey="computer-a" load={()=>deferred}/>);
 await view.rerender(<ArtifactViewer artifact={first.artifact} scopeKey="computer-b" load={async()=>next}/>);await waitFor(()=>expect(view.getByText('源码')).toBeTruthy());
 await act(async()=>finish(first));await fireEvent.press(view.getByText('源码'));expect(view.getByLabelText('文件源码').props.value).toBe('Edited');
});
test('a load failure has a usable retry and never presents a blank successful preview',async()=>{
 const load=jest.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValueOnce(first);const view=await render(<ArtifactViewer artifact={first.artifact} scopeKey="retry" load={load}/>);
 await waitFor(()=>expect(view.getByText('offline')).toBeTruthy());await fireEvent.press(view.getByText('重新加载'));await waitFor(()=>expect(view.getByText('源码')).toBeTruthy());expect(view.queryByText('offline')).toBeNull();
});
