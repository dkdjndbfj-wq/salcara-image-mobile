import type { CharacterDraft } from '../memorybox/characters';
import type { Character } from '../memorybox/types';
import type { ChatMessage, Conversation, DocumentAttachment, ProviderProfile, ReferenceImage } from '../domain';
import type { BackupProgress, RestoreResult } from '../storage/backup';

export type ProviderPatch = Partial<Pick<ProviderProfile, 'model' | 'quality' | 'aspectRatio' | 'resolutionTier' | 'chatModel' | 'chatApi' | 'name' | 'baseUrl'>>;
export type RequestPhase = 'idle' | 'thinking' | 'writing' | 'drawing' | 'downloading';

export interface SendInput {
  text: string;
  images?: ReferenceImage[];
  documents?: DocumentAttachment[];
  maskUri?: string | null;
  /** Sent from voice conversation: the reply is spoken, so the model answers briefly without Markdown. */
  voice?: boolean;
  /** Deep research: plan, many searches and a cited report. */
  research?: boolean;
}


/** The two halves of the app: the tool-using assistant, and chat with characters. */
export type Space = 'assistant' | 'companion' | 'remote';

export interface AppContextValue {
  ready: boolean;
  providers: ProviderProfile[];
  /** Provider + model used for conversation, vision, files and deciding when to draw. */
  chatProvider: ProviderProfile | null;
  /** Provider + model + defaults used when the assistant draws. */
  imageProvider: ProviderProfile | null;
  conversations: Conversation[];
  /** null means an unsaved new chat. It only becomes a row after the first message. */
  activeConversationId: string | null;
  activeConversation: Conversation | null;
  messages: ChatMessage[];
  /** The open conversation has a reply in progress. */
  busy: boolean;
  /** Any conversation has a reply in progress (drawing can continue in the background). */
  anyBusy: boolean;
  /** Conversations with a reply in progress, for the drawer indicator. */
  runningConversationIds: string[];
  phase: RequestPhase;
  /** Custom agent of the open conversation (or of the new-chat draft). */
  activeAgentId: string | null;
  space: Space;
  switchSpace: (space: Space) => void;
  /** Chat space: the open character (null = the character list). */
  activeCharacterId: string | null;
  openCharacter: (characterId: string) => Promise<void>;
  closeCharacter: () => void;
  createCharacter: (draft: CharacterDraft) => Promise<Character>;
  editCharacter: (id: string, draft: CharacterDraft) => Promise<void>;
  deleteCharacter: (id: string) => Promise<void>;
  /** Long threads load older messages on demand. */
  hasOlderMessages: boolean;
  loadOlderMessages: () => Promise<void>;
  reloadProviders: () => Promise<void>;
  selectChatProvider: (providerId: string, model?: string) => Promise<void>;
  selectImageProvider: (providerId: string, patch?: ProviderPatch) => Promise<void>;
  updateProvider: (providerId: string, patch: ProviderPatch) => Promise<void>;
  removeProvider: (providerId: string) => Promise<void>;
  /** Starts a blank draft, optionally talking to a custom agent. */
  newChat: (agentId?: string | null) => void;
  openConversation: (conversationId: string) => Promise<void>;
  /** Restores a backup file the person picks (merged in); null when nothing was picked. */
  restoreBackup: (onProgress?: (progress: BackupProgress) => void) => Promise<RestoreResult | null>;
  /** Opens a conversation at one message (a search hit); the chat screen scrolls to it and marks it briefly. */
  openMessage: (conversationId: string, messageId: string) => Promise<void>;
  jumpRequest: { messageId: string; seq: number } | null;
  deleteConversation: (conversationId: string) => Promise<void>;
  renameConversation: (conversationId: string, title: string) => Promise<void>;
  send: (input: SendInput) => Promise<void>;
  stop: () => void;
  retry: (message: ChatMessage) => Promise<void>;
  /** Replaces a sent message with an edited one: it and everything after it are removed, then the new one is sent. */
  editAndResend: (messageId: string, input: SendInput) => Promise<void>;
  /** Deletes one message (a question also takes its answer with it). */
  deleteMessage: (messageId: string) => Promise<void>;
  /** Saves a finished spoken exchange (realtime voice model) into the open conversation. */
  recordVoiceExchange: (userText: string, assistantText: string) => Promise<void>;
  /** Runs a phone action the assistant prepared, after the user tapped its card. */
  runAction: (message: ChatMessage, actionId: string) => Promise<void>;
  dismissAction: (message: ChatMessage, actionId: string) => Promise<void>;
}
