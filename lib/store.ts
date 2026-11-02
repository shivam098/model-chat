import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { dataDirectory, ensureDataDirectory } from "./config";
import { AppError } from "./errors";
import { LIMITS, type Chat, type Message, type MessageStatus, type Attachment } from "./contracts";
import type { MediaFrame } from "./media";

export type FileRecord = Attachment & { text: string; bytes: Buffer };
export class Store {
  constructor(public db: Database.Database) {
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("secure_delete = ON");
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_chat (
        id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        title TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', draft TEXT NOT NULL DEFAULT '',
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS app_chat_owner ON app_chat(userId, updatedAt);
      CREATE TABLE IF NOT EXISTS app_message (
        id TEXT PRIMARY KEY, chatId TEXT NOT NULL REFERENCES app_chat(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL,
        model TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('complete','streaming','cancelled','error')),
        error TEXT, createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS app_message_chat ON app_message(chatId, createdAt);
      CREATE UNIQUE INDEX IF NOT EXISTS app_one_generation ON app_message(chatId) WHERE status='streaming';
      CREATE TABLE IF NOT EXISTS app_file (
        id TEXT PRIMARY KEY, chatId TEXT NOT NULL REFERENCES app_chat(id) ON DELETE CASCADE,
        messageId TEXT REFERENCES app_message(id) ON DELETE CASCADE,
        name TEXT NOT NULL, size INTEGER NOT NULL, characters INTEGER NOT NULL, notes TEXT NOT NULL,
        text TEXT NOT NULL, bytes BLOB NOT NULL, createdAt INTEGER NOT NULL,
        mimeType TEXT NOT NULL DEFAULT 'text/plain'
      );
      CREATE INDEX IF NOT EXISTS app_file_chat ON app_file(chatId);
      CREATE TABLE IF NOT EXISTS app_media_frame (
        id TEXT PRIMARY KEY, fileId TEXT NOT NULL REFERENCES app_file(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, seconds REAL NOT NULL CHECK(seconds>=0),
        mimeType TEXT NOT NULL CHECK(mimeType='image/jpeg'), bytes BLOB NOT NULL,
        UNIQUE(fileId,position)
      );
      CREATE TABLE IF NOT EXISTS app_acting (
        sessionId TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
        id TEXT NOT NULL UNIQUE, actorId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        subjectId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
        actorId TEXT, subjectId TEXT, action TEXT NOT NULL, objectId TEXT,
        outcome TEXT NOT NULL CHECK(outcome IN ('allowed','denied','error')),
        reason TEXT, delegationId TEXT
      );
      CREATE INDEX IF NOT EXISTS app_audit_actor ON app_audit(actorId,id);
    `);
    const columns = db.pragma("table_info(app_chat)") as { name: string }[];
    if (!columns.some(column => column.name === "draft")) db.exec("ALTER TABLE app_chat ADD COLUMN draft TEXT NOT NULL DEFAULT ''");
    const userColumns = db.pragma("table_info(user)") as { name: string }[];
    if (userColumns.length && !userColumns.some(column => column.name === "appRole")) db.exec("ALTER TABLE user ADD COLUMN appRole TEXT NOT NULL DEFAULT 'user'");
    const fileColumns = db.pragma("table_info(app_file)") as { name: string }[];
    if (!fileColumns.some(column => column.name === "mimeType")) db.exec("ALTER TABLE app_file ADD COLUMN mimeType TEXT NOT NULL DEFAULT 'text/plain'");
  }
  recoverInterrupted() {
    this.db.prepare("UPDATE app_message SET status='error', error=? WHERE status='streaming'")
      .run("The server restarted before this reply finished. Any saved partial text is shown.");
  }
  listChats(userId: string): Chat[] {
    return this.db.prepare("SELECT id,title,model,createdAt,updatedAt FROM app_chat WHERE userId=? ORDER BY updatedAt DESC").all(userId) as Chat[];
  }
  chat(userId: string, chatId: string): Chat {
    const row = this.db.prepare("SELECT id,title,model,draft,createdAt,updatedAt FROM app_chat WHERE userId=? AND id=?").get(userId, chatId) as Chat | undefined;
    if (!row) throw new AppError(404, "Chat not found.");
    return row;
  }
  createChat(userId: string) {
    return this.db.transaction(() => {
      if (this.listChats(userId).length >= LIMITS.chatsPerUser) throw new AppError(400, "Chat limit reached (100). Delete an old chat first.");
      const now = Date.now();
      const id = randomUUID();
      this.db.prepare("INSERT INTO app_chat(id,userId,title,createdAt,updatedAt) VALUES (?,?,?,?,?)").run(id, userId, "New chat", now, now);
      return this.chat(userId, id);
    })();
  }
  assertIdle(userId: string, chatId: string) {
    this.chat(userId, chatId);
    if (this.db.prepare("SELECT 1 FROM app_message WHERE chatId=? AND status='streaming'").get(chatId)) {
      throw new AppError(409, "A reply is in progress. Stop it or wait before changing this chat.");
    }
  }
  renameChat(userId: string, chatId: string, title: string) {
    this.chat(userId, chatId);
    this.db.prepare("UPDATE app_chat SET title=?,updatedAt=? WHERE id=? AND userId=?").run(title, Date.now(), chatId, userId);
    return this.chat(userId, chatId);
  }
  saveDraft(userId: string, chatId: string, draft: string, model?: string) {
    this.assertIdle(userId, chatId);
    if (draft.length > LIMITS.inputCharacters) throw new AppError(400, "The draft exceeds the message length limit.");
    const chat = this.chat(userId, chatId);
    if (chat.draft === draft && (model === undefined || chat.model === model)) return;
    this.db.prepare("UPDATE app_chat SET draft=?,model=COALESCE(?,model),updatedAt=? WHERE id=? AND userId=?").run(draft, model ?? null, Date.now(), chatId, userId);
  }
  deleteChat(userId: string, chatId: string) {
    this.assertIdle(userId, chatId);
    this.db.prepare("DELETE FROM app_chat WHERE id=? AND userId=?").run(chatId, userId);
  }
  messages(userId: string, chatId: string): Message[] {
    this.chat(userId, chatId);
    return this.db.prepare("SELECT * FROM app_message WHERE chatId=? ORDER BY createdAt,rowid").all(chatId) as Message[];
  }
  attachments(userId: string, chatId: string): Attachment[] {
    this.chat(userId, chatId);
    return this.db.prepare("SELECT f.id,f.chatId,f.messageId,f.name,f.size,f.characters,f.notes,f.createdAt,f.mimeType,(SELECT count(*) FROM app_media_frame m WHERE m.fileId=f.id) AS frameCount FROM app_file f WHERE f.chatId=? ORDER BY f.createdAt,f.rowid").all(chatId) as Attachment[];
  }
  file(userId: string, chatId: string, fileId: string): FileRecord {
    this.chat(userId, chatId);
    const row = this.db.prepare("SELECT * FROM app_file WHERE chatId=? AND id=?").get(chatId, fileId) as FileRecord | undefined;
    if (!row) throw new AppError(404, "File not found.");
    return row;
  }
  fileText(userId: string, chatId: string, fileId: string) {
    this.chat(userId, chatId);
    const row = this.db.prepare("SELECT id,name,text,notes FROM app_file WHERE chatId=? AND id=?").get(chatId, fileId) as { id: string; name: string; text: string; notes: string } | undefined;
    if (!row) throw new AppError(404, "File not found.");
    return row;
  }
  addFile(userId: string, chatId: string, name: string, bytes: Buffer, text: string, notes: string, mimeType = "text/plain", frames: MediaFrame[] = []) {
    return this.db.transaction(() => {
      this.assertIdle(userId, chatId);
      const current = this.attachments(userId, chatId);
      if (current.length >= LIMITS.filesPerChat) throw new AppError(400, "Each chat can hold up to 8 files.");
      if (current.reduce((n, f) => n + f.characters, text.length) > LIMITS.chatFileCharacters) throw new AppError(400, "This chat's files exceed the 60,000-character limit. Use a smaller file or a new chat.");
      if (frames.length > LIMITS.videoFrames || frames.some(frame => frame.bytes.length > LIMITS.videoFrameBytes || frame.seconds < 0 || frame.seconds > LIMITS.mediaSeconds + 0.5)) throw new AppError(400, "Sampled video frames exceed the supported limits.");
      const total = this.db.prepare("SELECT COALESCE(SUM(f.size + COALESCE((SELECT SUM(length(m.bytes)) FROM app_media_frame m WHERE m.fileId=f.id),0)),0) AS size FROM app_file f JOIN app_chat c ON f.chatId=c.id WHERE c.userId=?").get(userId) as { size: number };
      if (total.size + bytes.length + frames.reduce((sum, frame) => sum + frame.bytes.length, 0) > LIMITS.userFileBytes) throw new AppError(400, "Your files and generated frames exceed 50 MB. Delete old chats or files first.");
      const id = randomUUID();
      this.db.prepare("INSERT INTO app_file(id,chatId,messageId,name,size,characters,notes,text,bytes,createdAt,mimeType) VALUES (?,?,NULL,?,?,?,?,?,?,?,?)").run(id, chatId, name, bytes.length, text.length, notes, text, bytes, Date.now(), mimeType);
      const insertFrame = this.db.prepare("INSERT INTO app_media_frame VALUES (?,?,?,?,?,?)");
      frames.forEach((frame, position) => insertFrame.run(randomUUID(), id, position, frame.seconds, frame.mimeType, frame.bytes));
      return this.attachments(userId, chatId).find(f => f.id === id)!;
    })();
  }
  deleteFile(userId: string, chatId: string, fileId: string) {
    this.assertIdle(userId, chatId);
    const file = this.file(userId, chatId, fileId);
    if (file.messageId) throw new AppError(409, "Files already sent are part of saved context. Delete the chat to remove them.");
    this.db.prepare("DELETE FROM app_file WHERE chatId=? AND id=?").run(chatId, fileId);
  }
  contextFiles(userId: string, chatId: string, pendingIds: string[]) {
    const attachments = this.attachments(userId, chatId);
    for (const id of pendingIds) {
      const file = attachments.find(item => item.id === id);
      if (!file) throw new AppError(404, "File not found.");
      if (file.messageId) throw new AppError(400, "This file has already been sent.");
    }
    return attachments
      .filter(f => f.messageId || pendingIds.includes(f.id))
      .map(f => {
        const full = this.fileText(userId, chatId, f.id);
        return { id: full.id, name: full.name, text: full.text };
      });
  }
  contextImages(userId: string, chatId: string, pendingIds: string[]) {
    this.contextFiles(userId, chatId, pendingIds);
    return this.attachments(userId, chatId).filter(file => file.messageId || pendingIds.includes(file.id)).flatMap(file => {
      if (file.mimeType?.startsWith("image/")) return [this.file(userId, chatId, file.id)];
      if (!file.mimeType?.startsWith("video/")) return [];
      const frames = this.db.prepare("SELECT id,seconds,mimeType,bytes FROM app_media_frame WHERE fileId=? ORDER BY position").all(file.id) as { id: string; seconds: number; mimeType: string; bytes: Buffer }[];
      return frames.map(frame => ({
        ...file, id: frame.id, name: `${file.name} [sample at ${frame.seconds.toFixed(2)}s]`,
        mimeType: frame.mimeType, bytes: frame.bytes, size: frame.bytes.length, text: `[Sampled video frame at approximately ${frame.seconds.toFixed(2)}s]`,
      }));
    });
  }
  beginTurn(userId: string, chatId: string, content: string, model: string, fileIds: string[]) {
    return this.db.transaction(() => {
      this.assertIdle(userId, chatId);
      this.contextFiles(userId, chatId, fileIds);
      if (this.messages(userId, chatId).length >= LIMITS.messagesPerChat) throw new AppError(400, "This chat has reached 100 turns. Start a new chat.");
      const now = Date.now();
      const user: Message = { id: randomUUID(), chatId, role: "user", content, model, status: "complete", error: null, createdAt: now };
      const assistant: Message = { ...user, id: randomUUID(), role: "assistant", content: "", status: "streaming", createdAt: now + 1 };
      const insert = this.db.prepare("INSERT INTO app_message VALUES (@id,@chatId,@role,@content,@model,@status,@error,@createdAt)");
      insert.run(user);
      insert.run(assistant);
      for (const id of fileIds) this.db.prepare("UPDATE app_file SET messageId=? WHERE chatId=? AND id=?").run(user.id, chatId, id);
      this.db.prepare("UPDATE app_chat SET model=?,updatedAt=?,draft='',title=CASE WHEN title='New chat' THEN ? ELSE title END WHERE id=? AND userId=?")
        .run(model, now, content.slice(0, 64) || "File analysis", chatId, userId);
      return { user, assistant };
    })();
  }
  saveReply(userId: string, chatId: string, messageId: string, content: string, status: MessageStatus, error: string | null = null): Message {
    this.chat(userId, chatId);
    const result = this.db.prepare("UPDATE app_message SET content=?,status=?,error=? WHERE id=? AND chatId=? AND role='assistant' AND status='streaming'")
      .run(content, status, error, messageId, chatId);
    if (result.changes !== 1) throw new AppError(409, "This reply is no longer active.");
    this.db.prepare("UPDATE app_chat SET updatedAt=? WHERE id=? AND userId=?").run(Date.now(), chatId, userId);
    return this.messages(userId, chatId).find(m => m.id === messageId)!;
  }
}

const globalStore = globalThis as typeof globalThis & { modelChatStore?: Store };
export function getStore() {
  if (!globalStore.modelChatStore) {
    ensureDataDirectory();
    globalStore.modelChatStore = new Store(new Database(path.join(dataDirectory, "model-chat.db")));
    if (process.env.MODEL_CHAT_SERVER_INSTANCE === String(process.pid)) globalStore.modelChatStore.recoverInterrupted();
  }
  return globalStore.modelChatStore;
}
