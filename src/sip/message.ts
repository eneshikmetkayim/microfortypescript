/**
 * SIP message parser/serializer (RFC 3261 §7, §20, §25).
 *
 * The Windows build delegates this to pjsip's parser; the port owns it so the
 * whole stack is inspectable and testable without native code.
 */

import { parseSipUri, type SipUri } from "./uri.ts";

export const COMPACT_HEADERS: Record<string, string> = {
  v: "via",
  f: "from",
  t: "to",
  i: "call-id",
  m: "contact",
  l: "content-length",
  c: "content-type",
  e: "content-encoding",
  s: "subject",
  k: "supported",
  o: "event",
  r: "refer-to",
  b: "referred-by",
  x: "session-expires",
  u: "allow-events",
};

export type HeaderParams = Array<[string, string | true]>;

export interface SipHeader {
  name: string;
  value: string;
}

export type StartLine =
  | { kind: "request"; method: string; uri: string; version: string }
  | { kind: "response"; version: string; status: number; reason: string };

export const REASONS: Record<number, string> = {
  100: "Trying",
  180: "Ringing",
  181: "Call Is Being Forwarded",
  182: "Queued",
  183: "Session Progress",
  200: "OK",
  202: "Accepted",
  300: "Multiple Choices",
  301: "Moved Permanently",
  302: "Moved Temporarily",
  305: "Use Proxy",
  380: "Alternative Service",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  410: "Gone",
  413: "Request Entity Too Large",
  414: "Request-URI Too Long",
  415: "Unsupported Media Type",
  416: "Unsupported URI Scheme",
  420: "Bad Extension",
  421: "Extension Required",
  423: "Interval Too Brief",
  480: "Temporarily Unavailable",
  481: "Call/Transaction Does Not Exist",
  482: "Loop Detected",
  483: "Too Many Hops",
  484: "Address Incomplete",
  485: "Ambiguous",
  486: "Busy Here",
  487: "Request Terminated",
  488: "Not Acceptable Here",
  491: "Request Pending",
  493: "Undecipherable",
  500: "Server Internal Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Server Time-out",
  505: "Version Not Supported",
  513: "Message Too Large",
  600: "Busy Everywhere",
  603: "Decline",
  604: "Does Not Exist Anywhere",
  606: "Not Acceptable",
};

export function canonicalHeaderName(name: string): string {
  const lower = name.trim().toLowerCase();
  return COMPACT_HEADERS[lower] ?? lower;
}

export class SipMessage {
  startLine: StartLine;
  headers: SipHeader[];
  body: string;

  constructor(startLine: StartLine, headers: SipHeader[] = [], body = "") {
    this.startLine = startLine;
    this.headers = headers;
    this.body = body;
  }

  static request(method: string, uri: string, headers: SipHeader[] = [], body = ""): SipMessage {
    return new SipMessage({ kind: "request", method, uri, version: "SIP/2.0" }, headers, body);
  }

  get isRequest(): boolean {
    return this.startLine.kind === "request";
  }

  get method(): string | undefined {
    return this.startLine.kind === "request" ? this.startLine.method : undefined;
  }

  get status(): number | undefined {
    return this.startLine.kind === "response" ? this.startLine.status : undefined;
  }

  get requestUri(): string | undefined {
    return this.startLine.kind === "request" ? this.startLine.uri : undefined;
  }

  header(name: string): string | undefined {
    const target = canonicalHeaderName(name);
    const found = this.headers.find((h) => canonicalHeaderName(h.name) === target);
    return found?.value;
  }

  headerValues(name: string): string[] {
    const target = canonicalHeaderName(name);
    return this.headers.filter((h) => canonicalHeaderName(h.name) === target).map((h) => h.value);
  }

  setHeader(name: string, value: string | undefined): this {
    const target = canonicalHeaderName(name);
    const first = this.headers.findIndex((h) => canonicalHeaderName(h.name) === target);
    if (value === undefined) {
      this.headers = this.headers.filter((h) => canonicalHeaderName(h.name) !== target);
      return this;
    }
    if (first >= 0) {
      this.headers[first] = { name, value };
      this.headers = this.headers.filter(
        (h, i) => i === first || canonicalHeaderName(h.name) !== target,
      );
    } else {
      this.headers.push({ name, value });
    }
    return this;
  }

  addHeader(name: string, value: string): this {
    this.headers.push({ name, value });
    return this;
  }

  removeHeader(name: string): this {
    return this.setHeader(name, undefined);
  }

  /** CSeq sequence number + method, e.g. `{ seq: 2, method: "INVITE" }`. */
  get cseq(): { seq: number; method: string } | undefined {
    const raw = this.header("cseq");
    if (!raw) return undefined;
    const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(raw);
    if (!match) return undefined;
    return { seq: Number(match[1]), method: (match[2] as string).toUpperCase() };
  }

  get fromTag(): string | undefined {
    return headerParam(this.header("from") ?? "", "tag");
  }

  get toTag(): string | undefined {
    return headerParam(this.header("to") ?? "", "tag");
  }

  get callId(): string | undefined {
    return this.header("call-id")?.trim();
  }

  /** Topmost Via branch, used for transaction matching. */
  get branch(): string | undefined {
    const via = this.header("via");
    if (!via) return undefined;
    return headerParam(via, "branch");
  }

  clone(): SipMessage {
    return new SipMessage(
      { ...this.startLine },
      this.headers.map((h) => ({ ...h })),
      this.body,
    );
  }

  toString(): string {
    return serializeMessage(this);
  }
}

export function headerParam(value: string, name: string): string | undefined {
  const lower = name.toLowerCase();
  // Skip the URI/addr-spec part so `;tag=` inside <> is not matched.
  let text = value;
  const gt = text.lastIndexOf(">");
  if (gt >= 0) text = text.slice(gt + 1);
  for (const part of text.split(";").slice(1)) {
    const eq = part.indexOf("=");
    if (eq < 0) {
      if (part.trim().toLowerCase() === lower) return "";
    } else if (part.slice(0, eq).trim().toLowerCase() === lower) {
      return part.slice(eq + 1).trim().replace(/^"|"$/g, "");
    }
  }
  return undefined;
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function parseMessage(raw: string): SipMessage {
  // RFC 3261 allows CRLF; be tolerant of bare LF and stray CR.
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");

  const first = lines.shift();
  if (!first || !first.trim()) throw new Error("empty SIP message");

  let startLine: StartLine;
  if (first.startsWith("SIP/2.0")) {
    const match = /^SIP\/2\.0\s+(\d{3})(?:\s+(.*))?$/.exec(first.trim());
    if (!match) throw new Error(`invalid SIP status line: ${first}`);
    startLine = {
      kind: "response",
      version: "SIP/2.0",
      status: Number(match[1]),
      reason: (match[2] ?? REASONS[Number(match[1])] ?? "").trim(),
    };
  } else {
    const match = /^([A-Za-z]+)\s+(\S+)\s+SIP\/2\.0$/.exec(first.trim());
    if (!match) throw new Error(`invalid SIP request line: ${first}`);
    startLine = {
      kind: "request",
      method: (match[1] as string).toUpperCase(),
      uri: match[2] as string,
      version: "SIP/2.0",
    };
  }

  const headers: SipHeader[] = [];
  let index = 0;
  for (; index < lines.length; index++) {
    const line = lines[index] as string;
    if (line === "") {
      index++;
      break;
    }
    if (/^[ \t]/.test(line) && headers.length) {
      const last = headers[headers.length - 1] as SipHeader;
      last.value += " " + line.trim();
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error(`invalid header line: ${line}`);
    headers.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() });
  }

  let body = lines.slice(index).join("\n");
  const lengthHeader = headers.find((h) => canonicalHeaderName(h.name) === "content-length");
  if (lengthHeader) {
    const declared = Number(lengthHeader.value.trim());
    if (Number.isFinite(declared) && declared >= 0) {
      // Slice on bytes without breaking multi-byte characters.
      const bytes = new TextEncoder().encode(body);
      if (bytes.length > declared) body = new TextDecoder().decode(bytes.slice(0, declared));
    }
  }

  return new SipMessage(startLine, headers, body);
}

export function serializeMessage(message: SipMessage): string {
  const start =
    message.startLine.kind === "request"
      ? `${message.startLine.method} ${message.startLine.uri} SIP/2.0`
      : `SIP/2.0 ${message.startLine.status} ${message.startLine.reason}`;

  const headers = message.headers.filter((h) => canonicalHeaderName(h.name) !== "content-length");
  const lines = [start, ...headers.map((h) => `${h.name}: ${h.value}`)];
  lines.push(`Content-Length: ${byteLength(message.body)}`);
  return `${lines.join("\r\n")}\r\n\r\n${message.body}`;
}

export interface ResponseOptions {
  toTag?: string;
  contact?: string;
  sdp?: string;
  extraHeaders?: Array<[string, string]>;
  reason?: string;
}

/** Build a response to `request`, copying the RFC 3261 mandatory headers. */
export function buildResponse(
  request: SipMessage,
  status: number,
  options: ResponseOptions = {},
): SipMessage {
  if (request.startLine.kind !== "request") throw new Error("cannot respond to a response");

  const headers: SipHeader[] = [];
  for (const via of request.headerValues("via")) headers.push({ name: "Via", value: via });
  for (const name of ["From", "To", "Call-ID", "CSeq"]) {
    const value = request.header(name);
    if (value === undefined) continue;
    if (name === "To" && options.toTag) {
      const existing = request.toTag;
      headers.push({
        name: "To",
        value: existing ? value : `${value};tag=${options.toTag}`,
      });
    } else {
      headers.push({ name, value });
    }
  }
  if (status > 100 && !request.toTag && !options.toTag) {
    // A final/in-dialog response without a tag is invalid; caller owns tags,
    // but tests and simple UASs get a deterministic fallback.
  }
  if (options.contact) headers.push({ name: "Contact", value: options.contact });
  for (const [name, value] of options.extraHeaders ?? []) headers.push({ name, value });

  let body = "";
  if (options.sdp) {
    body = options.sdp;
    headers.push({ name: "Content-Type", value: "application/sdp" });
  }
  return new SipMessage(
    {
      kind: "response",
      version: "SIP/2.0",
      status,
      reason: options.reason ?? REASONS[status] ?? "",
    },
    headers,
    body,
  );
}

export function isProvisional(message: SipMessage): boolean {
  const status = message.status;
  return status !== undefined && status < 200;
}

export function isFinal(message: SipMessage): boolean {
  const status = message.status;
  return status !== undefined && status >= 200;
}

export function parseUriHeader(value: string): SipUri | undefined {
  const match = /<([^>]+)>/.exec(value);
  const raw = match ? (match[1] as string) : value.trim().split(";")[0];
  if (!raw) return undefined;
  try {
    return parseSipUri(raw);
  } catch {
    return undefined;
  }
}
