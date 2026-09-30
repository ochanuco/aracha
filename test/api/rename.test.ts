import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, create, json, project, uniquePath } from "./helpers";
import { headOf, namespace, revisionsOf, startRename } from "../coordinator/helpers";

const code = async (res: Response) => ((await res.json()) as { code: string }).code;

describe("rename routes", () => {
  it("validates the request", async () => {
    const ns = namespace();
    const a = await create(`${ns}/a`, "a");
    const b = await create(`${ns}/b`, "b");
    await project(a.document_id);
    await project(b.document_id);

    const taken = await json("POST", "/api/rename", { document_id: a.document_id, new_path: `${ns}/b` });
    expect([taken.status, await code(taken)]).toEqual([409, "PATH_TAKEN"]);
    const same = await json("POST", "/api/rename", { document_id: a.document_id, new_path: `${ns}/a` });
    expect(same.status).toBe(400);
    const bad = await json("POST", "/api/rename", { document_id: a.document_id, new_path: "x.md" });
    expect([bad.status, await code(bad)]).toEqual([400, "INVALID_PATH"]);
    const missing = await json("POST", "/api/rename", { document_id: crypto.randomUUID(), new_path: `${ns}/z` });
    expect(missing.status).toBe(404);
  });

  it("serves status and retry, and 404 for unknown operations", async () => {
    const ns = namespace();
    const a = await create(`${ns}/a`, "a");
    const { res, value } = await startRename(a.document_id, `${ns}/moved`);
    expect(res.status).toBe(202);
    const got = await api(`/api/operations/${value.operation_id}`);
    expect(got.status).toBe(200);
    expect(((await got.json()) as { status: string }).status).toBe("completed");
    const again = await json("POST", `/api/operations/${value.operation_id}/retry`, {});
    expect(again.status).toBe(200);
    expect(await revisionsOf(a.document_id, value.operation_id)).toHaveLength(1);
    expect((await api(`/api/operations/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await json("POST", `/api/operations/${crypto.randomUUID()}/retry`, {})).status).toBe(404);
  });
});

describe("alias cleanup", () => {
  it("refuses while an edge to the alias exists and succeeds afterwards", async () => {
    const ns = namespace();
    const oldPath = `${ns}/old`;
    const target = await create(oldPath, "t");
    const ref = await create(`${ns}/ref`, `[t](/${oldPath}.md)\n`);
    await project(target.document_id);
    await project(ref.document_id);
    const { value } = await startRename(target.document_id, `${ns}/new`);
    expect(value.status).toBe("completed");
    await project(target.document_id);
    await project(ref.document_id);
    expect((await headOf(target.document_id)).meta.aliases).toEqual([oldPath]);

    // point the referrer back at the alias so an edge exists
    const refHead = await headOf(ref.document_id);
    const back = await json("PUT", `/api/documents/${ref.document_id}/autosave`, {
      base_revision_id: refHead.revision_id,
      markdown: `[t](/${oldPath}.md)\n`,
    });
    expect(back.status).toBe(200);
    await project(ref.document_id);

    const blocked = await json("POST", "/api/aliases/cleanup", { document_id: target.document_id, alias: oldPath });
    expect([blocked.status, await code(blocked)]).toEqual([409, "ALIAS_IN_USE"]);
    const ctx = (await (await json("POST", "/api/aliases/cleanup", { document_id: target.document_id, alias: oldPath })).json()) as {
      context: { document_ids: string[] };
    };
    expect(ctx.context.document_ids).toEqual([ref.document_id]);

    const fixed = await json("PUT", `/api/documents/${ref.document_id}/autosave`, {
      base_revision_id: (await headOf(ref.document_id)).revision_id,
      markdown: `[t](/${ns}/new.md)\n`,
    });
    expect(fixed.status).toBe(200);
    await project(ref.document_id);

    const ok = await json("POST", "/api/aliases/cleanup", { document_id: target.document_id, alias: oldPath });
    expect(ok.status).toBe(200);
    expect((await headOf(target.document_id)).meta.aliases).toEqual([]);
    await project(target.document_id);
    const row = await env.DB.prepare("SELECT 1 AS x FROM aliases WHERE alias_path = ?").bind(oldPath).first();
    expect(row).toBeNull();

    const gone = await json("POST", "/api/aliases/cleanup", { document_id: target.document_id, alias: oldPath });
    expect(gone.status).toBe(404);
  });
});
