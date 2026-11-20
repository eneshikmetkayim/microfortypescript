/**
 * Port of MicroSIP's number formatting pipeline:
 *   - `SanitizeNumber` / `FormatNumber` (global.cpp:68-195)
 *   - `GetSIPURI` (global.cpp:246)
 *   - `MSIP::IsPSTNNnmber` (lib/MSIP.cpp:502)
 *   - dial plan matching with `x`, `.`, `[2-9]`, `<match:replace>`
 *
 * Dial plan semantics (microsip.org/help, confirmed against global.cpp):
 *   x     any single character
 *   .     zero or more of the previous element (`x.` = any number)
 *   [..]  character set / range
 *   <a:b> capture `a` and replace it with `b`; `<:b>` inserts `b`
 *   |     alternative patterns; the whole value may be wrapped in (...)
 * Numbers that match no pattern are blocked (empty dial string).
 */

import type { AccountConfig } from "../sip/registration.ts";

export interface DialPlanResult {
  matched: boolean;
  number: string;
  /** Collected capture groups and their replacements, in pattern order. */
  replacements: string[];
}

export interface FormatNumberOptions {
  account?: Pick<AccountConfig, "server" | "domain" | "dialingPrefix" | "dialPlan" | "username">;
  /** Account 0 (local, call by IP) skips prefix/dial-plan transforms. */
  isLocal?: boolean;
  /** `noTransform` in the C++ signature. */
  noTransform?: boolean;
  /** Explicit domain override for GetSIPURI. */
  domain?: string;
  /** Use the "simple" URI form without transport parameters (always true in FormatNumber). */
  simple?: boolean;
}

export interface FormatNumberResult {
  /** Address handed to pjsua (`<sip:...>`). */
  uri: string;
  /** Digits after prefix/dial-plan processing. */
  number: string;
  /** DTMF/commands after the first comma (`sound:...`, `sip:...`). */
  commands?: string;
  /** True when a dial plan exists and the number matched none of its rules. */
  blocked: boolean;
  isLocal: boolean;
}

export function sanitizeNumber(number: string): string {
  return number.replace(/[.\-()/ ]/g, "");
}

/** lib/MSIP.cpp:502 — at least 4 chars, digits and dial punctuation only. */
export function isPstnNumber(number: string): boolean {
  if (number.length < 4) return false;
  for (const char of number) {
    if (char === "+") {
      if (number[0] !== "+") return false;
    } else if (!/[0-9*#.\-()/ ]/.test(char)) {
      return false;
    }
  }
  return true;
}

interface ParsedPattern {
  regex: RegExp;
  /** Replacement strings in capture-group order. */
  replacements: string[];
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Converts one dial-plan alternative into a JS RegExp. Mirrors the C++ pass:
 * `<a:b>` becomes a capture group, `<a>` becomes literal text, `.` becomes `*`
 * and `x` becomes `.`.
 */
export function compileDialPlanPattern(pattern: string): ParsedPattern | null {
  let regexSource = "";
  const replacements: string[] = [];

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string;
    if (char === "<") {
      const end = pattern.indexOf(">", i + 1);
      if (end < 0) return null;
      const group = pattern.slice(i + 1, end);
      const colon = group.indexOf(":");
      if (colon < 0) {
        regexSource += escapeRegex(group);
      } else {
        regexSource += `(${translateBody(group.slice(0, colon))})`;
        replacements.push(group.slice(colon + 1));
      }
      i = end;
      continue;
    }
    if (char === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end < 0) return null;
      regexSource += pattern.slice(i, end + 1);
      i = end;
      continue;
    }
    if (char === ".") {
      regexSource += "*";
      continue;
    }
    if (char === "x" || char === "X") {
      regexSource += ".";
      continue;
    }
    if (char === "*" || char === "+" || char === "?" || char === "{" || char === "}") {
      regexSource += char;
      continue;
    }
    regexSource += escapeRegex(char);
  }

  try {
    // `d` exposes capture offsets so replacements can be spliced in place.
    return { regex: new RegExp(`^${regexSource}$`, "d"), replacements };
  } catch {
    return null;
  }
}

/** Translates MicroSIP wildcards inside a capture group. */
function translateBody(body: string): string {
  let out = "";
  for (const char of body) {
    if (char === ".") out += "*";
    else if (char === "x" || char === "X") out += ".";
    else out += escapeRegex(char);
  }
  return out;
}

/** Splits on `|`, honouring nothing else — MicroSIP does a plain Tokenize. */
export function dialPlanPatterns(dialPlan: string): string[] {
  // CString::Trim(" ()") strips spaces and parentheses from both ends.
  return dialPlan
    .replace(/^[\s()]+/, "")
    .replace(/[\s()]+$/, "")
    .split("|")
    .filter((token) => token.length > 0);
}

/** Applies the first matching pattern; returns the transformed number. */
export function applyDialPlan(number: string, dialPlan: string): DialPlanResult {
  const patterns = dialPlanPatterns(dialPlan);
  if (!patterns.length) return { matched: true, number, replacements: [] };

  for (const pattern of patterns) {
    const parsed = compileDialPlanPattern(pattern);
    if (!parsed) continue;
    const match = parsed.regex.exec(number);
    if (!match) continue;

    if (parsed.replacements.length === 0) {
      return { matched: true, number, replacements: [] };
    }

    const indices = (match as unknown as { indices?: Array<[number, number] | undefined> }).indices;
    let output = "";
    let previousEnd = 0;
    for (let group = 0; group < parsed.replacements.length; group++) {
      const span = indices?.[group + 1];
      if (!span) continue;
      output += number.slice(previousEnd, span[0]) + (parsed.replacements[group] as string);
      previousEnd = span[1];
    }
    output += number.slice(previousEnd);
    return { matched: true, number: output, replacements: parsed.replacements };
  }

  return { matched: false, number: "", replacements: [] };
}

/** `GetSIPURI(str, isSimple, isLocal, domain)` from global.cpp:246. */
export function getSipUri(
  value: string,
  options: { isSimple?: boolean; isLocal?: boolean; domain?: string; transport?: string } = {},
): string {
  let str = value;
  // MicroSIP searches for "sip:" anywhere (global.cpp:250).
  if (!/sip:/i.test(str)) str = `sip:${str}`;

  if (!str.includes("@")) {
    const domain = options.domain ?? "";
    if (domain) {
      const semicolon = str.indexOf(";");
      const question = str.indexOf("?");
      const cut = semicolon >= 0 ? semicolon : question;
      str = cut >= 0 ? `${str.slice(0, cut)}@${domain}${str.slice(cut)}` : `${str}@${domain}`;
    }
  }

  if (str.endsWith(">")) return str;
  if (options.isSimple === false && options.transport && options.transport !== "udp") {
    str = `${str};transport=${options.transport}`;
  }
  return `<${str}>`;
}

/**
 * `FormatNumber()` — applies dialing prefix, dial plan, then returns the
 * address for pjsua. `commands` is everything after the first comma (used by
 * MicroSIP for DTMF sequences after the call connects).
 */
export function formatNumber(
  input: string,
  options: FormatNumberOptions = {},
): FormatNumberResult {
  const account = options.account;
  let number = input;

  let commands: string | undefined;
  const comma = number.indexOf(",");
  if (comma !== -1) {
    if (comma < number.length - 1) commands = number.slice(comma);
    number = number.slice(0, comma);
  }

  const isLocal = options.isLocal ?? false;
  let formatted = number;

  if (!options.noTransform) {
    const isBracketed = formatted.includes("<") && formatted.includes(">");
    if (!isBracketed && !isLocal && account) {
      let addPrefix = false;
      if (isPstnNumber(formatted)) {
        formatted = sanitizeNumber(formatted);
        if (account.dialingPrefix && formatted.length > 3) {
          if (formatted.startsWith("+")) formatted = formatted.slice(1);
          addPrefix = true;
        }
      }
      if (addPrefix) formatted = `${account.dialingPrefix}${formatted}`;

      if (account.dialPlan) {
        const applied = applyDialPlan(formatted, account.dialPlan);
        if (!applied.matched) {
          return {
            uri: "",
            number: "",
            commands,
            blocked: true,
            isLocal,
          };
        }
        formatted = applied.number;
      }
    }
  }

  const domain =
    options.domain ||
    account?.domain ||
    account?.server?.replace(/:\d+$/, "") ||
    "";
  return {
    uri: getSipUri(formatted, { isSimple: options.simple ?? true, isLocal, domain }),
    number: formatted,
    commands,
    blocked: false,
    isLocal,
  };
}

/** `<sip:a@b>` -> `sip:a@b` (the stack takes a bare Request-URI). */
export function unwrapUri(uri: string): string {
  const trimmed = uri.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) return trimmed.slice(1, -1);
  return trimmed;
}

export interface DialTarget {
  uri: string;
  number: string;
  commands?: string;
  blocked: boolean;
}

/**
 * `DialNumberFromCommandLine` (mainDlg.cpp:4538): strips tel:/sip:/callto:/
 * dialpad:/dial:, `//host/`, and applies `/account:N` params. The returned
 * number then goes through FormatNumber.
 */
export function dialStringToNumber(destination: string): string {
  let params = destination.trim();
  for (const prefix of ["tel:", "sip:", "callto:", "dialpad:", "dial:"]) {
    if (params.toLowerCase().startsWith(prefix)) {
      params = params.slice(prefix.length);
      break;
    }
  }
  if (params.startsWith("//")) {
    params = params.slice(2);
    if (params.endsWith("/")) params = params.slice(0, -1);
  }
  const accountIndex = params.indexOf("/account:");
  if (accountIndex >= 0) params = params.slice(0, accountIndex);
  return params.trim();
}
