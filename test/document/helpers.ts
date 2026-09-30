import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { storeBlob } from "../../src/write";
import { uuidv7 } from "../../src/ids";
import type { CommitRequest, CommitValue, Result } from "../../src/do/document";
import { getCha } from "../../src/cha/impl";

export const WS = "ws";

export function newDoc() {
  const id = uuidv7();
  const stub = env.DOCUMENT.getByName(id);
  const blob = (s: string) => getCha().blobId(new TextEncoder().encode(s));
  const store = (s: string) => storeBlob(env, new TextEncoder().encode(s));
  const commit = async (over: Partial<CommitRequest> & { content: string }) => {
    const { content, ...rest } = over;
    await store(content);
    return stub.commit({
      workspace_id: WS,
      document_id: id,
      operation_id: uuidv7(),
      actor_id: "dev",
      kind: "autosave",
      base_revision_id: null,
      content_blob_id: blob(content),
      path: "notes/a",
      attachments: [],
      ...rest,
    });
  };
  const seqs = () =>
    runInDurableObject(stub, (_i, state) =>
      state.storage.sql
        .exec<{ projection_seq: number; published_seq: number }>("SELECT projection_seq, published_seq FROM document_state")
        .one(),
    );
  return { id, stub, blob, store, commit, seqs };
}

export function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`unexpected error ${r.error.code}`);
  return r.value;
}

export type { CommitValue };
