import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { Keyboard, Platform, StyleSheet, Text } from 'react-native';
import { KeyboardSafeView, useKeyboardViewportHeight } from '../components/KeyboardSafeView';

let mockFrame = { x: 0, y: 54, width: 390, height: 790 };
let mockDeferred = false;
const mockMeasures: Array<(x:number,y:number,width:number,height:number)=>void> = [];
const mockWindow = { width: 390, height: 844, scale: 1, fontScale: 1 };
jest.mock('react-native', () => {
  const React = require('react'), native = jest.requireActual('react-native');
  return Object.create(Object.getPrototypeOf(native), { ...Object.getOwnPropertyDescriptors(native),
    useWindowDimensions: { value: () => mockWindow },
    View: { value: React.forwardRef((props:any,ref:any) => {
      React.useImperativeHandle(ref,()=>({measureInWindow:(callback:any)=>{
        if(mockDeferred)mockMeasures.push(callback);else callback(mockFrame.x,mockFrame.y,mockFrame.width,mockFrame.height);
      }}));
      return React.createElement(native.View,props);
    }) },
  });
});
const listeners = new Map<string,(event:any)=>void>();
const frame = (screenY=544,height=300,width=390,screenX=0) => ({screenX,screenY,width,height});
const event = (coordinates=frame()) => ({endCoordinates:coordinates,duration:0,easing:'keyboard'});
const emit = async (name:string, coordinates=frame()) => act(async()=>{listeners.get(name)?.(event(coordinates));});
const padding = (ui:Awaited<ReturnType<typeof render>>) => StyleSheet.flatten(ui.getByTestId('safe').props.style).paddingBottom ?? 0;
const ReadHeight = () => <Text testID="height">{useKeyboardViewportHeight()}</Text>;
beforeEach(()=>{
  listeners.clear();mockMeasures.length=0;mockDeferred=false;mockFrame={x:0,y:54,width:390,height:790};
  jest.replaceProperty(Platform,'OS','ios');
  jest.spyOn(Keyboard,'addListener').mockImplementation((name,callback)=>{listeners.set(name,callback);return {remove:()=>{listeners.delete(name);}} as ReturnType<typeof Keyboard.addListener>;});
  jest.spyOn(Keyboard,'metrics').mockReturnValue(undefined);
});
afterEach(()=>jest.restoreAllMocks());

test.each(['ios','android'] as const)('%s lifts the shared conversation/workspace only while covered',async os=>{
  jest.replaceProperty(Platform,'OS',os);const change=jest.fn();
  const ui=await render(<KeyboardSafeView testID="safe" style={{flex:1}} onOcclusionChange={change}><Text>主对话与侧聊</Text></KeyboardSafeView>);
  await emit(os==='ios'?'keyboardWillShow':'keyboardDidShow');
  expect(padding(ui)).toBe(300);expect(change).toHaveBeenLastCalledWith(true);
  await emit(os==='ios'?'keyboardWillHide':'keyboardDidHide');
  expect(padding(ui)).toBe(0);expect(change).toHaveBeenLastCalledWith(false);
  await ui.unmount();expect(listeners.size).toBe(0);
});

test('Android resize after the keyboard event removes the previously calculated padding',async()=>{
  jest.replaceProperty(Platform,'OS','android');const change=jest.fn();
  const ui=await render(<KeyboardSafeView testID="safe" style={{flex:1}} onOcclusionChange={change}><ReadHeight/></KeyboardSafeView>);
  await emit('keyboardDidShow');expect(padding(ui)).toBe(300);
  mockFrame.height=490;
  await fireEvent(ui.getByTestId('safe'),'layout',{nativeEvent:{layout:{x:0,y:54,width:390,height:490}}});
  expect(padding(ui)).toBe(0);expect(change).toHaveBeenLastCalledWith(true);
  expect(ui.getByTestId('height').props.children).toBe(490);
});

test('mounting with an already visible keyboard reads current geometry',async()=>{
  jest.mocked(Keyboard.metrics).mockReturnValue(frame());
  const ui=await render(<KeyboardSafeView testID="safe" style={{flex:1}}><Text>恢复会话</Text></KeyboardSafeView>);
  expect(padding(ui)).toBe(300);
});

test('a delayed show measurement cannot restore padding after hide or unmount',async()=>{
  const change=jest.fn();const ui=await render(<KeyboardSafeView testID="safe" onOcclusionChange={change}><Text>编辑</Text></KeyboardSafeView>);
  mockDeferred=true;await emit('keyboardWillShow');const old=mockMeasures.shift()!;
  await emit('keyboardWillHide');await act(async()=>old(0,54,390,790));expect(padding(ui)).toBe(0);
  await emit('keyboardWillShow');const unmounted=mockMeasures.shift()!;await ui.unmount();const calls=change.mock.calls.length;
  await act(async()=>unmounted(0,54,390,790));expect(change).toHaveBeenCalledTimes(calls);
});

test('latest keyboard frame wins even when measurement callbacks finish out of order',async()=>{
  const ui=await render(<KeyboardSafeView testID="safe"><Text>编辑</Text></KeyboardSafeView>);
  mockDeferred=true;await emit('keyboardWillShow');const old=mockMeasures.shift()!;
  await emit('keyboardWillChangeFrame',frame(500,344));const latest=mockMeasures.shift()!;
  await act(async()=>{latest(0,54,390,790);old(0,54,390,790);});expect(padding(ui)).toBe(344);
});

test('iPad floating and external keyboards do not reserve a full keyboard gap',async()=>{
  mockFrame={x:0,y:64,width:1194,height:770};
  const ui=await render(<KeyboardSafeView testID="safe" style={{paddingBottom:12}}><Text>平板编辑</Text></KeyboardSafeView>);
  await emit('keyboardWillShow',frame(500,334,1194));expect(padding(ui)).toBe(334);
  await emit('keyboardWillChangeFrame',frame(320,260,320,700));expect(padding(ui)).toBe(12);
  await emit('keyboardWillChangeFrame',frame(834,0,1194));expect(padding(ui)).toBe(12);
});
