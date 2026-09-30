import { api } from "./api.js";
import { uuidv7 } from "./uuid.js";
import { h, clear, errText } from "./dom.js";

const when = (ms) => (ms ? new Date(ms).toLocaleString() : "?");

const short = (id) => String(id).slice(0, 8);

function groupRevisions(revs) {
  // consecutive autosaves collapse into one group; other kinds stay single
  const out = [];
  for (const r of revs) {
    const last = out[out.length - 1];
    if (r.kind === "autosave" && last && last.autosave) last.items.push(r);
    else out.push({ autosave: r.kind === "autosave", items: [r] });
  }
  return out;
}

export async function renderHistory(el, ctx) {
  clear(el).append(h("p", { class: "muted" }, "Loading…"));
  if (!ctx.docId()) { clear(el).append(h("p", { class: "muted" }, "Open a document.")); return; }
  const docId = ctx.docId();
  let changes;
  try {
    changes = await api.history(docId);
  } catch (e) {
    clear(el).append(h("p", { class: "error" }, errText(e)));
    return;
  }
  if (docId !== ctx.docId()) return;
  clear(el);
  if (!changes.length) el.append(h("p", { class: "muted" }, "No history yet."));
  for (const ch of changes) {
    const box = h("div", { class: "change" },
      h("div", {}, ch.description || "(no description)"),
      h("div", { class: "meta" }, `${ch.state} · opened ${when(ch.opened_at)}${ch.closed_at ? ` · closed ${when(ch.closed_at)}` : ""}`));
    for (const g of groupRevisions(ch.revisions || [])) {
      if (g.autosave && g.items.length > 1) {
        const d = h("details", {}, h("summary", {}, `${g.items.length} autosaves`));
        for (const r of g.items) d.append(revRow(r, docId, ctx));
        box.append(d);
      } else {
        for (const r of g.items) box.append(revRow(r, docId, ctx));
      }
    }
    el.append(box);
  }
}

function revRow(rev, docId, ctx) {
  const out = h("div", { class: "diff-out", hidden: true });
  const diffBtn = h("button", { type: "button" }, "Diff");
  diffBtn.addEventListener("click", async () => {
    if (!out.hidden) { out.hidden = true; return; }
    const parent = (rev.parents || [])[0];
    out.hidden = false;
    if (!parent) { clear(out).append("No parent revision to diff against."); return; }
    clear(out).append("Loading…");
    try {
      renderDiff(out, await api.diff(docId, parent, rev.revision_id));
    } catch (e) {
      clear(out).append(h("span", { class: "error" }, errText(e)));
    }
  });
  const restoreBtn = h("button", { type: "button" }, "Restore");
  restoreBtn.addEventListener("click", async () => {
    if (!confirm(`Restore revision ${short(rev.revision_id)}?`)) return;
    try {
      await ctx.settleEdits();
      await api.closeChange(docId);
      await api.restore(docId, uuidv7(), rev.revision_id);
      await ctx.reload();
    } catch (e) {
      alert(`Restore failed: ${errText(e)}`);
    }
  });
  return h("div", {},
    h("div", { class: "rev" },
      h("code", { title: rev.revision_id }, short(rev.revision_id)),
      h("span", { class: "muted" }, `${rev.kind} · ${when(rev.created_at)}`),
      diffBtn, restoreBtn),
    out);
}

function renderDiff(out, diff) {
  clear(out);
  const labels = diff.labels || [];
  if (!labels.length) out.append(h("p", { class: "muted" }, "No labelled changes."));
  const byCat = new Map();
  for (const l of labels) {
    if (!byCat.has(l.category)) byCat.set(l.category, []);
    byCat.get(l.category).push(l);
  }
  for (const [cat, items] of byCat) {
    out.append(h("h4", {}, cat),
      h("ul", {}, items.map((l) => h("li", {}, `${l.change}: ${l.summary}`))));
  }
  out.append(h("details", {}, h("summary", {}, "raw events"),
    h("pre", {}, JSON.stringify(diff.events, null, 2))));
}
