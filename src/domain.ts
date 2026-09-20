export type Quality = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type AspectRatio = '1:1' | '16:9' | '9:16';
export type ResolutionTier = '1K' | '2K' | '4K';
export type MessageStatus = 'pending' | 'complete' | 'error' | 'cancelled' | 'interrupted';
export type MessageMode = 'generate' | 'edit';

export interface ProviderProfile {
  id: string;
  name: string;
  baseUrl: string;
  model: string | null;
  quality: Quality | null;
  aspectRatio: AspectRatio | null;
  resolutionTier: ResolutionTier | null;
  createdAt: number;
  updatedAt: number;
}

export interface Conversation {
  id: string;
  title: string;
  providerId: string;
  transparent: boolean;
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
  maskUri: string | null;
  error: string | null;
  elapsedMs: number | null;
  createdAt: number;
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
