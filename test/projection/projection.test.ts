import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleProjectionBatch, projectDocument } from "../../src/projection/consumer";
import { backlinks, graph, listDocuments, resolvePath, search } from "../../src/projection/queries";
import { storeBlob } from "../../src/write";
import { uuidv7 } from "../../src/ids";
import { autosave, create, project, state, uniquePath } from "../api/helpers";

const fm = (aliases: string[]) => `---\ntype: note\ntitle: T\naracha:\n  aliases:\n${aliases.map((a) => `    - ${a}\n`).join("")}---\n`;

describe("projection", () => {
  it("projects an import into documents, metadata and resolvePath", async () => {
    const path = uniquePath("first");
    const { document_id, revision_id } = await create(path, "---\ntype: note\ntitle: Hello\nowner: me\n---\nbody");
    await project(document_id);
    const row = await resolvePath(env, path);
    expect(row).toMatchObject({ document_id, title: "Hello", type: "note", revision_id, conflicted: 0 });
    expect((await listDocuments(env)).some((d) => d.document_id === document_id)).toBe(true);
    const { results } = await env.DB.prepare("SELECT key FROM metadata WHERE document_id = ? ORDER BY key").bind(document_id).all();
    expect(results.map((r) => r.key)).toEqual(["owner", "title", "type"]);
  });

  it("falls back to the last path segment as title", async () => {
    const path = uniquePath("untitled");
    const { document_id } = await create(path, "no frontmatter");
    await project(document_id);
    expect((await resolvePath(env, path))?.title).toBe("untitled");
  });

  it("ignores older and duplicate projection_seq", async () => {
    const path = uniquePath("seq");
    const { document_id, revision_id } = await create(path, "one");
    await project(document_id);
    const second = await autosave(document_id, revision_id, "two");
    const s = await state(document_id);
    const msg = { workspace_id: s.workspace_id, document_id, revision_id: second.body.revision_id };
    await projectDocument(env, { ...msg, projection_seq: s.projection_seq - 1 });
    expect((await resolvePath(env, path))?.revision_id).toBe(revision_id);
    await projectDocument(env, { ...msg, projection_seq: s.projection_seq });
    expect((await resolvePath(env, path))?.revision_id).toBe(second.body.revision_id);
    await projectDocument(env, { ...msg, projection_seq: s.projection_seq });
    expect((await resolvePath(env, path))?.indexed_seq).toBe(s.projection_seq);
  });

  it("re-projection replaces edges and the FTS row", async () => {
    const dir = uniquePath("x").split("/")[0];
    const { document_id, revision_id } = await create(`${dir}/a`, "see [b](/zz/b.md) quokkaword");
    await project(document_id);
    expect((await graph(env)).filter((e) => e.source_document_id === document_id).map((e) => e.target_path)).toEqual(["zz/b"]);
    expect((await search(env, "quokkaword")).map((h) => h.document_id)).toContain(document_id);
    await autosave(document_id, revision_id, "see [c](/zz/c.md) wombatword");
    await project(document_id);
    expect((await graph(env)).filter((e) => e.source_document_id === document_id).map((e) => e.target_path)).toEqual(["zz/c"]);
    expect((await search(env, "quokkaword")).map((h) => h.document_id)).not.toContain(document_id);
    expect((await search(env, "wombatword")).map((h) => h.document_id)).toContain(document_id);
  });

  it("finds backlinks through the path and through an alias, and resolves graph targets", async () => {
    const dir = uniquePath("x").split("/")[0];
    const target = await create(`${dir}/target`, `${fm([`${dir}/old-name`])}body`);
    const viaPath = await create(`${dir}/p`, `[t](/${dir}/target.md)`);
    const viaAlias = await create(`${dir}/q`, `[t](/${dir}/old-name.md#sec)`);
    const dangling = await create(`${dir}/r`, `[t](/${dir}/nowhere.md)`);
    for (const d of [target, viaPath, viaAlias, dangling]) await project(d.document_id);

    const links = await backlinks(env, target.document_id);
    expect(links.map((l) => l.document_id).sort()).toEqual([viaPath.document_id, viaAlias.document_id].sort());
    expect(links[0]).toHaveProperty("title");
    expect((await resolvePath(env, `${dir}/old-name`))?.document_id).toBe(target.document_id);

    const edges = await graph(env);
    const targetOf = (src: string) => edges.find((e) => e.source_document_id === src)!.target_document_id;
    expect(targetOf(viaAlias.document_id)).toBe(target.document_id);
    expect(targetOf(dangling.document_id)).toBeNull();
  });

  it("keeps only .md links and dedupes targets", async () => {
    const dir = uniquePath("x").split("/")[0];
    const md = [
      `[a](/${dir}/keep.md)`,
      `[a2](/${dir}/keep.md#frag)`,
      `[b](/${dir}/page)`,
      `[c](/${dir}/img.png)`,
      `[d](/${dir}/q.md?x=1)`,
      `[e](https://example.com/e.md)`,
    ].join("\n\n");
    const { document_id } = await create(`${dir}/src`, md);
    await project(document_id);
    const { results } = await env.DB.prepare("SELECT target_path FROM edges WHERE source_document_id = ? ORDER BY target_path")
      .bind(document_id)
      .all();
    expect(results.map((r) => r.target_path)).toEqual([`${dir}/keep`, `${dir}/q`]);
  });

  it("searches Japanese text, short queries and quote characters", async () => {
    const dir = uniquePath("x").split("/")[0];
    const { document_id } = await create(`${dir}/jp`, `# タイトル\n\n吾輩は猫である。名前はまだ無い。zq"unique`);
    await project(document_id);
    const ids = async (q: string) => (await search(env, q)).map((h) => h.document_id);
    expect(await ids("吾輩は猫")).toContain(document_id);
    expect(await ids("猫")).toContain(document_id);
    expect(await ids("名前")).toContain(document_id);
    expect(await ids("zq")).toContain(document_id);
    expect(await ids('zq"unique')).toContain(document_id);
    expect(await ids("存在しない検索語")).not.toContain(document_id);
    expect(await ids("")).toEqual([]);
  });

  it("lets the latest projection take over a path", async () => {
    const path = uniquePath("shared");
    const ids: string[] = [];
    for (const text of ["first", "second"]) {
      const id = uuidv7();
      ids.push(id);
      const r = await env.DOCUMENT.getByName(id).commit({
        workspace_id: env.WORKSPACE_ID,
        document_id: id,
        operation_id: uuidv7(),
        actor_id: "dev",
        kind: "import",
        base_revision_id: null,
        content_blob_id: await storeBlob(env, new TextEncoder().encode(text)),
        path,
        attachments: [],
      });
      expect(r.ok).toBe(true);
      await project(id);
    }
    expect((await resolvePath(env, path))?.document_id).toBe(ids[1]);
    const { results } = await env.DB.prepare("SELECT document_id FROM documents WHERE document_id = ?").bind(ids[0]).all();
    expect(results).toEqual([]);
  });

  it("acks projected messages and retries failures in the queue handler", async () => {
    const { document_id } = await create(uniquePath("q"), "queued");
    const s = await state(document_id);
    const calls: string[] = [];
    const msg = (body: object, name: string) =>
      ({ body, ack: () => calls.push(`ack:${name}`), retry: () => calls.push(`retry:${name}`) }) as unknown as Message<never>;
    await handleProjectionBatch(
      {
        messages: [
          msg({ workspace_id: s.workspace_id, document_id, revision_id: s.primary_head, projection_seq: s.projection_seq }, "good"),
          msg({ workspace_id: s.workspace_id, document_id: uuidv7(), revision_id: "x", projection_seq: 1 }, "bad"),
        ],
      } as unknown as MessageBatch<never>,
      env,
    );
    expect(calls).toEqual(["ack:good", "retry:bad"]);
  });
});
