export const LIMITS = {
  fileBytes: 5 * 1024 * 1024,
  videoFrames: 4,
  videoFrameBytes: 512 * 1024,
  transfersPerUser: 3,
  transfersPerApp: 6,
  fileCharacters: 30_000,
  chatFileCharacters: 60_000,
  /** A message can be a long paste (about 33k tokens); the request is still checked against the chosen model's window. */
  inputCharacters: 100_000,
  outputCharacters: 32_000,
  reasoningCharacters: 32_000,
  codeEventText: 64_000,
  webSources: 8,
  messagesPerChat: 200,
  chatsPerUser: 100,
};
/** Request-body ceiling for anything carrying a message or draft: the longest message, even if every character is escaped, plus room. */
export const MESSAGE_BODY_BYTES = LIMITS.inputCharacters * 6 + 64 * 1024;
export const MEDIA_EXTENSIONS = ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "mp4", "mov", "webm", "mkv", "avi"];
export function isMediaExtension(extension: string) { return MEDIA_EXTENSIONS.includes(extension.toLowerCase()); }
export const FILE_ACCEPT = ".txt,.md,.csv,.json,.log,.yaml,.yml,.xml,.pdf,.docx,.xlsx,.png,.jpg,.jpeg,.webp,.gif,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.mp4,.mov,.webm,.mkv,.avi";
export interface NativeImage { type: "blob"; data: string; mimeType: string; displayName: string }
export interface ImageSource { id: string; fileId: string; name: string; mimeType: string; size: number }
export interface ImageAnalysis { fileId: string; imageId: string; model: string; content: string; createdAt: number }
export type MessageStatus = "complete" | "streaming" | "cancelled" | "error";
export interface Chat {
  id: string;
  title: string;
  model: string;
  /** Reasoning level chosen for this chat (null: the default, medium). */
  thinking?: string | null;
  createdAt: number;
  updatedAt: number;
  draft?: string;
  mode?: "chat" | "code";
  projectPath?: string | null;
}
/** One card in a coding reply: a command, a file change, a read/search, or a note. Approvals live on the card they gate. */
export interface CodeEvent {
  id: string;
  chatId: string;
  messageId: string;
  seq: number;
  kind: "command" | "file" | "tool" | "note";
  data: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}
export interface Message {
  id: string;
  chatId: string;
  role: "user" | "assistant";
  content: string;
  model: string;
  status: MessageStatus;
  error: string | null;
  createdAt: number;
  /** The model's own reasoning summary, shown behind "Show thinking"; never sent back as context. */
  reasoning: string;
  /** Web pages found by web search for this reply (cited ones first); absent when the reply didn't search. */
  sources?: WebSource[];
  /** Reasoning level the reply was requested with (absent for replies from before levels were chosen). */
  thinking?: string | null;
  /** Deep research run that produces this reply. */
  research?: ResearchView;
  /** The message before this one on its branch (null for the first). */
  parentId?: string | null;
  /** For an edited user message: every version of it, oldest first (present only when there are several). */
  siblings?: string[];
  /** On a reply whose request summarised older turns to fit the model's context. */
  contextNote?: string;
}
export interface WebSource { url: string; title: string; cited?: boolean }
export type ResearchState = "planning" | "awaiting_start" | "running" | "writing" | "complete" | "cancelled" | "error";
export interface ResearchEntry { kind: "plan" | "search" | "read" | "skip" | "write" | "note"; text: string; url?: string; at: number }
export interface ResearchView {
  id: string;
  state: ResearchState;
  title: string;
  plan: string[];
  log: ResearchEntry[];
  counts: { searches: number; pages: number; failedPages: number; requests: number; userRequests: number };
  limits: { searches: number; pages: number; minutes: number };
  sources: { n: number; url: string; title: string }[];
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}
export interface Attachment {
  id: string;
  chatId: string;
  messageId: string | null;
  name: string;
  size: number;
  characters: number;
  notes: string;
  createdAt: number;
  mimeType?: string;
  frameCount?: number;
  processingStatus?: "uploading" | "queued" | "processing" | "ready" | "failed" | "cancelled";
  processingStage?: string | null;
  processingProgress?: number | null;
  processingError?: string | null;
  uploadComplete?: number;
  messageRole?: "user" | "assistant" | null;
  /** Later versions of the message that carried this attachment over when it was edited. */
  linkedMessageIds?: string[];
  preview?: "image" | "video" | "pdf" | null;
}
export const PREVIEW_TYPES: Record<string, "image" | "video" | "pdf"> = {
  "image/png": "image", "image/jpeg": "image", "image/gif": "image", "image/webp": "image",
  "video/mp4": "video", "video/webm": "video", "application/pdf": "pdf",
};
export interface ChatDetail {
  chat: Chat;
  messages: Message[];
  attachments: Attachment[];
  codeEvents?: CodeEvent[];
  codeLive?: boolean;
}
export interface Model {
  id: string;
  name: string;
  multiplier?: number;
  vision?: boolean;
  maxImages?: number;
  /** Reasoning levels the model supports, in order (none…max); absent when it has no adjustable reasoning. */
  levels?: string[];
}
export type StreamEvent =
  | { type: "start"; user: Message; assistant: Message }
  | { type: "delta"; text: string }
  | { type: "replace"; text: string }
  | { type: "reasoning"; text: string; replace?: boolean }
  | { type: "code"; event: CodeEvent }
  | { type: "web"; searching: boolean; searches: number; sources: WebSource[] }
  | { type: "progress"; stage: string }
  | { type: "context"; note: string }
  | { type: "attachments" }
  | { type: "done"; message: Message }
  | { type: "error"; error: string };
