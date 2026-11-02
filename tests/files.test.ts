import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { extractFile, validateFileName } from "../lib/files";
import { docx, pdf, xlsx } from "./fixtures";

test("all four text formats preserve usable UTF-8 contents", async () => {
  for (const [name, input] of [["note.txt", "Hello"], ["note.md", "# Title"], ["data.csv", "a,b\n1,2"], ["data.json", '{"revenue":42}']]) {
    assert.equal((await extractFile(name, Buffer.from(input))).text, input);
  }
});
test("PDF, DOCX and XLSX extraction returns grounded text with source markers", async () => {
  assert.match((await extractFile("paper.pdf", pdf())).text, /\[Page 1\][\s\S]*Model Chat PDF fixture/);
  assert.match((await extractFile("paper.docx", await docx())).text, /quiet document/);
  const sheet = await extractFile("budget.xlsx", await xlsx());
  assert.match(sheet.text, /\[Sheet: Budget\]/); assert.match(sheet.text, /A1=Revenue/); assert.match(sheet.text, /B1=42/); assert.match(sheet.text, /C1=84/);
});
test("content validation rejects renamed binary, invalid UTF-8, JSON, wrong file magic and scan-only PDF", async () => {
  for (const [name, bytes] of [
    ["bad.txt", Buffer.from([0, 1, 2])], ["bad.txt", Buffer.from([0xff, 0xfe])],
    ["bad.json", Buffer.from("{")], ["fake.pdf", Buffer.from("not a PDF")],
    ["fake.docx", Buffer.from("not a ZIP")], ["scan.pdf", pdf("")],
  ] as const) await assert.rejects(() => extractFile(name, bytes));
  for (const name of ["../secret.txt", "secret.exe", "photo.svg", "hello.txt:evil", "empty", "archive.zip"]) assert.throws(() => validateFileName(name));
});
test("exact file and extracted-text limits reject overflow", async () => {
  assert.equal((await extractFile("exact.txt", Buffer.from("x".repeat(30_000)))).text.length, 30_000);
  await assert.rejects(() => extractFile("large.txt", Buffer.from("x".repeat(30_001))), /30,000/);
  await assert.rejects(() => extractFile("large.txt", Buffer.alloc(5 * 1024 * 1024 + 1)), /5 MB/);
});
test("Office ZIP bombs and embedded executable payloads are refused before parsing", async () => {
  const bomb = new JSZip();
  bomb.file("word/document.xml", "x".repeat(21 * 1024 * 1024));
  const bombBytes = await bomb.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await assert.rejects(() => extractFile("bomb.docx", bombBytes), /limit/);
  const macro = await JSZip.loadAsync(await docx());
  macro.file("word/vbaProject.bin", "not allowed");
  const macroBytes = await macro.generateAsync({ type: "nodebuffer" });
  await assert.rejects(() => extractFile("macro.docx", macroBytes), /macros|executables/);
});
