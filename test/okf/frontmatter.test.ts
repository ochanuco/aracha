import { describe, expect, it } from "vitest";
import { readMeta, splitDocument, writeArachaMeta } from "../../src/okf";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("splitDocument", () => {
  it("splits frontmatter and body with correct byte offset", () => {
    const src = "---\ntype: note\n---\nbody\n";
    const r = splitDocument(enc(src));
    expect(r.frontmatter).toBe("type: note\n");
    expect(r.body).toBe("body\n");
    expect(r.bodyOffset).toBe(enc("---\ntype: note\n---\n").length);
  });

  it("returns null frontmatter without a block", () => {
    const r = splitDocument(enc("# Title\n"));
    expect(r).toEqual({ frontmatter: null, body: "# Title\n", bodyOffset: 0 });
  });

  it("ignores an unclosed block", () => {
    expect(splitDocument(enc("---\ntype: x\nno close\n")).frontmatter).toBeNull();
  });

  it("accepts ... as closer and handles CRLF", () => {
    const r = splitDocument(enc("---\r\ntype: x\r\n...\r\nhi\r\n"));
    expect(r.frontmatter).toBe("type: x\r\n");
    expect(r.body).toBe("hi\r\n");
    expect(r.bodyOffset).toBe(enc("---\r\ntype: x\r\n...\r\n").length);
  });

  it("counts multibyte characters in bodyOffset", () => {
    const head = "---\ntitle: 日本語\n---\n";
    expect(splitDocument(enc(head + "x")).bodyOffset).toBe(enc(head).length);
  });

  it("handles empty frontmatter and closer at EOF", () => {
    expect(splitDocument(enc("---\n---\nx")).frontmatter).toBe("");
    const r = splitDocument(enc("---\na: 1\n---"));
    expect(r.frontmatter).toBe("a: 1\n");
    expect(r.body).toBe("");
  });
});

describe("readMeta", () => {
  it("reads known keys, aracha block and keeps all", () => {
    const m = readMeta(
      enc(
        "---\ntype: concept\ntitle: T\ndescription: D\ntags: [a, b]\nx: 1\naracha:\n  id: 0190-abc\n  aliases:\n    - old/a\n    - old/b\n---\nbody",
      ),
    );
    expect(m.type).toBe("concept");
    expect(m.title).toBe("T");
    expect(m.description).toBe("D");
    expect(m.tags).toEqual(["a", "b"]);
    expect(m.arachaId).toBe("0190-abc");
    expect(m.aliases).toEqual(["old/a", "old/b"]);
    expect(m.all.x).toBe(1);
  });

  it("returns empty result for invalid YAML and no frontmatter", () => {
    expect(readMeta(enc("---\na: [unclosed\nb: : :\n---\n"))).toEqual({ aliases: [], all: {} });
    expect(readMeta(enc("plain"))).toEqual({ aliases: [], all: {} });
  });

  it("omits absent fields", () => {
    const m = readMeta(enc("---\ntype: t\n---\n"));
    expect(m.title).toBeUndefined();
    expect(m.arachaId).toBeUndefined();
    expect(m.aliases).toEqual([]);
  });
});

describe("writeArachaMeta", () => {
  const stripAracha = (s: string) =>
    s.replace(/aracha:(?:\r?\n[ \t]+[^\r\n]*)*\r?\n/, "");

  it("preserves everything outside the aracha key", () => {
    const src =
      "---\n# leading comment\ntype: concept   # trailing\n'quoted': \"v\"\nz: [1,  2]\n\nunknown:\n  nested: true\n---\n# 日本語\nbody\n";
    const out = dec(writeArachaMeta(enc(src), { id: "ID1", aliases: ["a/b"] }));
    expect(out).toContain("aracha:\n  id: ID1\n  aliases:\n    - a/b\n");
    expect(stripAracha(out)).toBe(src);
  });

  it("preserves CRLF", () => {
    const src = "---\r\ntype: x\r\n# c\r\n---\r\nbody\r\n";
    const out = dec(writeArachaMeta(enc(src), { id: "ID", aliases: ["p/q"] }));
    expect(out).toContain("aracha:\r\n  id: ID\r\n  aliases:\r\n    - p/q\r\n");
    expect(out.replace(/\r\n/g, "\n")).not.toContain("\r");
    expect(stripAracha(out)).toBe(src);
  });

  it("prepends a minimal block when there is no frontmatter", () => {
    const out = dec(writeArachaMeta(enc("# Hi\n"), { id: "ID", aliases: [] }));
    expect(out).toBe("---\naracha:\n  id: ID\n---\n# Hi\n");
  });

  it("writes no aliases key for an empty list", () => {
    const out = dec(writeArachaMeta(enc("---\ntype: x\n---\n"), { id: "ID", aliases: [] }));
    expect(out).not.toContain("aliases");
    expect(readMeta(enc(out)).arachaId).toBe("ID");
  });

  it("updates an existing block in place, keeping neighbours", () => {
    const src =
      "---\ntype: x\naracha:\n  id: OLD\n  aliases:\n    - one\n# after\nlast: 1\n---\nbody";
    const out = dec(writeArachaMeta(enc(src), { id: "NEW", aliases: ["one", "two"] }));
    expect(out).toBe(
      "---\ntype: x\naracha:\n  id: NEW\n  aliases:\n    - one\n    - two\n# after\nlast: 1\n---\nbody",
    );
  });

  it("replaces a flow-style aracha value", () => {
    const out = dec(
      writeArachaMeta(enc("---\naracha: {id: OLD}\nz: 1\n---\n"), { id: "N", aliases: [] }),
    );
    expect(out).toBe("---\naracha:\n  id: N\nz: 1\n---\n");
  });

  it("appends after content lacking a final newline and handles empty frontmatter", () => {
    expect(dec(writeArachaMeta(enc("---\ntype: x\n---\n"), { id: "I", aliases: [] }))).toBe(
      "---\ntype: x\naracha:\n  id: I\n---\n",
    );
    expect(dec(writeArachaMeta(enc("---\n---\nb"), { id: "I", aliases: [] }))).toBe(
      "---\naracha:\n  id: I\n---\nb",
    );
  });

  it("keeps body bytes exactly, including multibyte text", () => {
    const body = "本文 日本語 🎉\n";
    const out = dec(writeArachaMeta(enc("---\na: 1\n---\n" + body), { id: "I", aliases: [] }));
    expect(out.endsWith("---\n" + body)).toBe(true);
  });

  it("throws on invalid frontmatter rather than corrupting it", () => {
    expect(() => writeArachaMeta(enc("---\na: [x\n---\n"), { id: "I", aliases: [] })).toThrow();
  });
});
