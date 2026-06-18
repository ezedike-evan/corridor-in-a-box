# Contributing to corridor-in-a-box

Thanks for your interest. This is the **open half** of an open-core system: a
manifest-driven engine for Stellar SEP-31 cross-border corridors. Contributions
that keep corridors as _configuration, not code_ are exactly what we want.

## Ground rules

- A new corridor is a new `*.corridor.yaml` file — **not** a fork of the engine.
  If you find yourself adding a string like `"NGN"` or a bank name to
  `packages/engine`, stop: that fact belongs in a manifest.
- Anything that depends on the proprietary route-intelligence dataset belongs
  behind the `RouteResolver` seam (`packages/router`), not in this repo.
- Money is never a JavaScript `number`. Use the string-based `Money` type and the
  helpers in `@corridor/types`.
- Every fallible operation returns `Outcome<T>` — we do not throw across module
  boundaries.

## Development setup

```bash
corepack enable          # or: npm i -g pnpm@9
pnpm install
pnpm typecheck           # whole monorepo, one tsc pass
pnpm test                # vitest: engine + manifest
pnpm lint                # eslint + prettier --check
pnpm example             # run a payment end-to-end (mocked anchor + settle)
```

Node 22+ and pnpm 9+ are required (see `.nvmrc` and `packageManager` in
`package.json`).

## Before you open a PR

Run the full gate locally — CI runs the same three commands:

```bash
pnpm lint && pnpm typecheck && pnpm test
```

- Keep PRs focused. One logical change per PR.
- Add or update tests for any behavior change. Engine logic must be exercised
  through the mock adapter / mock submitter (see `tests/engine.test.ts`).
- Update the README or relevant doc when you change a public interface.
- Do **not** commit secrets, signing keys, or `.env` files.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/) prefixes
(`feat:`, `fix:`, `docs:`, `chore:`, `build:`, `test:`). Keep the subject line
under ~72 characters and explain the _why_ in the body.

## Good first issues

- Implement the SEP-10 challenge/response handshake in `Sep31Adapter.authToken()`.
- Add a `*.corridor.yaml` for a live SEP-31 receive-side anchor and a `plan` test.
- Extend the conformance suite in `packages/adapter-kit` with more probes.

## License

By contributing you agree that your contributions are licensed under the
[Apache-2.0 License](./LICENSE).
