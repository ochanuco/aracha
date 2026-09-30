import { describe, expect, it } from "vitest";
import type { DiffEvent, DiffNode } from "../src/cha/port";
import { labelEvents } from "../src/diff-labels";

const n = (kind: string, over: Partial<DiffNode> = {}): DiffNode => ({ kind, ...over });

const oldTree = n("document", {
  children: [
    n("frontmatter", { children: [n("metadata", { attributes: { key: "title" }, text: '"A"' })] }),
    n("section", { children: [n("heading", { text: "Old head" }), n("paragraph", { text: "gone", children: [] })] }),
    n("paragraph", { text: "see", children: [n("link", { attributes: { target: "a/b" }, text: "b" })] }),
  ],
});
const newTree = n("document", {
  children: [
    n("frontmatter", { children: [n("metadata", { attributes: { key: "title" }, text: '"B"' })] }),
    n("section", { children: [n("heading", { text: "New head" }), n("list_item", { text: "fresh" })] }),
    n("paragraph", { text: "see", children: [n("link", { attributes: { target: "a/c" }, text: "c" })] }),
    n("code_block", { text: "x" }),
  ],
});

describe("labelEvents", () => {
  it("maps kinds to categories and change types", () => {
    const events: DiffEvent[] = [
      { type: "NodeAdded", path: [3], kind: "code_block" },
      { type: "NodeRemoved", path: [1, 1], kind: "paragraph" },
      { type: "NodeAdded", path: [1, 1], kind: "list_item" },
      { type: "NodeAdded", path: [1], kind: "section" },
      { type: "NodeAdded", path: [4], kind: "list" },
    ];
    const labels = labelEvents(oldTree, newTree, events);
    expect(labels.map((l) => [l.category, l.change, l.event_index])).toEqual([
      ["code_block", "added", 0],
      ["paragraph", "removed", 1],
      ["list_item", "added", 2],
      ["section", "added", 3],
      ["other", "added", 4],
    ]);
    expect(labels[1]!.summary).toContain("gone");
  });

  it("looks removals up in the old tree and falls back to the event kind", () => {
    const labels = labelEvents(oldTree, newTree, [{ type: "NodeRemoved", path: [2, 0], kind: "link" }]);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({ category: "link", change: "removed" });
  });

  it("uses one metadata category for frontmatter and metadata nodes", () => {
    const labels = labelEvents(oldTree, newTree, [
      { type: "NodeModified", old_path: [0], new_path: [0], kind: "frontmatter" },
      { type: "NodeModified", old_path: [0, 0], new_path: [0, 0], kind: "metadata" },
    ]);
    expect(labels.map((l) => l.category)).toEqual(["metadata", "metadata"]);
    expect(labels[1]!.summary).toContain("title");
  });

  it("skips NodeModified refined by a TextChanged or AttributeChanged, and Child events", () => {
    const events: DiffEvent[] = [
      { type: "NodeModified", old_path: [1, 0], new_path: [1, 0], kind: "heading" },
      { type: "TextChanged", old_path: [1, 0], new_path: [1, 0], old_text: "Old head", new_text: "New head" },
      { type: "ChildAdded", parent_old_path: [1], parent_new_path: [1], index: 1, kind: "list_item" },
      { type: "ChildRemoved", parent_old_path: [1], parent_new_path: [1], index: 1, kind: "paragraph" },
      { type: "NodeModified", old_path: [0, 0], new_path: [0, 0], kind: "metadata" },
    ];
    const labels = labelEvents(oldTree, newTree, events);
    expect(labels.map((l) => [l.category, l.event_index])).toEqual([
      ["heading", 1],
      ["metadata", 4],
    ]);
    expect(labels[0]!.summary).toContain("Old head");
    expect(labels[0]!.summary).toContain("New head");
  });

  it("describes a link target change", () => {
    const events: DiffEvent[] = [
      { type: "NodeModified", old_path: [2, 0], new_path: [2, 0], kind: "link" },
      { type: "AttributeChanged", old_path: [2, 0], new_path: [2, 0], name: "target", old_value: "a/b", new_value: "a/c" },
    ];
    const labels = labelEvents(oldTree, newTree, events);
    expect(labels).toEqual([
      { category: "link", change: "modified", summary: "link target changed: a/b → a/c", event_index: 1 },
    ]);
  });
});
