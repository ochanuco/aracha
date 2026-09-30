import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("bindings", () => {
  it("serves /api/health", async () => {
    const res = await exports.default.fetch("https://example.com/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("DOCUMENT DO responds to ping", async () => {
    expect(await env.DOCUMENT.getByName("t").ping()).toBe("pong");
  });

  it("OPERATION_COORDINATOR DO responds to ping", async () => {
    expect(await env.OPERATION_COORDINATOR.getByName("t").ping()).toBe("pong");
  });

  it("BLOBS round-trips", async () => {
    await env.BLOBS.put("k", "v");
    expect(await (await env.BLOBS.get("k"))?.text()).toBe("v");
  });

  it("DB has documents table", async () => {
    const { results } = await env.DB.prepare("SELECT * FROM documents").all();
    expect(results).toEqual([]);
  });

  it("PROJECTION_QUEUE accepts a message", async () => {
    await env.PROJECTION_QUEUE.send({ hello: "world" });
  });
});
