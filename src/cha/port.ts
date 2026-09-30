// Mirrors cha-abi/1 (cha repository, docs/ABI.md). No logic lives here.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type Change = { id: string; state: "open" | "closed" };
export type Attachment = { attachment_id: string; blob_id: string };
export type State = { tombstone: boolean; host: { [key: string]: Json } };
export type StoredRevision = { revision_id: string; canonical: string };

export type PreparedRevision = {
  revision_id: string;
  canonical: string;
  revision: object;
};

export type CanonicalRevision = {
  schema: "cha.revision/1";
  document_id: string;
  change_id: string;
  parents: string[];
  content_blob_id: string | null;
  attachments: Attachment[];
  state: State;
};

export type PrepareRevisionInput = {
  document_id: string;
  change: Change;
  parents: string[];
  content_blob_id: string | null;
  attachments: Attachment[];
  state: State;
};

export type PrepareRestoreInput = {
  document_id: string;
  change: Change;
  parents: string[];
  target: StoredRevision;
  host?: { [key: string]: Json };
};

export type PrepareConflictResolutionInput = {
  document_id: string;
  change: Change;
  heads: StoredRevision[];
  content_blob_id: string | null;
  attachments: Attachment[];
  state: State;
};

export type DiffNode = {
  kind: string;
  attributes?: { [key: string]: Json };
  text?: string | null;
  children?: DiffNode[];
};

export type SemanticDiffInput = { old: DiffNode; new: DiffNode };

export type DiffEvent =
  | { type: "NodeAdded"; path: number[]; kind: string }
  | { type: "NodeRemoved"; path: number[]; kind: string }
  | { type: "NodeModified"; old_path: number[]; new_path: number[]; kind: string }
  | {
      type: "AttributeChanged";
      old_path: number[];
      new_path: number[];
      name: string;
      old_value?: Json;
      new_value?: Json;
    }
  | {
      type: "TextChanged";
      old_path: number[];
      new_path: number[];
      old_text: string | null;
      new_text: string | null;
    }
  | {
      type: "ChildAdded";
      parent_old_path: number[];
      parent_new_path: number[];
      index: number;
      kind: string;
    }
  | {
      type: "ChildRemoved";
      parent_old_path: number[];
      parent_new_path: number[];
      index: number;
      kind: string;
    };

export type SemanticDiffOutput = { events: DiffEvent[] };

export type OperationChange = { document_id: string; change_id: string };
export type PrepareOperationInput = {
  operation_id: string;
  actor_id: string;
  changes: OperationChange[];
};
export type PrepareOperationOutput = {
  operation: { operation_id: string; actor_id: string; changes: OperationChange[] };
  multi_document: boolean;
};

export interface ChaPort {
  abiVersion(): string;
  blobId(bytes: Uint8Array): string;
  prepareRevision(input: PrepareRevisionInput): PreparedRevision;
  prepareRestore(input: PrepareRestoreInput): PreparedRevision;
  prepareConflictResolution(input: PrepareConflictResolutionInput): PreparedRevision;
  semanticDiff(input: SemanticDiffInput): SemanticDiffOutput;
  prepareOperation(input: PrepareOperationInput): PrepareOperationOutput;
}

export class ChaError extends Error {
  readonly code: string;
  readonly context: { [key: string]: Json };

  constructor(code: string, message: string, context: { [key: string]: Json } = {}) {
    super(message);
    this.name = "ChaError";
    this.code = code;
    this.context = context;
  }
}

export function isChaError(e: unknown): e is ChaError {
  return (
    e instanceof Error &&
    e.name === "ChaError" &&
    typeof (e as { code?: unknown }).code === "string"
  );
}
