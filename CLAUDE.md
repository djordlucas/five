# five — working agreement

- Node 24, TypeScript run directly (type stripping, no build); relative imports
  carry `.ts`. Web UI in `web/` (Preact + Vite) imports only `src/api/types.ts`.
- Much is copied from `../seven`: the runner, tool store, built-ins, Ollama
  client, logging, web tokens. Keep those close to seven's so fixes port over.
- Five's own parts: `src/workers/` — the main loop (`scheduler.ts`), agents
  (`agent.ts`), the lead, the chat and task workers (`lead.ts`, `chat.ts`,
  `task.ts`), the board, the worker store, seeds, model slots, settings, tools
  and web helpers — plus `src/agent/media.ts` (images and PDFs),
  `src/tools/libs.ts` and `src/agent/builtins/libs.ts` (libraries),
  `src/state.ts`, `src/api/server.ts`.
- Keep every model call small: an agent's context is built fresh, grows by
  appending only, and gets only the tools it needs. The lead and the chat are
  fixed; only task workers are the lead's to write.
- Verify with `make ci-host` (or `make ci`) before committing.
- An API change touches `src/api/server.ts`, `src/api/types.ts`, the test, the
  README's endpoint table and the UI page that uses it.
