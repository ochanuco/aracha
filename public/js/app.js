import { api, ApiError } from "./api.js";
import { Autosaver, replayDraft } from "./autosave.js";
import { drafts } from "./drafts.js";
import { h, clear, errText } from "./dom.js";
import { renderHistory } from "./history.js";
import { renderBacklinks } from "./backlinks.js";
import { renderRename, stopRenamePolling } from "./rename.js";
import { renderConflict } from "./conflict.js";

const $ = (id) => document.getElementById(id);
const editor = $("editor");
const statusEl = $("save-status");
const conflictView = $("conflict-view");

let currentId = null;
let autosaver = null;
let activeTab = "history";
let listQuery = "";
let openSeq = 0;

function setStatus(kind, text) {
  statusEl.className = `status ${kind}`;
  statusEl.textContent = text;
}

// ---- document list / search ----

async function refreshList() {
  try {
    const docs = listQuery ? await api.search(listQuery) : await api.listDocuments();
    const ul = clear($("doc-list"));
    for (const d of docs) {
      ul.append(h("li", {
        class: d.document_id === currentId ? "active" : "",
        onclick: () => openDocument(d.document_id),
      }, d.title || d.path,
      d.conflicted ? " (conflicted)" : "",
      h("div", { class: "type" }, d.path)));
    }
    if (!docs.length) ul.append(h("li", { class: "type" }, "No documents"));
  } catch (e) {
    clear($("doc-list")).append(h("li", { class: "error" }, errText(e)));
  }
}

let searchT = null;
$("search").addEventListener("input", (ev) => {
  clearTimeout(searchT);
  searchT = setTimeout(() => {
    listQuery = ev.target.value.trim();
    refreshList();
  }, 300);
});

$("new-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const err = $("new-error");
  err.hidden = true;
  const path = $("new-path").value.trim();
  if (!path) return;
  const base = path.split("/").pop().replace(/\.md$/, "");
  try {
    const res = await api.createDocument(path, `---\ntype: note\ntitle: ${JSON.stringify(base)}\n---\n# ${base}\n`);
    $("new-path").value = "";
    await refreshList();
    await openDocument(res.document_id);
  } catch (e) {
    err.textContent = e instanceof ApiError && e.code === "PATH_TAKEN" ? `Path already taken: ${path}` : errText(e);
    err.hidden = false;
  }
});

// ---- document open / reload ----

function primaryHead(doc) {
  const p = doc.primary_head;
  const id = p && typeof p === "object" ? p.revision_id : p;
  return doc.heads.find((x) => x.revision_id === id) || doc.heads[0];
}

async function openDocument(id) {
  const seq = ++openSeq;
  if (autosaver) { await autosaver.flushAndWait(); }
  if (seq !== openSeq) return;
  currentId = id;
  stopRenamePolling();
  await loadDocument(seq);
  refreshList();
}

async function loadDocument(seq = ++openSeq) {
  if (autosaver) { autosaver.destroy(); autosaver = null; }
  const id = currentId;
  if (!id) return;
  let doc;
  let rejectedDraft = null;
  try {
    doc = await api.getDocument(id);
    if (seq !== openSeq) return;
    if (!doc.conflicted) {
      const { outcome, markdown } = await replayDraft(id);
      if (outcome === "rejected") rejectedDraft = markdown;
      if (seq !== openSeq) return;
      if (outcome === "offline") setStatus("offline", "offline — draft kept");
      if (outcome === "replayed" || outcome === "conflict") {
        doc = await api.getDocument(id);
        if (seq !== openSeq) return;
      }
    }
  } catch (e) {
    setStatus("error", `load failed: ${errText(e)}`);
    return;
  }
  showDocument(doc);
  if (rejectedDraft !== null && autosaver) {
    editor.value = rejectedDraft;
    autosaver.setText(rejectedDraft);
  }
}

function showDocument(doc) {
  const head = primaryHead(doc);
  $("doc-path").textContent = head.path || doc.document_id;
  $("conflict-badge").hidden = !doc.conflicted;
  if (doc.conflicted) {
    editor.value = head.markdown;
    editor.readOnly = true;
    editor.hidden = true;
    editor.disabled = false;
    conflictView.hidden = false;
    renderConflict(conflictView, doc, head.markdown, () => loadDocument());
    setStatus("error", "conflicted — resolve to continue editing");
  } else {
    conflictView.hidden = true;
    editor.hidden = false;
    editor.readOnly = false;
    editor.disabled = false;
    editor.value = head.markdown;
    setStatus("", statusEl.classList.contains("offline") ? statusEl.textContent : "");
    autosaver = new Autosaver({
      documentId: doc.document_id,
      baseRevisionId: head.revision_id,
      onStatus: setStatus,
      onBase: () => {},
      onConflict: () => loadDocument(),
    });
  }
  renderTab();
}

editor.addEventListener("input", () => {
  if (autosaver) autosaver.setText(editor.value);
});

// ---- tabs ----

const ctx = {
  docId: () => currentId,
  open: (id) => openDocument(id),
  reload: () => loadDocument(),
  refreshList,
  // Sends any unsaved text; rejects if it could not be saved, so restore/rename
  // never run against a stale server state.
  async settleEdits() {
    if (autosaver && !(await autosaver.flushAndWait())) throw new Error("unsaved changes could not be saved");
  },
};

function renderTab() {
  for (const name of ["history", "backlinks", "rename"]) $(`tab-${name}`).hidden = name !== activeTab;
  const el = $(`tab-${activeTab}`);
  if (activeTab === "history") renderHistory(el, ctx);
  else if (activeTab === "backlinks") renderBacklinks(el, ctx);
  else if (!el.firstChild || el.dataset.doc !== currentId) {
    el.dataset.doc = currentId || "";
    renderRename(el, ctx);
  }
}

document.querySelectorAll(".tabs button").forEach((b) => {
  b.addEventListener("click", () => {
    activeTab = b.dataset.tab;
    document.querySelectorAll(".tabs button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    renderTab();
  });
});

// ---- offline / page leave ----

window.addEventListener("online", async () => {
  if (!currentId) return;
  if (autosaver && autosaver.dirty) { autosaver.flush(); return; }
  if (autosaver && (await drafts.get(currentId))) await loadDocument();
});

window.addEventListener("pagehide", () => {
  if (!currentId) return;
  if (autosaver) autosaver.sendKeepalive();
  navigator.sendBeacon(api.closeChangeBeaconUrl(currentId));
});

refreshList();
