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

Production is deployed by the `deploy` GitHub Actions workflow on every push to `main`. It stops for approval in the `production-approval` Environment only when there is no previous deploy record, when rolling back, or when a change needs a manual step; the `plan` job summary of the run shows what ships and why approval is needed. Run the workflow manually with `ref` set to a commit SHA on main to roll back. It runs `scripts/deploy.sh production` (`wrangler deploy`). D1 migrations are not applied by the deploy; run `pnpm exec wrangler d1 migrations apply aracha --remote` by hand for each PR that adds one.

## Updating cha

```sh
scripts/vendor-cha.sh <path to cha checkout>   # after running its scripts/build-wasm.sh
pnpm test
```
