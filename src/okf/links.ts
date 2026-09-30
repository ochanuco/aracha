import { parseMarkdown, type MNode } from "./md";
import { splitDocument } from "./frontmatter";

export interface LinkRef {
  /** Resolved concept ID. */
  target: string;
  /** Raw href text as written in the source. */
  href: string;
  /** UTF-8 byte offsets of the href text within the document. */
  start: number;
  end: number;
}

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const WS = /\s/;

/** Prefix table from UTF-16 index to UTF-8 byte offset. */
function byteTable(s: string): Uint32Array {
  const t = new Uint32Array(s.length + 1);
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    t[i] = n;
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) n += 4;
    else if (c >= 0xdc00 && c <= 0xdfff) n += 0;
    else n += 3;
  }
  t[s.length] = n;
  return t;
}

function parseDest(src: string, from: number, limit: number): [number, number] | null {
  let k = from;
  while (k < limit && WS.test(src[k]!)) k++;
  if (k >= limit) return null;
  if (src[k] === "<") {
    let i = k + 1;
    while (i < limit && src[i] !== ">") {
      if (src[i] === "\\") i++;
      else if (src[i] === "\n") return null;
      i++;
    }
    return i < limit ? [k + 1, i] : null;
  }
  let i = k;
  let depth = 0;
  while (i < limit) {
    const c = src[i]!;
    if (c === "\\") i++;
    else if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) break;
      depth--;
    } else if (WS.test(c)) break;
    i++;
  }
  return [k, Math.min(i, limit)];
}

/** UTF-16 span of the raw destination text of a link or definition node. */
function hrefSpan(src: string, node: MNode): [number, number] | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined || src[start] !== "[") return null;
  let span: [number, number] | null = null;
  if (node.type === "link") {
    const kids = node.children ?? [];
    const last = kids[kids.length - 1]?.position?.end.offset;
    const close = src.indexOf("]", last ?? start + 1);
    if (close === -1 || src[close + 1] !== "(") return null;
    span = parseDest(src, close + 2, end);
  } else {
    let i = start + 1;
    while (i < end && src[i] !== "]") i += src[i] === "\\" ? 2 : 1;
    if (src[i] !== "]" || src[i + 1] !== ":") return null;
    span = parseDest(src, i + 2, end);
  }
  return span && span[1] > span[0] ? span : null;
}

function collect(nodes: MNode[], out: MNode[]): void {
  for (const n of nodes) {
    if (n.type === "link" || n.type === "definition") out.push(n);
    if (n.children) collect(n.children, out);
  }
}

function splitHref(href: string): { path: string; suffix: string } {
  const i = href.search(/[#?]/);
  return i === -1 ? { path: href, suffix: "" } : { path: href.slice(0, i), suffix: href.slice(i) };
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function dirOf(conceptId: string): string[] {
  const parts = conceptId.split("/");
  parts.pop();
  return parts;
}

/** Resolves an href to a concept ID, or null for external, fragment-only, or out-of-bundle links. */
export function resolveHref(href: string, ownPath: string): string | null {
  if (href === "" || href.startsWith("#") || href.startsWith("//") || SCHEME.test(href)) {
    return null;
  }
  const { path } = splitHref(href);
  if (path === "") return null;
  const decoded = decode(path);
  const stack: string[] = decoded.startsWith("/") ? [] : dirOf(ownPath);
  for (const seg of decoded.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (stack.length === 0) return null;
      stack.pop();
    } else stack.push(seg);
  }
  if (stack.length === 0) return null;
  const last = stack.length - 1;
  stack[last] = stack[last]!.replace(/\.md$/, "");
  if (stack[last] === "") return null;
  return stack.join("/");
}

export function extractLinks(bytes: Uint8Array, ownPath: string): LinkRef[] {
  const { body, bodyOffset } = splitDocument(bytes);
  const nodes: MNode[] = [];
  collect(parseMarkdown(body), nodes);
  const table = byteTable(body);
  const out: LinkRef[] = [];
  for (const node of nodes) {
    const span = hrefSpan(body, node);
    if (!span) continue;
    const href = body.slice(span[0], span[1]);
    const target = resolveHref(href, ownPath);
    if (target === null) continue;
    out.push({
      target,
      href,
      start: bodyOffset + table[span[0]!]!,
      end: bodyOffset + table[span[1]!]!,
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

function escapeSegment(seg: string, encodeAll: boolean): string {
  if (encodeAll) return encodeURIComponent(seg);
  return seg.replace(/[%\s#?<>()[\]\\]/g, (c) => encodeURIComponent(c));
}

function relativePath(fromDir: string[], to: string[]): string[] {
  let i = 0;
  while (i < fromDir.length && i < to.length - 1 && fromDir[i] === to[i]) i++;
  return [...fromDir.slice(i).map(() => ".."), ...to.slice(i)];
}

function rewriteHref(href: string, ownPath: string, to: string): string {
  const { path, suffix } = splitHref(href);
  const encodeAll = path.includes("%");
  const ext = path.endsWith(".md") ? ".md" : "";
  const toSegs = to.split("/");
  let segs: string[];
  let prefix = "";
  if (path.startsWith("/")) {
    segs = toSegs;
    prefix = "/";
  } else {
    segs = relativePath(dirOf(ownPath), toSegs);
    if (path.startsWith("./") && segs[0] !== "..") prefix = "./";
  }
  return prefix + segs.map((s) => escapeSegment(s, encodeAll)).join("/") + ext + suffix;
}

export function rewriteLinks(
  bytes: Uint8Array,
  ownPath: string,
  from: string,
  to: string,
): Uint8Array {
  const hits = extractLinks(bytes, ownPath).filter((l) => l.target === from);
  if (hits.length === 0) return bytes;
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  let pos = 0;
  for (const l of hits) {
    parts.push(bytes.subarray(pos, l.start), enc.encode(rewriteHref(l.href, ownPath, to)));
    pos = l.end;
  }
  parts.push(bytes.subarray(pos));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
