# Aracha agent instructions

Read:
1. `docs/shared/SYSTEM_OVERVIEW.md`
2. `docs/shared/WASM_CONTRACT.md`
3. `docs/DESIGN.md`
4. `docs/adr/*`

You own the Aracha repository.

cha is a separate repository producing a WASM artifact.

Do not reimplement BlobId, RevisionId, Change, Revision DAG, restore, conflict-resolution, or semantic-diff algorithms in production TypeScript.

If cha is not ready yet, use a narrow integration test double only at the WASM boundary.

Primary objective: prove the full Cloudflare vertical slice in `docs/DESIGN.md`.
