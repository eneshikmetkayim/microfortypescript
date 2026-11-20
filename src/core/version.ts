/** Mirrors MicroSIP-3.23.5-src/const.h and define.h. */

export const MICROSIP_VERSION = "3.23.5";
export const MICROSIP_NAME = "MicroSIP";
export const MICROSIP_URL = "https://www.microsip.org";
export const PORT_NAME = "microfortypescript";

/** `User-Agent` used by the Wallet build (pjsua default is `pjsua/<ver>`). */
export const USER_AGENT = `${MICROSIP_NAME}/${MICROSIP_VERSION} (${PORT_NAME})`;

/** define.h:61 — the only codecs enabled by default. */
export const DEFAULT_CODECS_ENABLED = "PCMA/8000/1 PCMU/8000/1";

/** MicroSIP keeps at most 1000 rows in call_log (Database.cpp InitCalls). */
export const CALL_LOG_LIMIT = 1000;
