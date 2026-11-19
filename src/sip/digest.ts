/**
 * HTTP Digest authentication for SIP (RFC 2617 / RFC 7616 MD5 flavours).
 * Ported behaviour: pjsip sends MD5 with qop=auth when the registrar offers it.
 */

import { md5Hex } from "./md5.ts";

export interface DigestChallenge {
  scheme: "digest";
  realm: string;
  nonce: string;
  opaque?: string;
  algorithm?: string;
  qop: string[];
  stale?: boolean;
  domain?: string;
}

export function parseChallenge(headerValue: string | undefined): DigestChallenge | null {
  if (!headerValue) return null;
  const text = headerValue.trim();
  if (!/^digest\b/i.test(text)) return null;

  const params: Record<string, string> = {};
  const re = /([A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^,]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const key = (match[1] as string).toLowerCase();
    let value = (match[2] as string).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    params[key] = value;
  }

  if (!params.realm || !params.nonce) return null;
  const qop = (params.qop ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

  return {
    scheme: "digest",
    realm: params.realm,
    nonce: params.nonce,
    opaque: params.opaque,
    algorithm: params.algorithm?.toUpperCase() ?? "MD5",
    qop,
    stale: params.stale === "true",
    domain: params.domain,
  };
}

export interface DigestCredentials {
  username: string;
  password: string;
  /** authID / auth-user param; defaults to username (MicroSIP `authID`). */
  authId?: string;
}

export interface DigestRequestOptions {
  challenge: DigestChallenge;
  credentials: DigestCredentials;
  method: string;
  uri: string;
  /** Client nonce; deterministic in tests, random in production. */
  cnonce?: string;
  /** Nonce count, 1-based; increments per challenge replay. */
  nc?: number;
  body?: string;
}

export interface DigestAuthorization {
  headerName: "Authorization" | "Proxy-Authorization";
  value: string;
  response: string;
}

export function randomCnonce(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function buildAuthorization(
  options: DigestRequestOptions,
  headerName: "Authorization" | "Proxy-Authorization" = "Authorization",
): DigestAuthorization {
  const { challenge, credentials, method, uri } = options;
  const algorithm = (challenge.algorithm ?? "MD5").toUpperCase();
  const cnonce = options.cnonce ?? randomCnonce();
  const nc = options.nc ?? 1;
  const ncHex = nc.toString(16).padStart(8, "0");
  const username = credentials.authId ?? credentials.username;
  const realm = challenge.realm;

  const ha1Base = md5Hex(`${username}:${realm}:${credentials.password}`);
  const ha1 =
    algorithm === "MD5-SESS" ? md5Hex(`${ha1Base}:${challenge.nonce}:${cnonce}`) : ha1Base;
  const ha2 = md5Hex(`${method}:${uri}`);

  const useQop = challenge.qop.includes("auth");
  const response = useQop
    ? md5Hex(`${ha1}:${challenge.nonce}:${ncHex}:${cnonce}:auth:${ha2}`)
    : md5Hex(`${ha1}:${challenge.nonce}:${ha2}`);

  const parts = [
    `username="${username}"`,
    `realm="${realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
    `algorithm=${algorithm}`,
  ];
  if (useQop) {
    parts.push("qop=auth", `nc=${ncHex}`, `cnonce="${cnonce}"`);
  }
  if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`);

  return { headerName, value: `Digest ${parts.join(", ")}`, response };
}

/** Extract the 401/407 challenge from a SIP response. */
export function challengeFromResponse(
  status: number | undefined,
  wwwAuthenticate: string | undefined,
  proxyAuthenticate: string | undefined,
): { headerName: "Authorization" | "Proxy-Authorization"; challenge: DigestChallenge } | null {
  if (status === 401) {
    const challenge = parseChallenge(wwwAuthenticate);
    return challenge ? { headerName: "Authorization", challenge } : null;
  }
  if (status === 407) {
    const challenge = parseChallenge(proxyAuthenticate);
    return challenge ? { headerName: "Proxy-Authorization", challenge } : null;
  }
  return null;
}
