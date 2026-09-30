import type { DiffEvent, DiffNode, Json } from "./cha/port";

export type DiffCategory =
  | "heading"
  | "paragraph"
  | "link"
  | "metadata"
  | "list_item"
  | "code_block"
  | "section"
  | "other";
export type DiffChange = "added" | "removed" | "modified";
export type DiffLabel = { category: DiffCategory; change: DiffChange; summary: string; event_index: number };

const CATEGORY: Record<string, DiffCategory> = {
  heading: "heading",
  paragraph: "paragraph",
  link: "link",
  frontmatter: "metadata",
  metadata: "metadata",
  list_item: "list_item",
  code_block: "code_block",
  section: "section",
};

const categoryOf = (kind: string): DiffCategory => CATEGORY[kind] ?? "other";

function nodeAt(root: DiffNode, path: number[]): DiffNode | null {
  let node: DiffNode | undefined = root;
  for (const i of path) {
    node = node?.children?.[i];
    if (!node) return null;
  }
  return node;
}

const same = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

const show = (v: Json | undefined) => (typeof v === "string" ? v : JSON.stringify(v ?? null));

const clip = (s: string) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 60 ? `${one.slice(0, 57)}...` : one;
};

function describe(node: DiffNode | null, kind: string): string {
  const key = node?.attributes?.key;
  if (kind === "metadata" && typeof key === "string") return `metadata "${key}"`;
  const text = node?.text ? clip(node.text) : "";
  return text ? `${kind} "${text}"` : kind;
}

export function labelEvents(oldTree: DiffNode, newTree: DiffNode, events: DiffEvent[]): DiffLabel[] {
  const labels: DiffLabel[] = [];
  events.forEach((e, event_index) => {
    switch (e.type) {
      case "ChildAdded":
      case "ChildRemoved":
        return;
      case "NodeAdded": {
        const node = nodeAt(newTree, e.path);
        labels.push({
          category: categoryOf(e.kind),
          change: "added",
          summary: `${describe(node, e.kind)} added`,
          event_index,
        });
        return;
      }
      case "NodeRemoved": {
        const node = nodeAt(oldTree, e.path);
        labels.push({
          category: categoryOf(e.kind),
          change: "removed",
          summary: `${describe(node, e.kind)} removed`,
          event_index,
        });
        return;
      }
      case "NodeModified": {
        const refined = events
          .slice(event_index + 1)
          .some(
            (f) =>
              (f.type === "TextChanged" || f.type === "AttributeChanged") &&
              same(f.old_path, e.old_path) &&
              same(f.new_path, e.new_path),
          );
        if (refined) return;
        const node = nodeAt(newTree, e.new_path);
        labels.push({
          category: categoryOf(e.kind),
          change: "modified",
          summary: `${describe(node, e.kind)} modified`,
          event_index,
        });
        return;
      }
      case "AttributeChanged": {
        const node = nodeAt(newTree, e.new_path) ?? nodeAt(oldTree, e.old_path);
        const kind = node?.kind ?? "other";
        const summary =
          kind === "link" && e.name === "target"
            ? `link target changed: ${show(e.old_value)} → ${show(e.new_value)}`
            : `${kind} ${e.name} changed: ${show(e.old_value)} → ${show(e.new_value)}`;
        labels.push({ category: categoryOf(kind), change: "modified", summary, event_index });
        return;
      }
      case "TextChanged": {
        const node = nodeAt(newTree, e.new_path) ?? nodeAt(oldTree, e.old_path);
        const kind = node?.kind ?? "other";
        labels.push({
          category: categoryOf(kind),
          change: "modified",
          summary: `${kind} text changed: ${clip(e.old_text ?? "")} → ${clip(e.new_text ?? "")}`,
          event_index,
        });
        return;
      }
    }
  });
  return labels;
}
