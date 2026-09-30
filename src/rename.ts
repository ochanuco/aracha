import { extractLinks, resolveHref, rewriteLinks } from "./okf";

const enc = new TextEncoder();

const dirOf = (path: string) => path.split("/").slice(0, -1).join("/");

// Renders `href` so that, read from a document at `newOwn`, it points at `target`. Reuses rewriteLinks on a one-link document to keep form, ".md" and fragment.
function reRender(href: string, newOwn: string, target: string): string | null {
  const meaning = resolveHref(href, newOwn);
  if (meaning === null) return null;
  const probe = enc.encode(`[x](<${href}>)`);
  const out = rewriteLinks(probe, newOwn, meaning, target);
  const link = extractLinks(out, newOwn)[0];
  return link ? link.href : null;
}

/**
 * Bytes of the renamed document itself: links keep pointing at the same documents
 * (self-links follow the move) even though the document's directory changes.
 */
export function relocateDocument(bytes: Uint8Array, oldPath: string, newPath: string): Uint8Array {
  const links = extractLinks(bytes, oldPath);
  const sameDir = dirOf(oldPath) === dirOf(newPath);
  const parts: Uint8Array[] = [];
  let pos = 0;
  for (const l of links) {
    const target = l.target === oldPath ? newPath : l.target;
    if (l.target !== oldPath && (sameDir || l.href.startsWith("/"))) continue;
    const next = reRender(l.href, newPath, target);
    if (next === null || next === l.href) continue;
    parts.push(bytes.subarray(pos, l.start), enc.encode(next));
    pos = l.end;
  }
  if (parts.length === 0) return bytes;
  parts.push(bytes.subarray(pos));
  return concat(parts);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
