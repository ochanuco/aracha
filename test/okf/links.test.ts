import { describe, expect, it } from "vitest";
import { extractLinks, rewriteLinks } from "../../src/okf";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const slice = (b: Uint8Array, s: number, e: number) => dec(b.subarray(s, e));

describe("extractLinks", () => {
  it("resolves absolute and relative links with exact spans", () => {
    const bytes = enc(
      "[a](/tables/users.md) [b](./x.md) [c](../y/z.md#sec) [d](w.md?q=1) [e](/a%20b.md)\n",
    );
    const links = extractLinks(bytes, "concepts/rust");
    expect(links.map((l) => l.target)).toEqual([
      "tables/users",
      "concepts/x",
      "y/z",
      "concepts/w",
      "a b",
    ]);
    for (const l of links) expect(slice(bytes, l.start, l.end)).toBe(l.href);
    expect(links[2]!.href).toBe("../y/z.md#sec");
  });

  it("skips external, fragment-only, images and escaping links", () => {
    const md = [
      "[a](https://x.com/a.md) [b](mailto:a@b.c) [c](#top) ![i](img.md)",
      "[d](../../../out.md) [e](//cdn/x.md)",
    ].join("\n");
    expect(extractLinks(enc(md), "concepts/rust")).toEqual([]);
  });

  it("gives correct byte offsets after Japanese text and frontmatter", () => {
    const bytes = enc("---\ntitle: 日本語\n---\n日本語の文章 🎉 [リンク](/a/b.md) 終わり\n");
    const [l] = extractLinks(bytes, "x");
    expect(l!.target).toBe("a/b");
    expect(slice(bytes, l!.start, l!.end)).toBe("/a/b.md");
  });

  it("handles reference definitions, titles and angle brackets", () => {
    const bytes = enc('[ref]: ./r.md "T"\n\n[x](<sp ace.md> "t") [y](z.md \'t\')\n');
    const links = extractLinks(bytes, "d/e");
    expect(links.map((l) => [l.target, l.href])).toEqual([
      ["d/r", "./r.md"],
      ["d/sp ace", "sp ace.md"],
      ["d/z", "z.md"],
    ]);
    for (const l of links) expect(slice(bytes, l.start, l.end)).toBe(l.href);
  });

  it("ignores code spans and blocks", () => {
    const md = "`[a](a.md)`\n\n```\n[b](b.md)\n```\n\n    [c](c.md)\n\n[real](r.md)\n";
    expect(extractLinks(enc(md), "p").map((l) => l.target)).toEqual(["r"]);
  });

  it("handles links nested in emphasis and parens in destinations", () => {
    const bytes = enc("**[a](a_(x).md)** and [b `c]`](b.md)\n");
    const links = extractLinks(bytes, "p");
    expect(links.map((l) => l.href)).toEqual(["a_(x).md", "b.md"]);
  });
});

describe("rewriteLinks", () => {
  it("returns identical bytes when nothing matches", () => {
    const bytes = enc("[a](other.md) `[x](old.md)`\n");
    expect(rewriteLinks(bytes, "d/n", "d/old", "d/new")).toBe(bytes);
  });

  it("keeps form, .md suffix and fragment and changes nothing else", () => {
    const src =
      "日本語 [a](/concepts/old.md#s) [b](old.md) [c](./old) [d](../concepts/old.md?x=1) [e](/keep.md)\n\n[r]: old.md \"t\"\n";
    const out = dec(rewriteLinks(enc(src), "concepts/n", "concepts/old", "areas/new"));
    expect(out).toBe(
      "日本語 [a](/areas/new.md#s) [b](../areas/new.md) [c](../areas/new) [d](../areas/new.md?x=1) [e](/keep.md)\n\n[r]: ../areas/new.md \"t\"\n",
    );
  });

  it("keeps ./ prefix when the new path is below the directory", () => {
    const out = dec(rewriteLinks(enc("[a](./old.md)"), "d/n", "d/old", "d/sub/new"));
    expect(out).toBe("[a](./sub/new.md)");
  });

  it("re-encodes characters that would break the destination", () => {
    const out = dec(rewriteLinks(enc("[a](/old.md)"), "n", "old", "a b/日本"));
    expect(out).toBe("[a](/a%20b/日本.md)");
  });

  it("preserves bytes around the splice with multibyte text and frontmatter", () => {
    const src = "---\ntitle: あ\n---\nあ[a](/old.md)い\n";
    expect(dec(rewriteLinks(enc(src), "n", "old", "new"))).toBe(
      "---\ntitle: あ\n---\nあ[a](/new.md)い\n",
    );
  });
});
