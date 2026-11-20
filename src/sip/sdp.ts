/**
 * SDP (RFC 4566) parse/build + audio codec negotiation.
 *
 * pjmedia owns this in the Windows build; the port keeps the same
 * payload-type/rtpmap/fmtp model and reports the codec it will use so the
 * UI can show what MicroSIP shows ("G722", "PCMU", ...).
 */

export interface SdpAttribute {
  name: string;
  value?: string;
}

export interface RtpMap {
  payloadType: number;
  encoding: string;
  clockRate: number;
  channels?: number;
}

export interface SdpMedia {
  type: string;
  port: number;
  protocol: string;
  formats: string[];
  connection?: string;
  attributes: SdpAttribute[];
  /** `m=` line index, useful for stable re-INVITEs. */
  index: number;
}

export interface SdpSession {
  version: number;
  origin: string;
  sessionName: string;
  connection?: string;
  timing: string;
  attributes: SdpAttribute[];
  media: SdpMedia[];
}

/** MicroSIP `_GLOBAL_CODECS_ENABLED` (define.h:61), then the optional codecs. */
export const DEFAULT_AUDIO_CODECS = [
  "PCMA/8000/1",
  "PCMU/8000/1",
  "G722/8000/1",
  "GSM/8000/1",
  "ILBC/8000/1",
  "SPEEX/8000/1",
  "OPUS/48000/2",
];

function parseAttribute(line: string): SdpAttribute {
  const colon = line.indexOf(":");
  if (colon < 0) return { name: line };
  return { name: line.slice(0, colon), value: line.slice(colon + 1) };
}

export function parseSdp(text: string): SdpSession {
  const session: SdpSession = {
    version: 0,
    origin: "",
    sessionName: "-",
    timing: "0 0",
    attributes: [],
    media: [],
  };

  let current: SdpMedia | null = null;
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;
    const type = line[0];
    const value = line.slice(2);
    switch (type) {
      case "v":
        session.version = Number(value) || 0;
        break;
      case "o":
        session.origin = value;
        break;
      case "s":
        session.sessionName = value;
        break;
      case "c":
        if (current) current.connection = value;
        else session.connection = value;
        break;
      case "t":
        session.timing = value;
        break;
      case "m": {
        const parts = value.split(/\s+/);
        const [kind = "audio", portText = "0", protocol = "RTP/AVP", ...formats] = parts;
        current = {
          type: kind,
          port: Number(portText.split("/")[0]),
          protocol,
          formats,
          attributes: [],
          index: session.media.length,
        };
        session.media.push(current);
        break;
      }
      case "a": {
        const attribute = parseAttribute(value);
        if (current) current.attributes.push(attribute);
        else session.attributes.push(attribute);
        break;
      }
      default:
        break;
    }
  }

  return session;
}

export function buildSdp(session: SdpSession): string {
  const lines: string[] = [];
  lines.push(`v=${session.version}`);
  lines.push(`o=${session.origin}`);
  lines.push(`s=${session.sessionName}`);
  if (session.connection) lines.push(`c=${session.connection}`);
  lines.push(`t=${session.timing}`);
  for (const attribute of session.attributes) {
    lines.push(attribute.value === undefined ? `a=${attribute.name}` : `a=${attribute.name}:${attribute.value}`);
  }
  for (const media of session.media) {
    lines.push(`m=${media.type} ${media.port} ${media.protocol} ${media.formats.join(" ")}`);
    if (media.connection) lines.push(`c=${media.connection}`);
    for (const attribute of media.attributes) {
      lines.push(
        attribute.value === undefined
          ? `a=${attribute.name}`
          : `a=${attribute.name}:${attribute.value}`,
      );
    }
  }
  return lines.join("\r\n") + "\r\n";
}

export function rtpmaps(media: SdpMedia): RtpMap[] {
  const maps: RtpMap[] = [];
  for (const attribute of media.attributes) {
    if (attribute.name !== "rtpmap" || !attribute.value) continue;
    const match = /^(\d+)\s+([^/]+)\/(\d+)(?:\/(\d+))?/.exec(attribute.value);
    if (!match) continue;
    maps.push({
      payloadType: Number(match[1]),
      encoding: (match[2] as string).toUpperCase(),
      clockRate: Number(match[3]),
      channels: match[4] ? Number(match[4]) : undefined,
    });
  }
  return maps;
}

export function rtpmapFor(media: SdpMedia, payloadType: number): RtpMap | undefined {
  return rtpmaps(media).find((map) => map.payloadType === payloadType);
}

export function fmtpFor(media: SdpMedia, payloadType: number): string | undefined {
  for (const attribute of media.attributes) {
    if (attribute.name !== "fmtp" || !attribute.value) continue;
    const match = /^(\d+)\s+(.*)$/.exec(attribute.value);
    if (match && Number(match[1]) === payloadType) return match[2];
  }
  return undefined;
}

export function mediaDirection(media: SdpMedia): "sendrecv" | "sendonly" | "recvonly" | "inactive" {
  for (const attribute of media.attributes) {
    if (
      attribute.name === "sendrecv" ||
      attribute.name === "sendonly" ||
      attribute.name === "recvonly" ||
      attribute.name === "inactive"
    ) {
      return attribute.name;
    }
  }
  return "sendrecv";
}

export function audioMedia(session: SdpSession): SdpMedia | undefined {
  return session.media.find((media) => media.type === "audio");
}

/** Static RTP/AVP payload types (RFC 3551) for SDPs without rtpmap. */
export const STATIC_PAYLOAD_TYPES: Record<number, { encoding: string; clockRate: number }> = {
  0: { encoding: "PCMU", clockRate: 8000 },
  3: { encoding: "GSM", clockRate: 8000 },
  4: { encoding: "G723", clockRate: 8000 },
  8: { encoding: "PCMA", clockRate: 8000 },
  9: { encoding: "G722", clockRate: 8000 },
  18: { encoding: "G729", clockRate: 8000 },
  101: { encoding: "TELEPHONE-EVENT", clockRate: 8000 },
};

export interface Codec {
  payloadType: number;
  name: string;
  clockRate: number;
  channels: number;
  fmtp?: string;
}

export function codecsOf(media: SdpMedia): Codec[] {
  const maps = rtpmaps(media);
  const result: Codec[] = [];
  for (const format of media.formats) {
    const pt = Number(format);
    if (!Number.isFinite(pt)) continue;
    const map = maps.find((m) => m.payloadType === pt);
    const staticType = STATIC_PAYLOAD_TYPES[pt];
    const name = map?.encoding ?? staticType?.encoding;
    if (!name) continue;
    result.push({
      payloadType: pt,
      name,
      clockRate: map?.clockRate ?? staticType?.clockRate ?? 8000,
      channels: map?.channels ?? 1,
      fmtp: fmtpFor(media, pt),
    });
  }
  return result;
}

export interface NegotiatedMedia {
  codecs: Codec[];
  dtmfPayloadType?: number;
  direction: "sendrecv" | "sendonly" | "recvonly" | "inactive";
  remotePort: number;
  remoteAddress?: string;
}

/**
 * Offer/answer match: keep the offerer's payload numbers in offer order, which
 * is what pjsua does when answering. Unmatched formats are dropped.
 */
export function negotiateAudio(offer: SdpSession, answer?: SdpSession): NegotiatedMedia | null {
  const offerMedia = audioMedia(offer);
  if (!offerMedia) return null;
  const offerCodecs = codecsOf(offerMedia);
  if (!offerCodecs.length) return null;

  if (!answer) {
    return {
      codecs: offerCodecs,
      dtmfPayloadType: offerCodecs.find((c) => c.name === "TELEPHONE-EVENT")?.payloadType,
      direction: mediaDirection(offerMedia),
      remotePort: offerMedia.port,
      remoteAddress: offerMedia.connection ?? offer.connection,
    };
  }

  const answerMedia = audioMedia(answer);
  if (!answerMedia) return null;
  const answerCodecs = codecsOf(answerMedia);
  const common = offerCodecs.filter((offered) =>
    answerCodecs.some(
      (answered) =>
        answered.name === offered.name &&
        answered.clockRate === offered.clockRate &&
        (answered.channels || 1) === (offered.channels || 1),
    ),
  );

  return {
    codecs: common,
    dtmfPayloadType: common.find((c) => c.name === "TELEPHONE-EVENT")?.payloadType,
    direction: mediaDirection(answerMedia),
    remotePort: offerMedia.port,
    remoteAddress: offerMedia.connection ?? offer.connection,
  };
}

export interface BuildOfferOptions {
  address: string;
  port?: number;
  sessionId?: number;
  codecs?: string[];
  direction?: "sendrecv" | "sendonly" | "recvonly" | "inactive";
  dtmf?: boolean;
}

interface CodecSpec {
  encoding: string;
  clockRate: number;
  channels?: number;
  payloadType: number;
  fmtp?: string;
}

// Dynamic payload types in a stable order, matching the codec order below.
const DYNAMIC_PAYLOADS: CodecSpec[] = [
  { encoding: "G722", clockRate: 8000, payloadType: 9 },
  { encoding: "PCMU", clockRate: 8000, payloadType: 0 },
  { encoding: "PCMA", clockRate: 8000, payloadType: 8 },
  { encoding: "GSM", clockRate: 8000, payloadType: 3 },
  { encoding: "ILBC", clockRate: 8000, payloadType: 97, fmtp: "mode=30" },
  { encoding: "SPEEX", clockRate: 8000, payloadType: 98 },
  { encoding: "OPUS", clockRate: 48000, channels: 2, payloadType: 99, fmtp: "useinbandfec=1" },
];

export function buildAudioOffer(options: BuildOfferOptions): string {
  const sessionId = options.sessionId ?? 1;
  const address = options.address;
  const requested = options.codecs ?? DEFAULT_AUDIO_CODECS;
  const selected: CodecSpec[] = [];
  // Keep the account's configured codec order (MicroSIP lists PCMA first).
  for (const name of requested) {
    const [encoding = "", clock, channels] = name.split("/");
    const spec = DYNAMIC_PAYLOADS.find(
      (candidate) =>
        candidate.encoding === encoding.toUpperCase() &&
        (!clock || Number(clock) === candidate.clockRate) &&
        (!channels || Number(channels) === (candidate.channels ?? 1)),
    );
    if (spec && !selected.some((s) => s.encoding === spec.encoding)) selected.push(spec);
  }
  if (!selected.length) selected.push(DYNAMIC_PAYLOADS[1] as CodecSpec);

  const formats = selected.map((s) => String(s.payloadType));
  if (options.dtmf !== false) formats.push("101");

  const attributes: SdpAttribute[] = [];
  for (const codec of selected) {
    attributes.push({
      name: "rtpmap",
      value: `${codec.payloadType} ${codec.encoding}/${codec.clockRate}${codec.channels ? `/${codec.channels}` : ""}`,
    });
    if (codec.fmtp) attributes.push({ name: "fmtp", value: `${codec.payloadType} ${codec.fmtp}` });
  }
  if (options.dtmf !== false) {
    attributes.push({ name: "rtpmap", value: "101 telephone-event/8000" });
    attributes.push({ name: "fmtp", value: "101 0-16" });
  }
  attributes.push({ name: options.direction ?? "sendrecv" });
  attributes.push({ name: "ptime", value: "20" });

  return buildSdp({
    version: 0,
    origin: `- ${sessionId} ${sessionId} IN IP4 ${address}`,
    sessionName: "MicroSIP",
    connection: `IN IP4 ${address}`,
    timing: "0 0",
    attributes: [],
    media: [
      {
        type: "audio",
        port: options.port ?? 4000,
        protocol: "RTP/AVP",
        formats,
        attributes,
        index: 0,
      },
    ],
  });
}

export interface BuildAnswerOptions {
  address: string;
  port?: number;
  sessionId?: number;
  direction?: "sendrecv" | "sendonly" | "recvonly" | "inactive";
  /** Local enabled codecs; offered codecs outside this list are not answered. */
  codecs?: string[];
}

function matchesCodecList(codec: Codec, list: string[]): boolean {
  const name = codec.name.toUpperCase();
  return list.some((entry) => {
    const [encoding = "", clock] = entry.split("/");
    return encoding.toUpperCase() === name && (!clock || Number(clock) === codec.clockRate);
  });
}

/** Answer an offer with the intersection, in the offerer's payload numbers. */
export function buildAudioAnswer(offer: SdpSession, options: BuildAnswerOptions): string {
  const offerMedia = audioMedia(offer);
  const offered = offerMedia ? codecsOf(offerMedia) : [];
  const keep = offered.filter(
    (codec) =>
      codec.name !== "TELEPHONE-EVENT" &&
      (!options.codecs || matchesCodecList(codec, options.codecs)),
  );
  const dtmf = offered.find((codec) => codec.name === "TELEPHONE-EVENT");

  const sessionId = options.sessionId ?? 1;
  const formats = keep.map((c) => String(c.payloadType));
  if (dtmf) formats.push(String(dtmf.payloadType));

  const attributes: SdpAttribute[] = [];
  for (const codec of keep) {
    attributes.push({
      name: "rtpmap",
      value: `${codec.payloadType} ${codec.name}/${codec.clockRate}${codec.channels > 1 ? `/${codec.channels}` : ""}`,
    });
    if (codec.fmtp) attributes.push({ name: "fmtp", value: `${codec.payloadType} ${codec.fmtp}` });
  }
  if (dtmf) {
    attributes.push({ name: "rtpmap", value: `${dtmf.payloadType} telephone-event/8000` });
    attributes.push({ name: "fmtp", value: `${dtmf.payloadType} 0-16` });
  }
  attributes.push({ name: options.direction ?? "sendrecv" });
  attributes.push({ name: "ptime", value: "20" });

  return buildSdp({
    version: 0,
    origin: `- ${sessionId} ${sessionId} IN IP4 ${options.address}`,
    sessionName: "MicroSIP",
    connection: `IN IP4 ${options.address}`,
    timing: "0 0",
    attributes: [],
    media: [
      {
        type: "audio",
        port: options.port ?? 4000,
        protocol: "RTP/AVP",
        formats,
        attributes,
        index: 0,
      },
    ],
  });
}
