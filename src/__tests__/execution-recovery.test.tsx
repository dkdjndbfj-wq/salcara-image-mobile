import React from 'react';
import {act,fireEvent,render} from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import {executionRecovery} from '../remote/execution-recovery';
import {ExecutionFailureActions} from '../remote/ExecutionFailureActions';
const mockPresses=new Map<string,()=>void>();
jest.mock('react-native',()=>{const actual=jest.requireActual('react-native'),React=require('react');const value=Object.create(actual);Object.defineProperty(value,'Pressable',{value:(props:any)=>{if(props.accessibilityLabel)mockPresses.set(props.accessibilityLabel,props.onPress);return React.createElement(actual.Pressable,props);}});return value;});
jest.mock('expo-clipboard',()=>({setStringAsync:jest.fn(async()=>{})}));
test.each([
 ['upstream_unauthorized','api',false],['usage_limit','api',true],['upstream_rate_limit','api',true],['model_capacity','model',true],
 ['context_limit','new',false],['session_budget','new',false],['policy_rejected',undefined,false],['sandbox_error',undefined,false],
 ['computer_offline','connection',false],['response_stream_interrupted','connection',true],
] as const)('typed %s keeps the correct action even when text mentions invalid API key', (code,action,retry)=>{
 const value=executionRecovery('invalid API key HTTP 401',code);expect(value.action).toBe(action);expect(value.retry).toBe(retry);
});
test('legacy model errors open the model picker and generic failures retain safe retry',()=>{
 expect(executionRecovery('model_not_found')).toMatchObject({action:'model',retry:false});
 expect(executionRecovery('unknown tool failure')).toMatchObject({retry:true});
});
test('API failure opens recovery only on explicit click and does not expose blind retry',async()=>{
 const resolve=jest.fn(),retry=jest.fn(),view=await render(<ExecutionFailureActions id="turn-a" scopeKey="pc-a" error="bad key" code="upstream_unauthorized" onResolve={resolve} onRetry={retry}/>);
 expect(resolve).not.toHaveBeenCalled();expect(view.queryByLabelText('重试上一条消息')).toBeNull();
 await fireEvent.press(view.getByLabelText('检查 API'));expect(resolve).toHaveBeenCalledWith('api');expect(retry).not.toHaveBeenCalled();await view.unmount();
});
test('old error callbacks cannot affect another device and details copy redacts credentials',async()=>{
 const resolve=jest.fn(),retry=jest.fn(),view=await render(<ExecutionFailureActions id="turn-a" scopeKey="pc-a" error="error" code="model_capacity" onResolve={resolve} onRetry={retry}/>);
 const oldAction=mockPresses.get('更换模型')!,oldRetry=mockPresses.get('重试上一条消息')!;
 await view.rerender(<ExecutionFailureActions id="turn-b" scopeKey="pc-b" error="request https://user:pass@api.test/v1?token=hidden api_key=secret-value" code="upstream_unauthorized" onResolve={resolve} onRetry={retry}/>);
 await act(async()=>{oldAction();oldRetry();});expect(resolve).not.toHaveBeenCalled();expect(retry).not.toHaveBeenCalled();
 await fireEvent.press(view.getByLabelText('查看错误详情'));await fireEvent.press(view.getByText('复制错误详情'));
 expect(Clipboard.setStringAsync).toHaveBeenCalledWith(expect.stringContaining('https://api.test/v1'));expect(Clipboard.setStringAsync).not.toHaveBeenCalledWith(expect.stringMatching(/pass|hidden|secret-value/));await view.unmount();
});
