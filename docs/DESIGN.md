# Aracha PoC design

Status: Accepted for PoC implementation

Aracha is the Cloudflare-hosted OKF-native PKM application.

It consumes `cha.wasm` from the separate cha repository.

## Canonical knowledge representation

- Raw OKF Markdown bytes are canonical.
- Target OKF v0.2.
- Import/export is lossless.
- Unknown frontmatter, comments, whitespace, and formatting survive round-trip.
- Parsed IR is derived and disposable.

Aracha extension:

```yaml
aracha:
  id: <UUIDv7>
  aliases:
    - concepts/old-path
```

OKF path remains the OKF concept identity.
`aracha.id` remains stable across rename.

## Cloudflare architecture

```text
Browser
  │
  ▼
Aracha Worker (TypeScript)
  ├─ Cloudflare Access
  ├─ OKF parser
  ├─ cha.wasm integration
  ├─ R2 CAS
  ├─ Queue publisher/consumer
  └─ D1 query layer

Document Durable Object
  ├─ heads
  ├─ Changes
  ├─ Revisions
  ├─ single-document Operations
  ├─ projection_seq
  └─ idempotency records

OperationCoordinator Durable Object
  ├─ multi-document Operation
  ├─ per-document apply state
  ├─ retry state
  └─ compensation references

R2
  ├─ raw OKF Markdown blobs
  ├─ attachment blobs
  └─ derived IR cache

D1
  ├─ documents
  ├─ metadata
  ├─ graph edges/backlinks
  ├─ FTS5
  └─ operation_index
```

## Document Durable Object

```text
1 DocumentId = 1 Document Durable Object
```

Use SQLite-backed Durable Objects.

It owns canonical document history state.

Suggested schema families:
- document_state
- heads
- changes
- revisions
- revision_parents
- revision_attachments
- operations
- operation_changes
- applied_operation_keys

### Stale edits

Autosave includes:
- `base_revision_id`
- full raw Markdown

If base is stale:
- do not reject user work,
- persist it as a competing Revision/head.

If multiple heads exist:
- block normal editing,
- show conflict-resolution UI.

Resolution:
- new ChangeId,
- new Revision with all conflicting heads as parents,
- collapse heads to one.

## Autosave and Change lifecycle

Editor: raw Markdown text editor.

Autosave:
- 1 second debounce,
- forced at least every 10 seconds during continuous typing,
- full Markdown payload, not patches.

Change closes:
- after 5 minutes idle,
- on page leave,
- before AI edit, restore, rename, import, and other important operations.

Every autosave creates an internal Operation but normal UI collapses them.

## R2 CAS

Aracha asks cha to compute BlobId.

Raw key pattern:

```text
blobs/sha256/<prefix>/<digest>
```

Raw Markdown and attachments share the content-only CAS.

Write order:

```text
raw bytes
→ cha blob_id
→ R2 put-if-absent
→ cha prepare_revision
→ Document DO commit
→ Queue projection event
```

Never commit a Revision before referenced blobs exist.

Derived IR:

```text
derived/ir/<parser-version>/<schema-version>/<source-blob-id>/...
```

IR is disposable.

## Attachments

Attachments are versioned.

Revision attachment manifest maps stable AttachmentIds to BlobIds.

Restore restores historical attachment state.

## D1 projection

D1 is eventually consistent and never canonical.

Use purpose-specific tables:
- documents
- metadata
- edges
- FTS5 search
- operation_index

Document DO owns monotonic `projection_seq`.

Queue payload:

```json
{
  "workspace_id": "...",
  "document_id": "...",
  "revision_id": "...",
  "projection_seq": 42
}
```

Consumer ignores messages with `incoming_seq <= indexed_seq`.

Otherwise reload authoritative state and rebuild projection.

## Concept rename

Required multi-document PoC scenario:

```text
concepts/rust
→ languages/rust
```

Flow:
1. create OperationId,
2. create OperationCoordinatorDO,
3. rename target document,
4. preserve old path as alias,
5. query D1 backlinks,
6. apply link updates to known referencing Document DOs,
7. each document gets its own ChangeId/Revision,
8. track per-document results,
9. allow `partially_applied`,
10. retry idempotently,
11. reindex/repair later,
12. allow explicit alias cleanup only after no old references remain.

## Multi-document Operation

Canonical state belongs to OperationCoordinatorDO.

Statuses:
- pending
- applying
- partially_applied
- completed

Idempotency key:
```text
(OperationId, DocumentId)
```

Cancellation creates a compensating Operation and forward revisions.

## Semantic diff integration

Aracha parses OKF Markdown into generic typed-tree IR.

Pass IR to cha.

UI semantic categories:
- headings
- paragraphs
- links/link targets
- frontmatter metadata
- list items
- code blocks
- sections

cha returns generic events; Aracha maps them to labels.

## Offline safety

IndexedDB stores only:
- latest unsent full Markdown,
- base_revision_id,
- document identity.

No local revision graph.

Reconnect replays once.
If stale, normal competing-head conflict behavior applies.

## Authentication

Use Cloudflare Access.

Do not implement login, ACL, or sharing in PoC.

Keep workspace_id in the model.

## Retry behavior

Automatically retry:
- R2 writes,
- Queue consumers,
- D1 projection,
- multi-document target application.

Persistent failures stay observable and manually retryable.

Never silently drop user content.

## PoC acceptance criteria

Demonstrate:
1. OKF Markdown edit,
2. autosave,
3. R2 CAS,
4. Change/Revision/Operation through cha,
5. Document DO history,
6. semantic diff,
7. Queue → D1 projection,
8. graph/backlinks,
9. FTS5,
10. history UI,
11. restore,
12. stale conflict with multiple heads,
13. manual multi-parent resolution,
14. concept rename,
15. backlink updates via coordinator,
16. forced partial failure,
17. retry to completed,
18. alias repair behavior,
19. lossless export,
20. latest IndexedDB draft replay.

## Explicit non-goals

- automatic merge
- CRDT/OT
- block editor
- vector search
- production GC
- multi-user ACL
- strict multi-DO transaction
- TypeScript reimplementation of cha semantics
