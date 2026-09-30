import type { Result, StateValue } from "../do/document";
import { extractLinks, readMeta, splitDocument } from "../okf";
import { loadBlob } from "../write";

export type ProjectionMessage = {
  workspace_id: string;
  document_id: string;
  revision_id: string;
  projection_seq: number;
};

const decoder = new TextDecoder();

function isMarkdownHref(href: string): boolean {
  const end = href.search(/[#?]/);
  return (end === -1 ? href : href.slice(0, end)).endsWith(".md");
}

export async function projectDocument(env: Env, msg: ProjectionMessage): Promise<void> {
  const { document_id } = msg;
  const indexed = await env.DB.prepare("SELECT indexed_seq FROM documents WHERE document_id = ?")
    .bind(document_id)
    .first<number>("indexed_seq");
  if (indexed !== null && msg.projection_seq <= indexed) return;

  const res = (await env.DOCUMENT.getByName(document_id).getState()) as Result<StateValue>;
  if (!res.ok) throw new Error(`getState failed: ${res.error.code}`);
  const state = res.value;
  const head = state.heads.find((h) => h.revision_id === state.primary_head);
  if (!head || head.content_blob_id === null) throw new Error("primary head has no content");
  const bytes = await loadBlob(env, head.content_blob_id);
  if (!bytes) throw new Error(`blob missing: ${head.content_blob_id}`);

  const path = head.path;
  const meta = readMeta(bytes);
  const title = meta.title ?? path.split("/").pop()!;
  const targets = [
    ...new Set(extractLinks(bytes, path).filter((l) => isMarkdownHref(l.href)).map((l) => l.target)),
  ];
  const body = splitDocument(bytes).body;
  const db = env.DB;

  const stmts: D1PreparedStatement[] = [];
  const dropOwner = (where: string, arg: string) => {
    const owner = `(SELECT document_id FROM documents WHERE ${where} AND document_id <> ?2)`;
    for (const table of ["aliases", "metadata", "search"]) {
      stmts.push(db.prepare(`DELETE FROM ${table} WHERE document_id IN ${owner}`).bind(arg, document_id));
    }
    stmts.push(
      db.prepare(`DELETE FROM edges WHERE source_document_id IN ${owner}`).bind(arg, document_id),
      db.prepare(`DELETE FROM documents WHERE ${where} AND document_id <> ?2`).bind(arg, document_id),
    );
  };
  dropOwner("path = ?1", path);

  stmts.push(
    db
      .prepare(
        `INSERT INTO documents (document_id, workspace_id, path, type, title, revision_id, content_blob_id, conflicted, indexed_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (document_id) DO UPDATE SET workspace_id = excluded.workspace_id, path = excluded.path,
           type = excluded.type, title = excluded.title, revision_id = excluded.revision_id,
           content_blob_id = excluded.content_blob_id, conflicted = excluded.conflicted, indexed_seq = excluded.indexed_seq`,
      )
      .bind(
        document_id,
        state.workspace_id,
        path,
        meta.type ?? null,
        title,
        head.revision_id,
        head.content_blob_id,
        state.conflicted ? 1 : 0,
        state.projection_seq,
      ),
    db.prepare("DELETE FROM aliases WHERE document_id = ?").bind(document_id),
    db.prepare("DELETE FROM metadata WHERE document_id = ?").bind(document_id),
    db.prepare("DELETE FROM edges WHERE source_document_id = ?").bind(document_id),
    db.prepare("DELETE FROM search WHERE document_id = ?").bind(document_id),
  );
  for (const alias of new Set(meta.aliases)) {
    stmts.push(
      db.prepare("INSERT OR REPLACE INTO aliases (alias_path, document_id) VALUES (?, ?)").bind(alias, document_id),
    );
  }
  for (const [key, value] of Object.entries(meta.all)) {
    stmts.push(
      db
        .prepare("INSERT INTO metadata (document_id, key, value_json) VALUES (?, ?, ?)")
        .bind(document_id, key, JSON.stringify(value ?? null)),
    );
  }
  for (const target of targets) {
    stmts.push(db.prepare("INSERT INTO edges (source_document_id, target_path) VALUES (?, ?)").bind(document_id, target));
  }
  stmts.push(
    db
      .prepare("INSERT INTO search (document_id, path, title, body) VALUES (?, ?, ?, ?)")
      .bind(document_id, path, title, body),
  );
  await db.batch(stmts);
}

export async function handleProjectionBatch(batch: MessageBatch<ProjectionMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      await projectDocument(env, message.body);
      message.ack();
    } catch {
      message.retry();
    }
  }
}
