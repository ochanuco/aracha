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

## Deploy

Production is deployed by running the `deploy` GitHub Actions workflow manually with `ref` set to `main` (or a commit SHA on main). It runs `scripts/deploy.sh production` (`wrangler deploy`) after the `production` Environment is approved. D1 migrations are not applied by the deploy; run `pnpm exec wrangler d1 migrations apply aracha --remote` by hand for each PR that adds one.

## Updating cha

```sh
scripts/vendor-cha.sh <path to cha checkout>   # after running its scripts/build-wasm.sh
pnpm test
```
