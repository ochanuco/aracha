import { env, exports } from "cloudflare:workers";
import { uuidv7 } from "../../src/ids";
import { projectDocument } from "../../src/projection/consumer";
import type { Result, StateValue } from "../../src/do/document";

export const api = (path: string, init?: RequestInit) => exports.default.fetch(`https://example.com${path}`, init);

export const json = (method: string, path: string, body: unknown) =>
  api(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** A path no other test uses, so tests do not depend on storage isolation. */
export const uniquePath = (name: string) => `t${uuidv7().slice(-12)}/${name}`;

export async function create(path: string, markdown: string) {
  const res = await json("POST", "/api/documents", { path, markdown });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { document_id: string; revision_id: string };
}

export async function state(id: string): Promise<StateValue> {
  const r = (await env.DOCUMENT.getByName(id).getState()) as Result<StateValue>;
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
}

export async function project(id: string) {
  const s = await state(id);
  await projectDocument(env, {
    workspace_id: s.workspace_id,
    document_id: id,
    revision_id: s.primary_head,
    projection_seq: s.projection_seq,
  });
}

export async function autosave(id: string, base: string, markdown: string) {
  const res = await json("PUT", `/api/documents/${id}/autosave`, { operation_id: uuidv7(), base_revision_id: base, markdown });
  return { status: res.status, body: (await res.json()) as { revision_id: string; conflicted: boolean; heads: string[] } };
}
