export type DocumentRow = {
  document_id: string;
  workspace_id: string;
  path: string;
  type: string | null;
  title: string;
  revision_id: string;
  content_blob_id: string | null;
  conflicted: number;
  indexed_seq: number;
};

export type BacklinkRow = { document_id: string; path: string; title: string };
export type GraphEdge = { source_document_id: string; target_path: string; target_document_id: string | null };
export type SearchHit = { document_id: string; path: string; title: string };

export async function listDocuments(env: { DB: D1Database }): Promise<DocumentRow[]> {
  const { results } = await env.DB.prepare("SELECT * FROM documents ORDER BY path").all<DocumentRow>();
  return results;
}

export async function resolvePath(env: { DB: D1Database }, path: string): Promise<DocumentRow | null> {
  const direct = await env.DB.prepare("SELECT * FROM documents WHERE path = ?").bind(path).first<DocumentRow>();
  if (direct) return direct;
  return env.DB.prepare(
    "SELECT d.* FROM aliases a JOIN documents d ON d.document_id = a.document_id WHERE a.alias_path = ?",
  )
    .bind(path)
    .first<DocumentRow>();
}

export async function backlinks(env: { DB: D1Database }, documentId: string): Promise<BacklinkRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT d.document_id, d.path, d.title FROM edges e
     JOIN documents d ON d.document_id = e.source_document_id
     WHERE d.document_id <> ?1 AND (
       e.target_path = (SELECT path FROM documents WHERE document_id = ?1)
       OR e.target_path IN (SELECT alias_path FROM aliases WHERE document_id = ?1))
     ORDER BY d.path`,
  )
    .bind(documentId)
    .all<BacklinkRow>();
  return results;
}

export async function edgeSources(env: { DB: D1Database }, targetPath: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT source_document_id FROM edges WHERE target_path = ? ORDER BY source_document_id",
  )
    .bind(targetPath)
    .all<{ source_document_id: string }>();
  return results.map((r) => r.source_document_id);
}

export async function graph(env: { DB: D1Database }): Promise<GraphEdge[]> {
  const { results } = await env.DB.prepare(
    `SELECT e.source_document_id, e.target_path,
            COALESCE(d.document_id, a.document_id) AS target_document_id
     FROM edges e
     LEFT JOIN documents d ON d.path = e.target_path
     LEFT JOIN aliases a ON a.alias_path = e.target_path
     ORDER BY e.source_document_id, e.target_path`,
  ).all<GraphEdge>();
  return results;
}

const LIMIT = 50;

export async function search(env: { DB: D1Database }, q: string): Promise<SearchHit[]> {
  const term = q.trim();
  if (term === "") return [];
  if ([...term].length < 3) {
    const like = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
    const { results } = await env.DB.prepare(
      `SELECT document_id, path, title FROM search
       WHERE title LIKE ?1 ESCAPE '\\' OR path LIKE ?1 ESCAPE '\\' OR body LIKE ?1 ESCAPE '\\'
       ORDER BY path LIMIT ${LIMIT}`,
    )
      .bind(like)
      .all<SearchHit>();
    return results;
  }
  const literal = `"${term.replace(/"/g, '""')}"`;
  const { results } = await env.DB.prepare(
    `SELECT document_id, path, title FROM search WHERE search MATCH ? ORDER BY rank LIMIT ${LIMIT}`,
  )
    .bind(literal)
    .all<SearchHit>();
  return results;
}
