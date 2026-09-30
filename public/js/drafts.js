// IndexedDB `aracha` / `drafts`, keyed by document_id. Holds only the latest
// unsent payload: { document_id, base_revision_id, markdown, operation_id }.

let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open("aracha", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("drafts", { keyPath: "document_id" });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      } catch (e) {
        reject(e);
      }
    });
  }
  return dbPromise;
}

async function run(mode, fn) {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("drafts", mode);
      const req = fn(tx.objectStore("drafts"));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } catch {
    return undefined; // IndexedDB unavailable: autosave still works, offline safety does not
  }
}

export const drafts = {
  get: (id) => run("readonly", (s) => s.get(id)),
  put: (rec) => run("readwrite", (s) => s.put({
    document_id: rec.document_id,
    base_revision_id: rec.base_revision_id,
    markdown: rec.markdown,
    operation_id: rec.operation_id,
  })),
  delete: (id) => run("readwrite", (s) => s.delete(id)),
};
