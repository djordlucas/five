# five — working agreement

- Node 24, TypeScript run directly (type stripping, no build); relative imports
  carry `.ts`. Web UI in `web/` (Preact + Vite) imports only `src/api/types.ts`.
- Much is copied from `../seven`: the runner, tool store, built-ins, Ollama
  client, logging, web tokens. Keep those close to seven's so fixes port over.
- Five's own parts: `src/agent/loop.ts` (the supervisor loop),
  `src/agent/context.ts` (context tools), `src/agent/prompt.ts` (the seed),
  `src/state.ts`, `src/api/server.ts`.
- Verify with `make ci-host` (or `make ci`) before committing.
- An API change touches `src/api/server.ts`, `src/api/types.ts`, the test, the
  README's endpoint table and the UI page that uses it.
