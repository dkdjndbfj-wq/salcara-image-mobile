// Real main conversation/sidebar; explicitly local data and no model call.
import React, {useState} from 'react';
import {ThreadView} from '../../src/remote/ThreadView';
import {previewAgent,previewDeviceId,previewSession} from './remote-store';
export function ConversationOutputsFixture(){
 const [sessionKey,setSessionKey]=useState(previewSession.sessionKey);
 return <ThreadView visible deviceId={previewDeviceId} sessionKey={sessionKey} agent={previewAgent} onClose={()=>setSessionKey(previewSession.sessionKey)} onCreated={setSessionKey} onNew={()=>setSessionKey(null)}/>;
}
