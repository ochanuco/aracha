import { env } from "cloudflare:workers";
import { uuidv7 } from "../../src/ids";
import { readMeta } from "../../src/okf";
import type { ChangeHistory, Result } from "../../src/do/document";
import type { OperationValue } from "../../src/do/coordinator";
import { loadBlob } from "../../src/write";
import { create, json, project, state } from "../api/helpers";

export { create, json, project, state };

export const namespace = () => `t${uuidv7().slice(-12)}`;

export async function headOf(id: string) {
  const s = await state(id);
  const head = s.heads.find((h) => h.revision_id === s.primary_head)!;
  const text = new TextDecoder().decode((await loadBlob(env, head.content_blob_id!))!);
  return { ...head, text, meta: readMeta(new TextEncoder().encode(text)) };
}

export async function history(id: string): Promise<ChangeHistory[]> {
  const r = (await env.DOCUMENT.getByName(id).getHistory()) as Result<ChangeHistory[]>;
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
}

export const revisionsOf = async (id: string, operationId: string) =>
  (await history(id)).flatMap((c) => c.revisions).filter((r) => r.operation_id === operationId);

export async function startRename(documentId: string, newPath: string, injectFailures?: Record<string, number>) {
  const res = await json("POST", "/api/rename", { document_id: documentId, new_path: newPath, inject_failures: injectFailures });
  return { res, value: (await res.json()) as OperationValue };
}

export const coordinatorOf = (operationId: string) => env.OPERATION_COORDINATOR.getByName(operationId);

export async function status(operationId: string): Promise<OperationValue> {
  const r = (await coordinatorOf(operationId).getStatus()) as Result<OperationValue>;
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
}

export async function retry(operationId: string): Promise<OperationValue> {
  const r = (await coordinatorOf(operationId).retry()) as Result<OperationValue>;
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
}
