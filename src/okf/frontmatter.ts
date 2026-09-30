import { isMap, isScalar, parseDocument, stringify } from "yaml";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export interface SplitResult {
  /** YAML text between the delimiter lines, verbatim (line endings included). */
  frontmatter: string | null;
  body: string;
  /** UTF-8 byte offset where `body` starts. */
  bodyOffset: number;
}

export interface Meta {
  type?: string;
  title?: string;
  description?: string;
  tags?: string[];
  arachaId?: string;
  aliases: string[];
  all: Record<string, unknown>;
}

interface Located {
  eol: string;
  /** UTF-16 indices into the decoded string. */
  yamlStart: number;
  yamlEnd: number;
  bodyStart: number;
}

const DELIM = /^(---|\.\.\.)[ \t]*$/;

function locate(s: string): Located | null {
  if (!/^---[ \t]*(\r?\n|$)/.test(s)) return null;
  let pos = s.indexOf("\n");
  if (pos === -1) return null;
  const eol = s[pos - 1] === "\r" ? "\r\n" : "\n";
  pos += 1;
  const yamlStart = pos;
  while (pos < s.length) {
    let lineEnd = s.indexOf("\n", pos);
    const next = lineEnd === -1 ? s.length : lineEnd + 1;
    if (lineEnd === -1) lineEnd = s.length;
    let line = s.slice(pos, lineEnd);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (DELIM.test(line)) return { eol, yamlStart, yamlEnd: pos, bodyStart: next };
    pos = next;
  }
  return null;
}

const byteLength = (s: string) => encoder.encode(s).length;

export function splitDocument(bytes: Uint8Array): SplitResult {
  const s = decoder.decode(bytes);
  const loc = locate(s);
  if (!loc) return { frontmatter: null, body: s, bodyOffset: 0 };
  return {
    frontmatter: s.slice(loc.yamlStart, loc.yamlEnd),
    body: s.slice(loc.bodyStart),
    bodyOffset: byteLength(s.slice(0, loc.bodyStart)),
  };
}

export function parseFrontmatter(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const doc = parseDocument(text);
    if (doc.errors.length > 0) return null;
    const value = doc.toJS();
    if (value === null || value === undefined) return {};
    if (typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export function readMeta(bytes: Uint8Array): Meta {
  const all = parseFrontmatter(splitDocument(bytes).frontmatter);
  if (!all) return { aliases: [], all: {} };
  const aracha = all.aracha;
  const a = aracha && typeof aracha === "object" && !Array.isArray(aracha)
    ? (aracha as Record<string, unknown>)
    : {};
  const meta: Meta = { aliases: strList(a.aliases), all };
  const type = str(all.type);
  const title = str(all.title);
  const description = str(all.description);
  if (type !== undefined) meta.type = type;
  if (title !== undefined) meta.title = title;
  if (description !== undefined) meta.description = description;
  if (Array.isArray(all.tags)) meta.tags = strList(all.tags);
  const id = str(a.id);
  if (id !== undefined) meta.arachaId = id;
  return meta;
}

function arachaBlock(id: string, aliases: string[], eol: string): string {
  const value: { id: string; aliases?: string[] } = { id };
  if (aliases.length > 0) value.aliases = aliases;
  return stringify({ aracha: value }, { indent: 2 })
    .replace(/\n$/, "")
    .replace(/\n/g, eol);
}

/**
 * Rewrites only the `aracha` key. Throws when the existing frontmatter is not a
 * valid YAML mapping, since editing it blindly could corrupt user data.
 */
export function writeArachaMeta(
  bytes: Uint8Array,
  meta: { id: string; aliases: string[] },
): Uint8Array {
  const s = decoder.decode(bytes);
  const loc = locate(s);
  if (!loc) {
    const eol = /^[^\n]*\r\n/.test(s) ? "\r\n" : "\n";
    const head = `---${eol}${arachaBlock(meta.id, meta.aliases, eol)}${eol}---${eol}`;
    return concat(encoder.encode(head), bytes);
  }

  const yaml = s.slice(loc.yamlStart, loc.yamlEnd);
  const doc = parseDocument(yaml);
  if (doc.errors.length > 0 || (doc.contents !== null && !isMap(doc.contents))) {
    throw new Error("frontmatter is not a valid YAML mapping");
  }
  const block = arachaBlock(meta.id, meta.aliases, loc.eol);
  const pair = isMap(doc.contents)
    ? doc.contents.items.find((p) => isScalar(p.key) && p.key.value === "aracha")
    : undefined;

  let newYaml: string;
  if (pair && isScalar(pair.key) && pair.key.range) {
    const start = pair.key.range[0];
    let end = pair.value?.range ? pair.value.range[1] : pair.key.range[1];
    if (!pair.value?.range) {
      const nl = yaml.indexOf("\n", end);
      end = nl === -1 ? yaml.length : nl;
    }
    // A block-map value's range includes its trailing line break, which the
    // replacement must not swallow.
    while (end > start && (yaml[end - 1] === "\n" || yaml[end - 1] === "\r")) end--;
    newYaml = yaml.slice(0, start) + block + yaml.slice(end);
  } else {
    const sep = yaml === "" || yaml.endsWith("\n") ? "" : loc.eol;
    newYaml = yaml + sep + block + loc.eol;
  }

  // Splice bytes so everything outside the edited span is copied verbatim.
  const yamlStartByte = byteLength(s.slice(0, loc.yamlStart));
  const yamlEndByte = yamlStartByte + byteLength(yaml);
  return concat(
    concat(bytes.subarray(0, yamlStartByte), encoder.encode(newYaml)),
    bytes.subarray(yamlEndByte),
  );
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
