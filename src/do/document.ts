import { DurableObject } from "cloudflare:workers";
import { getCha } from "../cha/impl";
import {
  isChaError,
  type Attachment,
  type CanonicalRevision,
  type PreparedRevision,
  type StoredRevision,
} from "../cha/port";
import { uuidv7 } from "../ids";

export const IDLE_CLOSE_MS = 5 * 60 * 1000;
export const REPUBLISH_DELAY_MS = 10_000;

export type RpcError = { code: string; message: string; context: { [key: string]: unknown } };
export type Result<T> = { ok: true; value: T } | { ok: false; error: RpcError };

export type CommitKind = "autosave" | "import" | "rename" | "link_update";

export type CommitRequest = {
  workspace_id: string;
  document_id: string;
  operation_id: string;
  actor_id: string;
  kind: CommitKind;
  base_revision_id: string | null;
  content_blob_id: string;
  path: string;
  attachments: Attachment[];
  require_head?: boolean;
  description?: string;
};

export type RestoreRequest = { operation_id: string; actor_id: string; target_revision_id: string };
export type ResolveRequest = {
  operation_id: string;
  actor_id: string;
  content_blob_id: string;
  path: string;
  attachments: Attachment[];
};

export type CommitValue = {
  revision_id: string;
  change_id: string;
  heads: string[];
  conflicted: boolean;
  projection_seq: number;
  created: boolean;
};

export type HeadInfo = { revision_id: string; content_blob_id: string | null; path: string; commit_seq: number };
export type StateValue = {
  workspace_id: string;
  document_id: string;
  heads: HeadInfo[];
  primary_head: string;
  conflicted: boolean;
  projection_seq: number;
  open_change_id: string | null;
};

export type RevisionValue = {
  revision_id: string;
  change_id: string;
  content_blob_id: string | null;
  path: string;
  tombstone: boolean;
  canonical: string;
  parents: string[];
  attachments: Attachment[];
  commit_seq: number;
  created_at: number;
  operation_id: string | null;
  actor_id: string | null;
  kind: string | null;
};

export type ChangeHistory = {
  change_id: string;
  state: "open" | "closed";
  description: string | null;
  opened_at: number;
  closed_at: number | null;
  last_activity_at: number;
  revisions: RevisionValue[];
};

type StateRow = {
  workspace_id: string;
  document_id: string;
  projection_seq: number;
  published_seq: number;
  commit_seq: number;
};
type RevisionRow = {
  revision_id: string;
  change_id: string;
  content_blob_id: string | null;
  path: string;
  tombstone: number;
  canonical_json: string;
  commit_seq: number;
  created_at: number;
};
type ChangeRow = {
  change_id: string;
  state: "open" | "closed";
  description: string | null;
  opened_at: number;
  closed_at: number | null;
  last_activity_at: number;
};

const err = (code: string, message: string, context: { [key: string]: unknown } = {}): Result<never> => ({
  ok: false,
  error: { code, message, context },
});
const ok = <T>(value: T): Result<T> => ({ ok: true, value });

// Everything a write needs, resolved before any storage mutation.
type Plan = {
  kind: string;
  operation_id: string;
  actor_id: string;
  description: string | null;
  changeId: string;
  closeChangeIds: string[];
  newChange: boolean;
  closeAfter: boolean;
  parents: string[];
  prepared: PreparedRevision;
  operation: ReturnType<ReturnType<typeof getCha>["prepareOperation"]>;
};

export class DocumentDO extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  ping(): string {
    return "pong";
  }

  private migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS document_state (
        id INTEGER PRIMARY KEY CHECK (id = 1), workspace_id TEXT NOT NULL, document_id TEXT NOT NULL,
        projection_seq INTEGER NOT NULL, published_seq INTEGER NOT NULL, commit_seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS heads (revision_id TEXT PRIMARY KEY, commit_seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS changes (
        change_id TEXT PRIMARY KEY, state TEXT NOT NULL, description TEXT,
        opened_at INTEGER NOT NULL, closed_at INTEGER, last_activity_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions (
        revision_id TEXT PRIMARY KEY, change_id TEXT NOT NULL, content_blob_id TEXT, path TEXT NOT NULL,
        tombstone INTEGER NOT NULL, canonical_json TEXT NOT NULL, commit_seq INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS revision_parents (
        revision_id TEXT NOT NULL, parent_revision_id TEXT NOT NULL, PRIMARY KEY (revision_id, parent_revision_id));
      CREATE TABLE IF NOT EXISTS revision_attachments (
        revision_id TEXT NOT NULL, attachment_id TEXT NOT NULL, blob_id TEXT NOT NULL,
        PRIMARY KEY (revision_id, attachment_id));
      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY, kind TEXT NOT NULL, actor_id TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS operation_changes (
        operation_id TEXT NOT NULL, change_id TEXT NOT NULL, revision_id TEXT NOT NULL,
        PRIMARY KEY (operation_id, revision_id));
      CREATE TABLE IF NOT EXISTS applied_operation_keys (operation_id TEXT PRIMARY KEY, result_json TEXT NOT NULL);
    `);
  }

  // ---- reads -------------------------------------------------------------

  private state(): StateRow | null {
    return this.sql.exec<StateRow>("SELECT * FROM document_state WHERE id = 1").toArray()[0] ?? null;
  }

  private heads(): HeadInfo[] {
    return this.sql
      .exec<HeadInfo & { tombstone: number }>(
        `SELECT h.revision_id, r.content_blob_id, r.path, h.commit_seq
         FROM heads h JOIN revisions r USING (revision_id) ORDER BY h.commit_seq, h.revision_id`,
      )
      .toArray()
      .map(({ revision_id, content_blob_id, path, commit_seq }) => ({ revision_id, content_blob_id, path, commit_seq }));
  }

  private revisionRow(id: string): RevisionRow | null {
    return this.sql.exec<RevisionRow>("SELECT * FROM revisions WHERE revision_id = ?", id).toArray()[0] ?? null;
  }

  private attachmentsOf(id: string): Attachment[] {
    return this.sql
      .exec<Attachment>("SELECT attachment_id, blob_id FROM revision_attachments WHERE revision_id = ? ORDER BY attachment_id", id)
      .toArray();
  }

  private openChange(): ChangeRow | null {
    return this.sql.exec<ChangeRow>("SELECT * FROM changes WHERE state = 'open' LIMIT 1").toArray()[0] ?? null;
  }

  private latestRevisionOfChange(changeId: string): string | null {
    return (
      this.sql
        .exec<{ revision_id: string }>(
          "SELECT revision_id FROM revisions WHERE change_id = ? ORDER BY commit_seq DESC LIMIT 1",
          changeId,
        )
        .toArray()[0]?.revision_id ?? null
    );
  }

  private replay(operationId: string): Result<CommitValue> | null {
    const row = this.sql
      .exec<{ result_json: string }>("SELECT result_json FROM applied_operation_keys WHERE operation_id = ?", operationId)
      .toArray()[0];
    if (!row) return null;
    return ok({ ...(JSON.parse(row.result_json) as CommitValue), created: false });
  }

  private commitValue(revisionId: string, changeId: string, created: boolean): CommitValue {
    const heads = this.heads();
    return {
      revision_id: revisionId,
      change_id: changeId,
      heads: heads.map((h) => h.revision_id),
      conflicted: heads.length > 1,
      projection_seq: this.state()?.projection_seq ?? 0,
      created,
    };
  }

  // ---- write core ----------------------------------------------------------

  private callCha<T>(fn: () => T): Result<T> {
    try {
      return ok(fn());
    } catch (e) {
      if (isChaError(e)) return err(e.code, e.message, e.context);
      throw e;
    }
  }

  // No await between the first storage write and the last: one atomic batch.
  private persist(st: StateRow | null, ids: { workspace_id: string; document_id: string }, p: Plan): CommitValue {
    const now = Date.now();
    const rev = p.prepared.revision as CanonicalRevision;
    const path = String(rev.state.host.path ?? "");
    this.ctx.storage.transactionSync(() => {
      for (const id of p.closeChangeIds) {
        this.sql.exec("UPDATE changes SET state = 'closed', closed_at = ? WHERE change_id = ?", now, id);
      }
      if (p.newChange) {
        this.sql.exec(
          "INSERT INTO changes (change_id, state, description, opened_at, last_activity_at) VALUES (?, 'open', ?, ?, ?)",
          p.changeId, p.description, now, now,
        );
      } else {
        this.sql.exec("UPDATE changes SET last_activity_at = ? WHERE change_id = ?", now, p.changeId);
      }
      const commitSeq = (st?.commit_seq ?? 0) + 1;
      const projectionSeq = (st?.projection_seq ?? 0) + 1;
      if (st) {
        this.sql.exec("UPDATE document_state SET projection_seq = ?, commit_seq = ? WHERE id = 1", projectionSeq, commitSeq);
      } else {
        this.sql.exec(
          "INSERT INTO document_state (id, workspace_id, document_id, projection_seq, published_seq, commit_seq) VALUES (1, ?, ?, ?, 0, ?)",
          ids.workspace_id, ids.document_id, projectionSeq, commitSeq,
        );
      }
      this.sql.exec(
        "INSERT INTO revisions (revision_id, change_id, content_blob_id, path, tombstone, canonical_json, commit_seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        p.prepared.revision_id, p.changeId, rev.content_blob_id, path, rev.state.tombstone ? 1 : 0,
        p.prepared.canonical, commitSeq, now,
      );
      for (const parent of p.parents) {
        this.sql.exec("INSERT INTO revision_parents (revision_id, parent_revision_id) VALUES (?, ?)", p.prepared.revision_id, parent);
        this.sql.exec("DELETE FROM heads WHERE revision_id = ?", parent);
      }
      for (const a of rev.attachments) {
        this.sql.exec(
          "INSERT INTO revision_attachments (revision_id, attachment_id, blob_id) VALUES (?, ?, ?)",
          p.prepared.revision_id, a.attachment_id, a.blob_id,
        );
      }
      this.sql.exec("INSERT INTO heads (revision_id, commit_seq) VALUES (?, ?)", p.prepared.revision_id, commitSeq);
      const op = p.operation.operation;
      this.sql.exec(
        "INSERT INTO operations (operation_id, kind, actor_id, created_at) VALUES (?, ?, ?, ?)",
        op.operation_id, p.kind, op.actor_id, now,
      );
      for (const c of op.changes) {
        this.sql.exec(
          "INSERT INTO operation_changes (operation_id, change_id, revision_id) VALUES (?, ?, ?)",
          op.operation_id, c.change_id, p.prepared.revision_id,
        );
      }
      if (p.closeAfter) {
        this.sql.exec("UPDATE changes SET state = 'closed', closed_at = ? WHERE change_id = ?", now, p.changeId);
      }
      const value = this.commitValue(p.prepared.revision_id, p.changeId, true);
      this.sql.exec(
        "INSERT INTO applied_operation_keys (operation_id, result_json) VALUES (?, ?)",
        p.operation_id, JSON.stringify(value),
      );
    });
    return this.commitValue(p.prepared.revision_id, p.changeId, true);
  }

  // Queue publish and alarm scheduling after the SQL writes; never fails the caller.
  private async afterWrite(): Promise<void> {
    await this.publish();
    await this.scheduleAlarm();
  }

  private async publish(): Promise<void> {
    const st = this.state();
    if (!st || st.published_seq >= st.projection_seq) return;
    const latest = this.sql
      .exec<{ revision_id: string }>("SELECT revision_id FROM revisions ORDER BY commit_seq DESC LIMIT 1")
      .one().revision_id;
    try {
      await this.env.PROJECTION_QUEUE.send({
        workspace_id: st.workspace_id,
        document_id: st.document_id,
        revision_id: latest,
        projection_seq: st.projection_seq,
      });
      this.sql.exec("UPDATE document_state SET published_seq = MAX(published_seq, ?) WHERE id = 1", st.projection_seq);
    } catch (e) {
      console.error("projection publish failed", e);
    }
  }

  private async scheduleAlarm(): Promise<void> {
    const st = this.state();
    const times: number[] = [];
    if (st && st.published_seq < st.projection_seq) times.push(Date.now() + REPUBLISH_DELAY_MS);
    const open = this.openChange();
    if (open) times.push(open.last_activity_at + IDLE_CLOSE_MS);
    if (times.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...times));
  }

  async alarm(): Promise<void> {
    const open = this.openChange();
    if (open && Date.now() - open.last_activity_at > IDLE_CLOSE_MS) {
      this.sql.exec("UPDATE changes SET state = 'closed', closed_at = ? WHERE change_id = ?", Date.now(), open.change_id);
    }
    await this.publish();
    await this.scheduleAlarm();
  }

  // ---- RPC -----------------------------------------------------------------

  async commit(req: CommitRequest): Promise<Result<CommitValue>> {
    const replayed = this.replay(req.operation_id);
    if (replayed) return replayed;

    const st = this.state();
    if (st && (st.document_id !== req.document_id || st.workspace_id !== req.workspace_id)) {
      return err("DOCUMENT_MISMATCH", "request does not match this document", {
        document_id: st.document_id,
      });
    }

    const heads = this.heads();
    if (req.base_revision_id !== null && !this.revisionRow(req.base_revision_id)) {
      return err("UNKNOWN_BASE", "base revision is unknown", { base_revision_id: req.base_revision_id });
    }
    const conflicted = heads.length > 1;
    if (req.require_head && conflicted) {
      return err("CONFLICTED", "document has several heads", { heads: heads.map((h) => h.revision_id) });
    }
    const head = heads.length === 1 ? heads[0]! : null;
    const extendsHead = head !== null && head.revision_id === req.base_revision_id;
    const fresh = heads.length === 0 && req.base_revision_id === null;
    if (req.require_head && !extendsHead && !fresh) {
      return err("STALE_BASE", "base revision is not the head", {
        base_revision_id: req.base_revision_id,
        heads: heads.map((h) => h.revision_id),
      });
    }

    if (extendsHead && head && this.sameContent(head, req)) {
      const value = this.commitValue(head.revision_id, this.revisionRow(head.revision_id)!.change_id, false);
      this.sql.exec(
        "INSERT OR IGNORE INTO applied_operation_keys (operation_id, result_json) VALUES (?, ?)",
        req.operation_id, JSON.stringify(value),
      );
      return ok(value);
    }

    const open = this.openChange();
    const reuse =
      req.kind === "autosave" &&
      open !== null &&
      req.base_revision_id !== null &&
      this.latestRevisionOfChange(open.change_id) === req.base_revision_id;
    const changeId = reuse ? open!.change_id : uuidv7();
    const parents = req.base_revision_id === null ? [] : [req.base_revision_id];

    const cha = getCha();
    const prepared = this.callCha(() =>
      cha.prepareRevision({
        document_id: req.document_id,
        change: { id: changeId, state: "open" },
        parents,
        content_blob_id: req.content_blob_id,
        attachments: req.attachments,
        state: { tombstone: false, host: { path: req.path } },
      }),
    );
    if (!prepared.ok) return prepared;
    const operation = this.callCha(() =>
      cha.prepareOperation({
        operation_id: req.operation_id,
        actor_id: req.actor_id,
        changes: [{ document_id: req.document_id, change_id: changeId }],
      }),
    );
    if (!operation.ok) return operation;

    if (this.revisionRow(prepared.value.revision_id)) {
      return ok(this.commitValue(prepared.value.revision_id, changeId, false));
    }

    const value = this.persist(st, req, {
      kind: req.kind,
      operation_id: req.operation_id,
      actor_id: req.actor_id,
      description: req.description ?? null,
      changeId,
      closeChangeIds: !reuse && open ? [open.change_id] : [],
      newChange: !reuse,
      closeAfter: req.kind !== "autosave",
      parents,
      prepared: prepared.value,
      operation: operation.value,
    });
    await this.afterWrite();
    return ok(value);
  }

  async restore(req: RestoreRequest): Promise<Result<CommitValue>> {
    const replayed = this.replay(req.operation_id);
    if (replayed) return replayed;
    const st = this.state();
    if (!st) return err("NOT_FOUND", "document does not exist");
    const heads = this.heads();
    if (heads.length !== 1) {
      return err("CONFLICTED", "restore requires exactly one head", { heads: heads.map((h) => h.revision_id) });
    }
    const target = this.revisionRow(req.target_revision_id);
    if (!target) return err("NOT_FOUND", "target revision not found", { revision_id: req.target_revision_id });
    const head = heads[0]!;
    const open = this.openChange();
    const changeId = uuidv7();

    const cha = getCha();
    const prepared = this.callCha(() =>
      cha.prepareRestore({
        document_id: st.document_id,
        change: { id: changeId, state: "open" },
        parents: [head.revision_id],
        target: { revision_id: target.revision_id, canonical: target.canonical_json },
        host: { path: head.path },
      }),
    );
    if (!prepared.ok) return prepared;
    const operation = this.callCha(() =>
      cha.prepareOperation({
        operation_id: req.operation_id,
        actor_id: req.actor_id,
        changes: [{ document_id: st.document_id, change_id: changeId }],
      }),
    );
    if (!operation.ok) return operation;

    const value = this.persist(st, st, {
      kind: "restore",
      operation_id: req.operation_id,
      actor_id: req.actor_id,
      description: null,
      changeId,
      closeChangeIds: open ? [open.change_id] : [],
      newChange: true,
      closeAfter: true,
      parents: [head.revision_id],
      prepared: prepared.value,
      operation: operation.value,
    });
    await this.afterWrite();
    return ok(value);
  }

  async resolve(req: ResolveRequest): Promise<Result<CommitValue>> {
    const replayed = this.replay(req.operation_id);
    if (replayed) return replayed;
    const st = this.state();
    if (!st) return err("NOT_FOUND", "document does not exist");
    const heads = this.heads();
    if (heads.length < 2) return err("NOT_CONFLICTED", "document has fewer than two heads", { count: heads.length });
    const stored: StoredRevision[] = heads.map((h) => ({
      revision_id: h.revision_id,
      canonical: this.revisionRow(h.revision_id)!.canonical_json,
    }));
    const open = this.openChange();
    const changeId = uuidv7();

    const cha = getCha();
    const prepared = this.callCha(() =>
      cha.prepareConflictResolution({
        document_id: st.document_id,
        change: { id: changeId, state: "open" },
        heads: stored,
        content_blob_id: req.content_blob_id,
        attachments: req.attachments,
        state: { tombstone: false, host: { path: req.path } },
      }),
    );
    if (!prepared.ok) return prepared;
    const operation = this.callCha(() =>
      cha.prepareOperation({
        operation_id: req.operation_id,
        actor_id: req.actor_id,
        changes: [{ document_id: st.document_id, change_id: changeId }],
      }),
    );
    if (!operation.ok) return operation;

    const value = this.persist(st, st, {
      kind: "resolve",
      operation_id: req.operation_id,
      actor_id: req.actor_id,
      description: null,
      changeId,
      closeChangeIds: open ? [open.change_id] : [],
      newChange: true,
      closeAfter: true,
      parents: heads.map((h) => h.revision_id),
      prepared: prepared.value,
      operation: operation.value,
    });
    await this.afterWrite();
    return ok(value);
  }

  async closeChange(): Promise<Result<{ change_id: string | null }>> {
    const open = this.openChange();
    if (open) {
      this.sql.exec("UPDATE changes SET state = 'closed', closed_at = ? WHERE change_id = ?", Date.now(), open.change_id);
    }
    await this.scheduleAlarm();
    return ok({ change_id: open?.change_id ?? null });
  }

  getState(): Result<StateValue> {
    const st = this.state();
    if (!st) return err("NOT_FOUND", "document does not exist");
    const heads = this.heads();
    return ok({
      workspace_id: st.workspace_id,
      document_id: st.document_id,
      heads,
      primary_head: heads[0]!.revision_id,
      conflicted: heads.length > 1,
      projection_seq: st.projection_seq,
      open_change_id: this.openChange()?.change_id ?? null,
    });
  }

  getHistory(): Result<ChangeHistory[]> {
    if (!this.state()) return err("NOT_FOUND", "document does not exist");
    const changes = this.sql
      .exec<ChangeRow>("SELECT * FROM changes ORDER BY opened_at DESC, rowid DESC")
      .toArray();
    return ok(
      changes.map((c) => ({
        ...c,
        revisions: this.sql
          .exec<RevisionRow>("SELECT * FROM revisions WHERE change_id = ? ORDER BY commit_seq DESC", c.change_id)
          .toArray()
          .map((r) => this.revisionValue(r)),
      })),
    );
  }

  getRevision(revisionId: string): Result<RevisionValue> {
    const row = this.revisionRow(revisionId);
    if (!row) return err("NOT_FOUND", "revision not found", { revision_id: revisionId });
    return ok(this.revisionValue(row));
  }

  private revisionValue(r: RevisionRow): RevisionValue {
    const op = this.sql
      .exec<{ operation_id: string; actor_id: string; kind: string }>(
        `SELECT o.operation_id, o.actor_id, o.kind FROM operation_changes oc
         JOIN operations o USING (operation_id) WHERE oc.revision_id = ? LIMIT 1`,
        r.revision_id,
      )
      .toArray()[0];
    return {
      revision_id: r.revision_id,
      change_id: r.change_id,
      content_blob_id: r.content_blob_id,
      path: r.path,
      tombstone: r.tombstone === 1,
      canonical: r.canonical_json,
      parents: this.sql
        .exec<{ parent_revision_id: string }>(
          "SELECT parent_revision_id FROM revision_parents WHERE revision_id = ? ORDER BY parent_revision_id",
          r.revision_id,
        )
        .toArray()
        .map((p) => p.parent_revision_id),
      attachments: this.attachmentsOf(r.revision_id),
      commit_seq: r.commit_seq,
      created_at: r.created_at,
      operation_id: op?.operation_id ?? null,
      actor_id: op?.actor_id ?? null,
      kind: op?.kind ?? null,
    };
  }

  private sameContent(head: HeadInfo, req: CommitRequest): boolean {
    if (head.content_blob_id !== req.content_blob_id || head.path !== req.path) return false;
    const stored = this.attachmentsOf(head.revision_id);
    if (stored.length !== req.attachments.length) return false;
    const byId = new Map(stored.map((a) => [a.attachment_id, a.blob_id]));
    return req.attachments.every((a) => byId.get(a.attachment_id) === a.blob_id);
  }
}
