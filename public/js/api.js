// The only module that calls fetch.

export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.message) || `HTTP ${status}`);
    this.status = status;
    this.code = body && body.code;
    this.context = body && body.context;
  }
}

export class NetworkError extends Error {}

async function request(method, path, { body, text, keepalive } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      keepalive: keepalive || undefined,
    });
  } catch (e) {
    throw new NetworkError(e && e.message ? e.message : "network error");
  }
  if (!res.ok) {
    let parsed = null;
    try { parsed = await res.json(); } catch { /* non-JSON error body */ }
    throw new ApiError(res.status, parsed);
  }
  if (text) return res.text();
  if (res.status === 204) return null;
  const raw = await res.text();
  return raw ? JSON.parse(raw) : null;
}

const enc = encodeURIComponent;
const doc = (id) => `/api/documents/${enc(id)}`;

export const api = {
  listDocuments: () => request("GET", "/api/documents"),
  createDocument: (path, markdown) => request("POST", "/api/documents", { body: { path, markdown } }),
  getDocument: (id) => request("GET", doc(id)),
  autosave: (id, payload, opts = {}) =>
    request("PUT", `${doc(id)}/autosave`, { body: payload, keepalive: opts.keepalive }),
  closeChange: (id) => request("POST", `${doc(id)}/close-change`),
  closeChangeBeaconUrl: (id) => `${doc(id)}/close-change`,
  history: (id) => request("GET", `${doc(id)}/history`),
  revisionText: (id, rev) => request("GET", `${doc(id)}/revisions/${enc(rev)}`, { text: true }),
  diff: (id, from, to) => request("GET", `${doc(id)}/diff?from=${enc(from)}&to=${enc(to)}`),
  restore: (id, operation_id, revision_id) =>
    request("POST", `${doc(id)}/restore`, { body: { operation_id, revision_id } }),
  resolve: (id, operation_id, markdown) =>
    request("POST", `${doc(id)}/resolve`, { body: { operation_id, markdown } }),
  backlinks: (id) => request("GET", `${doc(id)}/backlinks`),
  search: (q) => request("GET", `/api/search?q=${enc(q)}`),
  rename: (body) => request("POST", "/api/rename", { body }),
  operation: (id) => request("GET", `/api/operations/${enc(id)}`),
  retryOperation: (id) => request("POST", `/api/operations/${enc(id)}/retry`),
  cleanupAlias: (document_id, alias) => request("POST", "/api/aliases/cleanup", { body: { document_id, alias } }),
};
