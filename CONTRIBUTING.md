# Contributing to corridor-in-a-box

Thanks for your interest. This is the open, runnable manifest-driven engine for
Stellar SEP-31 cross-border corridors, with a `RouteResolver` extension seam.
Contributions
that keep corridors as _configuration, not code_ are exactly what we want.

## Ground rules

- A new corridor is a new `*.corridor.yaml` file — **not** a fork of the engine.
  If you find yourself adding a string like `"NGN"` or a bank name to
  `packages/engine`, stop: that fact belongs in a manifest.
- `packages/router` is the public `RouteResolver` interface and default
  implementation. Any future proprietary route-intelligence logic or dataset
  should be implemented outside this repo; none is included today.
- Money is never a JavaScript `number`. Use the string-based `Money` type and the
  helpers in `@corridor/types`.
- Every fallible operation returns `Outcome<T>` — we do not throw across module
  boundaries.

## Development setup

```bash
corepack enable          # or: npm i -g pnpm@9
pnpm install
pnpm typecheck           # whole monorepo, one tsc pass
pnpm test                # vitest: engine, manifest, money, sep31, stellar, service, …
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

### Quarantining a flaky test

Don't delete or `.skip` a test that flakes. Open an issue for it, then wrap it in
`quarantine()` from `tests/helpers/quarantine.ts`, giving the issue URL first:

```ts
quarantine(
  "https://github.com/ezedike-evan/corridor-in-a-box/issues/123",
  "socket 413",
  () => {
    it("rejects a body over the cap", async () => {
      /* … */
    });
  },
);
```

`pnpm test` skips quarantined blocks. `pnpm test:quarantine` runs only those
blocks, retrying each test up to 3 times. The non-blocking `quarantine` CI job
lists every quarantined test, its issue, and how it did in the job summary.
`tests/quarantine.test.ts` fails if a `quarantine()` call has no issue URL.
Once the issue is fixed, remove the wrapper.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/) prefixes
(`feat:`, `fix:`, `docs:`, `chore:`, `build:`, `test:`). Keep the subject line
under ~72 characters and explain the _why_ in the body.

## Good first issues

- Add a `*.corridor.yaml` for a live SEP-31 receive-side anchor (fill `dest.endpoints`
  from its `stellar.toml`) and a `plan` test asserting it reports runnable.
- Extend the conformance suite in `packages/adapter-kit` with more probes.
- Run the env-gated integration test against the Anchor Platform reference server
  and capture the trail in the README (see `tests/integration/` and
  [docs/operations.md](./docs/operations.md)).
- Widen the SEP-31 status mapping in `packages/sep31` as you hit real anchors that
  report statuses we don't yet classify (see `mapSep31Status`).

## Keeping docs in sync

| If you change X          | Also update Y                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| New error code           | `packages/service/src/index.ts` STATUS_BY_CODE, `web/lib/docs.ts` HTTP API page, `docs/operations.md` |
| New package              | README tree and web Architecture page                                                                 |
| New env var              | `.env.example`                                                                                        |
| Corridor liveness change | README tables, ROADMAP, grant-proposal                                                                |
| Any merged PR            | CHANGELOG Unreleased                                                                                  |

Note that `web/lib/docs.ts` duplicates README content by hand.

## License

By contributing you agree that your contributions are licensed under the
[Apache-2.0 License](./LICENSE).
