# cha WASM contract

Status: PoC contract

This is the cross-repository contract between cha and Aracha.

It defines behavior and data ownership, not the final ABI.

## Rules

- Inputs/outputs must be deterministic and serializable.
- Errors use structured `code`, `message`, and `context`.
- cha performs no network or storage I/O.
- Aracha performs all persistence and Cloudflare orchestration.
- cha is the single implementation of BlobId and RevisionId algorithms.
- Aracha must not duplicate those algorithms.

## Required PoC operations

### `blob_id`

Input:
- raw bytes

Output:
- self-describing BlobId, initially `sha256:<digest>`.

### `prepare_revision`

Input:
- DocumentId
- ChangeId
- parent RevisionIds
- content BlobId
- attachment manifest
- semantic revision state

Output:
- canonical revision state
- RevisionId

Rules:
- no timestamp in RevisionId identity,
- no OperationId,
- no ActorId,
- ChangeId is included,
- unordered collections are canonicalized.

### `semantic_diff`

Input:
- old generic typed-tree IR
- new generic typed-tree IR

Output:
- deterministic generic semantic change events.

Event families:
- NodeAdded
- NodeRemoved
- NodeModified
- AttributeChanged
- TextChanged
- child add/remove changes

Aracha maps these into domain-specific labels.

### `prepare_restore`

Produces data for a new forward-moving Revision that references historical content state.

### `prepare_conflict_resolution`

Produces a new Revision whose parent set contains all conflicting heads.

## Generic typed tree

```json
{
  "kind": "heading",
  "attributes": {
    "level": 2
  },
  "text": "Storage",
  "children": []
}
```

cha treats `kind` as opaque domain data and does not know Markdown node types.

## Identity types

- WorkspaceId: UUIDv7, Aracha repository mapping
- DocumentId: UUIDv7
- ChangeId: UUIDv7
- OperationId: UUIDv7
- ActorId: opaque string
- BlobId: self-describing content hash
- RevisionId: content hash of canonical revision state

## Contract tests

cha owns test vectors for:
- BlobId hashing,
- canonical RevisionId hashing,
- semantic diff,
- multi-parent conflict-resolution construction.

Aracha integration tests call the real WASM implementation and validate those vectors rather than reimplementing them.
