# corridor-in-a-box — web

A small Next.js (App Router, Tailwind v4) frontend for the engine:

- **Dashboard** — the corridors with build-time liveness (runnable / not runnable).
- **Run a payment** — drive a payment through the engine and watch it walk the
  state machine, including the idempotent replay.
- **Docs** — overview, getting started, architecture, HTTP API, key management.

It is a standalone app (not part of the pnpm workspace), so it builds and runs on
its own without touching the monorepo's test/lint gate.

## Develop

```bash
cd web
pnpm install
pnpm dev      # http://localhost:3000
```

```bash
pnpm typecheck
pnpm build
```

## How it talks to the engine

By default the **Run a payment** page calls a local API route
(`app/api/payments/route.ts`) that drives a faithful simulation of
`@corridor/engine` (`lib/engine-sim.ts`) — same state machine and idempotency
rules. To drive the real engine, run `@corridor/service` and point the route at
it (`CORRIDOR_SERVICE_URL`).
