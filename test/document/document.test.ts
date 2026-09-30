import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { uuidv7 } from "../../src/ids";
import { newDoc, unwrap } from "./helpers";

describe("DocumentDO", () => {
  it("getState is NOT_FOUND before the first commit", async () => {
    const { stub } = newDoc();
    const r = await stub.getState();
    expect(r).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("first commit creates a root revision and publishes projection_seq 1", async () => {
    const d = newDoc();
    const v = unwrap(await d.commit({ content: "a", kind: "import" }));
    expect(v).toMatchObject({ created: true, conflicted: false, projection_seq: 1 });
    expect(v.heads).toEqual([v.revision_id]);
    expect(await d.seqs()).toEqual({ projection_seq: 1, published_seq: 1 });
    const rev = unwrap(await d.stub.getRevision(v.revision_id));
    expect(rev.parents).toEqual([]);
    expect(rev.path).toBe("notes/a");
    expect(rev.kind).toBe("import");
  });

  it("sequential autosaves reuse one open Change", async () => {
    const d = newDoc();
    const a = unwrap(await d.commit({ content: "a" }));
    const b = unwrap(await d.commit({ content: "b", base_revision_id: a.revision_id }));
    const c = unwrap(await d.commit({ content: "c", base_revision_id: b.revision_id }));
    expect(new Set([a.change_id, b.change_id, c.change_id]).size).toBe(1);
    expect(c.heads).toEqual([c.revision_id]);
    const history = unwrap(await d.stub.getHistory());
    expect(history).toHaveLength(1);
    expect(history[0]!.revisions.map((r) => r.revision_id)).toEqual([c.revision_id, b.revision_id, a.revision_id]);
  });

  it("replays an operation_id with the stored result", async () => {
    const d = newDoc();
    const op = uuidv7();
    const first = unwrap(await d.commit({ content: "a", operation_id: op }));
    const again = unwrap(await d.commit({ content: "zzz", operation_id: op }));
    expect(again).toEqual({ ...first, created: false });
    expect(await d.seqs()).toMatchObject({ projection_seq: 1 });
  });

  it("no-op autosave creates nothing", async () => {
    const d = newDoc();
    const a = unwrap(await d.commit({ content: "a" }));
    const same = unwrap(await d.commit({ content: "a", base_revision_id: a.revision_id }));
    expect(same).toMatchObject({ revision_id: a.revision_id, created: false, projection_seq: 1 });
    expect(unwrap(await d.stub.getHistory())[0]!.revisions).toHaveLength(1);
  });

  it("stale base creates a second head", async () => {
    const d = newDoc();
    const a = unwrap(await d.commit({ content: "a" }));
    const b = unwrap(await d.commit({ content: "b", base_revision_id: a.revision_id }));
    const stale = unwrap(await d.commit({ content: "c", base_revision_id: a.revision_id }));
    expect(stale.conflicted).toBe(true);
    expect(stale.heads.sort()).toEqual([b.revision_id, stale.revision_id].sort());
    const s = unwrap(await d.stub.getState());
    expect(s.conflicted).toBe(true);
    expect(s.primary_head).toBe(b.revision_id);
  });

  it("require_head with a stale base is STALE_BASE, and CONFLICTED when conflicted", async () => {
    const d = newDoc();
    const a = unwrap(await d.commit({ content: "a" }));
    unwrap(await d.commit({ content: "b", base_revision_id: a.revision_id }));
    const r = await d.commit({ content: "c", base_revision_id: a.revision_id, require_head: true });
    expect(r).toMatchObject({ ok: false, error: { code: "STALE_BASE" } });
    unwrap(await d.commit({ content: "c", base_revision_id: a.revision_id }));
    const r2 = await d.commit({ content: "d", base_revision_id: a.revision_id, require_head: true });
    expect(r2).toMatchObject({ ok: false, error: { code: "CONFLICTED" } });
  });

  it("unknown base is UNKNOWN_BASE", async () => {
    const d = newDoc();
    unwrap(await d.commit({ content: "a" }));
    const r = await d.commit({ content: "b", base_revision_id: d.blob("nope") });
    expect(r).toMatchObject({ ok: false, error: { code: "UNKNOWN_BASE" } });
  });

  it("wrong document id is DOCUMENT_MISMATCH", async () => {
    const d = newDoc();
    unwrap(await d.commit({ content: "a" }));
    const r = await d.commit({ content: "b", document_id: uuidv7() });
    expect(r).toMatchObject({ ok: false, error: { code: "DOCUMENT_MISMATCH" } });
  });

  it("resolve yields one head with both parents and a new Change", async () => {
    const d = newDoc();
    const a = unwrap(await d.commit({ content: "a" }));
    const b = unwrap(await d.commit({ content: "b", base_revision_id: a.revision_id }));
    const c = unwrap(await d.commit({ content: "c", base_revision_id: a.revision_id }));
    const r = unwrap(
      await d.stub.resolve({ operation_id: uuidv7(), actor_id: "dev", content_blob_id: await d.store("m"), path: "notes/a", attachments: [] }),
    );
    expect(r.heads).toEqual([r.revision_id]);
    expect(r.conflicted).toBe(false);
    expect([b.change_id, c.change_id]).not.toContain(r.change_id);
    const rev = unwrap(await d.stub.getRevision(r.revision_id));
    expect(rev.parents.sort()).toEqual([b.revision_id, c.revision_id].sort());
    expect(rev.kind).toBe("resolve");
    expect(unwrap(await d.stub.getState()).open_change_id).toBeNull();
  });

  it("resolve with one head is NOT_CONFLICTED", async () => {
    const d = newDoc();
    unwrap(await d.commit({ content: "a" }));
    const r = await d.stub.resolve({ operation_id: uuidv7(), actor_id: "dev", content_blob_id: await d.store("m"), path: "p", attachments: [] });
    expect(r).toMatchObject({ ok: false, error: { code: "NOT_CONFLICTED" } });
  });

  it("restore creates a forward revision keeping the current path", async () => {
    const d = newDoc();
    const a = unwrap(await d.commit({ content: "a" }));
    const b = unwrap(await d.commit({ content: "b", base_revision_id: a.revision_id, kind: "rename", path: "notes/renamed" }));
    const r = unwrap(await d.stub.restore({ operation_id: uuidv7(), actor_id: "dev", target_revision_id: a.revision_id }));
    expect(r.heads).toEqual([r.revision_id]);
    const rev = unwrap(await d.stub.getRevision(r.revision_id));
    expect(rev.parents).toEqual([b.revision_id]);
    expect(rev.content_blob_id).toBe(d.blob("a"));
    expect(rev.path).toBe("notes/renamed");
    expect(rev.kind).toBe("restore");
    expect(unwrap(await d.stub.getState()).open_change_id).toBeNull();
  });

  it("restore while conflicted is CONFLICTED", async () => {
    const d = newDoc();
    const a = unwrap(await d.commit({ content: "a" }));
    unwrap(await d.commit({ content: "b", base_revision_id: a.revision_id }));
    unwrap(await d.commit({ content: "c", base_revision_id: a.revision_id }));
    const r = await d.stub.restore({ operation_id: uuidv7(), actor_id: "dev", target_revision_id: a.revision_id });
    expect(r).toMatchObject({ ok: false, error: { code: "CONFLICTED" } });
  });

  it("closeChange then autosave opens a new Change", async () => {
    const d = newDoc();
    const a = unwrap(await d.commit({ content: "a" }));
    unwrap(await d.stub.closeChange());
    const b = unwrap(await d.commit({ content: "b", base_revision_id: a.revision_id }));
    expect(b.change_id).not.toBe(a.change_id);
    expect(unwrap(await d.stub.getHistory())).toHaveLength(2);
  });

  it("alarm closes an idle Change", async () => {
    const d = newDoc();
    unwrap(await d.commit({ content: "a" }));
    expect(unwrap(await d.stub.getState()).open_change_id).not.toBeNull();
    await runInDurableObject(d.stub, (_i, state) => {
      state.storage.sql.exec("UPDATE changes SET last_activity_at = ?", Date.now() - 6 * 60 * 1000);
    });
    expect(await runDurableObjectAlarm(d.stub)).toBe(true);
    expect(unwrap(await d.stub.getState()).open_change_id).toBeNull();
  });

  it("publish failure leaves published_seq behind; the alarm republishes", async () => {
    const d = newDoc();
    await runInDurableObject(d.stub, async (i) => {
      const instance = i as unknown as { env: Env };
      const real = instance.env;
      instance.env = {
        ...real,
        PROJECTION_QUEUE: {
          send: async () => {
            throw new Error("queue down");
          },
        },
      } as unknown as Env;
      (globalThis as { __realEnv?: Env }).__realEnv = real;
    });
    const v = unwrap(await d.commit({ content: "a" }));
    expect(v.projection_seq).toBe(1);
    expect(await d.seqs()).toEqual({ projection_seq: 1, published_seq: 0 });
    await runInDurableObject(d.stub, (i) => {
      (i as unknown as { env: Env }).env = (globalThis as { __realEnv?: Env }).__realEnv!;
    });
    expect(await runDurableObjectAlarm(d.stub)).toBe(true);
    expect(await d.seqs()).toEqual({ projection_seq: 1, published_seq: 1 });
  });
});

void env;
