import { derivedIrKey } from "./cas";
import { getCha } from "./cha/impl";
import { isChaError, type DiffNode } from "./cha/port";
import { labelEvents } from "./diff-labels";
import type { Result, RpcError, StateValue } from "./do/document";
import { exportTar } from "./export";
import { isUuidv7, uuidv7 } from "./ids";
import { IR_SCHEMA_VERSION, PARSER_VERSION, readMeta, toTypedTree, writeArachaMeta } from "./okf";
import { backlinks, edgeSources, graph, listDocuments, resolvePath, search } from "./projection/queries";
import { loadBlob, storeBlob } from "./write";

type Ctx = { request: Request; env: Env; url: URL; params: string[]; actor: string };
type Handler = (ctx: Ctx) => Promise<Response>;
type Route = { method: string; pattern: RegExp; handler: Handler };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly context: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function statusFor(code: string): number {
  if (code === "NOT_FOUND") return 404;
  if (["CONFLICTED", "NOT_CONFLICTED", "STALE_BASE", "PATH_TAKEN", "DOCUMENT_EXISTS", "ALIAS_IN_USE"].includes(code)) return 409;
  if (/^(INVALID_|UNKNOWN_)/.test(code) || ["DOCUMENT_MISMATCH", "NO_CONTENT"].includes(code)) return 400;
  return 500;
}

const errorResponse = (e: RpcError) =>
  Response.json({ code: e.code, message: e.message, context: e.context }, { status: statusFor(e.code) });

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: RpcError }): T {
  if (!r.ok) throw new HttpError(statusFor(r.error.code), r.error.code, r.error.message, r.error.context);
  return r.value;
}

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // falls through to the error below
  }
  throw new HttpError(400, "INVALID_JSON", "request body must be a JSON object");
}

function str(body: Record<string, unknown>, field: string): string {
  const v = body[field];
  if (typeof v !== "string") throw new HttpError(400, "INVALID_INPUT", `${field} must be a string`, { field });
  return v;
}

const operationId = (body: Record<string, unknown>) =>
  typeof body.operation_id === "string" && body.operation_id !== "" ? body.operation_id : uuidv7();

// A concept ID: relative, no ".md" suffix, no empty or dot segments.
function assertConceptId(path: string): void {
  const ok =
    path !== "" &&
    !path.startsWith("/") &&
    !path.endsWith("/") &&
    !path.endsWith(".md") &&
    path.split("/").every((s) => s !== "" && s !== "." && s !== "..");
  if (!ok) throw new HttpError(400, "INVALID_PATH", "path must be a concept ID without leading slash or .md", { path });
}

const doc = (env: Env, id: string) => env.DOCUMENT.getByName(id);

async function requireBlob(env: Env, blobId: string | null): Promise<Uint8Array> {
  if (blobId === null) throw new HttpError(400, "NO_CONTENT", "revision has no content");
  const bytes = await loadBlob(env, blobId);
  if (!bytes) throw new HttpError(500, "BLOB_MISSING", "blob missing from store", { blob_id: blobId });
  return bytes;
}

async function typedTree(env: Env, blobId: string, bytes: Uint8Array): Promise<DiffNode> {
  const key = derivedIrKey(PARSER_VERSION, IR_SCHEMA_VERSION, blobId);
  const cached = await env.BLOBS.get(key);
  if (cached) return (await cached.json()) as DiffNode;
  const tree = toTypedTree(bytes);
  await env.BLOBS.put(key, JSON.stringify(tree), { httpMetadata: { contentType: "application/json" } });
  return tree;
}

const createDocument: Handler = async ({ request, env, actor }) => {
  const body = await bodyOf(request);
  const path = str(body, "path");
  const markdown = str(body, "markdown");
  assertConceptId(path);
  if (await resolvePath(env, path)) throw new HttpError(409, "PATH_TAKEN", "path is already in use", { path });

  const bytes = encoder.encode(markdown);
  const declared = readMeta(bytes).arachaId;
  const documentId = isUuidv7(declared) ? declared : uuidv7();
  const stub = doc(env, documentId);
  if ((await stub.getState()).ok) {
    throw new HttpError(409, "DOCUMENT_EXISTS", "document id is already in use", { document_id: documentId });
  }
  const blobId = await storeBlob(env, bytes);
  const value = unwrap(
    await stub.commit({
      workspace_id: env.WORKSPACE_ID,
      document_id: documentId,
      operation_id: uuidv7(),
      actor_id: actor,
      kind: "import",
      base_revision_id: null,
      content_blob_id: blobId,
      path,
      attachments: [],
    }),
  );
  return Response.json({ document_id: documentId, revision_id: value.revision_id }, { status: 201 });
};

const getDocument: Handler = async ({ env, params: [id] }) => {
  const state = unwrap(await doc(env, id!).getState());
  const heads = await Promise.all(
    state.heads.map(async (h) => ({
      ...h,
      markdown: decoder.decode(await requireBlob(env, h.content_blob_id)),
    })),
  );
  return Response.json({ ...state, heads });
};

const autosave: Handler = async ({ request, env, actor, params: [id] }) => {
  const body = await bodyOf(request);
  const base = str(body, "base_revision_id");
  const markdown = str(body, "markdown");
  const stub = doc(env, id!);
  const baseRev = unwrap(await stub.getRevision(base));
  const blobId = await storeBlob(env, encoder.encode(markdown));
  const value = unwrap(
    await stub.commit({
      workspace_id: env.WORKSPACE_ID,
      document_id: id!,
      operation_id: operationId(body),
      actor_id: actor,
      kind: "autosave",
      base_revision_id: base,
      content_blob_id: blobId,
      path: baseRev.path,
      attachments: [],
    }),
  );
  return Response.json(value);
};

const restore: Handler = async ({ request, env, actor, params: [id] }) => {
  const body = await bodyOf(request);
  const value = unwrap(
    await doc(env, id!).restore({
      operation_id: operationId(body),
      actor_id: actor,
      target_revision_id: str(body, "revision_id"),
    }),
  );
  return Response.json(value);
};

const resolve: Handler = async ({ request, env, actor, params: [id] }) => {
  const body = await bodyOf(request);
  const markdown = str(body, "markdown");
  const stub = doc(env, id!);
  let path: string;
  if (body.path === undefined) {
    const state = unwrap(await stub.getState());
    path = state.heads.find((h) => h.revision_id === state.primary_head)!.path;
  } else {
    path = str(body, "path");
    assertConceptId(path);
  }
  const blobId = await storeBlob(env, encoder.encode(markdown));
  const value = unwrap(
    await stub.resolve({
      operation_id: operationId(body),
      actor_id: actor,
      content_blob_id: blobId,
      path,
      attachments: [],
    }),
  );
  return Response.json(value);
};

const revisionBytes: Handler = async ({ env, params: [id, rev] }) => {
  const revision = unwrap(await doc(env, id!).getRevision(rev!));
  const bytes = await requireBlob(env, revision.content_blob_id);
  return new Response(bytes, { headers: { "content-type": "text/markdown; charset=utf-8" } });
};

const diff: Handler = async ({ env, url, params: [id] }) => {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !to) throw new HttpError(400, "INVALID_INPUT", "from and to are required");
  const stub = doc(env, id!);
  const [a, b] = await Promise.all([stub.getRevision(from), stub.getRevision(to)]);
  const oldRev = unwrap(a);
  const newRev = unwrap(b);
  const oldBytes = await requireBlob(env, oldRev.content_blob_id);
  const newBytes = await requireBlob(env, newRev.content_blob_id);
  const oldTree = await typedTree(env, oldRev.content_blob_id!, oldBytes);
  const newTree = await typedTree(env, newRev.content_blob_id!, newBytes);
  const { events } = getCha().semanticDiff({ old: oldTree, new: newTree });
  return Response.json({ events, labels: labelEvents(oldTree, newTree, events) });
};

const coordinator = (env: Env, id: string) => env.OPERATION_COORDINATOR.getByName(id);

async function primaryHead(env: Env, documentId: string) {
  const state = unwrap((await doc(env, documentId).getState()) as Result<StateValue>);
  const head = state.heads.find((h) => h.revision_id === state.primary_head)!;
  return { state, head };
}

const rename: Handler = async ({ request, env, actor }) => {
  const body = await bodyOf(request);
  const documentId = str(body, "document_id");
  const newPath = str(body, "new_path");
  assertConceptId(newPath);
  let injectFailures: Record<string, number> | undefined;
  if (body.inject_failures !== undefined) {
    const f = body.inject_failures;
    const valid =
      f !== null && typeof f === "object" && !Array.isArray(f) && Object.values(f).every((n) => Number.isInteger(n));
    if (!valid) throw new HttpError(400, "INVALID_INPUT", "inject_failures must map document ids to counts");
    injectFailures = f as Record<string, number>;
  }
  const { head } = await primaryHead(env, documentId);
  if (head.path === newPath) throw new HttpError(400, "INVALID_PATH", "new_path equals the current path", { path: newPath });
  const taken = await resolvePath(env, newPath);
  if (taken && taken.document_id !== documentId) {
    throw new HttpError(409, "PATH_TAKEN", "path is already in use", { path: newPath, document_id: taken.document_id });
  }
  const opId = uuidv7();
  const value = unwrap(
    await coordinator(env, opId).startRename({
      operation_id: opId,
      workspace_id: env.WORKSPACE_ID,
      actor_id: actor,
      document_id: documentId,
      new_path: newPath,
      inject_failures: injectFailures,
    }),
  );
  return Response.json(value, { status: 202 });
};

const cleanupAlias: Handler = async ({ request, env, actor }) => {
  const body = await bodyOf(request);
  const documentId = str(body, "document_id");
  const alias = str(body, "alias");
  const { state, head } = await primaryHead(env, documentId);
  if (state.conflicted) throw new HttpError(409, "CONFLICTED", "document has several heads", { document_id: documentId });
  const bytes = await requireBlob(env, head.content_blob_id);
  const meta = readMeta(bytes);
  if (!meta.aliases.includes(alias)) throw new HttpError(404, "NOT_FOUND", "alias not found on document", { alias });
  const referrers = await edgeSources(env, alias);
  if (referrers.length > 0) {
    throw new HttpError(409, "ALIAS_IN_USE", "documents still link to the alias", { alias, document_ids: referrers });
  }
  const next = writeArachaMeta(bytes, { id: documentId, aliases: meta.aliases.filter((a) => a !== alias) });
  const value = unwrap(
    await doc(env, documentId).commit({
      workspace_id: env.WORKSPACE_ID,
      document_id: documentId,
      operation_id: uuidv7(),
      actor_id: actor,
      kind: "rename",
      base_revision_id: head.revision_id,
      content_blob_id: await storeBlob(env, next),
      path: head.path,
      attachments: [],
      require_head: true,
    }),
  );
  return Response.json(value);
};

const routes: Route[] = [];
const route = (method: string, path: string, handler: Handler) =>
  routes.push({ method, pattern: new RegExp(`^${path.replace(/:\w+/g, "([^/]+)")}$`), handler });

route("POST", "/api/documents", createDocument);
route("GET", "/api/documents", async ({ env }) => Response.json(await listDocuments(env)));
route("GET", "/api/documents/by-path", async ({ env, url }) => {
  const path = url.searchParams.get("path");
  if (!path) throw new HttpError(400, "INVALID_INPUT", "path is required");
  const found = await resolvePath(env, path);
  if (!found) throw new HttpError(404, "NOT_FOUND", "no document at path", { path });
  return Response.json(found);
});
route("GET", "/api/documents/:id", getDocument);
route("PUT", "/api/documents/:id/autosave", autosave);
route("POST", "/api/documents/:id/close-change", async ({ env, params: [id] }) =>
  Response.json(unwrap(await doc(env, id!).closeChange())),
);
route("GET", "/api/documents/:id/history", async ({ env, params: [id] }) =>
  Response.json(unwrap(await doc(env, id!).getHistory())),
);
route("GET", "/api/documents/:id/revisions/:rev", revisionBytes);
route("GET", "/api/documents/:id/diff", diff);
route("POST", "/api/documents/:id/restore", restore);
route("POST", "/api/documents/:id/resolve", resolve);
route("GET", "/api/documents/:id/backlinks", async ({ env, params: [id] }) =>
  Response.json(await backlinks(env, id!)),
);
route("GET", "/api/graph", async ({ env }) => Response.json(await graph(env)));
route("GET", "/api/search", async ({ env, url }) => Response.json(await search(env, url.searchParams.get("q") ?? "")));
route("POST", "/api/rename", rename);
route("GET", "/api/operations/:id", async ({ env, params: [id] }) =>
  Response.json(unwrap(await coordinator(env, id!).getStatus())),
);
route("POST", "/api/operations/:id/retry", async ({ env, params: [id] }) =>
  Response.json(unwrap(await coordinator(env, id!).retry())),
);
route("POST", "/api/aliases/cleanup", cleanupAlias);
route("GET", "/api/export", async ({ env }) => exportTar(env));

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const actor = request.headers.get("Cf-Access-Authenticated-User-Email") ?? "dev";
  let pathMatched = false;
  for (const r of routes) {
    const m = r.pattern.exec(url.pathname);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== request.method) continue;
    try {
      return await r.handler({ request, env, url, params: m.slice(1).map(decodeURIComponent), actor });
    } catch (e) {
      if (e instanceof HttpError) {
        return Response.json({ code: e.code, message: e.message, context: e.context }, { status: e.status });
      }
      if (isChaError(e)) return errorResponse({ code: e.code, message: e.message, context: e.context });
      throw e;
    }
  }
  if (pathMatched) return Response.json({ code: "METHOD_NOT_ALLOWED", message: "method not allowed", context: {} }, { status: 405 });
  return Response.json({ code: "NOT_FOUND", message: "no such route", context: {} }, { status: 404 });
}
