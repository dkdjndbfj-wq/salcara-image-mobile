import React from 'react';
import {RemoteDemoWorkspace} from '../../src/remote/RemoteDemoWorkspace';

/** Actual conversation and side-pane layout, backed only by the demo transport. */
export function KeyboardWorkspaceFixture(){
  return <RemoteDemoWorkspace agentId="codex" agentName="Codex"/>;
}
