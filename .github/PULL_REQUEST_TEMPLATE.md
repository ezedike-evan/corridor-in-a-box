<!--
Thanks for contributing! Keep PRs focused: one logical change per PR.
See CONTRIBUTING.md for the ground rules.
-->

## What & why

<!-- What does this change, and why? Link any issue: "Closes #123". -->

## Type of change

- [ ] New corridor manifest (`*.corridor.yaml` only — no engine change)
- [ ] Bug fix
- [ ] Feature
- [ ] Docs
- [ ] Build / CI / chore

## Checklist

- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass locally
- [ ] Tests added/updated for any behaviour change (engine logic exercised through the mock adapter / submitter)
- [ ] No corridor-specific strings added to `packages/engine` (a corridor is configuration, not code)
- [ ] No dependency on the proprietary `RouteResolver` dataset added outside the `packages/router` seam
- [ ] Money handled via the `Money` type — never a JS `number`
- [ ] README / relevant doc updated if a public interface changed
- [ ] No secrets, signing keys, or `.env` files committed
