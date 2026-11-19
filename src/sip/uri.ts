/**
 * SIP URI + name-addr parser/serializer.
 *
 * Mirrors the fields MicroSIP exposes through `SIPURI` (global.h): user,
 * password, host, port, name and the parameter list used by `URLMask()`
 * ({user}, {number}, {domain}, {name}, {callerid}).
 */

export type UriScheme = "sip" | "sips" | "tel";

export interface SipUri {
  scheme: UriScheme;
  user?: string;
  password?: string;
  host: string;
  port?: number;
  /** URI parameters in order of appearance, e.g. `;transport=ws;lr`. */
  params: Array<[string, string | true]>;
  /** URI headers after `?`, e.g. `?subject=hi`. */
  headers: Array<[string, string]>;
}

const UNRESERVED = /^[A-Za-z0-9\-_.!~*'()&=+$,;?/]$/;
const HOST_SAFE = /^[A-Za-z0-9\-_.:\[\]]$/;

export function decodeComponent(value: string): string {
  return value.replace(/%([0-9a-fA-F]{2})/g, (_m, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

export function encodeComponent(value: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(value)) {
    const ch = String.fromCharCode(byte);
    out += byte < 0x80 && UNRESERVED.test(ch)
      ? ch
      : `%${byte.toString(16).toUpperCase()}`;
  }
  return out;
}

/** MicroSIP `urlencode()` (global.cpp:945): only RFC 3986 unreserved + `!*'()`. */
export function urlencode(value: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(value)) {
    const ch = String.fromCharCode(byte);
    if (
      (byte >= 48 && byte <= 57) ||
      (byte >= 65 && byte <= 90) ||
      (byte >= 97 && byte <= 122) ||
      ch === "~" || ch === "!" || ch === "*" || ch === "(" || ch === ")" || ch === "'"
    ) {
      out += ch;
    } else {
      out += `%${byte.toString(16).padStart(2, "0")}`;
    }
  }
  return out;
}

export function parseSipUri(input: string): SipUri {
  const text = input.trim();
  const colon = text.indexOf(":");
  if (colon <= 0) throw new Error(`invalid SIP URI: ${input}`);
  const scheme = text.slice(0, colon).toLowerCase();
  if (scheme !== "sip" && scheme !== "sips" && scheme !== "tel") {
    throw new Error(`unsupported URI scheme: ${scheme}`);
  }
  let rest = text.slice(colon + 1);

  const headers: Array<[string, string]> = [];
  const q = rest.indexOf("?");
  if (q >= 0) {
    for (const part of rest.slice(q + 1).split("&")) {
      if (!part) continue;
      const eq = part.indexOf("=");
      if (eq < 0) headers.push([decodeComponent(part), ""]);
      else headers.push([decodeComponent(part.slice(0, eq)), decodeComponent(part.slice(eq + 1))]);
    }
    rest = rest.slice(0, q);
  }

  let user: string | undefined;
  let password: string | undefined;
  let hostPart = rest;

  const at = rest.lastIndexOf("@");
  if (scheme === "tel" && at < 0) {
    // `tel:+90...` carries the number as the whole URI body, no host part.
    return {
      scheme: "tel",
      user: decodeComponent(rest),
      host: "",
      params: [],
      headers,
    };
  }
  if (at >= 0) {
    const userinfo = rest.slice(0, at);
    hostPart = rest.slice(at + 1);
    const sep = userinfo.indexOf(":");
    if (sep >= 0) {
      user = decodeComponent(userinfo.slice(0, sep));
      password = decodeComponent(userinfo.slice(sep + 1));
    } else {
      user = decodeComponent(userinfo);
    }
  }

  const semi = hostPart.indexOf(";");
  const authority = semi >= 0 ? hostPart.slice(0, semi) : hostPart;
  const paramText = semi >= 0 ? hostPart.slice(semi + 1) : "";

  const params: Array<[string, string | true]> = [];
  for (const part of paramText.split(";")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq < 0) params.push([part.toLowerCase(), true]);
    else params.push([part.slice(0, eq).toLowerCase(), decodeComponent(part.slice(eq + 1))]);
  }

  let host = authority;
  let port: number | undefined;
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close < 0) throw new Error(`invalid IPv6 host: ${authority}`);
    host = authority.slice(0, close + 1);
    const tail = authority.slice(close + 1);
    if (tail.startsWith(":")) port = Number(tail.slice(1));
  } else {
    const c = authority.lastIndexOf(":");
    if (c >= 0) {
      host = authority.slice(0, c);
      port = Number(authority.slice(c + 1));
    }
  }
  if (!host && scheme !== "tel") throw new Error(`missing host in SIP URI: ${input}`);

  const uri: SipUri = { scheme: scheme as UriScheme, host, params, headers };
  if (user !== undefined) uri.user = user;
  if (password !== undefined) uri.password = password;
  if (port !== undefined && Number.isFinite(port)) uri.port = port;
  return uri;
}

export function formatSipUri(uri: SipUri): string {
  let out = `${uri.scheme}:`;
  if (uri.user !== undefined) {
    out += encodeComponent(uri.user);
    if (uri.password !== undefined) out += `:${encodeComponent(uri.password)}`;
    if (uri.host) out += "@";
  }
  out += HOST_SAFE.test(uri.host) ? uri.host : uri.host;
  if (uri.port !== undefined) out += `:${uri.port}`;
  for (const [name, value] of uri.params) {
    out += value === true ? `;${name}` : `;${name}=${encodeComponent(value)}`;
  }
  if (uri.headers.length) {
    out += "?" + uri.headers.map(([k, v]) => `${encodeComponent(k)}=${encodeComponent(v)}`).join("&");
  }
  return out;
}

export interface NameAddr {
  displayName?: string;
  uri: SipUri;
  /** Header parameters outside the brackets, e.g. `;tag=abc`. */
  params: Array<[string, string | true]>;
}

function parseParams(text: string): Array<[string, string | true]> {
  const params: Array<[string, string | true]> = [];
  for (const part of text.split(";")) {
    if (!part.trim()) continue;
    const eq = part.indexOf("=");
    if (eq < 0) params.push([part.trim().toLowerCase(), true]);
    else params.push([part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim()]);
  }
  return params;
}

export function parseNameAddr(input: string): NameAddr {
  const text = input.trim();
  const lt = text.indexOf("<");
  if (lt >= 0) {
    const gt = text.indexOf(">", lt);
    if (gt < 0) throw new Error(`unterminated name-addr: ${input}`);
    let display = text.slice(0, lt).trim();
    if (display.startsWith('"') && display.endsWith('"')) display = display.slice(1, -1);
    return {
      displayName: display || undefined,
      uri: parseSipUri(text.slice(lt + 1, gt)),
      params: parseParams(text.slice(gt + 1)),
    };
  }
  // Bare URI, possibly followed by header params.
  const semi = text.indexOf(";");
  const rawUri = semi >= 0 ? text.slice(0, semi) : text;
  return {
    uri: parseSipUri(rawUri),
    params: semi >= 0 ? parseParams(text.slice(semi + 1)) : [],
  };
}

export function formatNameAddr(addr: NameAddr): string {
  let prefix = "";
  if (addr.displayName) {
    const needsQuotes = /[^\w\s.\-']/.test(addr.displayName);
    prefix = needsQuotes
      ? `"${addr.displayName.replace(/"/g, "")}" `
      : `${addr.displayName} `;
  }
  let out = `${prefix}<${formatSipUri(addr.uri)}>`;
  for (const [name, value] of addr.params) {
    out += value === true ? `;${name}` : `;${name}=${value}`;
  }
  return out;
}

export function uriParam(uri: SipUri, name: string): string | true | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of uri.params) if (key === lower) return value;
  return undefined;
}

export function setUriParam(uri: SipUri, name: string, value: string | true): void {
  const lower = name.toLowerCase();
  const idx = uri.params.findIndex(([key]) => key === lower);
  if (idx >= 0) uri.params[idx] = [lower, value];
  else uri.params.push([lower, value]);
}

export function removeUriParam(uri: SipUri, name: string): void {
  const lower = name.toLowerCase();
  uri.params = uri.params.filter(([key]) => key !== lower);
}

/** Contact/From/To host:port without the scheme, as MicroSIP displays it. */
export function hostPort(uri: SipUri): string {
  return uri.port === undefined ? uri.host : `${uri.host}:${uri.port}`;
}

export function isIpAddress(host: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return host.startsWith("[") && host.endsWith("]");
}
