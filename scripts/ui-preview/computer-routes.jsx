import React,{useEffect,useState} from 'react';
import {Text,View} from 'react-native';
import {RemoteComputers} from '../../src/remote/RemoteComputers';
import {useRemote,configureComputerRoutesPreview} from './remote-store';
import {getDirectConnectionState} from './computer-pairings';
export function ComputerRoutesPreview(){
  useEffect(()=>configureComputerRoutesPreview(),[]);
  const remote=useRemote();
  const [selection,setSelection]=useState({kind:'relay',connectionId:'preview-relay-A',deviceId:'A'});
  return <View style={{flex:1,backgroundColor:'#fafafa',paddingTop:12}}>
    <Text style={{fontSize:11,color:'#777',paddingHorizontal:18,paddingBottom:8}}>本地演示 · {selection.kind} · {selection.deviceId}</Text>
    <RemoteComputers remote={remote} selectedDeviceId={selection.deviceId} directConnection={getDirectConnectionState()} directSelected={selection.kind==='direct'} selectedDirectDeviceId={selection.kind==='direct'?selection.deviceId:undefined}
      onSelected={setSelection} onBind={()=>{}}/>
  </View>;
}
