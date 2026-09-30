# ADR-0009: Aracha consumes cha as external WASM
Status: Accepted

The Aracha Worker remains TypeScript.
Aracha consumes cha.wasm from the separate cha repository.
Aracha must not reimplement cha identity/history semantics in TypeScript.
workers-rs is not required for the PoC.
