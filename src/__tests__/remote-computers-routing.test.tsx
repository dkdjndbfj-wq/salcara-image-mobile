import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { RemoteComputers } from '../remote/RemoteComputers';
import type { RemoteState } from '../remote/store';
import type { DirectConnectionState } from '../remote/direct-pairing';

let mockRemote:RemoteState;
let mockDirect:DirectConnectionState;
const mockUse=jest.fn(),mockReconnect=jest.fn(),mockRevoke=jest.fn(),mockForget=jest.fn(),mockToast=jest.fn();
const direct={deviceId:'direct-C',deviceName:'电脑 C',endpoint:'wss://192.168.1.8:47832/direct/ws',pairedAt:1};
jest.mock('../components/Icon',()=>({Icon:()=>null}));
jest.mock('../remote/RemoteConnectionSyncNotice',()=>({RemoteConnectionSyncNotice:()=>null}));
jest.mock('../remote/store',()=>({getRemoteState:()=>mockRemote,useSavedConnection:(...args:unknown[])=>mockUse(...args),
  probeSavedConnections:async()=>Object.fromEntries(mockRemote.connections.map(item=>[item.id,'online'])),
  renameRemoteConnection:jest.fn(),revokeRemoteConnectionById:(id:string)=>mockRevoke(id)}));
jest.mock('../remote/direct-pairing',()=>({listDirectPairings:async()=>[direct],getDirectConnectionState:()=>mockDirect,
  reconnectDirect:(id:string)=>mockReconnect(id),forgetDirectPairing:(id:string)=>mockForget(id)}));
jest.mock('../components/ui',()=>({showToast:(...args:unknown[])=>mockToast(...args),AppDialog:({visible,title,message,actions}:any)=>{
  const {View,Text,Pressable}=require('react-native');
  return visible?<View><Text>{title}</Text><Text>{message}</Text>{actions.map((action:any)=><Pressable key={action.label} accessibilityLabel={`确认 ${action.label}`} onPress={action.onPress}><Text>{action.label}</Text></Pressable>)}</View>:null;
}}));
jest.mock('../remote/ProgrammingUi',()=>{
  const actual=jest.requireActual('../remote/ProgrammingUi'),{View,Text,Pressable}=require('react-native');
  return {...actual,ProgrammingPanel:({visible,children,title,footer}:any)=>visible?<View><Text>{title}</Text>{children}{footer}</View>:null,
    ProgrammingAction:({label,onPress}:any)=><Pressable accessibilityLabel={label} onPress={onPress}><Text>{label}</Text></Pressable>};
});
beforeEach(()=>{
  jest.clearAllMocks();mockDirect={status:'closed',deviceId:direct.deviceId,deviceName:direct.deviceName};
  mockRemote={phase:'ready',connectionId:'relay-A',selectedHubUrl:'https://a.example/v1',serviceId:null,probes:{},connection:'open',devicesLoaded:true,
    connections:[{id:'relay-A',hubUrl:'https://a.example/v1',deviceId:'A',deviceName:'电脑 A',pairedAt:1},
      {id:'bot-B',hubUrl:'https://b.example/v1',deviceId:'B',deviceName:'电脑 B',botGroupId:'group-B',pairedAt:2}],
    devices:[{deviceId:'A',name:'电脑 A',online:true,os:'windows',lastSeen:0,tools:[],projects:[]}],agents:{},sessions:{},timelines:{},approvals:{},focus:null,signingIn:null};
  mockUse.mockImplementation(async(id:string)=>{const target=mockRemote.connections.find(item=>item.id===id)!;mockRemote={...mockRemote,connectionId:id,selectedHubUrl:target.hubUrl,
    devices:[{deviceId:target.deviceId,name:target.deviceName,online:true,os:'windows',lastSeen:0,tools:[],projects:[]}]};});
  mockReconnect.mockImplementation(async(id:string)=>{mockDirect={status:'connected',deviceId:id,deviceName:direct.deviceName};return mockDirect;});
});
const props=()=>({remote:mockRemote,selectedDeviceId:'A',directConnection:mockDirect,onSelected:jest.fn(),onBind:jest.fn()});

test('A relay, B Bot and C direct have distinct labels and dispatch their exact connection targets',async()=>{
  const input=props(),view=await render(<RemoteComputers {...input}/>);
  expect(view.getByText('中转站')).toBeTruthy();expect(view.getByText('Bot')).toBeTruthy();expect(view.getByText('直连')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('选择电脑 电脑 B'));
  expect(mockUse).toHaveBeenCalledWith('bot-B',false,expect.objectContaining({stillWanted:expect.any(Function)}));
  expect(input.onSelected).toHaveBeenLastCalledWith({kind:'bot',connectionId:'bot-B',deviceId:'B'});
  await fireEvent.press(view.getByLabelText('选择直连电脑 电脑 C rect-C'));
  expect(mockReconnect).toHaveBeenCalledWith('direct-C');
  expect(input.onSelected).toHaveBeenLastCalledWith({kind:'direct',deviceId:'direct-C'});
  expect(mockUse).toHaveBeenCalledTimes(1);
});

test('a mismatched successful return cannot navigate to the requested computer',async()=>{
  mockUse.mockImplementation(async()=>{});
  const input=props(),view=await render(<RemoteComputers {...input}/>);
  await fireEvent.press(view.getByLabelText('选择电脑 电脑 B'));
  expect(input.onSelected).not.toHaveBeenCalled();expect(mockToast).toHaveBeenCalledWith(expect.stringContaining('未切换'), 'alert');
});

test.each(['error','pending'] as const)('an incomplete %s connection never reports selection success',async condition=>{
  mockUse.mockImplementation(async()=>{mockRemote={...mockRemote,connectionId:'bot-B',selectedHubUrl:'https://b.example/v1',
    connection:condition==='error'?'error':'connecting',signingIn:condition==='pending'?'bot-B':null};});
  const input=props(),view=await render(<RemoteComputers {...input}/>);
  await fireEvent.press(view.getByLabelText('选择电脑 电脑 B'));
  expect(input.onSelected).not.toHaveBeenCalled();expect(mockToast).toHaveBeenCalledWith(expect.stringContaining('未切换'), 'alert');
});

test('a canceled selection cannot navigate after its delayed result arrives',async()=>{
  let finish!:()=>void;mockUse.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
  const input=props(),view=await render(<RemoteComputers {...input}/>);
  await fireEvent.press(view.getByLabelText('选择电脑 电脑 B'));
  const guard=mockUse.mock.calls[0][2].stillWanted;
  await view.unmount();expect(guard()).toBe(false);
  await act(async()=>{mockRemote={...mockRemote,connectionId:'bot-B'};finish();});
  expect(input.onSelected).not.toHaveBeenCalled();
});

test('an online station with an offline computer never reports success',async()=>{
  mockUse.mockImplementation(async()=>{mockRemote={...mockRemote,connectionId:'bot-B',selectedHubUrl:'https://b.example/v1',
    devices:[{...mockRemote.devices[0],deviceId:'B',online:false}]};});
  const input=props(),view=await render(<RemoteComputers {...input}/>);
  await fireEvent.press(view.getByLabelText('切换到Bot 电脑 B'));
  expect(mockUse).toHaveBeenCalledWith('bot-B',false,expect.objectContaining({requireOnline:true}));
  expect(input.onSelected).not.toHaveBeenCalled();
});

test('leaving the programming module invalidates an in-flight switch even when reopened',async()=>{
  let finish!:()=>void;mockUse.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
  const input=props(),view=await render(<RemoteComputers {...input} visible/>);
  await fireEvent.press(view.getByLabelText('切换到Bot 电脑 B'));
  const guard=mockUse.mock.calls[0][2].stillWanted;
  await view.rerender(<RemoteComputers {...input} visible={false}/>);
  expect(guard()).toBe(false);
  await view.rerender(<RemoteComputers {...input} visible/>);
  expect(guard()).toBe(false);
  await act(async()=>{finish();});
  expect(input.onSelected).not.toHaveBeenCalled();expect(mockToast).not.toHaveBeenCalled();
});

test('multiple modes for one verified computer require selecting a specific connection',async()=>{
  mockRemote.connections=mockRemote.connections.map(item=>({...item,computerId:'physical-A',deviceId:'A',deviceName:'电脑 A'}));
  const input=props(),view=await render(<RemoteComputers {...input}/>);
  await fireEvent.press(view.getByLabelText('选择电脑 电脑 A'));
  expect(mockUse).not.toHaveBeenCalled();expect(input.onSelected).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('切换到Bot b.example A'));
  expect(input.onSelected).toHaveBeenLastCalledWith({kind:'bot',connectionId:'bot-B',deviceId:'A'});
});

test('same-name computers remain separate and their IDs select the correct transport',async()=>{
  mockRemote.connections=mockRemote.connections.map(item=>({...item,deviceName:'同名电脑'}));
  const input=props(),view=await render(<RemoteComputers {...input}/>);
  expect(view.getByLabelText('选择电脑 同名电脑 A')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('选择电脑 同名电脑 B'));
  expect(input.onSelected).toHaveBeenLastCalledWith({kind:'bot',connectionId:'bot-B',deviceId:'B'});
});

test('failed direct reconnect never selects a relay or reports the failed target as current',async()=>{
  mockReconnect.mockRejectedValue(new Error('无法连接 C'));
  const input=props(),view=await render(<RemoteComputers {...input}/>);
  await fireEvent.press(view.getByLabelText('选择直连电脑 电脑 C rect-C'));
  expect(input.onSelected).not.toHaveBeenCalled();expect(mockUse).not.toHaveBeenCalled();
  expect(view.getByText('当前 · 中转站')).toBeTruthy();
});

test('Bot removal names the whole affected group and never claims only one computer is removed',async()=>{
  mockRemote.connections.push({...mockRemote.connections[1],id:'bot-D',deviceId:'D',deviceName:'电脑 D'});
  const view=await render(<RemoteComputers {...props()}/>);
  await fireEvent.press(view.getByLabelText('管理设备 电脑 B'));
  await fireEvent.press(view.getByLabelText('解除 Bot 组'));
  expect(view.getByText(/同时解除 2 台电脑的 Bot 连接：电脑 B、电脑 D/)).toBeTruthy();
  expect(mockRevoke).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('确认 解除 Bot 组'));
  expect(mockRevoke).toHaveBeenCalledWith('bot-B');expect(mockForget).not.toHaveBeenCalled();
});
