import { statfs } from "node:fs/promises";
import { dataDirectory } from "./config";
import { AppError } from "./errors";
import type { UploadStore } from "./upload-store";

export const UPLOAD_PART_BYTES = 4 * 1024 * 1024;
const DISK_RESERVE = 1024n * 1024n * 1024n;
export async function requireDiskCapacity(additionalBytes: number) {
  const stats = await statfs(dataDirectory, { bigint: true });
  const free = stats.bavail * stats.bsize;
  if (free < BigInt(Math.ceil(additionalBytes)) * 2n + DISK_RESERVE) {
    throw new AppError(507, "The host does not have enough free disk space. Free space or move the data directory, then retry.");
  }
}
export function rejectExecutableHeader(bytes: Buffer) {
  if (bytes.subarray(0, 2).toString("ascii") === "MZ" || bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) {
    throw new AppError(415, "Executable files are not accepted.");
  }
}
export async function receiveUpload(request: Request, uploads: UploadStore, fileId: string, authorize: () => void) {
  if (!request.body) throw new AppError(400, "The file is empty.");
  const reader = request.body.getReader();
  let chunks: Buffer[] = [];
  let buffered = 0;
  let total = 0;
  let position = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (let offset = 0; offset < value.length; offset += UPLOAD_PART_BYTES) {
        const part = Buffer.from(value.subarray(offset, Math.min(value.length, offset + UPLOAD_PART_BYTES)));
        chunks.push(part); buffered += part.length;
        if (buffered >= UPLOAD_PART_BYTES) {
          authorize();
          await requireDiskCapacity(buffered);
          const content = Buffer.concat(chunks);
          if (!position) rejectExecutableHeader(content);
          total += content.length;
          if (!Number.isSafeInteger(total)) throw new AppError(400, "The file length exceeds this platform's addressable range.");
          uploads.append(fileId, position++, content);
          chunks = []; buffered = 0;
        }
      }
    }
    if (buffered) {
      authorize(); await requireDiskCapacity(buffered);
      const content = Buffer.concat(chunks);
      if (!position) rejectExecutableHeader(content);
      total += content.length;
      uploads.append(fileId, position, content);
    }
    authorize(); request.signal.throwIfAborted();
    uploads.enqueue(fileId);
  } finally { reader.releaseLock(); }
}
