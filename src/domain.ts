import type { AgentTrace } from './agent/types';

export type Quality = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** 'auto' or any width:height between 1:3 and 3:1 (see image-sizes.ts). */
export type AspectRatio = 'auto' | `${number}:${number}`;
export type ResolutionTier = '1K' | '2K' | '4K';
export type MessageStatus = 'pending' | 'complete' | 'error' | 'cancelled' | 'interrupted';
export type MessageMode = 'generate' | 'edit' | 'chat';
/** How the composer chooses between the independent chat and image APIs. */
export type ComposerMode = 'auto' | 'image' | 'chat';
export type ChatApi = 'chat-completions' | 'responses' | 'anthropic';
/** How a local attachment is prepared before it is sent to a model. */
export type AttachmentKind = 'pdf' | 'text' | 'office' | 'archive' | 'image' | 'binary';

export interface ProviderProfile {
  id: string;
  name: string;
  baseUrl: string;
  model: string | null;
  quality: Quality | null;
  aspectRatio: AspectRatio | null;
  resolutionTier: ResolutionTier | null;
  chatModel?: string | null;
  chatApi?: ChatApi;
  analysisProviderId?: string | null;
  imageProviderId?: string | null;
  /** Catalog id (src/api/vendors.ts); null for services added before the catalog (matched by address). */
  vendor?: string | null;
  /** Non-secret vendor fields such as an Azure region or a 火山 APP ID. */
  extra?: Record<string, string> | null;
  createdAt: number;
  updatedAt: number;
}

export interface Conversation {
  id: string;
  title: string;
  providerId: string;
  transparent: boolean;
  /** New conversations default to auto. Old installs may still contain chat/image. */
  mode?: ComposerMode;
  /** Custom agent (智能体) this conversation talks to. */
  agentId?: string | null;
  /** assistant: the tool-using assistant space; companion: a chat character's endless conversation. */
  kind?: 'assistant' | 'companion';
  characterId?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ReferenceImage {
  id: string;
  uri: string;
  name: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  size: number;
  width?: number;
  height?: number;
}

export interface DocumentAttachment {
  id: string;
  uri: string;
  name: string;
  /** Keep the original MIME when Android provides one. Unknown types are allowed. */
  mimeType: string;
  size: number;
  /** Optional for old database rows; callers should infer it when absent. */
  kind?: AttachmentKind;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  prompt: string;
  mode: MessageMode;
  status: MessageStatus;
  providerId: string;
  model: string;
  quality: Quality;
  size: string;
  transparent: boolean;
  imageUri: string | null;
  remoteImageUrl: string | null;
  references: ReferenceImage[];
  documents?: DocumentAttachment[];
  text?: string | null;
  /** Image prompt written by the conversation model (tool call) or the user. */
  preparedPrompt?: string | null;
  analysisModel?: string | null;
  analysisProviderId?: string | null;
  requestApi?: ChatApi;
  analysisApi?: ChatApi;
  maskUri: string | null;
  error: string | null;
  elapsedMs: number | null;
  createdAt: number;
  /** Tool steps, sources, suggestions, files and actions of an agent reply. */
  agent?: AgentTrace | null;
}

export interface GenerationSettings {
  model: string;
  quality: Quality;
  aspectRatio: AspectRatio;
  resolutionTier: ResolutionTier;
}

export interface ImageApiResponse {
  created?: number;
  data?: Array<{
    b64_json?: string;
    url?: string;
    revised_prompt?: string;
  }>;
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}
