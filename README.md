# Aracha

OKF-native cloud PKM on Cloudflare Workers. History and identity semantics come from [cha](https://github.com/ochanuco/cha) through WebAssembly.

Design: `docs/shared/`, `docs/DESIGN.md`, `docs/adr/`, `docs/POC_IMPLEMENTATION.md`.

## Develop

```sh
pnpm install
pnpm typecheck
pnpm test                                      # Workers runtime; includes cha's contract vectors
pnpm exec wrangler d1 migrations apply aracha --local
pnpm dev                                       # add `--var FAULT_INJECTION:1` to enable rename fault injection
```

## Updating cha

```sh
scripts/vendor-cha.sh <path to cha checkout>   # after running its scripts/build-wasm.sh
pnpm test
```
