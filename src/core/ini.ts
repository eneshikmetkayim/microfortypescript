/**
 * Windows INI reader/writer compatible with MicroSIP's settings.cpp.
 *
 * MicroSIP stores everything in `microsip.ini` through
 * GetPrivateProfileString/WritePrivateProfileString: section names are
 * case-insensitive, keys are case-insensitive, values are raw strings, and a
 * missing key yields the caller's default. This module reproduces that model
 * (including keeping unknown keys so a round-trip does not lose settings).
 */

export type IniSection = Map<string, string>;

export class IniDocument {
  private sections = new Map<string, IniSection>();
  /** Preserves section order for a stable file layout. */
  private order: string[] = [];

  static parse(text: string): IniDocument {
    const doc = new IniDocument();
    let current: IniSection | null = null;
    const clean = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    for (const rawLine of clean.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith(";") || line.startsWith("#")) continue;
      if (line.startsWith("[") && line.endsWith("]")) {
        const name = line.slice(1, -1).trim();
        current = doc.ensure(name);
        continue;
      }
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (!current) current = doc.ensure("");
      current.set(key.toLowerCase(), value);
    }
    return doc;
  }

  private ensure(section: string): IniSection {
    const key = section.toLowerCase();
    let existing = this.sections.get(key);
    if (!existing) {
      existing = new Map();
      this.sections.set(key, existing);
      this.order.push(section);
    }
    return existing;
  }

  get(section: string, key: string, fallback = ""): string {
    return this.sections.get(section.toLowerCase())?.get(key.toLowerCase()) ?? fallback;
  }

  getNumber(section: string, key: string, fallback = 0): number {
    const raw = this.get(section, key, "");
    if (raw === "") return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  }

  getBool(section: string, key: string, fallback = false): boolean {
    const raw = this.get(section, key, "").toLowerCase();
    if (raw === "") return fallback;
    return raw === "1" || raw === "true" || raw === "yes";
  }

  set(section: string, key: string, value: string | number | boolean | undefined): this {
    if (value === undefined) {
      this.remove(section, key);
      return this;
    }
    const table = this.ensure(section);
    table.set(key.toLowerCase(), typeof value === "string" ? value : value ? "1" : "0");
    if (typeof value === "number") table.set(key.toLowerCase(), String(value));
    return this;
  }

  setString(section: string, key: string, value: string): this {
    return this.set(section, key, value);
  }

  remove(section: string, key: string): this {
    this.sections.get(section.toLowerCase())?.delete(key.toLowerCase());
    return this;
  }

  removeSection(section: string): this {
    const key = section.toLowerCase();
    this.sections.delete(key);
    this.order = this.order.filter((name) => name.toLowerCase() !== key);
    return this;
  }

  section(name: string): IniSection {
    return this.ensure(name);
  }

  hasSection(name: string): boolean {
    return this.sections.has(name.toLowerCase());
  }

  sectionNames(): string[] {
    return [...this.order];
  }

  /** Keys of a section in insertion order. */
  keys(section: string): string[] {
    return [...(this.sections.get(section.toLowerCase())?.keys() ?? [])];
  }

  toString(): string {
    const lines: string[] = [];
    for (const name of this.order) {
      const table = this.sections.get(name.toLowerCase());
      if (!table || table.size === 0) continue;
      if (lines.length) lines.push("");
      lines.push(`[${name}]`);
      for (const [key, value] of table) lines.push(`${key}=${value}`);
    }
    return lines.join("\r\n") + "\r\n";
  }
}

export function parseIni(text: string): IniDocument {
  return IniDocument.parse(text);
}

export function serializeIni(doc: IniDocument): string {
  return doc.toString();
}
