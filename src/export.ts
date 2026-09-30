import type { Result, StateValue } from "./do/document";
import { listDocuments } from "./projection/queries";
import { loadBlob } from "./write";

const encoder = new TextEncoder();
const BLOCK = 512;

export type TarEntry = { name: string; bytes: Uint8Array };

function field(header: Uint8Array, offset: number, length: number, value: string): void {
  header.set(encoder.encode(value).subarray(0, length), offset);
}

const octal = (n: number, width: number) => n.toString(8).padStart(width, "0");

// ustar stores a long path as prefix (<= 155 bytes) + "/" + name (<= 100 bytes).
function splitName(name: string): { prefix: string; name: string } {
  if (encoder.encode(name).length <= 100) return { prefix: "", name };
  for (let i = name.indexOf("/"); i !== -1; i = name.indexOf("/", i + 1)) {
    const prefix = name.slice(0, i);
    const rest = name.slice(i + 1);
    if (encoder.encode(rest).length > 100) continue;
    if (encoder.encode(prefix).length <= 155) return { prefix, name: rest };
    break;
  }
  throw new Error(`path too long for ustar: ${name}`);
}

function header(name: string, size: number, mtime: number): Uint8Array {
  const parts = splitName(name);
  const h = new Uint8Array(BLOCK);
  field(h, 0, 100, parts.name);
  field(h, 100, 8, `${octal(0o644, 7)}\0`);
  field(h, 108, 8, `${octal(0, 7)}\0`);
  field(h, 116, 8, `${octal(0, 7)}\0`);
  field(h, 124, 12, `${octal(size, 11)}\0`);
  field(h, 136, 12, `${octal(mtime, 11)}\0`);
  field(h, 148, 8, "        ");
  field(h, 156, 1, "0");
  field(h, 257, 6, "ustar\0");
  field(h, 263, 2, "00");
  field(h, 345, 155, parts.prefix);
  let sum = 0;
  for (const b of h) sum += b;
  field(h, 148, 8, `${octal(sum, 6)}\0 `);
  return h;
}

export function buildTar(entries: TarEntry[], mtime = Math.floor(Date.now() / 1000)): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const e of entries) {
    chunks.push(header(e.name, e.bytes.length, mtime), e.bytes);
    const pad = (BLOCK - (e.bytes.length % BLOCK)) % BLOCK;
    if (pad) chunks.push(new Uint8Array(pad));
  }
  chunks.push(new Uint8Array(BLOCK * 2));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export async function exportTar(env: Env): Promise<Response> {
  const entries: TarEntry[] = [];
  for (const doc of await listDocuments(env)) {
    const res = (await env.DOCUMENT.getByName(doc.document_id).getState()) as Result<StateValue>;
    if (!res.ok) throw new Error(`getState failed for ${doc.document_id}: ${res.error.code}`);
    const head = res.value.heads.find((h) => h.revision_id === res.value.primary_head);
    if (!head || head.content_blob_id === null) continue;
    const bytes = await loadBlob(env, head.content_blob_id);
    if (!bytes) throw new Error(`blob missing: ${head.content_blob_id}`);
    entries.push({ name: `${head.path}.md`, bytes });
  }
  return new Response(buildTar(entries), {
    headers: {
      "content-type": "application/x-tar",
      "content-disposition": 'attachment; filename="aracha-export.tar"',
    },
  });
}
