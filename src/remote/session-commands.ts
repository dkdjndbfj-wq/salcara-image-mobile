import type { NativeSessionActionResult, NativeSessionActionsReading } from './session-actions';
import type { SessionWorkflowResult, SessionWorkflowsReading } from './session-workflows';

export type SessionCommand = 'fork' | 'archive' | 'review';
export interface SessionCommandTransport {
  scope(): string;
  isCurrent(): boolean;
  readActions(signal?: AbortSignal): Promise<NativeSessionActionsReading>;
  applyAction(reading: NativeSessionActionsReading, action: 'fork' | 'archive'): Promise<NativeSessionActionResult>;
  readWorkflows(signal?: AbortSignal): Promise<SessionWorkflowsReading>;
  applyReview(reading: SessionWorkflowsReading): Promise<SessionWorkflowResult>;
}
