import * as actual from '../../src/remote/direct-pairing';
export * from '../../src/remote/direct-pairing';
const enabled=new URLSearchParams(location.search).get('scene')==='computer-routes';
const peer={deviceId:'local-direct-C',deviceName:'书房电脑',endpoint:'wss://192.168.1.8:47832/direct/ws',pairedAt:Date.now()};
let connection={status:'closed',deviceId:peer.deviceId,deviceName:peer.deviceName};
let saved=[peer];
export const listDirectPairings=()=>enabled?Promise.resolve(saved):actual.listDirectPairings();
export const getDirectConnectionState=()=>enabled?connection:actual.getDirectConnectionState();
export const reconnectDirect=async id=>{
  if(!enabled)return actual.reconnectDirect(id);
  connection={status:'connected',deviceId:id,deviceName:peer.deviceName};return connection;
};
export const forgetDirectPairing=async id=>{
  if(!enabled)return actual.forgetDirectPairing(id);
  saved=saved.filter(item=>item.deviceId!==id);connection={status:'idle'};
};
