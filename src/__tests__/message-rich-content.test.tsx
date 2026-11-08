import React from 'react';
import {render,fireEvent} from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import {MessageContent} from '../components/MessageContent';
jest.mock('../components/RichRenderedSurface',()=>({RichRenderedSurface:({kind,source,inline}:any)=>{const {Text}=require('react-native');return <Text testID={`render-${kind}${inline?'-inline':''}`}>{source}</Text>;}}));
test('complete Mermaid and math render through engines while streaming diagrams stay readable',async()=>{
 const view=await render(<MessageContent text={'行内 $x^2$\n\n$$\n\\frac{a}{b}\n$$\n\n```mermaid\nflowchart LR\nA-->B\n```'} />);
 expect(view.getByTestId('render-math-inline')).toBeTruthy();expect(view.getByTestId('render-math')).toBeTruthy();expect(view.getByTestId('render-mermaid')).toBeTruthy();
 await view.rerender(<MessageContent text={'```mermaid\nflowchart LR\nA-->'} streaming/>);expect(view.queryByTestId('render-mermaid')).toBeNull();expect(view.getByText('mermaid')).toBeTruthy();
});
test('diagram source toggle and copy preserve the exact original DSL',async()=>{
 const source='sequenceDiagram\n Alice->>Bob: Hello';const view=await render(<MessageContent text={'```mermaid\n'+source+'\n```'}/>);
 const surface=view.getByTestId('render-mermaid');
 await fireEvent.press(view.getByLabelText('查看渲染源码'));expect(view.queryByTestId('render-mermaid')).toBeNull();expect(view.getByText(source)).toBeTruthy();
 const spy=jest.spyOn(Clipboard,'setStringAsync');await fireEvent.press(view.getByLabelText('复制渲染源码'));expect(spy).toHaveBeenCalledWith(source);
 await fireEvent.press(view.getByLabelText('显示渲染内容'));expect(view.getByTestId('render-mermaid')).toBe(surface);
});
