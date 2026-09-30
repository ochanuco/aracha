import { describe, expect, it } from "vitest";
import { buildTar } from "../src/export";
import { api, create, project, uniquePath } from "./api/helpers";

const dec = new TextDecoder();

function parseTar(buf: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  let at = 0;
  while (at + 512 <= buf.length) {
    const h = buf.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const str = (o: number, l: number) => dec.decode(h.subarray(o, o + l)).replace(/\0.*$/s, "");
    const copy = h.slice();
    copy.fill(0x20, 148, 156);
    const sum = copy.reduce((a, b) => a + b, 0);
    expect(parseInt(str(148, 8).trim(), 8)).toBe(sum);
    expect(str(257, 5)).toBe("ustar");
    const prefix = str(345, 155);
    const name = (prefix ? `${prefix}/` : "") + str(0, 100);
    const size = parseInt(str(124, 12), 8);
    out.set(name, buf.slice(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  expect(buf.length - at).toBeGreaterThanOrEqual(1024);
  return out;
}

describe("export", () => {
  it("writes each document's primary head bytes at <path>.md", async () => {
    const md = "---\r\ntype: note\r\nunknown: {a: 1}   \r\n# comment\r\n---\r\n\r\n日本語  \r\n<!-- c -->\r\n";
    const p1 = uniquePath("exact");
    const p2 = uniquePath("second");
    const a = await create(p1, md);
    const b = await create(p2, "plain");
    await project(a.document_id);
    await project(b.document_id);

    const res = await api("/api/export");
    expect(res.headers.get("content-type")).toBe("application/x-tar");
    const files = parseTar(new Uint8Array(await res.arrayBuffer()));
    expect(files.get(`${p1}.md`)).toEqual(new TextEncoder().encode(md));
    expect(dec.decode(files.get(`${p2}.md`)!)).toBe("plain");
  });

  it("uses the ustar prefix for long names and rejects unsplittable ones", () => {
    const name = `${"a".repeat(60)}/${"b".repeat(60)}/c.md`;
    const bytes = new TextEncoder().encode("x".repeat(600));
    const files = parseTar(buildTar([{ name, bytes }, { name: "short.md", bytes: new Uint8Array() }]));
    expect(files.get(name)).toEqual(bytes);
    expect(files.get("short.md")).toEqual(new Uint8Array());
    expect(() => buildTar([{ name: "z".repeat(300), bytes }])).toThrow();
  });
});
