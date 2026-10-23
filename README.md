# five

An experimental self-modifying agent: one agent, in a loop that never stops,
that reads and rewrites its own context — system prompt included.

- **The loop.** Each turn sends the context (system prompt + every message so
  far) with the next prompt appended as a user message. The model makes as many
  tool calls as it likes; the turn ends when it replies without a call or calls
  `end_turn`. The next turn starts with the prompt it set with
  `set_next_prompt`, or the same one again.
- **The context is the agent's.** `read_context`, `set_system_prompt`,
  `edit_system_prompt`, `edit_message`, `insert_message`, `delete_messages`,
  `set_next_prompt`, `end_turn`. Changes apply from the next model call. Five
  never adds anything to the system prompt; messages pile up until the agent
  removes them, and Ollama silently drops the oldest text when the window fills.
- **seven's tools.** `run_js`, `define_tool`, `read_tool`, `delete_tool`,
  `tool_health`, `disable_tool`, `enable_tool`, `start_tool`, `run_status`,
  `wait_run`, `kill_run`, `list_runs`, `sql`, and every tool the agent builds.
  Code runs in a Node.js child process per run, with no permission model.
- **Model.** Ollama, `qwen3.5:9b` by default.
- **State.** One SQLite file, `<workspace>/.five/five.db`: the context, the event
  log, tools, runs. A restart resumes where it stopped.
- **Web UI** (Preact, seven's and nine's design tokens), polling the JSON API:
  *Loop* follows turns live and has Start / Pause / Step / Stop turn; *Context*
  shows and edits the system prompt, next prompt and messages while paused, and
  resets; *Tools* lists what the agent built.

## Running

| How | Command | UI |
|---|---|---|
| Docker (Ollama on the host) | `make up` · `make logs` · `make down` | `http://<host>:5555` |
| Host, Node ≥ 24 | `npm ci && npm ci --prefix web && make start-host` | `http://127.0.0.1:5555` |

The loop waits for **Start** unless `FIVE_AUTOSTART=on`. Configuration is
environment only; `.env.example` lists every variable. All data lives in the
workspace (`./workspace` under Docker).

## API

| Method | Path | Does |
|---|---|---|
| GET | `/api/v1/status` | model, limits, loop state, token use, last event seq |
| POST | `/api/v1/loop/{start,pause,stop,step}` | control the loop (`stop` also ends the turn) |
| GET | `/api/v1/context` | system prompt, next prompt, turn, messages |
| PUT | `/api/v1/context/system`, `/api/v1/context/next` | `{text}`; refused (409) during a turn |
| PUT, DELETE | `/api/v1/context/messages/:i` | edit `{content}` or delete a message |
| POST | `/api/v1/context/reset` | seed context, turn 0, events cleared |
| GET | `/api/v1/events?after=<seq>` or `?turns=<n>` | the event log |
| GET | `/api/v1/tools`, `/api/v1/tools/:name` | built tools |

Writes need `content-type: application/json`.

## Development

`make ci` (in the dev container) or `make ci-host`: typecheck, Biome, the
tests (`node --test`, against a scripted model), and the web UI's typecheck.

## Limits

- **No sign-in.** Docker publishes port 5555 on every interface: anyone who
  reaches it can drive the agent, and the agent runs arbitrary code.
  `FIVE_PUBLISH=127.0.0.1` keeps it local.
- **No context management by five.** Overflow is the agent's problem; the UI
  shows the last call's prompt tokens against the window.
- One process per workspace; nothing prevents a second one.
