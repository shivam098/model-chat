import { createHash } from "node:crypto";

const UNSAFE = /[^\p{L}\p{N} ._()+,=-]/gu;
// Sandbox-safe names keep ordinary Unicode names unchanged. A changed name gets a short hash of the
// original, so different originals never collapse to the same stored or input name.
export function safeFileName(original: string, fallback = "output") {
  const trimmed = original.replace(/[\s.]+$/u, "");
  const match = /\.([\p{L}\p{N}]{1,10})$/u.exec(trimmed);
  const extension = match ? match[1] : "";
  const rawStem = match ? trimmed.slice(0, -match[0].length) : trimmed;
  let stem = rawStem.replace(/\//g, "-").replace(UNSAFE, "_").replace(/^[^\p{L}\p{N}]+/u, "");
  stem = [...stem].slice(0, 100).join("").replace(/[\s._-]+$/u, "");
  const changed = stem !== rawStem || trimmed !== original;
  if (!/[\p{L}\p{N}]/u.test(stem)) stem = fallback;
  if (changed) stem += `-${createHash("sha256").update(original).digest("hex").slice(0, 6)}`;
  return { name: extension ? `${stem}.${extension}` : stem, extension: extension.toLowerCase() };
}
