import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { AccessContext } from "./access";
import type { Store } from "./store";
import { AppError } from "./errors";
import { rejectExecutableHeader } from "./upload-io";

export type FileJobStatus = "uploading" | "queued" | "processing" | "ready" | "failed" | "cancelled";
export interface FileJob {
  fileId: string; actorId: string; subjectId: string; sessionId: string; delegationId: string | null;
  extension: string; status: FileJobStatus; stage: string; progress: number;
  error: string | null; completeUpload: number; attempts: number; lease: string | null;
  expectedSize: number;
  createdAt: number; updatedAt: number;
}
export function installUploadSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_file_job (
      fileId TEXT PRIMARY KEY REFERENCES app_file(id) ON DELETE CASCADE,
      actorId TEXT NOT NULL, subjectId TEXT NOT NULL, sessionId TEXT NOT NULL, delegationId TEXT,
      extension TEXT NOT NULL, status TEXT NOT NULL,
      stage TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0, error TEXT,
      completeUpload INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, lease TEXT,
      expectedSize INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS app_file_job_queue ON app_file_job(status,createdAt);
    CREATE TABLE IF NOT EXISTS app_file_chunk (
      fileId TEXT NOT NULL REFERENCES app_file(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(fileId,position)
    );
    CREATE TABLE IF NOT EXISTS app_text_chunk (
      id INTEGER PRIMARY KEY, fileId TEXT NOT NULL REFERENCES app_file(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, content TEXT NOT NULL, UNIQUE(fileId,position)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS app_text_search USING fts5(content,fileId UNINDEXED,position UNINDEXED,content='app_text_chunk',content_rowid='id');
    CREATE TRIGGER IF NOT EXISTS app_text_insert AFTER INSERT ON app_text_chunk BEGIN
      INSERT INTO app_text_search(rowid,content,fileId,position) VALUES(new.id,new.content,new.fileId,new.position);
    END;
    CREATE TRIGGER IF NOT EXISTS app_text_delete AFTER DELETE ON app_text_chunk BEGIN
      INSERT INTO app_text_search(app_text_search,rowid,content,fileId,position) VALUES('delete',old.id,old.content,old.fileId,old.position);
    END;
    CREATE TABLE IF NOT EXISTS app_analysis_image (
      fileId TEXT PRIMARY KEY REFERENCES app_file(id) ON DELETE CASCADE,
      mimeType TEXT NOT NULL, bytes BLOB NOT NULL
    );
  `);
}
export class UploadStore {
  constructor(public store: Store) {}
  job(fileId: string) {
    return this.store.db.prepare("SELECT * FROM app_file_job WHERE fileId=?").get(fileId) as FileJob | undefined;
  }
  create(context: AccessContext, chatId: string, name: string, extension: string, expectedSize = 0) {
    this.store.chat(context.subject.id, chatId);
    const id = randomUUID();
    const now = Date.now();
    this.store.db.transaction(() => {
      this.store.db.prepare("INSERT INTO app_file(id,chatId,messageId,name,size,characters,notes,text,bytes,createdAt,mimeType) VALUES (?,?,NULL,?,0,0,'Uploading','',?,?,'application/octet-stream')")
        .run(id, chatId, name, Buffer.alloc(0), now);
      this.store.db.prepare("INSERT INTO app_file_job(fileId,actorId,subjectId,sessionId,delegationId,extension,status,stage,createdAt,updatedAt,expectedSize) VALUES (?,?,?,?,?,?,'uploading','Receiving upload',?,?,?)")
        .run(id, context.actor.id, context.subject.id, context.sessionId, context.delegationId, extension, now, now, expectedSize);
    })();
    return id;
  }
  append(fileId: string, position: number, bytes: Buffer) {
    this.store.db.transaction(() => {
      const job = this.job(fileId);
      if (!job || job.status !== "uploading") throw new AppError(409, "This upload is no longer active.");
      const count = (this.store.db.prepare("SELECT count(*) count FROM app_file_chunk WHERE fileId=?").get(fileId) as { count: number }).count;
      if (position < count) {
        const existing = this.store.db.prepare("SELECT bytes FROM app_file_chunk WHERE fileId=? AND position=?").get(fileId, position) as { bytes: Buffer };
        if (!existing.bytes.equals(bytes)) throw new AppError(409, "The repeated upload part does not match.");
        return;
      }
      if (position !== count) throw new AppError(409, "Upload parts must arrive in order.");
      if (!bytes.length) throw new AppError(400, "Upload parts cannot be empty.");
      const size = (this.store.db.prepare("SELECT size FROM app_file WHERE id=?").get(fileId) as { size: number }).size;
      const total = size + bytes.length;
      if (!Number.isSafeInteger(total)) throw new AppError(400, "The file length exceeds this platform's addressable range.");
      if (job.expectedSize && total > job.expectedSize) throw new AppError(400, "The upload exceeds its declared length.");
      this.store.db.prepare("INSERT INTO app_file_chunk VALUES (?,?,?)").run(fileId, position, bytes);
      this.store.db.prepare("UPDATE app_file SET size=? WHERE id=?").run(total, fileId);
      this.store.db.prepare("UPDATE app_file_job SET updatedAt=? WHERE fileId=?").run(Date.now(), fileId);
    })();
  }
  enqueue(fileId: string) {
    const job = this.job(fileId);
    const file = this.store.db.prepare("SELECT size FROM app_file WHERE id=?").get(fileId) as { size: number } | undefined;
    if (!job || !file?.size || (job.expectedSize && file.size !== job.expectedSize)) throw new AppError(400, "The upload is empty or incomplete.");
    if (job.completeUpload) return;
    const prefix = this.store.db.prepare("SELECT substr(bytes,1,32) bytes FROM app_file_chunk WHERE fileId=? ORDER BY position LIMIT 32").all(fileId) as { bytes: Buffer }[];
    rejectExecutableHeader(Buffer.concat(prefix.map(row => row.bytes)).subarray(0, 32));
    const result = this.store.db.prepare("UPDATE app_file_job SET status='queued',stage='Queued for background processing',completeUpload=1,updatedAt=? WHERE fileId=? AND status='uploading'")
      .run(Date.now(), fileId);
    if (!result.changes) throw new AppError(409, "The upload could not be queued.");
  }
  assertUploader(context: AccessContext, fileId: string) {
    const job = this.job(fileId);
    if (!job || job.actorId !== context.actor.id || job.subjectId !== context.subject.id || job.sessionId !== context.sessionId) throw new AppError(403, "This upload belongs to a different authenticated workspace.");
    return job;
  }
  discardIncomplete(fileId: string) {
    const job = this.job(fileId);
    if (job?.status === "uploading") this.store.db.prepare("DELETE FROM app_file WHERE id=?").run(fileId);
  }
  authorize(job: FileJob) {
    const owner = this.store.db.prepare("SELECT id,appRole FROM user WHERE id=?").get(job.subjectId) as { id: string; appRole: string } | undefined;
    const file = this.store.db.prepare("SELECT c.userId FROM app_file f JOIN app_chat c ON c.id=f.chatId WHERE f.id=?").get(job.fileId) as { userId: string } | undefined;
    if (!owner || file?.userId !== owner.id) throw new AppError(403, "The file owner or file no longer exists.");
    if (job.actorId === job.subjectId) return;
    const actor = this.store.db.prepare("SELECT appRole FROM user WHERE id=?").get(job.actorId) as { appRole: string } | undefined;
    const session = this.store.db.prepare("SELECT expiresAt FROM session WHERE id=? AND userId=?").get(job.sessionId, job.actorId) as { expiresAt: string | number } | undefined;
    const expires = session ? new Date(session.expiresAt).getTime() : NaN;
    if (!job.delegationId || actor?.appRole !== "superuser" || owner.appRole !== "user" || !Number.isFinite(expires) || expires <= Date.now()) {
      throw new AppError(403, "The administrator's authorization for this job ended.");
    }
  }
  check(job: FileJob) {
    const current = this.job(job.fileId);
    if (!current || current.status !== "processing" || current.lease !== job.lease) throw new AppError(409, "File processing was cancelled or replaced.");
    this.authorize(job);
  }
  recover() {
    this.store.db.transaction(() => {
      this.store.db.prepare("UPDATE app_file_job SET status='failed',stage='Upload interrupted',error='The upload did not finish. Remove this entry and upload the original again.',updatedAt=? WHERE status='uploading'").run(Date.now());
      this.store.db.prepare("UPDATE app_file_job SET status='queued',stage='Queued after restart',lease=NULL,updatedAt=? WHERE status='processing'").run(Date.now());
    })();
  }
  claim(media: boolean) {
    return this.store.db.transaction(() => {
      const mediaExtensions = "'mp3','wav','m4a','aac','flac','ogg','opus','mp4','mov','webm','mkv','avi'";
      const job = this.store.db.prepare(`SELECT * FROM app_file_job WHERE status='queued' AND extension ${media ? "IN" : "NOT IN"} (${mediaExtensions}) ORDER BY createdAt,fileId LIMIT 1`).get() as FileJob | undefined;
      if (!job) return undefined;
      const lease = randomUUID();
      this.store.db.prepare("UPDATE app_file_job SET status='processing',stage='Starting processor',progress=0,attempts=attempts+1,lease=?,error=NULL,updatedAt=? WHERE fileId=?")
        .run(lease, Date.now(), job.fileId);
      this.store.db.prepare("DELETE FROM app_text_chunk WHERE fileId=?").run(job.fileId);
      this.store.db.prepare("DELETE FROM app_media_frame WHERE fileId=?").run(job.fileId);
      this.store.db.prepare("DELETE FROM app_analysis_image WHERE fileId=?").run(job.fileId);
      return { ...job, status: "processing" as const, lease, attempts: job.attempts + 1 };
    })();
  }
  progress(job: FileJob, stage: string, progress: number) {
    this.check(job);
    this.store.db.prepare("UPDATE app_file_job SET stage=?,progress=?,updatedAt=? WHERE fileId=? AND lease=?")
      .run(stage.slice(0, 100), Math.max(0, Math.min(0.99, progress)), Date.now(), job.fileId, job.lease);
  }
  audit(job: FileJob, outcome: "allowed" | "denied" | "error", reason: string) {
    this.store.db.prepare("INSERT INTO app_audit(at,actorId,subjectId,action,objectId,outcome,reason,delegationId) VALUES (?,?,?,'file.process',?,?,?,?)")
      .run(Date.now(), job.actorId, job.subjectId, job.fileId, outcome, reason, job.delegationId);
  }
  fail(job: FileJob, error: string, restart = false, denied = false) {
    const current = this.job(job.fileId);
    if (!current || current.lease !== job.lease || current.status !== "processing") return;
    this.store.db.transaction(() => {
      this.store.db.prepare("UPDATE app_file_job SET status=?,stage=?,error=?,lease=NULL,updatedAt=? WHERE fileId=?")
        .run(restart ? "queued" : "failed", restart ? "Queued after shutdown" : "Processing failed", restart ? null : error.slice(0, 500), Date.now(), job.fileId);
      if (!restart) this.audit(job, denied ? "denied" : "error", denied ? "authorization_ended" : "processing_failed");
    })();
  }
  retry(context: AccessContext, chatId: string, fileId: string) {
    const file = this.store.fileText(context.subject.id, chatId, fileId);
    const job = this.job(file.id);
    if (!job?.completeUpload || !["failed", "cancelled"].includes(job.status)) throw new AppError(409, "Only a completely uploaded failed or cancelled file can be retried.");
    this.store.db.prepare("UPDATE app_file_job SET actorId=?,subjectId=?,sessionId=?,delegationId=?,status='queued',stage='Queued for retry',error=NULL,progress=0,lease=NULL,updatedAt=? WHERE fileId=?")
      .run(context.actor.id, context.subject.id, context.sessionId, context.delegationId, Date.now(), fileId);
  }
  cancel(context: AccessContext, chatId: string, fileId: string) {
    this.store.fileText(context.subject.id, chatId, fileId);
    const result = this.store.db.prepare("UPDATE app_file_job SET status='cancelled',stage='Cancelled',error=NULL,updatedAt=? WHERE fileId=? AND status IN ('uploading','queued','processing')")
      .run(Date.now(), fileId);
    if (!result.changes) throw new AppError(409, "This file is not waiting or processing.");
  }
  *rawChunks(fileId: string) {
    const job = this.job(fileId);
    if (!job) {
      const row = this.store.db.prepare("SELECT bytes FROM app_file WHERE id=?").get(fileId) as { bytes: Buffer } | undefined;
      if (!row) throw new AppError(404, "File not found.");
      yield row.bytes;
      return;
    }
    if (!job.completeUpload) throw new AppError(409, "The original upload is incomplete.");
    for (let position = 0; ; position++) {
      const row = this.store.db.prepare("SELECT bytes FROM app_file_chunk WHERE fileId=? AND position=?").get(fileId, position) as { bytes: Buffer } | undefined;
      if (!row) break;
      yield row.bytes;
    }
  }
}

export function fileTextPage(db: Database.Database, fileId: string, cursor = 0) {
  const count = (db.prepare("SELECT count(*) count FROM app_text_chunk WHERE fileId=?").get(fileId) as { count: number }).count;
  if (!count) {
    const row = db.prepare("SELECT text FROM app_file WHERE id=?").get(fileId) as { text: string } | undefined;
    return { text: row?.text || "", nextCursor: null, chunkCount: 0 };
  }
  const rows = db.prepare("SELECT position,content FROM app_text_chunk WHERE fileId=? AND position>=? ORDER BY position LIMIT 8").all(fileId, cursor) as { position: number; content: string }[];
  const next = (rows.at(-1)?.position ?? cursor - 1) + 1;
  return { text: rows.map(row => row.content).join(""), nextCursor: next < count ? next : null, chunkCount: count };
}

export function fileContextExcerpt(db: Database.Database, fileId: string, query: string, budget: number): string {
  const meta = db.prepare("SELECT characters,text FROM app_file WHERE id=?").get(fileId) as { characters: number; text: string };
  const count = (db.prepare("SELECT count(*) count FROM app_text_chunk WHERE fileId=?").get(fileId) as { count: number }).count;
  const label = `[Selected excerpts from ${meta.characters} processed characters. This is not the entire file; do not claim complete coverage.]\n`;
  const fits = (text: string) => Buffer.byteLength(JSON.stringify(text), "utf8") <= budget;
  const excerpt = (text: string) => {
    let low = 0, high = Math.min(text.length, budget);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(label + text.slice(0, middle))) low = middle; else high = middle - 1;
    }
    if (low && /[\uD800-\uDBFF]/.test(text[low - 1])) low--;
    return label + text.slice(0, low);
  };
  if (!count) return fits(meta.text) ? meta.text : excerpt(meta.text);
  const maximum = Math.max(1, Math.floor(budget / 4000));
  if (count <= maximum && meta.characters <= budget) {
    const full = (db.prepare("SELECT content FROM app_text_chunk WHERE fileId=? ORDER BY position").all(fileId) as { content: string }[]).map(row => row.content).join("");
    return fits(full) ? full : excerpt(full);
  }
  const ignored = new Set(["the", "and", "with", "this", "that", "file", "files", "please", "summary", "summarize", "audio", "video", "transcript", "what"]);
  const tokens = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) || []).filter(token => !ignored.has(token)))].slice(0, 12);
  let rows: { position: number; content: string }[] = [];
  if (tokens.length) {
    const expression = tokens.map(token => `"${token.replaceAll('"', '""')}"`).join(" OR ");
    rows = db.prepare("SELECT position,content FROM app_text_search WHERE app_text_search MATCH ? AND fileId=? ORDER BY rank LIMIT ?").all(expression, fileId, maximum) as typeof rows;
  }
  if (!rows.length) {
    const positions = new Set(Array.from({ length: maximum }, (_, index) => maximum === 1 ? 0 : Math.round(index * (count - 1) / (maximum - 1))));
    const get = db.prepare("SELECT position,content FROM app_text_chunk WHERE fileId=? AND position=?");
    rows = [...positions].map(position => get.get(fileId, position) as { position: number; content: string });
  }
  return excerpt(rows.sort((a, b) => a.position - b.position).map(row => `[Section ${row.position + 1}]\n${row.content}`).join("\n"));
}
