# Shared system overview

Status: Accepted for PoC implementation  
Date: 2026-09-30

## Products

### Aracha

An OKF-native cloud PKM.

Owns:
- raw OKF Markdown editing,
- OKF parsing and graph semantics,
- Cloudflare Access,
- Document Durable Objects,
- Operation Coordinator Durable Objects,
- R2 content-addressed storage,
- Queue projection,
- D1 graph/backlink/FTS projection,
- autosave and simple offline draft safety,
- history/conflict/restore UI,
- invocation of cha through WebAssembly.

### cha

**Change History & Amendments for documents**

Owns:
- BlobId generation,
- RevisionId generation,
- Change semantics,
- immutable Revision DAG semantics,
- Operation semantics,
- restore semantics,
- conflict-resolution semantics,
- generic typed-tree semantic diff.

cha does not know OKF, Markdown, Cloudflare, HTTP, storage backends, or authentication.

## Runtime topology

```text
Browser
  │
  ▼
Aracha TypeScript Worker
  ├─ Cloudflare Access
  ├─ OKF parsing
  ├─ R2 CAS
  ├─ Queue
  ├─ D1
  ├─ Document Durable Objects
  ├─ Operation Coordinator Durable Objects
  └─ cha.wasm
        │
        ▼
      cha-core
```

## Sources of truth

| Concern | Canonical owner |
|---|---|
| Knowledge document bytes | Raw OKF Markdown blob |
| Document history / heads | Document Durable Object |
| Multi-document operation state | OperationCoordinator Durable Object |
| Blob bytes | R2 CAS |
| Graph/search projection | D1, derived |
| Semantic IR | Derived/cache only |

## Repository relationship

```text
cha repo
  cha-core
  cha-wasm
      │
      ▼
aracha repo
  consumes cha.wasm
```

## PoC vertical slice

1. edit OKF Markdown,
2. autosave,
3. store raw document blob in R2 CAS,
4. generate Change / Revision / Operation through cha,
5. persist history in Document DO,
6. generate semantic diff,
7. project current state through Queue into D1,
8. query graph/backlinks and FTS,
9. restore a historical revision,
10. create stale-edit conflict with multiple heads,
11. resolve manually into multi-parent Revision,
12. rename an OKF concept,
13. update known inbound links through one multi-document Operation,
14. demonstrate partial failure and retry,
15. preserve old path alias during projection lag,
16. export OKF losslessly,
17. replay one latest offline IndexedDB draft safely after reconnect.
