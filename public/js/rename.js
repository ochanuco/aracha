import { api } from "./api.js";
import { h, clear, errText } from "./dom.js";

let pollToken = 0;

export function stopRenamePolling() {
  pollToken++;
}

export function renderRename(el, ctx) {
  const docId = ctx.docId();
  clear(el);
  if (!docId) { el.append(h("p", { class: "muted" }, "Open a document.")); return; }

  const newPath = h("input", { type: "text", placeholder: "new path", "aria-label": "New path" });
  const inject = h("textarea", { rows: 3, placeholder: '{"document_id": 1}', "aria-label": "Inject failures (JSON)" });
  const btn = h("button", { type: "button" }, "Rename");
  const msg = h("p", { class: "error", hidden: true });
  const opBox = h("div", {});

  btn.addEventListener("click", async () => {
    msg.hidden = true;
    const body = { document_id: docId, new_path: newPath.value.trim() };
    if (!body.new_path) { showErr(msg, "Enter a new path."); return; }
    const raw = inject.value.trim();
    if (raw) {
      try { body.inject_failures = JSON.parse(raw); } catch { showErr(msg, "inject failures is not valid JSON."); return; }
    }
    try {
      await ctx.settleEdits();
      await api.closeChange(docId);
      const op = await api.rename(body);
      poll(op.operation_id, opBox, ctx);
    } catch (e) {
      showErr(msg, errText(e));
    }
  });

  const alias = h("input", { type: "text", placeholder: "old path (alias)", "aria-label": "Alias" });
  const aliasMsg = h("p", { hidden: true });
  const aliasBtn = h("button", { type: "button" }, "Clean up alias");
  aliasBtn.addEventListener("click", async () => {
    aliasMsg.hidden = true;
    try {
      await api.cleanupAlias(docId, alias.value.trim());
      aliasMsg.className = "muted";
      aliasMsg.textContent = "Alias removed.";
    } catch (e) {
      aliasMsg.className = "error";
      aliasMsg.textContent = errText(e);
    }
    aliasMsg.hidden = false;
  });

  el.append(
    h("div", { class: "stack" },
      h("h2", {}, "Rename"), newPath,
      h("label", { class: "muted" }, "inject failures (optional JSON {document_id: count})"), inject,
      btn, msg),
    opBox,
    h("div", { class: "stack" }, h("h2", {}, "Alias cleanup"), alias, aliasBtn, aliasMsg));
}

function showErr(el, text) {
  el.textContent = text;
  el.hidden = false;
}

async function poll(opId, box, ctx) {
  const token = ++pollToken;
  while (token === pollToken) {
    let op;
    try {
      op = await api.operation(opId);
    } catch (e) {
      if (token !== pollToken) return;
      clear(box).append(h("p", { class: "error" }, `status unavailable: ${errText(e)}`));
      await sleep(1000);
      continue;
    }
    if (token !== pollToken) return;
    renderOp(box, op, async () => {
      try {
        renderOp(box, await api.retryOperation(opId), null);
      } catch (e) {
        box.append(h("p", { class: "error" }, errText(e)));
      }
      poll(opId, box, ctx);
    });
    if (op.status === "completed") {
      ctx.refreshList();
      ctx.reload();
      return;
    }
    await sleep(1000);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function renderOp(box, op, onRetry) {
  clear(box).append(
    h("h2", {}, `Operation ${String(op.operation_id).slice(0, 8)}: ${op.status}`),
    h("p", { class: "muted" }, `${op.kind} · attempts ${op.attempts}`),
    h("table", {},
      h("thead", {}, h("tr", {}, ["document", "role", "status", "attempts", "revision", "last error"].map((c) => h("th", {}, c)))),
      h("tbody", {}, (op.targets || []).map((t) => h("tr", {},
        [t.document_id, t.role, t.status, t.attempts, t.revision_id ?? "", t.last_error ?? ""]
          .map((c) => h("td", {}, c)))))));
  if (op.status === "partially_applied" && onRetry) {
    box.append(h("button", { type: "button", onclick: onRetry }, "Retry"));
  }
}
