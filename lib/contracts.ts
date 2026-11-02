export const LIMITS = {
  fileBytes: 5 * 1024 * 1024,
  mediaBytes: 25 * 1024 * 1024,
  mediaSeconds: 180,
  videoFrames: 4,
  videoFrameBytes: 512 * 1024,
  userFileBytes: 50 * 1024 * 1024,
  filesPerChat: 8,
  filesPerMessage: 4,
  fileCharacters: 30_000,
  chatFileCharacters: 60_000,
  promptBytes: 100_000,
  inputCharacters: 8_000,
  outputCharacters: 32_000,
  messagesPerChat: 200,
  chatsPerUser: 100,
};
export const MEDIA_EXTENSIONS = ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "mp4", "mov", "webm", "mkv", "avi"];
export function isMediaExtension(extension: string) { return MEDIA_EXTENSIONS.includes(extension.toLowerCase()); }
export function uploadByteLimit(name: string) { return isMediaExtension(name.split(".").at(-1) || "") ? LIMITS.mediaBytes : LIMITS.fileBytes; }
export const FILE_ACCEPT = ".txt,.md,.csv,.json,.log,.yaml,.yml,.xml,.pdf,.docx,.xlsx,.png,.jpg,.jpeg,.webp,.gif,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.mp4,.mov,.webm,.mkv,.avi";
export interface NativeImage { type: "blob"; data: string; mimeType: string; displayName: string }
export type MessageStatus = "complete" | "streaming" | "cancelled" | "error";
export interface Chat {
  id: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  draft?: string;
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
}
export interface ChatDetail {
  chat: Chat;
  messages: Message[];
  attachments: Attachment[];
}
export interface Model {
  id: string;
  name: string;
  multiplier?: number;
  vision?: boolean;
}
export type StreamEvent =
  | { type: "start"; user: Message; assistant: Message }
  | { type: "delta"; text: string }
  | { type: "replace"; text: string }
  | { type: "done"; message: Message }
  | { type: "error"; error: string };
