import { describe, expect, it } from "vitest";
import { IR_SCHEMA_VERSION, PARSER_VERSION, toTypedTree } from "../../src/okf";

const enc = (s: string) => new TextEncoder().encode(s);

const DOC = `---
type: concept
tags: [a, b]
zeta: 1
alpha: true
---
intro

# One

para [link](/x.md) text

## Sub

- item 1
- item 2

\`\`\`ts
code
\`\`\`

# Two
`;

describe("toTypedTree", () => {
  it("builds the expected shape", () => {
    const t = toTypedTree(enc(DOC));
    expect(t.kind).toBe("document");
    const [fm, intro, one, two] = t.children;
    expect(fm!.kind).toBe("frontmatter");
    expect(fm!.children.map((c) => c.attributes.key)).toEqual(["type", "tags", "zeta", "alpha"]);
    expect(fm!.children[0]).toEqual({
      kind: "metadata",
      attributes: { key: "type" },
      text: '"concept"',
      children: [],
    });
    expect(fm!.children[1]!.text).toBe('["a","b"]');
    expect(intro!.kind).toBe("paragraph");
    expect(intro!.text).toBe("intro");

    expect(one!.kind).toBe("section");
    expect(one!.children[0]).toMatchObject({ kind: "heading", attributes: { level: 1 }, text: "One" });
    const para = one!.children[1]!;
    expect(para).toMatchObject({ kind: "paragraph", text: "para link text" });
    expect(para.children).toEqual([
      { kind: "link", attributes: { target: "/x.md" }, text: "link", children: [] },
    ]);
    const sub = one!.children[2]!;
    expect(sub.kind).toBe("section");
    expect(sub.children.map((c) => c.kind)).toEqual(["heading", "list", "code_block"]);
    const list = sub.children[1]!;
    expect(list.attributes).toEqual({ ordered: false });
    expect(list.children.map((c) => c.kind)).toEqual(["list_item", "list_item"]);
    expect(sub.children[2]).toMatchObject({ kind: "code_block", attributes: { lang: "ts" }, text: "code" });
    expect(two!.kind).toBe("section");
  });

  it("is deterministic, JSON-serialisable and uses only scalar attributes", () => {
    const a = JSON.stringify(toTypedTree(enc(DOC)));
    expect(JSON.stringify(toTypedTree(enc(DOC)))).toBe(a);
    const walk = (n: any): void => {
      for (const v of Object.values(n.attributes)) {
        expect(["string", "number", "boolean"]).toContain(typeof v);
      }
      expect(typeof n.text).toBe("string");
      n.children.forEach(walk);
    };
    walk(JSON.parse(a));
  });

  it("handles documents without frontmatter and invalid frontmatter", () => {
    expect(toTypedTree(enc("# A\n")).children.map((c) => c.kind)).toEqual(["section"]);
    const t = toTypedTree(enc("---\na: [x\n---\nhi\n"));
    expect(t.children[0]).toMatchObject({ kind: "frontmatter", children: [] });
  });

  it("exposes version constants", () => {
    expect(PARSER_VERSION).toBeTruthy();
    expect(IR_SCHEMA_VERSION).toBeTruthy();
  });
});
