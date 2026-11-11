import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { RemoteComputers } from '../remote/RemoteComputers';
import type { RemoteState } from '../remote/store';
import type { DirectConnectionState } from '../remote/direct-pairing';

let mockRemote:RemoteState;
let mockDirect:DirectConnectionState;
const mockUse=jest.fn(),mockReconnect=jest.fn(),mockRevoke=jest.fn(),mockForget=jest.fn(),mockToast=jest.fn();
const mockProbe=jest.fn(),mockListDirect=jest.fn(),mockRename=jest.fn(),mockGroupRefresh=jest.fn(),mockGroupRevoke=jest.fn();
const direct={deviceId:'direct-C',deviceName:'电脑 C',endpoint:'wss://192.168.1.8:47832/direct/ws',pairedAt:1,pairingScope:'direct:binding-c'};
jest.mock('../components/Icon',()=>({Icon:()=>null}));
jest.mock('../remote/RemoteConnectionSyncNotice',()=>({RemoteConnectionSyncNotice:()=>null}));
jest.mock('../remote/store',()=>({getRemoteState:()=>mockRemote,useSavedConnection:(...args:unknown[])=>mockUse(...args),
  probeSavedConnections:()=>mockProbe(),
  remoteConnectionRevision:()=>1,refreshRemoteBotGroup:(...args:unknown[])=>mockGroupRefresh(...args),
  revokeRemoteBotGroup:(...args:unknown[])=>mockGroupRevoke(...args),
  renameRemoteConnection:(...args:unknown[])=>mockRename(...args),revokeRemoteConnectionById:(id:string)=>mockRevoke(id)}));
jest.mock('../remote/direct-pairing',()=>({listDirectPairings:()=>mockListDirect(),getDirectConnectionState:()=>mockDirect,
  reconnectDirect:(...args:unknown[])=>mockReconnect(...args),forgetDirectPairing:(...args:unknown[])=>mockForget(...args)}));
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
  mockProbe.mockImplementation(async()=>Object.fromEntries(mockRemote.connections.map(item=>[item.id,'online'])));
  mockListDirect.mockResolvedValue([direct]);
  mockRename.mockResolvedValue(undefined);mockRevoke.mockResolvedValue(undefined);mockForget.mockResolvedValue(undefined);
  mockGroupRefresh.mockResolvedValue({devices:[]});mockGroupRevoke.mockResolvedValue(undefined);
});
const props=()=>({remote:mockRemote,selectedDeviceId:'A',directConnection:mockDirect,onSelected:jest.fn(),onBind:jest.fn()});

test('direct removal sends the captured binding identity to the atomic storage boundary',async()=>{
  const input=props(),onDirectRemoved=jest.fn(),view=await render(<RemoteComputers {...input} onDirectRemoved={onDirectRemoved}/>);
  await fireEvent.press(view.getByLabelText('管理直连 电脑 C'));
  await fireEvent.press(view.getByLabelText('解除直连'));
  await fireEvent.press(view.getByLabelText('确认 解除直连'));
  expect(mockForget).toHaveBeenCalledWith(direct.deviceId,direct);
  expect(onDirectRemoved).toHaveBeenCalledWith(direct.deviceId,direct.pairingScope);
});

test('direct removal acknowledgement cannot navigate after the parent owner changed while still visible',async()=>{
  let finish!:()=>void,wanted=true;
  mockForget.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
  const input=props(),onDirectRemoved=jest.fn(),view=await render(<RemoteComputers {...input} isNavigationCurrent={()=>wanted} onDirectRemoved={onDirectRemoved}/>);
  await fireEvent.press(view.getByLabelText('管理直连 电脑 C'));
  await fireEvent.press(view.getByLabelText('解除直连'));
  await fireEvent.press(view.getByLabelText('确认 解除直连'));
  wanted=false; await act(async()=>{finish();});
  expect(onDirectRemoved).not.toHaveBeenCalled();expect(mockToast).not.toHaveBeenCalled();
});

test('A relay, B Bot and C direct have distinct labels and dispatch their exact connection targets',async()=>{
  const input=props(),view=await render(<RemoteComputers {...input}/>);
  expect(view.getByText('中转站')).toBeTruthy();expect(view.getByText('Bot')).toBeTruthy();expect(view.getByText('直连')).toBeTruthy();
  expect(view.getAllByRole('button', {name:/^选择(直连)?电脑 /})).toHaveLength(3);
  expect(view.getAllByRole('button', {name:/^管理(设备|直连) /})).toHaveLength(3);
  expect(view.queryAllByRole('button', {name:/^(打开|切换到)(中转站|Bot|直连) /})).toHaveLength(0);
  await fireEvent.press(view.getByLabelText('选择电脑 电脑 B'));
  expect(mockUse).toHaveBeenCalledWith('bot-B',false,expect.objectContaining({stillWanted:expect.any(Function)}));
  expect(input.onSelected).toHaveBeenLastCalledWith({kind:'bot',connectionId:'bot-B',deviceId:'B'});
  await fireEvent.press(view.getByLabelText('选择直连电脑 电脑 C rect-C'));
  expect(mockReconnect).toHaveBeenCalledWith('direct-C',expect.objectContaining({stillWanted:expect.any(Function)}));
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
  await fireEvent.press(view.getByLabelText('选择电脑 电脑 B'));
  expect(mockUse).toHaveBeenCalledWith('bot-B',false,expect.objectContaining({requireOnline:true}));
  expect(input.onSelected).not.toHaveBeenCalled();
});

test('leaving the programming module invalidates an in-flight switch even when reopened',async()=>{
  let finish!:()=>void;mockUse.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
  const input=props(),view=await render(<RemoteComputers {...input} visible/>);
  await fireEvent.press(view.getByLabelText('选择电脑 电脑 B'));
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

test('an inactive retained device page does not start connection probes or read direct pairings',async()=>{
  const view=await render(<RemoteComputers {...props()} visible={false}/>);
  expect(mockProbe).not.toHaveBeenCalled();expect(mockListDirect).not.toHaveBeenCalled();
  await view.rerender(<RemoteComputers {...props()} visible/>);
  expect(mockProbe).toHaveBeenCalledTimes(1);expect(mockListDirect).toHaveBeenCalledTimes(1);
});

test('returning to the device page refreshes health and ignores a pre-leave delayed probe',async()=>{
  let finish!:(health:Record<string,string>)=>void;
  mockProbe.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const input=props(),view=await render(<RemoteComputers {...input} visible/>);
  await view.rerender(<RemoteComputers {...input} visible={false}/>);
  mockProbe.mockResolvedValueOnce({'relay-A':'online','bot-B':'offline'});
  await view.rerender(<RemoteComputers {...input} visible/>);
  expect(mockProbe).toHaveBeenCalledTimes(2);
  expect(view.getByText('电脑离线')).toBeTruthy();
  await act(async()=>{finish({'relay-A':'online','bot-B':'online'});});
  expect(view.getByText('电脑离线')).toBeTruthy();
});

test('leaving the device page dismisses management so returning cannot reuse an old confirmation',async()=>{
  const input=props(),view=await render(<RemoteComputers {...input} visible/>);
  await fireEvent.press(view.getByLabelText('管理设备 电脑 B'));
  await fireEvent.press(view.getByLabelText('解除 Bot 组'));
  expect(view.getByText('解除这个 Bot 组？')).toBeTruthy();
  await view.rerender(<RemoteComputers {...input} visible={false}/>);
  expect(view.queryByText('解除这个 Bot 组？')).toBeNull();
  await view.rerender(<RemoteComputers {...input} visible/>);
  expect(view.queryByText('解除这个 Bot 组？')).toBeNull();
  expect(mockRevoke).not.toHaveBeenCalled();
});

test('a freshly rebound pairing cannot be selected through an older card snapshot',async()=>{
  const input=props(),view=await render(<RemoteComputers {...input}/>);
  mockRemote={...mockRemote,connections:mockRemote.connections.map(item=>item.id==='relay-A'?{...item,pairedAt:99}:item)};
  await fireEvent.press(view.getByLabelText('选择电脑 电脑 A'));
  expect(input.onSelected).not.toHaveBeenCalled();expect(mockUse).not.toHaveBeenCalled();
  expect(mockToast).toHaveBeenCalledWith(expect.stringContaining('已改变'),'alert');
});

test('an old removal confirmation cannot revoke a freshly rebound connection with the same ID',async()=>{
  const view=await render(<RemoteComputers {...props()}/>);
  await fireEvent.press(view.getByLabelText('管理设备 电脑 B'));
  await fireEvent.press(view.getByLabelText('解除 Bot 组'));
  mockRemote={...mockRemote,connections:mockRemote.connections.map(item=>item.id==='bot-B'?{...item,pairedAt:99}:item)};
  await fireEvent.press(view.getByLabelText('确认 解除 Bot 组'));
  expect(mockRevoke).not.toHaveBeenCalled();
  expect(mockToast).toHaveBeenCalledWith(expect.stringContaining('已改变'),'alert');
});

test('a Bot generation change invalidates an older computer card even when timestamps match',async()=>{
  mockRemote={...mockRemote,connections:mockRemote.connections.map(item=>item.id==='bot-B'?{...item,botGeneration:'one'}:item)};
  const input=props(),view=await render(<RemoteComputers {...input}/>);
  mockRemote={...mockRemote,connections:mockRemote.connections.map(item=>item.id==='bot-B'?{...item,botGeneration:'two'}:item)};
  await fireEvent.press(view.getByLabelText('选择电脑 电脑 B'));
  expect(mockUse).not.toHaveBeenCalled();expect(input.onSelected).not.toHaveBeenCalled();
});

test('device management exposes an empty Bot group without a fake computer card',async()=>{
  mockListDirect.mockResolvedValue([]);
  mockRemote={...mockRemote,connections:[],connectionId:null,devices:[],botGroups:[{
    id:'empty-group',hubUrl:'https://b.example/v1',groupId:'empty',generation:'one',pairedAt:1,status:'active',
    pin:{instanceId:'fixture-instance',publicKey:'A'.repeat(43)+'='},
  }]};
  const input=props(),view=await render(<RemoteComputers {...input}/>);
  expect(view.getByText(/已绑定，等待电脑加入/)).toBeTruthy();
  expect(view.queryAllByRole('button',{name:/^选择(直连)?电脑 /})).toHaveLength(0);
  expect(view.queryByText('还没有绑定电脑')).toBeNull();
  await fireEvent.press(view.getByLabelText('刷新组电脑'));
  expect(mockGroupRefresh).toHaveBeenCalledWith('empty-group',expect.any(Function));
  expect(mockUse).not.toHaveBeenCalled();expect(input.onSelected).not.toHaveBeenCalled();
});

test('an old name editor cannot change a freshly rebound connection',async()=>{
  const view=await render(<RemoteComputers {...props()}/>);
  await fireEvent.press(view.getByLabelText('管理设备 电脑 B'));
  await fireEvent.press(view.getByText('编辑设备名称'));
  await fireEvent.changeText(view.getByLabelText('电脑备注名'),'新备注');
  mockRemote={...mockRemote,connections:mockRemote.connections.map(item=>item.id==='bot-B'?{...item,pairedAt:99}:item)};
  await fireEvent.press(view.getByLabelText('保存'));
  expect(mockRename).not.toHaveBeenCalled();
  expect(mockToast).toHaveBeenCalledWith(expect.stringContaining('已改变'),'alert');
});

test('same-name disambiguation uses the displayed connection rather than a group first entry',async()=>{
  const current={...mockRemote.connections[0],computerId:'physical-A',alias:'同名电脑'};
  mockRemote.connections=[{...current,id:'relay-backup-A',hubUrl:'https://backup.example/v1',alias:undefined,deviceName:'旧电脑名'},current,
    {...mockRemote.connections[1],deviceName:'同名电脑'}];
  const input=props(),view=await render(<RemoteComputers {...input}/>);
  expect(view.getByLabelText('选择电脑 同名电脑 A')).toBeTruthy();
  expect(view.getByLabelText('选择电脑 同名电脑 B')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('管理设备 同名电脑 B'));
  expect(view.getByText('连接方式 · Bot')).toBeTruthy();
  expect(mockUse).not.toHaveBeenCalled();
});

test('a direct reconnect receives the page owner guard and cannot navigate after leaving',async()=>{
  let finish!:()=>void;mockReconnect.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
  const input=props(),view=await render(<RemoteComputers {...input} visible/>);
  await fireEvent.press(view.getByLabelText('选择直连电脑 电脑 C rect-C'));
  const guard=mockReconnect.mock.calls[0][1].stillWanted;
  expect(guard()).toBe(true);
  await view.rerender(<RemoteComputers {...input} visible={false}/>);
  await view.rerender(<RemoteComputers {...input} visible/>);
  expect(guard()).toBe(false);
  await act(async()=>{mockDirect={...mockDirect,status:'connected'};finish();});
  expect(input.onSelected).not.toHaveBeenCalled();expect(mockToast).not.toHaveBeenCalled();
});

test('a delayed name-save acknowledgement does not show an old-page success after returning',async()=>{
  let finish!:()=>void;mockRename.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
  const input=props(),view=await render(<RemoteComputers {...input} visible/>);
  await fireEvent.press(view.getByLabelText('管理设备 电脑 B'));
  await fireEvent.press(view.getByText('编辑设备名称'));
  await fireEvent.press(view.getByLabelText('保存'));
  await view.rerender(<RemoteComputers {...input} visible={false}/>);
  await view.rerender(<RemoteComputers {...input} visible/>);
  await act(async()=>{finish();});
  expect(mockToast).not.toHaveBeenCalled();
  expect(view.queryByLabelText('电脑备注名')).toBeNull();
});
