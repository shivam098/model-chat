import { parentPort, workerData } from "node:worker_threads";
import yauzl from "yauzl";
import { open, readFile, stat, writeFile } from "node:fs/promises";
import { freemem } from "node:os";

const maximumText = 30_000;
// Shown to the user as written; any other image-decoder error is replaced by a plain message.
class ImageRejection extends Error {}
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"];
// 16,383 x 16,383, libvips' own default: covers 200 MP phone cameras and very wide panoramas.
const MAX_IMAGE_PIXELS = 268_402_689;
// The largest side JPEG, PNG and GIF can encode.
const MAX_IMAGE_SIDE = 65_535;
// Progressive JPEG, interlaced PNG, WebP and GIF are decoded whole; baseline JPEG and PNG are decoded in strips.
const WHOLE_IMAGE_BUDGET = Math.min(1024 ** 3, freemem() / 4);
// Above 16 MP, an image that would expand to more than 4,096 times its file size is treated as a decompression bomb.
const BOMB_MIN_PIXELS = 16_000_000;
const BOMB_EXPANSION = 4096;
const IMAGE_SECONDS = 120;
const UNREADABLE_IMAGE = "This image couldn't be read. It may be damaged, cut off during upload, or use an encoding Model Chat can't decode. Open it and export it again as JPEG or PNG, then upload that.";
const count = value => value.toLocaleString("en-US");
const megapixels = pixels => `${pixels < 10_000_000 ? (pixels / 1e6).toFixed(1) : count(Math.round(pixels / 1e6))} megapixels`;
const size = bytes => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${Math.round(bytes / 1024 ** 2)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
function wholeImageBytes(kind, meta, pixels) {
  const channels = meta.channels || 3;
  if (kind === "jpeg") {
    if (!meta.isProgressive) return 0;
    // libjpeg keeps every 16-bit DCT coefficient of a progressive JPEG until its last scan.
    const samples = { "4:2:0": 1.5, "4:2:2": 2, "4:4:0": 2, "4:2:0:4": 2.5 }[meta.chromaSubsampling] ?? channels;
    return pixels * samples * 2;
  }
  if (kind === "png") return meta.isProgressive ? pixels * channels * ((meta.bitsPerSample || 8) > 8 ? 2 : 1) : 0;
  return pixels * 4;
}
async function imageInput(extension, bytes) {
  const kind = extension === "jpg" || extension === "jpeg" ? "jpeg" : extension;
  const valid = kind === "png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) :
    kind === "jpeg" ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff :
    kind === "gif" ? ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii")) :
    bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!valid) throw new ImageRejection(`The image bytes do not match the .${extension} extension. Open it and export it again as JPEG or PNG, then upload that.`);
  const { default: sharp } = await import("sharp");
  const source = workerData.inputPath || bytes;
  const fileBytes = workerData.inputPath ? (await stat(workerData.inputPath)).size : source.length;
  let meta;
  // Reads only the header, so the limits below are checked before any pixels are decoded.
  try { meta = await sharp(source, { limitInputPixels: false, animated: false }).metadata(); }
  catch { throw new ImageRejection(UNREADABLE_IMAGE); }
  const { width, height } = meta;
  if (!width || !height) throw new ImageRejection(UNREADABLE_IMAGE);
  if ((meta.pages || 1) !== 1) throw new ImageRejection("Animated images are not supported. Upload a still PNG or JPEG frame.");
  const pixels = width * height;
  const dimensions = `${count(width)} × ${count(height)} pixels (${megapixels(pixels)})`;
  if (pixels > MAX_IMAGE_PIXELS || width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) {
    throw new ImageRejection(`This image is ${dimensions}. Model Chat accepts up to 268 megapixels and 65,535 pixels per side, enough for 200 MP phone photos and most panoramas. Export a smaller copy and upload that.`);
  }
  if (pixels > BOMB_MIN_PIXELS && pixels * (meta.channels || 3) > fileBytes * BOMB_EXPANSION) {
    throw new ImageRejection(`This file is only ${size(fileBytes)} but claims to hold ${dimensions}. Files like this are usually built to exhaust memory, so it was not opened. If it's a real picture, export it again as JPEG and upload that.`);
  }
  const whole = wholeImageBytes(kind, meta, pixels);
  if (whole > WHOLE_IMAGE_BUDGET) {
    const format = kind === "jpeg" ? "progressive JPEG" : kind === "png" ? "interlaced PNG" : kind.toUpperCase();
    throw new ImageRejection(`This ${format} is ${dimensions} and must be decoded all at once, which needs about ${size(whole)} of memory (the limit is ${size(WHOLE_IMAGE_BUDGET)}). Export it as a standard JPEG or a smaller copy and upload that.`);
  }
  const image = sharp(source, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "error", animated: false }).timeout({ seconds: IMAGE_SECONDS });
  let analysisBytes;
  try {
    // A square box gives the same result before or after orientation, so libvips can shrink while decoding.
    if (workerData.inputPath) analysisBytes = await image.autoOrient().resize(2048, 2048, { fit: "inside", withoutEnlargement: true }).flatten({ background: "white" }).jpeg({ quality: 85 }).toBuffer();
    else await image.resize(32, 32, { fit: "inside" }).toBuffer();
  } catch (error) {
    if (/timeout/i.test(error instanceof Error ? error.message : "")) {
      throw new ImageRejection(`Decoding this image took longer than ${IMAGE_SECONDS / 60} minutes, so it was stopped. Export a smaller JPEG copy and upload that.`);
    }
    throw new ImageRejection(UNREADABLE_IMAGE);
  }
  const shown = meta.autoOrient || { width, height };
  return { text: `[Native image input: ${shown.width} x ${shown.height}. Its pixels are supplied separately to a vision-capable model.]`,
    notes: analysisBytes
      ? `Native Copilot image input, sent to the model as a copy at most 2048 pixels on its longest side. A vision-capable model is required; the original file is kept.`
      : "Native Copilot image input. A vision-capable model is required; original bytes are retained.",
    mimeType: `image/${kind}`, ...(analysisBytes ? { analysisBytes } : {}) };
}
function bounded(text) {
  if (!workerData.outputPath && text.length > maximumText) throw new Error("The extracted file exceeds 30,000 characters. Upload a smaller excerpt.");
  return text;
}
async function checkArchive(buffer, expected) {
  await new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) return reject(new Error("This is not a valid Office ZIP document."));
      let entries = 0;
      let total = 0;
      let actual = 0;
      let hasExpected = false;
      let failed = false;
      function fail(reason) {
        if (failed) return;
        failed = true;
        zip.close();
        reject(new Error(reason));
      }
      zip.on("error", () => fail("The Office document is damaged."));
      zip.on("end", () => hasExpected ? resolve() : reject(new Error("The file does not match its Office extension.")));
      zip.on("entry", entry => {
        if (failed) return;
        entries++;
        total += entry.uncompressedSize;
        if (entries > 2000 || total > (workerData.inputPath ? Math.min(freemem() / 8, 128 * 1024 * 1024) : 20 * 1024 * 1024) ||
            entry.uncompressedSize > 150 * Math.max(entry.compressedSize, 1024)) {
          return fail("The document archive exceeds safe size or compression limits.");
        }
        if ((entry.generalPurposeBitFlag & 1) || /(^|\/)(?:vbaProject|embeddings)(?:[./]|$)/i.test(entry.fileName) ||
            /\.(exe|dll|com|js|vbs|ps1|bat|cmd|bin)$/i.test(entry.fileName)) {
          return fail("Encrypted documents, embedded executables and macros are not supported.");
        }
        if (entry.fileName === expected) hasExpected = true;
        if (entry.fileName.endsWith("/")) return zip.readEntry();
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return fail("The Office document could not be expanded.");
          stream.on("error", () => fail("The Office document is damaged."));
          stream.on("data", chunk => {
            actual += chunk.length;
            if (actual > (workerData.inputPath ? Math.min(freemem() / 8, 128 * 1024 * 1024) : 20 * 1024 * 1024)) {
              stream.destroy();
              fail("The expanded archive exceeds the isolated parser's memory-safety budget.");
            }
          });
          stream.on("end", () => { if (!failed) zip.readEntry(); });
        });
      });
      zip.readEntry();
    });
  });
}
async function extract() {
  const extension = workerData.extension;
  let bytes;
  if (workerData.inputPath && IMAGE_EXTENSIONS.includes(extension)) {
    const file = await open(workerData.inputPath, "r");
    try { bytes = Buffer.alloc(32); await file.read(bytes, 0, 32, 0); } finally { await file.close(); }
  } else if (workerData.inputPath) {
    const info = await stat(workerData.inputPath);
    if (info.size > Math.min(freemem() / 8, 512 * 1024 * 1024)) throw new Error("This document cannot be decoded within the isolated parser's available-memory budget. The original upload is retained.");
    bytes = await readFile(workerData.inputPath);
  } else bytes = Buffer.from(workerData.bytes);
  if (IMAGE_EXTENSIONS.includes(extension)) return imageInput(extension, bytes);
  if (["txt", "md", "csv", "json", "log", "yaml", "yml", "xml"].includes(extension)) {
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error("Text uploads must use UTF-8 encoding."); }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text) || text.startsWith("MZ") || text.startsWith("\u007fELF")) {
      throw new Error("The file contains binary data. Upload a UTF-8 text document.");
    }
    if (extension === "json") {
      try { JSON.parse(text); } catch { throw new Error("The JSON file is not valid JSON."); }
    }
    return { text: bounded(text), notes: "UTF-8 text. No code or formulas are executed." };
  }
  if (extension === "pdf") {
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("The file is not a PDF.");
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loading = getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0,
    });
    const document = await loading.promise;
    try {
      if (!workerData.outputPath && document.numPages > 100) throw new Error("PDFs are limited to 100 pages.");
      let text = "";
      let emptyPages = 0;
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        const pageText = content.items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("").trim();
        if (!pageText) emptyPages++;
        text = bounded(text + `\n[Page ${pageNumber}]\n${pageText}\n`);
        page.cleanup();
        if (workerData.outputPath) parentPort.postMessage({ progress: pageNumber / document.numPages, stage: `Reading PDF page ${pageNumber} of ${document.numPages}` });
      }
      if (emptyPages === document.numPages) throw new Error("No selectable text found. Scanned PDFs need OCR, which is not included.");
      return { text, notes: `${document.numPages} pages. Text only; layout and images omitted.${emptyPages ? ` ${emptyPages} pages had no selectable text.` : ""}` };
    } finally { await loading.destroy(); }
  }
  if (extension === "docx") {
    await checkArchive(bytes, "word/document.xml");
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer: bytes }, { externalFileAccess: false });
    return { text: bounded(result.value), notes: "Document text only; images, comments and formatting omitted." };
  }
  if (extension === "xlsx") {
    await checkArchive(bytes, "xl/workbook.xml");
    const { default: readExcelFile } = await import("read-excel-file/node");
    const sheets = await readExcelFile(bytes, { trim: false });
    if (!workerData.outputPath && sheets.length > 20) throw new Error("Workbooks are limited to 20 sheets.");
    let text = "";
    let cells = 0;
    for (const sheet of sheets) {
      text = bounded(text + `\n[Sheet: ${sheet.sheet}]\n`);
      if (!workerData.outputPath && sheet.data.length > 100_000) throw new Error("The workbook exceeds the row limit.");
      sheet.data.forEach((row, rowNumber) => {
        const values = [];
        if (row.length > 1000) throw new Error("The workbook exceeds the column limit.");
        row.forEach((value, col) => {
          if (value === null || value === undefined) return;
          cells++;
          if (!workerData.outputPath && cells > 10_000) throw new Error("The workbook exceeds the 10,000-cell limit.");
          const printable = value instanceof Date ? value.toISOString() : String(value);
          let column = ""; let number = col + 1;
          while (number > 0) { number--; column = String.fromCharCode(65 + number % 26) + column; number = Math.floor(number / 26); }
          values.push(`${column}${rowNumber + 1}=${printable}`);
        });
        text = bounded(text + values.join("\t") + "\n");
      });
    }
    return { text, notes: "All sheets, nonempty cells and cached formula results. Formulas are never calculated; cells without cached values, charts and images omitted." };
  }
  throw new Error("Unsupported file format.");
}
try {
  const result = await extract();
  if (!result.text.trim()) throw new Error("The document does not contain readable text.");
  if (workerData.outputPath) {
    await writeFile(workerData.outputPath, result.text, { mode: 0o600 });
    parentPort.postMessage({ ok: true, notes: result.notes, mimeType: result.mimeType || "text/plain", analysisBytes: result.analysisBytes });
  } else parentPort.postMessage({ ok: true, ...result });
} catch (error) {
  const known = error instanceof Error ? error.message : "";
  const safe = /limit|exceed|not |must |need OCR|No selectable|UTF-8|empty|binary|macros|damaged|encrypted/i.test(known);
  parentPort.postMessage({ ok: false, error: error instanceof ImageRejection ? known.slice(0, 400)
    : safe ? known.slice(0, 220) : "The file could not be read. It may be damaged, encrypted, or unsupported." });
}
