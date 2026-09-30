import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { blobKey, getBlob, putIfAbsent } from "../src/cas";
import { loadBlob, storeBlob } from "../src/write";

const HEX = "ab".repeat(32);

describe("cas", () => {
  it("maps blob ids to keys", () => {
    expect(blobKey(`sha256:${HEX}`)).toBe(`blobs/sha256/ab/${HEX}`);
    expect(() => blobKey("md5:abc")).toThrow();
  });

  it("putIfAbsent is idempotent and never overwrites", async () => {
    const id = `sha256:${"cd".repeat(32)}`;
    await putIfAbsent(env.BLOBS, id, new TextEncoder().encode("first"));
    await putIfAbsent(env.BLOBS, id, new TextEncoder().encode("second"));
    expect(new TextDecoder().decode((await getBlob(env.BLOBS, id))!)).toBe("first");
  });

  it("getBlob returns null when missing", async () => {
    expect(await getBlob(env.BLOBS, `sha256:${"ef".repeat(32)}`)).toBeNull();
  });

  it("storeBlob/loadBlob round-trip through cha", async () => {
    const bytes = new TextEncoder().encode("hello");
    const id = await storeBlob(env, bytes);
    expect(id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await storeBlob(env, bytes)).toBe(id);
    expect(await loadBlob(env, id)).toEqual(bytes);
  });
});
