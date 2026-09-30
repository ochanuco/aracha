import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { uuidv7 } from "../../src/ids";
import { resolvePath } from "../../src/projection/queries";
import { autosave } from "../api/helpers";
import { coordinatorOf, create, headOf, namespace, project, retry, revisionsOf, startRename, state, status } from "./helpers";

async function fixture() {
  const ns = namespace();
  const oldPath = `${ns}/concepts/rust`;
  const newPath = `${ns}/languages/rust`;
  const target = await create(oldPath, `# Rust\n\nSee [go](../tools/go.md) and [self](rust.md#top).\n`);
  const a = await create(`${ns}/notes/a`, `Read [Rust](/${oldPath}.md).\n`);
  const b = await create(`${ns}/concepts/b`, `Read [Rust](./rust.md#install) too.\n`);
  for (const d of [target, a, b]) await project(d.document_id);
  return { ns, oldPath, newPath, target, a, b };
}

describe("rename operation", () => {
  it("moves the target and rewrites every referrer under one operation", async () => {
    const f = await fixture();
    const { res, value } = await startRename(f.target.document_id, f.newPath);
    expect(res.status).toBe(202);
    expect(value.status).toBe("completed");
    expect(value.old_path).toBe(f.oldPath);

    const head = await headOf(f.target.document_id);
    expect(head.path).toBe(f.newPath);
    expect(head.meta.arachaId).toBe(f.target.document_id);
    expect(head.meta.aliases).toContain(f.oldPath);
    // self-link and the link to another document still resolve after the directory change
    expect(head.text).toContain("[go](../tools/go.md)");
    expect(head.text).toContain("[self](rust.md#top)");

    expect((await headOf(f.a.document_id)).text).toContain(`[Rust](/${f.newPath}.md)`);
    expect((await headOf(f.b.document_id)).text).toContain("[Rust](../languages/rust.md#install)");

    const revisionIds = new Set<string>();
    const changeIds = new Set<string>();
    for (const t of value.targets) {
      expect(t.status).toBe("applied");
      const revs = await revisionsOf(t.document_id, value.operation_id);
      expect(revs).toHaveLength(1);
      expect(revs[0]!.revision_id).toBe(t.revision_id);
      expect(revs[0]!.kind).toBe(t.role === "target" ? "rename" : "link_update");
      revisionIds.add(revs[0]!.revision_id);
      changeIds.add(revs[0]!.change_id);
    }
    expect(value.targets).toHaveLength(3);
    expect(changeIds.size).toBe(3);
    expect(revisionIds.size).toBe(3);
  });

  it("relocates a self-link that points at the old path", async () => {
    const ns = namespace();
    const t = await create(`${ns}/concepts/x`, "[me](x.md) and [abs](/" + `${ns}/concepts/x.md)\n`);
    const { value } = await startRename(t.document_id, `${ns}/other/y`);
    expect(value.status).toBe("completed");
    expect((await headOf(t.document_id)).text).toMatch(new RegExp(`---\\n\\[me\\]\\(y\\.md\\) and \\[abs\\]\\(/${ns}/other/y\\.md\\)\\n$`));
  });

  it("reports a partial failure and completes on retry without extra revisions", async () => {
    const f = await fixture();
    const { value } = await startRename(f.target.document_id, f.newPath, { [f.b.document_id]: 1 });
    expect(value.status).toBe("partially_applied");
    const byId = Object.fromEntries(value.targets.map((t) => [t.document_id, t]));
    expect(byId[f.b.document_id]).toMatchObject({ status: "failed", last_error: "injected failure", attempts: 1 });
    expect(byId[f.a.document_id]!.status).toBe("applied");
    expect(byId[f.target.document_id]!.status).toBe("applied");

    const done = await retry(value.operation_id);
    expect(done.status).toBe("completed");
    expect(done.attempts).toBe(2);
    for (const d of [f.target, f.a, f.b]) expect(await revisionsOf(d.document_id, value.operation_id)).toHaveLength(1);
    expect((await headOf(f.b.document_id)).text).toContain("../languages/rust.md#install");

    const again = await retry(value.operation_id);
    expect(again.status).toBe("completed");
    for (const d of [f.target, f.a, f.b]) expect(await revisionsOf(d.document_id, value.operation_id)).toHaveLength(1);
  });

  it("retries by alarm with backoff", async () => {
    const f = await fixture();
    const { value } = await startRename(f.target.document_id, f.newPath, { [f.a.document_id]: 1 });
    expect(value.status).toBe("partially_applied");
    expect(await runDurableObjectAlarm(coordinatorOf(value.operation_id))).toBe(true);
    expect((await status(value.operation_id)).status).toBe("completed");
    expect(await runDurableObjectAlarm(coordinatorOf(value.operation_id))).toBe(false);
  });

  it("stops scheduling alarms after five automatic attempts", async () => {
    const f = await fixture();
    const { value } = await startRename(f.target.document_id, f.newPath, { [f.a.document_id]: 99 });
    let runs = 1;
    while (await runDurableObjectAlarm(coordinatorOf(value.operation_id))) runs++;
    expect(runs).toBe(5);
    expect((await status(value.operation_id)).status).toBe("partially_applied");
  });

  it("picks up a referrer that was not projected yet, while the alias keeps the old path resolving", async () => {
    const f = await fixture();
    const late = await create(`${f.ns}/notes/late`, `Late [Rust](/${f.oldPath}.md).\n`);
    const { value } = await startRename(f.target.document_id, f.newPath);
    expect(value.status).toBe("completed");
    expect(value.targets.map((t) => t.document_id)).not.toContain(late.document_id);
    expect((await headOf(late.document_id)).text).toContain(`/${f.oldPath}.md`);

    await project(f.target.document_id);
    expect((await resolvePath(env, f.oldPath))?.document_id).toBe(f.target.document_id);
    expect((await resolvePath(env, f.newPath))?.document_id).toBe(f.target.document_id);

    await project(late.document_id);
    const after = await retry(value.operation_id);
    expect(after.status).toBe("completed");
    expect(after.targets.find((t) => t.document_id === late.document_id)?.status).toBe("applied");
    expect((await headOf(late.document_id)).text).toContain(`/${f.newPath}.md`);
  });

  it("fails a conflicted referrer with CONFLICTED", async () => {
    const f = await fixture();
    const base = f.a.revision_id;
    await autosave(f.a.document_id, base, `Read one [Rust](/${f.oldPath}.md).\n`);
    const forked = await autosave(f.a.document_id, base, `Read two [Rust](/${f.oldPath}.md).\n`);
    expect(forked.body.conflicted).toBe(true);
    const { value } = await startRename(f.target.document_id, f.newPath);
    expect(value.status).toBe("partially_applied");
    const t = value.targets.find((x) => x.document_id === f.a.document_id)!;
    expect(t.status).toBe("failed");
    expect(t.last_error).toMatch(/^CONFLICTED/);
    expect(value.targets.find((x) => x.document_id === f.b.document_id)!.status).toBe("applied");
  });

  it("mirrors the final status into operation_index", async () => {
    const f = await fixture();
    const { value } = await startRename(f.target.document_id, f.newPath, { [f.a.document_id]: 1 });
    const row = () =>
      env.DB.prepare("SELECT * FROM operation_index WHERE operation_id = ?")
        .bind(value.operation_id)
        .first<{ kind: string; status: string; document_id: string; detail_json: string }>();
    expect((await row())!.status).toBe("partially_applied");
    await retry(value.operation_id);
    const done = (await row())!;
    expect(done).toMatchObject({ kind: "rename", status: "completed", document_id: f.target.document_id });
    expect(JSON.parse(done.detail_json)).toHaveLength(3);
  });

  it("is idempotent per operation id", async () => {
    const f = await fixture();
    const opId = uuidv7();
    const req = {
      operation_id: opId,
      workspace_id: (await state(f.target.document_id)).workspace_id,
      actor_id: "dev",
      document_id: f.target.document_id,
      new_path: f.newPath,
    };
    const first = await coordinatorOf(opId).startRename(req);
    const second = await coordinatorOf(opId).startRename({ ...req, new_path: `${f.ns}/elsewhere` });
    expect(first.ok && second.ok && second.value).toEqual(first.ok && first.value);
    expect(await revisionsOf(f.target.document_id, opId)).toHaveLength(1);
  });

  it("keeps ping()", async () => {
    expect(await coordinatorOf("x").ping()).toBe("pong");
  });
});
