# Aracha PoC implementation spec

Refines `DESIGN.md` into modules, schemas, and interfaces. `DESIGN.md`, the ADRs, and `shared/` win on any conflict.

## OKF facts this implementation relies on

Source: <https://okf.md/spec/> (v0.2).

- Concept ID is the bundle-relative file path minus `.md` (`tables/users.md` → `tables/users`).
- `type` is the only required frontmatter key. Unknown keys must survive round-trip.
- Links are plain Markdown links. Absolute form starts with `/` and is bundle-root-relative (`[x](/tables/customers.md)`); relative form is resolved against the linking file. Broken links are legal.
- `index.md` and `log.md` are reserved and have no frontmatter.

## Interpretations of the design

- **Import is byte-exact.** Import never rewrites the file. If `aracha.id` is present and is a UUIDv7 it becomes the DocumentId; otherwise Aracha generates one and keeps it outside the file. `aracha.id` and `aracha.aliases` are written into frontmatter only when Aracha itself authors a revision (rename).
- **Path lives in revision state.** A document's path is recorded in the host part of cha's semantic revision state, so rename is part of canonical history and restore/export can recover it.
- **Primary head.** While a document has several heads, the projection and export use the earliest-committed head.
- **Path uniqueness** is checked against D1 and is therefore best-effort in the PoC.
- **ActorId** is the `Cf-Access-Authenticated-User-Email` header, or `dev` when absent (local development).
- **Workspace** is the single `WORKSPACE_ID` var.

## Modules

```text
src/
├─ index.ts            fetch router, queue consumer, DO re-exports
├─ ids.ts              UUIDv7 generation and validation
├─ cha/                ChaPort interface and the WASM loader
├─ okf/                frontmatter, typed tree, links
├─ cas.ts              R2 content-addressed store
├─ write.ts            the write path shared by API and coordinator
├─ do/document.ts      DocumentDO
├─ do/coordinator.ts   OperationCoordinatorDO
├─ projection/         queue consumer and D1 queries
├─ diff-labels.ts      cha diff events → UI categories
├─ export.ts           tar export
└─ api.ts              HTTP handlers
public/                raw Markdown editor UI
```

## `src/cha/`

The cha ABI (`cha-abi/1`) is defined in the cha repository at `docs/ABI.md`; Aracha mirrors its input and output types and adds no logic.

- `port.ts`: `ChaPort` with `abiVersion`, `blobId(bytes)`, `prepareRevision`, `prepareRestore`, `prepareConflictResolution`, `semanticDiff`, `prepareOperation`. Methods are synchronous, take and return parsed objects, and throw `ChaError` (`code`, `message`, `context`).
- `impl.ts`: `getCha(): ChaPort`, backed by `vendor/cha/cha_wasm_bg.wasm` initialised once per isolate with `initSync`. JSON encoding and decoding happen here and nowhere else.

Host state stored in every revision: `state.host = { "path": "<concept id>" }`.

## `src/okf/`

All functions are pure and take/return `Uint8Array` or strings; offsets are UTF-8 byte offsets.

- `splitDocument(bytes)` → `{ frontmatter: string | null, body: string, bodyOffset: number }`. A document without a leading `---` block has `frontmatter: null`.
- `readMeta(bytes)` → `{ type?, title?, description?, tags?: string[], arachaId?, aliases: string[], all: Record<string, unknown> }`. Invalid YAML yields an empty result, never a throw.
- `writeArachaMeta(bytes, { id, aliases })` → new bytes. Edits only the `aracha` key; every other key, comment, and the body stay byte-identical. Creates a frontmatter block when none exists.
- `toTypedTree(bytes)` → generic typed tree `{ kind, attributes, text, children }` with kinds `document`, `frontmatter`, `metadata` (`attributes.key`, `text` = JSON of the value), `section` (a heading plus everything up to the next heading of the same or higher level), `heading` (`attributes.level`), `paragraph`, `link` (`attributes.target`), `list`, `list_item`, `code_block` (`attributes.lang`), and `other`.
- `extractLinks(bytes, ownPath)` → `{ target: string, href: string, start: number, end: number }[]`. `target` is the resolved concept ID; `start`/`end` delimit the href inside the source. URLs with a scheme and pure `#fragment` links are skipped; a `#fragment` suffix is ignored for resolution.
- `rewriteLinks(bytes, ownPath, from, to)` → new bytes. Splices only the href spans that resolve to `from`; keeps each link's form (absolute stays absolute, relative is recomputed), its `.md` suffix, and its fragment.
- `PARSER_VERSION`, `IR_SCHEMA_VERSION` constants key the derived IR cache.

## `src/cas.ts`

- `blobKey(blobId)` maps `sha256:<hex>` to `blobs/sha256/<first two hex chars>/<hex>`.
- `putIfAbsent(bucket, blobId, bytes)` uses a conditional put and retries transient failures three times.
- `getBlob(bucket, blobId)` → bytes or `null`.
- Derived IR lives at `derived/ir/<PARSER_VERSION>/<IR_SCHEMA_VERSION>/<blobId>/tree.json`.

## Write path (`src/write.ts`)

```text
raw bytes → cha.blobId → putIfAbsent → DocumentDO.commit
```

`DocumentDO.commit` calls `cha.prepareRevision`, persists, and publishes the projection event. The DO never sees a BlobId whose bytes are not already in R2.

## DocumentDO

One instance per DocumentId, addressed with `getByName(documentId)`.

### Schema

```sql
document_state(id INTEGER PRIMARY KEY CHECK (id = 1), workspace_id, document_id,
               projection_seq INTEGER, published_seq INTEGER, commit_seq INTEGER)
heads(revision_id PRIMARY KEY, commit_seq INTEGER)
changes(change_id PRIMARY KEY, state, description, opened_at, closed_at, last_activity_at)
revisions(revision_id PRIMARY KEY, change_id, content_blob_id, path, tombstone INTEGER,
          canonical_json, commit_seq INTEGER, created_at)
revision_parents(revision_id, parent_revision_id, PRIMARY KEY (revision_id, parent_revision_id))
revision_attachments(revision_id, attachment_id, blob_id, PRIMARY KEY (revision_id, attachment_id))
operations(operation_id PRIMARY KEY, kind, actor_id, created_at)
operation_changes(operation_id, change_id, revision_id, PRIMARY KEY (operation_id, revision_id))
applied_operation_keys(operation_id PRIMARY KEY, result_json)
```

### RPC

- `commit(req)` where `req = { workspace_id, document_id, operation_id, actor_id, kind, base_revision_id, content_blob_id, path, attachments, require_head?, description? }` and `kind ∈ autosave | import | rename | link_update`.
  1. A repeated `operation_id` returns the stored result.
  2. Parents: no heads and `base_revision_id = null` → `[]`; otherwise `[base_revision_id]`, which must be a known revision. A base that is not the single head is a stale edit and produces a competing head.
  3. `require_head: true` turns a stale base into a `STALE_BASE` error instead (used by the coordinator, which retries).
  4. If the base is the single head and blob, path, and attachments are unchanged, return the head without a new revision.
  5. Change selection: `autosave` reuses the open Change when it extends that Change's latest revision; every other case closes the open Change and opens a new one. Non-autosave kinds close their Change immediately after the commit.
  6. `cha.prepareRevision`, then one synchronous SQL batch: revision, parents, attachments, operation, heads, `projection_seq + 1`, idempotency record.
  7. Publish `{ workspace_id, document_id, revision_id, projection_seq }` to the queue and advance `published_seq`.
- `restore({ operation_id, actor_id, target_revision_id })` requires a single head; uses `cha.prepareRestore`.
- `resolve({ operation_id, actor_id, content_blob_id, path, attachments })` requires two or more heads; uses `cha.prepareConflictResolution` with every head as parent and leaves one head.
- `closeChange()` closes the open Change.
- `getState()` → `{ workspace_id, document_id, heads: [{ revision_id, content_blob_id, path, commit_seq }], primary_head, conflicted, projection_seq, open_change_id }`.
- `getHistory()` → Changes with their Revisions (parents, operation, actor, kind, timestamps), newest first.
- `getRevision(revisionId)`.

### Alarm

A single alarm serves two jobs: republish when `published_seq < projection_seq`, and close the open Change after 5 minutes without activity.

## D1 projection

```sql
documents(document_id PRIMARY KEY, workspace_id, path UNIQUE, type, title, revision_id,
          content_blob_id, conflicted INTEGER, indexed_seq INTEGER)
aliases(alias_path PRIMARY KEY, document_id)
metadata(document_id, key, value_json, PRIMARY KEY (document_id, key))
edges(source_document_id, target_path, PRIMARY KEY (source_document_id, target_path))
search USING fts5(document_id UNINDEXED, path, title, body, tokenize = 'trigram')
operation_index(operation_id PRIMARY KEY, kind, status, document_id, detail_json, updated_at)
```

Consumer, per message: skip when `projection_seq <= indexed_seq`; otherwise read `DocumentDO.getState()`, load the primary head's blob, parse, and replace that document's rows in one batch, storing the DO's `projection_seq`. Failures are retried by the queue.

Queries:
- resolve path → document, through `documents.path` then `aliases.alias_path`,
- backlinks of a document: `edges` whose `target_path` is its path or one of its aliases,
- graph: all edges with targets resolved the same way,
- search: FTS5 match.

## OperationCoordinatorDO

One instance per OperationId. Statuses: `pending → applying → partially_applied | completed`.

```sql
operation(id INTEGER PRIMARY KEY CHECK (id = 1), operation_id, workspace_id, actor_id, kind,
          status, params_json, attempts INTEGER, created_at, updated_at)
targets(document_id PRIMARY KEY, role, status, attempts INTEGER, revision_id, last_error)
fault_budget(document_id PRIMARY KEY, remaining INTEGER)
```

- `startRename({ operation_id, actor_id, document_id, new_path, inject_failures? })`.
- `retry()` and the alarm run the same apply loop.
- `getStatus()` → operation row plus targets.

Apply loop:
1. Target document first: write `aracha.id` and the old path into `aracha.aliases`, commit with the new path, kind `rename`.
2. Query D1 backlinks of the old path and add unseen documents as `link` targets. Re-running this on every attempt picks up references that were not yet projected.
3. For each non-applied target: load head, `rewriteLinks(old → new)`, commit with kind `link_update`, `require_head: true`, and the shared `operation_id`. A conflicted document fails the target.
4. All applied → `completed`. Otherwise → `partially_applied`, and the alarm retries with backoff up to five automatic attempts; `retry()` stays available afterwards.
5. Mirror status into D1 `operation_index`.

`inject_failures` (`{ document_id: count }`) is honoured only when `FAULT_INJECTION = "1"`; each listed target fails that many times before succeeding.

Alias cleanup removes an alias from the target's frontmatter only when D1 shows no edge to the old path.

## HTTP API

| Method and path | Purpose |
|---|---|
| `POST /api/documents` `{ path, markdown }` | import / create |
| `GET /api/documents` | list |
| `GET /api/documents/by-path?path=` | resolve path or alias |
| `GET /api/documents/:id` | state plus Markdown of every head |
| `PUT /api/documents/:id/autosave` `{ operation_id, base_revision_id, markdown }` | autosave |
| `POST /api/documents/:id/close-change` | close the open Change |
| `GET /api/documents/:id/history` | history |
| `GET /api/documents/:id/revisions/:rev` | raw bytes of a revision |
| `GET /api/documents/:id/diff?from=&to=` | semantic diff with labels |
| `POST /api/documents/:id/restore` `{ operation_id, revision_id }` | restore |
| `POST /api/documents/:id/resolve` `{ operation_id, markdown }` | conflict resolution |
| `GET /api/documents/:id/backlinks` | backlinks |
| `GET /api/graph` | edges |
| `GET /api/search?q=` | full-text search |
| `POST /api/rename` `{ document_id, new_path, inject_failures? }` | start rename |
| `GET /api/operations/:id` | operation status |
| `POST /api/operations/:id/retry` | manual retry |
| `POST /api/aliases/cleanup` `{ document_id, alias }` | alias cleanup |
| `GET /api/export` | tar of every document's primary head at `<path>.md` |

Errors are `{ code, message, context }` JSON; cha errors pass through unchanged.

## UI

One static page, no build step.

- Document list, search box, new-document form.
- Raw Markdown `<textarea>` with autosave: 1 s debounce, forced every 10 s while typing, full payload with `base_revision_id`. `close-change` is sent with `sendBeacon` on page leave.
- IndexedDB holds one record per document: `{ document_id, base_revision_id, markdown }`, written before each send and cleared on success. On load or `online`, a leftover record is replayed once.
- History panel: Changes (autosaves collapsed), semantic diff against the previous revision, restore button.
- Conflict view when `conflicted`: editing is disabled, heads are shown side by side, a resolution textarea submits to `resolve`.
- Rename form with operation status, per-target results, and a retry button.
- Backlinks panel.
