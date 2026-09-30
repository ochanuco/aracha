import { api, ApiError, NetworkError } from "./api.js";
import { drafts } from "./drafts.js";
import { uuidv7 } from "./uuid.js";

const DEBOUNCE_MS = 1000;
const MAX_WAIT_MS = 10000;
const RETRY_MS = 5000;

// States (derived from fields, no single enum):
//   idle      : !dirty && !inFlight
//   waiting   : dirty, debounce/max timers armed
//   sending   : inFlight (at most one request; newer text stays dirty and is
//               sent right after the response)
//   failed    : dirty, !inFlight, retry timer armed, `payload` retained so the
//               retry reuses the same operation_id
//   disabled  : conflict view; nothing is sent
export class Autosaver {
  constructor({ documentId, baseRevisionId, onStatus, onBase, onConflict }) {
    this.documentId = documentId;
    this.base = baseRevisionId;
    this.onStatus = onStatus;
    this.onBase = onBase;
    this.onConflict = onConflict;
    this.latest = null;
    this.dirty = false;
    this.inFlight = false;
    this.disabled = false;
    this.payload = null;
    this.debounceT = null;
    this.maxT = null;
    this.retryT = null;
    this.waiters = [];
  }

  setText(text) {
    if (this.disabled) return;
    this.latest = text;
    this.dirty = true;
    clearTimeout(this.debounceT);
    this.debounceT = setTimeout(() => this.flush(), DEBOUNCE_MS);
    if (!this.maxT) this.maxT = setTimeout(() => this.flush(), MAX_WAIT_MS);
    if (!this.inFlight) this.onStatus("unsaved", "unsaved changes");
  }

  disable() {
    this.disabled = true;
    this.#clearTimers();
    this.#settle();
  }

  destroy() {
    this.disable();
  }

  #clearTimers() {
    clearTimeout(this.debounceT);
    clearTimeout(this.maxT);
    clearTimeout(this.retryT);
    this.debounceT = this.maxT = this.retryT = null;
  }

  #settle() {
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
  }

  // Sends now if dirty and nothing is in flight.
  flush() {
    clearTimeout(this.debounceT);
    clearTimeout(this.maxT);
    clearTimeout(this.retryT);
    this.debounceT = this.maxT = this.retryT = null;
    if (this.disabled || this.inFlight) return;
    if (!this.dirty) { this.#settle(); return; }
    this.#send();
  }

  // Resolves once there is nothing left to send or sending has failed/stopped.
  // Returns true when all text is saved.
  async flushAndWait() {
    this.flush();
    if (this.dirty || this.inFlight) await new Promise((r) => this.waiters.push(r));
    return !this.dirty;
  }

  #buildPayload() {
    const p = this.payload;
    if (p && p.markdown === this.latest && p.base_revision_id === this.base) return p;
    this.payload = {
      operation_id: uuidv7(),
      base_revision_id: this.base,
      markdown: this.latest,
    };
    return this.payload;
  }

  async #send() {
    const p = this.#buildPayload();
    this.inFlight = true;
    this.onStatus("saving", "saving…");
    await drafts.put({ document_id: this.documentId, ...p });
    let res;
    try {
      res = await api.autosave(this.documentId, p);
    } catch (e) {
      this.inFlight = false;
      if (e instanceof NetworkError) this.onStatus("offline", "offline — draft kept");
      else this.onStatus("error", `save failed: ${e instanceof ApiError ? e.message : e}`);
      this.retryT = setTimeout(() => this.flush(), RETRY_MS);
      this.#settle();
      return;
    }
    this.inFlight = false;
    this.payload = null;
    this.base = res.revision_id;
    this.onBase(res.revision_id);
    if (res.conflicted) {
      this.disabled = true;
      this.#clearTimers();
      drafts.delete(this.documentId);
      this.#settle();
      this.onConflict();
      return;
    }
    if (this.latest === p.markdown) {
      this.dirty = false;
      drafts.delete(this.documentId);
      this.onStatus("saved", "saved");
      this.#settle();
    } else {
      this.flush();
    }
  }

  // Page leave: fire the pending payload with keepalive.
  sendKeepalive() {
    if (this.disabled || !this.dirty || this.inFlight) return;
    const p = this.#buildPayload();
    api.autosave(this.documentId, p, { keepalive: true }).catch(() => {});
  }
}

// Replays a leftover draft exactly once with its original operation_id.
// Returns { outcome: "none" | "replayed" | "conflict" | "offline" | "error" | "rejected", markdown? }.
// A rejected draft stays in IndexedDB and its text is handed back so the editor can show it.
export async function replayDraft(documentId) {
  const rec = await drafts.get(documentId);
  if (!rec) return { outcome: "none" };
  try {
    const res = await api.autosave(documentId, {
      operation_id: rec.operation_id,
      base_revision_id: rec.base_revision_id,
      markdown: rec.markdown,
    });
    await drafts.delete(documentId);
    return { outcome: res.conflicted ? "conflict" : "replayed" };
  } catch (e) {
    if (e instanceof NetworkError) return { outcome: "offline" };
    if (e instanceof ApiError && e.status >= 500) return { outcome: "error" };
    return { outcome: "rejected", markdown: rec.markdown };
  }
}
