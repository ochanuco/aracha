import { api } from "./api.js";
import { h, clear, errText } from "./dom.js";

export async function renderBacklinks(el, ctx) {
  const docId = ctx.docId();
  if (!docId) { clear(el).append(h("p", { class: "muted" }, "Open a document.")); return; }
  clear(el).append(h("p", { class: "muted" }, "Loading…"));
  try {
    const links = await api.backlinks(docId);
    if (docId !== ctx.docId()) return;
    clear(el);
    if (!links.length) el.append(h("p", { class: "muted" }, "No backlinks."));
    const ul = h("ul", { class: "doc-list" });
    for (const l of links) {
      ul.append(h("li", { onclick: () => ctx.open(l.document_id) }, l.title || l.path,
        h("div", { class: "type" }, l.path)));
    }
    el.append(ul);
  } catch (e) {
    clear(el).append(h("p", { class: "error" }, errText(e)));
  }
}
