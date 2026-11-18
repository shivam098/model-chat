export const LIMITS = {
  fileBytes: 5 * 1024 * 1024,
  videoFrames: 4,
  videoFrameBytes: 512 * 1024,
  transfersPerUser: 3,
  transfersPerApp: 6,
  fileCharacters: 30_000,
  chatFileCharacters: 60_000,
  promptBytes: 100_000,
  inputCharacters: 8_000,
  outputCharacters: 32_000,
  reasoningCharacters: 32_000,
  codeEventText: 64_000,
  webSources: 8,
  messagesPerChat: 200,
  chatsPerUser: 100,
};
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
}
export interface WebSource { url: string; title: string; cited?: boolean }
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
}
export type StreamEvent =
  | { type: "start"; user: Message; assistant: Message }
  | { type: "delta"; text: string }
  | { type: "replace"; text: string }
  | { type: "reasoning"; text: string; replace?: boolean }
  | { type: "code"; event: CodeEvent }
  | { type: "web"; searching: boolean; searches: number; sources: WebSource[] }
  | { type: "progress"; stage: string }
  | { type: "attachments" }
  | { type: "done"; message: Message }
  | { type: "error"; error: string };
