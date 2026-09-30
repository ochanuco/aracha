import { api } from "./api.js";
import { uuidv7 } from "./uuid.js";
import { h, clear, errText } from "./dom.js";

export function renderConflict(el, doc, primaryText, onResolved) {
  clear(el);
  const heads = h("div", { class: "heads" }, doc.heads.map((hd) =>
    h("div", {},
      h("div", { class: "muted" }, `${hd.revision_id}${hd.path ? ` · ${hd.path}` : ""}`),
      h("pre", {}, hd.markdown))));
  const ta = h("textarea", { "aria-label": "Resolution" });
  ta.value = primaryText;
  const msg = h("p", { class: "error", hidden: true });
  const btn = h("button", { type: "button" }, "Resolve");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    msg.hidden = true;
    try {
      await api.resolve(doc.document_id, uuidv7(), ta.value);
      await onResolved();
    } catch (e) {
      msg.textContent = errText(e);
      msg.hidden = false;
      btn.disabled = false;
    }
  });
  el.append(h("h2", {}, "Conflict: multiple heads"), heads,
    h("h2", {}, "Resolution"), ta, h("p", {}, btn), msg);
}
