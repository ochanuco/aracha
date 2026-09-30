# Aracha / cha agent handoff

This bundle is intended to be handed to one coordinating Claude Agent, which may delegate work to another agent.

There are two repositories:

- `aracha/` — Cloudflare-based OKF PKM application.
- `cha/` — standalone Rust document history/version-control engine.
- `shared/` — cross-repository contract and system-level architecture.

## Read order

1. `shared/SYSTEM_OVERVIEW.md`
2. `shared/WASM_CONTRACT.md`
3. `aracha/docs/DESIGN.md`
4. `cha/docs/DESIGN.md`
5. ADRs under each repository folder.

## Hard boundary

### Aracha must not

- reimplement cha Change / Revision / Operation semantics in TypeScript,
- independently implement BlobId or RevisionId algorithms,
- push Cloudflare-specific concerns into cha.

### cha must not

- depend on Aracha,
- depend on Cloudflare,
- depend on OKF or Markdown,
- depend on Durable Objects, D1, R2, HTTP, authentication, or TypeScript.

`cha-core` is deterministic and I/O-free.
Aracha supplies OKF parsing, persistence, coordination, graph/search, and Cloudflare integration.
