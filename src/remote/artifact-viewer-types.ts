import type { ArtifactDescriptor, ArtifactPayload } from './conversation-artifacts';
import type {ArtifactElementSelection,ArtifactAnnotationPin} from './artifact-annotations';

export interface ArtifactAnnotation {
  artifactId: string;
  path: string;
  name: string;
  revision: string;
  comment: string;
  quote?: string;
  page?: number;
  sheet?: string;
  cellRange?: string;
}

export interface ArtifactViewerProps {
  artifact: ArtifactDescriptor;
  /** Complete binding/computer/agent/workspace/session identity, not a display label. */
  scopeKey: string;
  load: (artifact: ArtifactDescriptor, signal: AbortSignal) => Promise<ArtifactPayload>;
  save?: (artifact: ArtifactDescriptor, content: string, expectedRevision: string, signal: AbortSignal) => Promise<ArtifactPayload>;
  onAnnotate?: (annotation: ArtifactAnnotation) => void;
  onComposeComments?:(text:string)=>boolean;
  onClose?: () => void;
  /** Allows a containing sheet to block Escape/backdrop dismissal while editing. */
  onDirtyChange?: (dirty: boolean) => void;
}

export interface InteractiveArtifactProps {
  scopeKey: string;
  artifactId: string;
  revision: string;
  source: string;
  title?: string;
  inline?: boolean;
  /** A transcript thumbnail must not overwrite the live sidebar's form state. */
  readOnlyState?: boolean;
  initialState?: Record<string, unknown>;
  onState?: (state: Record<string, unknown>) => void;
  /** Selection comes from an explicit gesture inside the isolated document. */
  onAnnotate?: (selection:ArtifactElementSelection) => void;
  elementAnnotations?:boolean;
  annotationPins?:readonly ArtifactAnnotationPin[];
  annotationFocus?:{id:string;nonce:number};
  onAnnotationFocus?:(id:string)=>void;
  onError?: (message: string) => void;
  /** Explicit log selection appends to this conversation's draft; it never sends. */
  onComposeLogs?: (text: string) => boolean | void;
  active?: boolean;
}
