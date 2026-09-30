import { DurableObject } from "cloudflare:workers";
import { isChaError } from "../cha/port";
import { readMeta, rewriteLinks, writeArachaMeta } from "../okf";
import { backlinks } from "../projection/queries";
import { relocateDocument } from "../rename";
import { loadBlob, storeBlob } from "../write";
import type { CommitRequest, CommitValue, Result, RpcError, StateValue } from "./document";

export const MAX_AUTO_ATTEMPTS = 5;
export const BACKOFF_BASE_MS = 2000;

export type OperationStatus = "pending" | "applying" | "partially_applied" | "completed";
export type TargetStatus = "pending" | "applied" | "failed";

export type StartRenameRequest = {
  operation_id: string;
  workspace_id: string;
  actor_id: string;
  document_id: string;
  new_path: string;
  inject_failures?: Record<string, number>;
};

export type TargetValue = {
  document_id: string;
  role: "target" | "link";
  status: TargetStatus;
  attempts: number;
  revision_id: string | null;
  last_error: string | null;
};

export type OperationValue = {
  operation_id: string;
  kind: "rename";
  status: OperationStatus;
  attempts: number;
  old_path: string;
  new_path: string;
  targets: TargetValue[];
};

type OperationRow = {
  operation_id: string;
  workspace_id: string;
  actor_id: string;
  kind: "rename";
  status: OperationStatus;
  params_json: string;
  attempts: number;
};
type Params = { document_id: string; old_path: string; new_path: string };

const err = (code: string, message: string, context: { [key: string]: unknown } = {}): Result<never> => ({
  ok: false,
  error: { code, message, context },
});
const ok = <T>(value: T): Result<T> => ({ ok: true, value });

class TargetFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class OperationCoordinatorDO extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;
  // Instance memory is enough: a running loop cannot outlive its isolate.
  private running = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  ping(): string {
    return "pong";
  }

  private migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS operation (
        id INTEGER PRIMARY KEY CHECK (id = 1), operation_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        actor_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, params_json TEXT NOT NULL,
        attempts INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS targets (
        document_id TEXT PRIMARY KEY, role TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL,
        revision_id TEXT, last_error TEXT);
      CREATE TABLE IF NOT EXISTS fault_budget (document_id TEXT PRIMARY KEY, remaining INTEGER NOT NULL);
    `);
  }

  private op(): OperationRow | null {
    return this.sql.exec<OperationRow>("SELECT * FROM operation WHERE id = 1").toArray()[0] ?? null;
  }

  private targets(): TargetValue[] {
    return this.sql
      .exec<TargetValue>(
        "SELECT document_id, role, status, attempts, revision_id, last_error FROM targets ORDER BY role DESC, document_id",
      )
      .toArray();
  }

  private statusValue(): OperationValue | null {
    const row = this.op();
    if (!row) return null;
    const params = JSON.parse(row.params_json) as Params;
    return {
      operation_id: row.operation_id,
      kind: row.kind,
      status: row.status,
      attempts: row.attempts,
      old_path: params.old_path,
      new_path: params.new_path,
      targets: this.targets(),
    };
  }

  private setStatus(status: OperationStatus, attempts?: number): void {
    this.sql.exec(
      "UPDATE operation SET status = ?, attempts = COALESCE(?, attempts), updated_at = ? WHERE id = 1",
      status,
      attempts ?? null,
      Date.now(),
    );
  }

  private markTarget(documentId: string, status: TargetStatus, fields: { revision_id?: string | null; error?: string | null } = {}): void {
    this.sql.exec(
      `UPDATE targets SET status = ?, attempts = attempts + 1, revision_id = COALESCE(?, revision_id), last_error = ?
       WHERE document_id = ?`,
      status,
      fields.revision_id ?? null,
      fields.error ?? null,
      documentId,
    );
  }

  // ---- RPC -----------------------------------------------------------------

  async startRename(req: StartRenameRequest): Promise<Result<OperationValue>> {
    const existing = this.statusValue();
    if (existing) return ok(existing);

    const state = (await this.env.DOCUMENT.getByName(req.document_id).getState()) as Result<StateValue>;
    if (!state.ok) return state;
    const head = state.value.heads.find((h) => h.revision_id === state.value.primary_head);
    if (!head) return err("NOT_FOUND", "document has no head", { document_id: req.document_id });

    // A concurrent startRename may have finished its own await first.
    if (this.op()) return ok(this.statusValue()!);
    const params: Params = { document_id: req.document_id, old_path: head.path, new_path: req.new_path };
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO operation (id, operation_id, workspace_id, actor_id, kind, status, params_json, attempts, created_at, updated_at)
         VALUES (1, ?, ?, ?, 'rename', 'applying', ?, 0, ?, ?)`,
        req.operation_id, req.workspace_id, req.actor_id, JSON.stringify(params), now, now,
      );
      this.sql.exec(
        "INSERT INTO targets (document_id, role, status, attempts) VALUES (?, 'target', 'pending', 0)",
        req.document_id,
      );
      if ((this.env.FAULT_INJECTION as string) === "1") {
        for (const [id, n] of Object.entries(req.inject_failures ?? {})) {
          this.sql.exec("INSERT OR REPLACE INTO fault_budget (document_id, remaining) VALUES (?, ?)", id, n);
        }
      }
    });
    return ok(await this.run());
  }

  async retry(): Promise<Result<OperationValue>> {
    if (!this.op()) return err("NOT_FOUND", "operation does not exist");
    return ok(await this.run());
  }

  async getStatus(): Promise<Result<OperationValue>> {
    const value = this.statusValue();
    return value ? ok(value) : err("NOT_FOUND", "operation does not exist");
  }

  async alarm(): Promise<void> {
    if (this.op()?.status === "partially_applied") await this.run();
  }

  // ---- apply loop ------------------------------------------------------------

  private async run(): Promise<OperationValue> {
    if (this.running) return this.statusValue()!;
    this.running = true;
    try {
      await this.applyOnce();
    } finally {
      this.running = false;
    }
    await this.mirror();
    return this.statusValue()!;
  }

  private async applyOnce(): Promise<void> {
    const row = this.op()!;
    const params = JSON.parse(row.params_json) as Params;
    const attempts = row.attempts + 1;
    this.setStatus("applying", attempts);

    const targetRow = this.targets().find((t) => t.role === "target")!;
    if (targetRow.status !== "applied") await this.applyTarget(row, params);
    if (this.targets().find((t) => t.role === "target")!.status === "applied") {
      await this.discoverLinks(params);
      for (const t of this.targets()) {
        if (t.role === "link" && t.status !== "applied") await this.applyLink(row, params, t.document_id);
      }
    }

    const done = this.targets().every((t) => t.status === "applied");
    this.setStatus(done ? "completed" : "partially_applied");
    if (!done && attempts < MAX_AUTO_ATTEMPTS) {
      await this.ctx.storage.setAlarm(Date.now() + BACKOFF_BASE_MS * 2 ** attempts);
    }
  }

  private async headOf(documentId: string): Promise<{ state: StateValue; revisionId: string; path: string; bytes: Uint8Array }> {
    const stub = this.env.DOCUMENT.getByName(documentId);
    const closed = (await stub.closeChange()) as Result<unknown>;
    if (!closed.ok) throw new TargetFailure(closed.error.code, closed.error.message);
    const res = (await stub.getState()) as Result<StateValue>;
    if (!res.ok) throw new TargetFailure(res.error.code, res.error.message);
    const state = res.value;
    if (state.conflicted) throw new TargetFailure("CONFLICTED", "document has several heads");
    const head = state.heads.find((h) => h.revision_id === state.primary_head)!;
    if (head.content_blob_id === null) throw new TargetFailure("NO_CONTENT", "head has no content");
    const bytes = await loadBlob(this.env, head.content_blob_id);
    if (!bytes) throw new TargetFailure("BLOB_MISSING", `blob missing: ${head.content_blob_id}`);
    return { state, revisionId: head.revision_id, path: head.path, bytes };
  }

  private async commit(row: OperationRow, req: Pick<CommitRequest, "document_id" | "kind" | "base_revision_id" | "content_blob_id" | "path">): Promise<CommitValue> {
    const res = (await this.env.DOCUMENT.getByName(req.document_id).commit({
      workspace_id: row.workspace_id,
      operation_id: row.operation_id,
      actor_id: row.actor_id,
      attachments: [],
      require_head: true,
      ...req,
    })) as Result<CommitValue>;
    if (!res.ok) throw new TargetFailure(res.error.code, res.error.message);
    return res.value;
  }

  private async attempt(documentId: string, work: () => Promise<string | null>): Promise<void> {
    try {
      const revisionId = await work();
      this.markTarget(documentId, "applied", { revision_id: revisionId });
    } catch (e) {
      const message = e instanceof TargetFailure ? `${e.code}: ${e.message}` : isChaError(e) ? `${e.code}: ${e.message}` : String(e);
      this.markTarget(documentId, "failed", { error: message });
    }
  }

  private applyTarget(row: OperationRow, p: Params): Promise<void> {
    return this.attempt(p.document_id, async () => {
      const head = await this.headOf(p.document_id);
      const moved = relocateDocument(head.bytes, p.old_path, p.new_path);
      const aliases = [...new Set([...readMeta(head.bytes).aliases, p.old_path])].filter((a) => a !== p.new_path);
      const bytes = writeArachaMeta(moved, { id: p.document_id, aliases });
      const value = await this.commit(row, {
        document_id: p.document_id,
        kind: "rename",
        base_revision_id: head.revisionId,
        content_blob_id: await storeBlob(this.env, bytes),
        path: p.new_path,
      });
      return value.revision_id;
    });
  }

  private async discoverLinks(p: Params): Promise<void> {
    try {
      const referrers = await backlinks(this.env, p.document_id);
      for (const r of referrers) {
        this.sql.exec(
          "INSERT OR IGNORE INTO targets (document_id, role, status, attempts) VALUES (?, 'link', 'pending', 0)",
          r.document_id,
        );
      }
    } catch (e) {
      console.error("backlink discovery failed", e);
    }
  }

  private consumeFault(documentId: string): boolean {
    const remaining = this.sql
      .exec<{ remaining: number }>("SELECT remaining FROM fault_budget WHERE document_id = ?", documentId)
      .toArray()[0]?.remaining;
    if (!remaining || remaining <= 0) return false;
    this.sql.exec("UPDATE fault_budget SET remaining = remaining - 1 WHERE document_id = ?", documentId);
    return true;
  }

  private async applyLink(row: OperationRow, p: Params, documentId: string): Promise<void> {
    if (this.consumeFault(documentId)) {
      this.markTarget(documentId, "failed", { error: "injected failure" });
      return;
    }
    await this.attempt(documentId, async () => {
      const head = await this.headOf(documentId);
      const bytes = rewriteLinks(head.bytes, head.path, p.old_path, p.new_path);
      if (bytes === head.bytes) return null;
      const value = await this.commit(row, {
        document_id: documentId,
        kind: "link_update",
        base_revision_id: head.revisionId,
        content_blob_id: await storeBlob(this.env, bytes),
        path: head.path,
      });
      return value.revision_id;
    });
  }

  // Best effort: the index is a view, so a D1 failure must not fail the operation.
  private async mirror(): Promise<void> {
    const value = this.statusValue();
    if (!value) return;
    const params = JSON.parse(this.op()!.params_json) as Params;
    try {
      await this.env.DB.prepare(
        `INSERT INTO operation_index (operation_id, kind, status, document_id, detail_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (operation_id) DO UPDATE SET status = excluded.status, detail_json = excluded.detail_json,
           updated_at = excluded.updated_at`,
      )
        .bind(
          value.operation_id,
          value.kind,
          value.status,
          params.document_id,
          JSON.stringify(value.targets.map((t) => ({ document_id: t.document_id, role: t.role, status: t.status }))),
          Date.now(),
        )
        .run();
    } catch (e) {
      console.error("operation_index mirror failed", e);
    }
  }
}
