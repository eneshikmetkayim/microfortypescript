/**
 * Port of `URLMask()` (MicroSIP-3.23.5-src/global.cpp:1245).
 *
 * Replacement order is significant and is reproduced verbatim:
 *   CString::Replace substitutes every occurrence immediately, so when the
 *   call user-data carries a caller-ID it wins, and the later `{callerid}`
 *   substitution from the SIP URI name/user has no token left to replace.
 *   Only calls without a stored caller-ID take the URI name/user value.
 * Tests in tests/urlmask.test.ts lock this behaviour in.
 */

import { md5Hex } from "../sip/md5.ts";
import { urlencode } from "../sip/uri.ts";

export interface UrlMaskAccount {
  server?: string;
  username?: string;
  password?: string;
}

export interface UrlMaskUri {
  user?: string;
  name?: string;
  domain?: string;
}

export interface UrlMaskContext {
  account?: UrlMaskAccount;
  /** Account id 0 means "no account" in MicroSIP; empty account strings. */
  hasAccount?: boolean;
  /** pjsua call info role: "in" for UAS, "out" for UAC. */
  direction?: "in" | "out" | "";
  callId?: string;
  /** Call duration in seconds (user_data->duration). */
  duration?: number;
  /** Epoch seconds; defaults to now. */
  time?: number;
  /** user_data->callerID parsed user part. */
  callerId?: string;
  /** Remote/local party used for {user}, {number}, {domain}, {name}. */
  uri?: UrlMaskUri;
}

function replaceAll(template: string, token: string, value: string): string {
  return template.split(token).join(value);
}

export function urlMask(template: string, context: UrlMaskContext = {}): string {
  let url = template;

  // -- server
  const server = context.hasAccount === false ? "" : (context.account?.server ?? "");
  url = replaceAll(url, "{server}", server || "localhost");

  // -- account credentials
  if (context.hasAccount === false) {
    url = replaceAll(url, "{extension}", "");
    url = replaceAll(url, "{password}", "");
    url = replaceAll(url, "{md5_password}", "");
  } else {
    url = replaceAll(url, "{extension}", context.account?.username ?? "");
    url = replaceAll(url, "{password}", urlencode(context.account?.password ?? ""));
    url = replaceAll(url, "{md5_password}", md5Hex(context.account?.password ?? ""));
  }

  // -- duration / time
  url = replaceAll(url, "{duration}", String(context.duration ?? 0));
  url = replaceAll(url, "{time}", String(context.time ?? Math.floor(Date.now() / 1000)));

  // -- call id / direction
  url = replaceAll(url, "{callid}", urlencode(context.callId ?? ""));
  url = replaceAll(url, "{direction}", context.direction ?? "");

  // -- caller id from the stored call user-data, then overwritten below
  if (context.callerId) {
    url = replaceAll(url, "{callerid}", urlencode(context.callerId));
  }

  // -- party fields
  const uri = context.uri;
  if (uri) {
    const callerId = uri.name && uri.name.length > 0 ? uri.name : (uri.user ?? "");
    url = replaceAll(url, "{callerid}", urlencode(callerId));
    url = replaceAll(url, "{user}", urlencode(uri.user ?? ""));
    url = replaceAll(url, "{number}", urlencode(uri.user ?? ""));
    url = replaceAll(url, "{domain}", urlencode(uri.domain ?? ""));
    url = replaceAll(url, "{name}", urlencode(uri.name ?? ""));
  }

  return url;
}

/** Tokens URLMask understands, for the settings UI and the audit report. */
export const URL_MASK_TOKENS = [
  "{server}",
  "{extension}",
  "{password}",
  "{md5_password}",
  "{duration}",
  "{time}",
  "{callid}",
  "{direction}",
  "{callerid}",
  "{user}",
  "{number}",
  "{domain}",
  "{name}",
] as const;
