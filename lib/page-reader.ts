import { BlockList, isIP, type Socket } from "node:net";
import { promises as dns } from "node:dns";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import zlib from "node:zlib";
import type { Readable } from "node:stream";

/**
 * Reads public web pages for deep research from this computer. The one boundary is the address check: every host is resolved and
 * every address it resolves to must be a public internet address; it is checked again when the connection is made, against the
 * connected socket, and on every redirect. Loopback, private, link-local, CGNAT, multicast, reserved, documentation and cloud
 * metadata ranges (IPv4 and IPv6, including mapped and translated forms) and this computer's own addresses are refused, so the
 * reader can't reach this PC, Model Chat, the coding preview proxy, the WSL sandbox or the local network.
 * No cookies, stored credentials, Windows integrated authentication or proxy are used; page scripts are never run.
 */
export const PAGE_LIMITS = { redirects: 5, bytes: 4 * 1024 * 1024, timeoutMs: 20_000, characters: 14_000 };
const USER_AGENT = "Mozilla/5.0 (compatible; ModelChatResearch/1.0; personal research assistant)";

export class PageReadError extends Error {}

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(network, prefix, "ipv4");
// Azure's host endpoint (wire server and instance metadata relay) is a public-looking address reachable only from inside a VM.
blocked.addAddress("168.63.129.16", "ipv4");
for (const [network, prefix] of [
  ["::", 96], ["::1", 128], ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
  ["5f00::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(network, prefix, "ipv6");

/** The eight 16-bit groups of a valid IPv6 address (a trailing dotted IPv4 part is folded into the last two). */
function ipv6Groups(address: string): number[] {
  let value = address.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    value = value.slice(0, -dotted[0].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = value.split("::");
  const front = head ? head.split(":") : [];
  const back = tail === undefined ? null : tail ? tail.split(":") : [];
  const groups = back === null ? front : [...front, ...Array(8 - front.length - back.length).fill("0"), ...back];
  return groups.map(group => parseInt(group, 16));
}
const lastIPv4 = (groups: number[]) => [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join(".");
function localAddresses() {
  return new Set(Object.values(os.networkInterfaces()).flatMap(list => list ?? []).map(item => item.address.toLowerCase().split("%")[0]));
}
/** True only for a public internet address that isn't one of this computer's own. */
export function isPublicAddress(address: string): boolean {
  const value = address.replace(/^\[|\]$/g, "");
  if (value.includes("%")) return false;
  const family = isIP(value);
  if (!family) return false;
  if (localAddresses().has(value.toLowerCase())) return false;
  if (family === 4) return !blocked.check(value, "ipv4");
  const groups = ipv6Groups(value);
  const zeros = (from: number, to: number) => groups.slice(from, to).every(group => group === 0);
  // IPv4-mapped (::ffff:0:0/96), IPv4-translated (::ffff:0:0:0/96) and NAT64 (64:ff9b::/96) carry an IPv4 destination; local-use NAT64 is refused.
  if (zeros(0, 5) && groups[5] === 0xffff) return isPublicAddress(lastIPv4(groups));
  if (zeros(0, 4) && groups[4] === 0xffff && groups[5] === 0) return isPublicAddress(lastIPv4(groups));
  if (groups[0] === 0x64 && groups[1] === 0xff9b) return zeros(2, 6) ? isPublicAddress(lastIPv4(groups)) : false;
  return !blocked.check(value, "ipv6");
}

type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
type Allow = (address: string, port: number) => boolean;
export interface ReaderOptions { resolve?: Resolver; allow?: Allow; signal?: AbortSignal; timeoutMs?: number }
const systemResolve: Resolver = async host => (await dns.lookup(host, { all: true, verbatim: true })).map(item => ({ address: item.address, family: item.family }));

export interface PageResult { url: string; title: string; text: string; contentType: string; truncated: boolean }

/** Resolves a host and refuses it unless every address it resolves to is allowed. */
async function resolveAllowed(host: string, port: number, resolve: Resolver, allow: Allow) {
  const literal = host.replace(/^\[|\]$/g, "");
  // "localhost" and *.localhost always mean this computer (RFC 6761), whatever a resolver says.
  if (/^localhost\.?$|\.localhost\.?$/i.test(literal)) throw new PageReadError(`${host} is a local, private or reserved address, which the page reader never opens.`);
  const addresses = isIP(literal) ? [{ address: literal, family: isIP(literal) }] : await resolve(literal).catch(() => { throw new PageReadError(`${host} could not be found.`); });
  if (!addresses.length) throw new PageReadError(`${host} could not be found.`);
  const refused = addresses.find(item => !allow(item.address, port));
  if (refused) throw new PageReadError(`${host} is a local, private or reserved address, which the page reader never opens.`);
  return addresses;
}

function decodeBody(stream: Readable, encoding: string | undefined): Readable {
  const value = (encoding || "").toLowerCase().trim();
  if (value === "gzip" || value === "x-gzip") return stream.pipe(zlib.createGunzip());
  if (value === "deflate") return stream.pipe(zlib.createInflate());
  if (value === "br") return stream.pipe(zlib.createBrotliDecompress());
  return stream;
}

async function fetchOnce(url: URL, options: Required<Pick<ReaderOptions, "resolve" | "allow">> & { signal: AbortSignal }) {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new PageReadError("Only http and https pages can be read.");
  if (url.username || url.password) throw new PageReadError("Links with embedded sign-in details aren't opened.");
  const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
  const host = url.hostname;
  await resolveAllowed(host, port, options.resolve, options.allow);
  const lookup = (hostname: string, lookupOptions: { all?: boolean }, callback: (error: Error | null, address: string | { address: string; family: number }[], family?: number) => void) => {
    resolveAllowed(hostname, port, options.resolve, options.allow).then(addresses => {
      if (lookupOptions.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    }, error => callback(error as Error, ""));
  };
  const transport = url.protocol === "https:" ? https : http;
  return await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const request = transport.request(url, {
      method: "GET", agent: false, signal: options.signal, lookup: lookup as never,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5", "Accept-Encoding": "gzip, deflate, br", "Accept-Language": "en;q=0.9" },
    }, response => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400) { response.resume(); resolve({ status, headers: response.headers, body: Buffer.alloc(0) }); return; }
      const declared = Number(response.headers["content-length"] || 0);
      if (declared > PAGE_LIMITS.bytes) { response.destroy(); reject(new PageReadError("The page is larger than the 4 MB reading limit.")); return; }
      const chunks: Buffer[] = [];
      let total = 0;
      const body = decodeBody(response, response.headers["content-encoding"] as string | undefined);
      body.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > PAGE_LIMITS.bytes) { body.destroy(); response.destroy(); reject(new PageReadError("The page is larger than the 4 MB reading limit.")); return; }
        chunks.push(chunk);
      });
      body.on("end", () => resolve({ status, headers: response.headers, body: Buffer.concat(chunks) }));
      body.on("error", () => reject(new PageReadError("The page's compressed content couldn't be read.")));
      response.on("error", () => reject(new PageReadError("The connection ended before the page finished downloading.")));
    });
    // Defence in depth: whatever resolved the name, the socket must be connected to an allowed address.
    request.on("socket", (socket: Socket) => {
      const verify = () => {
        const remote = socket.remoteAddress;
        if (!remote || !options.allow(remote, socket.remotePort || port)) request.destroy(new PageReadError(`${host} connected to an address the page reader never opens.`));
      };
      if (socket.connecting) socket.once("connect", verify); else verify();
      socket.once("secureConnect", verify);
    });
    request.on("error", error => {
      if (error instanceof PageReadError) return reject(error);
      if (options.signal.aborted) return reject(new PageReadError((options.signal.reason as Error | undefined)?.name === "TimeoutError" ? "Reading the page took longer than 20 seconds." : "Reading the page was cancelled."));
      const code = (error as NodeJS.ErrnoException).code || "";
      if (/ECONNRESET|ECONNREFUSED|EPIPE|EACCES|ENETUNREACH|EHOSTUNREACH/.test(code)) reject(new PageReadError(`${host} refused the connection or it was blocked (for example by Windows network protection).`));
      else if (/CERT|SSL|TLS/i.test(code) || /certificate/i.test(error.message)) reject(new PageReadError(`${host} has an invalid HTTPS certificate.`));
      else if (/ENOTFOUND|EAI_AGAIN/.test(code)) reject(new PageReadError(`${host} could not be found.`));
      else reject(new PageReadError(`${host} couldn't be read (${code || "network error"}).`));
    });
    request.end();
  });
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", euro: "€", pound: "£", middot: "·", bull: "•", times: "×" };
export function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const value = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : " ";
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}
/** Readable text of an HTML page: scripts, styles, navigation and forms are dropped; nothing is executed. */
export function htmlToText(html: string): { title: string; text: string } {
  const source = html.slice(0, 3 * 1024 * 1024);
  const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(source)?.[1] || "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim().slice(0, 300);
  let body = source.replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|math|iframe|object|embed|canvas|head|nav|footer|aside|form|button|select|dialog)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(script|style|link|meta|input|img|source|track|area|base)\b[^>]*>/gi, " ");
  // Prefer the page's main content when it marks one and it has real text.
  const blocks = [...body.matchAll(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)].map(match => match[2]);
  const main = blocks.sort((a, b) => b.length - a.length)[0];
  if (main && main.replace(/<[^>]+>/g, "").trim().length > 600) body = main;
  const text = decodeEntities(body
    .replace(/<h([1-4])\b[^>]*>/gi, (_, level: string) => `\n\n${"#".repeat(Number(level) + 1)} `)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(td|th)\b[^>]*>/gi, " | ")
    .replace(/<\/?(p|div|section|header|ul|ol|h[1-6]|tr|table|thead|tbody|blockquote|pre|br|hr|dd|dt|dl|figcaption|figure|summary|details)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .split("\n").map(line => line.replace(/[ \t\u00a0]+/g, " ").trim()).filter((line, index, lines) => line || lines[index - 1])
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title, text };
}
function charsetOf(contentType: string, head: Buffer) {
  const declared = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] || /<meta[^>]+charset=["']?([\w-]+)/i.exec(head.subarray(0, 4096).toString("latin1"))?.[1];
  try { return new TextDecoder(declared || "utf-8"); } catch { return new TextDecoder("utf-8"); }
}

/** Reads one public page and returns its readable text (at most 14,000 characters). */
export async function readPage(address: string, options: ReaderOptions = {}): Promise<PageResult> {
  let url: URL;
  try { url = new URL(address.trim()); } catch { throw new PageReadError("That isn't a valid web address."); }
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? PAGE_LIMITS.timeoutMs), ...(options.signal ? [options.signal] : [])]);
  const config = { resolve: options.resolve ?? systemResolve, allow: options.allow ?? ((ip: string) => isPublicAddress(ip)), signal };
  for (let hop = 0; ; hop++) {
    const response = await fetchOnce(url, config);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      if (!location) throw new PageReadError(`The page redirected without a destination (HTTP ${response.status}).`);
      if (hop >= PAGE_LIMITS.redirects) throw new PageReadError("The page redirected too many times.");
      try { url = new URL(location, url); } catch { throw new PageReadError("The page redirected to an invalid address."); }
      continue;
    }
    if (response.status >= 400) throw new PageReadError(`${url.hostname} answered HTTP ${response.status}.`);
    const contentType = String(response.headers["content-type"] || "").toLowerCase();
    const decoded = charsetOf(contentType, response.body).decode(response.body);
    let title = "", text = "";
    if (/html|xhtml/.test(contentType) || (!contentType && /<html|<body/i.test(decoded.slice(0, 2048)))) ({ title, text } = htmlToText(decoded));
    else if (/^text\/|json|xml|javascript|csv|markdown/.test(contentType)) text = decoded.replace(/\r\n/g, "\n").trim();
    else throw new PageReadError(`This link is a ${contentType.split(";")[0] || "file"} rather than a readable web page (PDFs and other documents aren't read).`);
    if (!text) throw new PageReadError("The page has no readable text (it may need JavaScript to show its content).");
    return { url: url.toString(), title: title || url.hostname, text: text.slice(0, PAGE_LIMITS.characters), contentType: contentType.split(";")[0], truncated: text.length > PAGE_LIMITS.characters };
  }
}
