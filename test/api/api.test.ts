import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { derivedIrKey } from "../../src/cas";
import { uuidv7 } from "../../src/ids";
import { IR_SCHEMA_VERSION, PARSER_VERSION } from "../../src/okf";
import { api, autosave, create, json, project, uniquePath } from "./helpers";

type Head = { revision_id: string; path: string; markdown: string; content_blob_id: string };
const getDoc = async (id: string) => (await (await api(`/api/documents/${id}`)).json()) as { heads: Head[]; conflicted: boolean; primary_head: string };

describe("documents API", () => {
  it("imports, lists and resolves by path and alias", async () => {
    const path = uniquePath("a");
    const { document_id } = await create(path, `---\ntype: note\naracha:\n  aliases:\n    - ${path}-old\n---\nx`);
    await project(document_id);
    const list = (await (await api("/api/documents")).json()) as { document_id: string }[];
    expect(list.map((d) => d.document_id)).toContain(document_id);
    for (const p of [path, `${path}-old`]) {
      const res = await api(`/api/documents/by-path?path=${encodeURIComponent(p)}`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { document_id: string }).document_id).toBe(document_id);
    }
    expect((await api("/api/documents/by-path?path=nope/nope")).status).toBe(404);
  });

  it("uses a valid UUIDv7 aracha.id as the DocumentId", async () => {
    const id = uuidv7();
    const { document_id } = await create(uniquePath("id"), `---\naracha:\n  id: ${id}\n---\nx`);
    expect(document_id).toBe(id);
    const other = await create(uniquePath("id2"), "---\naracha:\n  id: not-a-uuid\n---\nx");
    expect(other.document_id).not.toBe("not-a-uuid");
  });

  it("rejects invalid paths and taken paths or aliases", async () => {
    for (const path of ["/lead", "x.md", "", "a//b", "a/../b", "a/"]) {
      const res = await json("POST", "/api/documents", { path, markdown: "x" });
      expect(res.status, path).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("INVALID_PATH");
    }
    const path = uniquePath("taken");
    const { document_id } = await create(path, `---\naracha:\n  aliases:\n    - ${path}-alias\n---\n`);
    await project(document_id);
    for (const p of [path, `${path}-alias`]) {
      const res = await json("POST", "/api/documents", { path: p, markdown: "y" });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe("PATH_TAKEN");
    }
    expect((await json("POST", "/api/documents", { path: uniquePath("m") })).status).toBe(400);
  });

  it("stores imports byte-exact", async () => {
    const md = "---\r\ntype: note\r\nunknown_key: [1, 2]   \r\n# a comment\r\n---\r\n\r\nbody  \r\n<!-- html comment -->\r\ntrailing   ";
    const { document_id, revision_id } = await create(uniquePath("exact"), md);
    const res = await api(`/api/documents/${document_id}/revisions/${revision_id}`);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await res.text()).toBe(md);
    expect(new Uint8Array(await (await api(`/api/documents/${document_id}/revisions/${revision_id}`)).arrayBuffer())).toEqual(
      new TextEncoder().encode(md),
    );
  });

  it("autosaves, then a stale base creates a competing head; resolve and restore", async () => {
    const path = uniquePath("flow");
    const { document_id, revision_id: r1 } = await create(path, "v1");

    const a = await autosave(document_id, r1, "v2");
    expect(a.status).toBe(200);
    expect(a.body.conflicted).toBe(false);
    expect((await getDoc(document_id)).heads.map((h) => h.markdown)).toEqual(["v2"]);

    const stale = await autosave(document_id, r1, "other");
    expect(stale.status).toBe(200);
    expect(stale.body.conflicted).toBe(true);
    const both = await getDoc(document_id);
    expect(both.conflicted).toBe(true);
    expect(both.heads.map((h) => h.markdown).sort()).toEqual(["other", "v2"]);
    expect(both.heads.every((h) => h.path === path)).toBe(true);

    const notConflicted = await json("POST", `/api/documents/${document_id}/restore`, { revision_id: r1 });
    expect(notConflicted.status).toBe(409);

    const resolved = await json("POST", `/api/documents/${document_id}/resolve`, { markdown: "merged" });
    expect(resolved.status).toBe(200);
    expect(((await resolved.json()) as { conflicted: boolean }).conflicted).toBe(false);
    const after = await getDoc(document_id);
    expect(after.heads.map((h) => h.markdown)).toEqual(["merged"]);

    const again = await json("POST", `/api/documents/${document_id}/resolve`, { markdown: "again" });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe("NOT_CONFLICTED");

    const restored = await json("POST", `/api/documents/${document_id}/restore`, { revision_id: r1 });
    expect(restored.status).toBe(200);
    expect((await getDoc(document_id)).heads.map((h) => h.markdown)).toEqual(["v1"]);
  });

  it("closes changes and serves history", async () => {
    const { document_id, revision_id } = await create(uniquePath("hist"), "a");
    await autosave(document_id, revision_id, "b");
    const closed = await json("POST", `/api/documents/${document_id}/close-change`, {});
    expect(closed.status).toBe(200);
    const history = (await (await api(`/api/documents/${document_id}/history`)).json()) as { revisions: unknown[] }[];
    expect(history.reduce((n, c) => n + c.revisions.length, 0)).toBe(2);
  });

  it("maps errors to JSON with status codes", async () => {
    const missing = await api(`/api/documents/${uuidv7()}`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "NOT_FOUND", context: {} });
    const { document_id } = await create(uniquePath("err"), "x");
    const bad = await json("PUT", `/api/documents/${document_id}/autosave`, { base_revision_id: "sha256:nope", markdown: "y" });
    expect(bad.status).toBe(404);
    expect((await api("/api/nothing")).status).toBe(404);
    expect((await api("/api/graph", { method: "DELETE" })).status).toBe(405);
    const notJson = await api(`/api/documents/${document_id}/restore`, { method: "POST", body: "nope" });
    expect(notJson.status).toBe(400);
  });

  it("serves the semantic diff with labels and caches the typed tree in R2", async () => {
    const { document_id, revision_id: r1 } = await create(uniquePath("diff"), "# One\n\ntext");
    const r2 = (await autosave(document_id, r1, "# Two\n\ntext")).body.revision_id;
    const res = await api(`/api/documents/${document_id}/diff?from=${r1}&to=${r2}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { type: string }[]; labels: unknown[] };
    expect(body.events.length).toBeGreaterThan(0);
    expect(Array.isArray(body.labels)).toBe(true);
    for (const rev of [r1, r2]) {
      const blobId = (await (await env.DOCUMENT.getByName(document_id).getRevision(rev)).valueOf()) as unknown as {
        ok: true;
        value: { content_blob_id: string };
      };
      const cached = await env.BLOBS.get(derivedIrKey(PARSER_VERSION, IR_SCHEMA_VERSION, blobId.value.content_blob_id));
      expect(cached).not.toBeNull();
      expect(((await cached!.json()) as { kind: string }).kind).toBe("document");
    }
    expect((await api(`/api/documents/${document_id}/diff?from=${r1}`)).status).toBe(400);
  });

  it("serves backlinks, graph and search", async () => {
    const dir = uniquePath("x").split("/")[0];
    const t = await create(`${dir}/t`, "target");
    const s = await create(`${dir}/s`, `[t](/${dir}/t.md) searchable-token`);
    await project(t.document_id);
    await project(s.document_id);
    const back = (await (await api(`/api/documents/${t.document_id}/backlinks`)).json()) as { document_id: string }[];
    expect(back.map((b) => b.document_id)).toEqual([s.document_id]);
    const g = (await (await api("/api/graph")).json()) as { source_document_id: string; target_document_id: string | null }[];
    expect(g.find((e) => e.source_document_id === s.document_id)?.target_document_id).toBe(t.document_id);
    const hits = (await (await api("/api/search?q=searchable-token")).json()) as { document_id: string }[];
    expect(hits.map((h) => h.document_id)).toEqual([s.document_id]);
  });
});
