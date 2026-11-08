import type { createConversationArtifacts } from './conversation-artifacts';
import { createContext, useContext } from 'react';
import type { AgentId } from './client';
import type { RemoteState, Timeline } from './store';
import type { WorkspaceFileReader } from './workspace-files';
import type { ComputerPreview } from './workspace-preview';
import type { WorkspaceProjectPreview } from './workspace-project-preview';
import type { TerminalSelection, WorkspaceTerminal } from './workspace-terminal';
import type { GitSelection, WorkspaceGit } from './workspace-git';
import type { SubagentSelection, SubagentTransport } from './subagent-controls';

export interface WorkspaceFileSelection {
  deviceId: string; sessionKey: string; agentId: AgentId; surface: 'cli' | 'desktop';
  expectedCwd?: string; expectedSessionKey?: string; expectedSurface?: 'cli' | 'desktop';
}

/** The same controls can use an authenticated Hub or Direct owner. This
 * projection supplies display data only; every factory rechecks its transport
 * and session scope before and after each request. No synthetic Hub is made. */
export interface WorkspaceRuntime {
  readonly scope: string;
  readonly remote: RemoteState;
  captureArtifacts?(selection:WorkspaceFileSelection,onInvalidated?:()=>void):ReturnType<typeof createConversationArtifacts>;
  captureFiles(selection: WorkspaceFileSelection, onInvalidated?: () => void): WorkspaceFileReader;
  captureProjectFiles?(selection:{deviceId:string;tool:string;cwd:string},onInvalidated?:()=>void):WorkspaceFileReader;
  captureTerminal(selection: TerminalSelection, onInvalidated?: () => void): WorkspaceTerminal;
  capturePreview(selection: TerminalSelection, onInvalidated: () => void): ComputerPreview;
  captureProjectPreview?(selection: TerminalSelection, onInvalidated?: () => void): WorkspaceProjectPreview;
  captureGit?(selection: GitSelection, onInvalidated?: () => void): WorkspaceGit;
  captureSubagents?(selection: SubagentSelection): SubagentTransport;
  readContextSession?(sessionKey:string):Promise<Timeline>;
}

export const WorkspaceRuntimeContext = createContext<WorkspaceRuntime | null>(null);
export const useWorkspaceRuntime = () => useContext(WorkspaceRuntimeContext);
