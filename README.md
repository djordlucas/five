# five

An experimental self-modifying agent: one agent, in a loop that never stops,
that reads and rewrites its own context — system prompt included — and builds
its own tools. Line seven/nine's sibling, and the most minimal of them: one
agent, one context, one SQLite file, Ollama.

![Architecture of five: the web UI and Ollama outside; in the container, the five process — HTTP API, supervisor loop, context, state, runner and tools — its child processes and the workspace](docs/architecture.png)

`docs/architecture.svg` is the source; `docs/architecture.png` is it rendered at 2×.

## How it works

| Part | What it does |
|---|---|
| The loop | Each turn appends the **next prompt** to the context as a user message and sends the whole context to the model. The model makes as many tool calls as it likes (up to `FIVE_MAX_STEPS` model calls); the turn ends when it calls `end_turn` or replies without a call. A turn that ends with a reply is folded into it, as `end_turn` folds one into its summary, if it did work; if it did none, it leaves nothing in the context (`FIVE_FOLD_REPLIES`). The next turn starts with the prompt the agent set with `end_turn` or `set_next_prompt`, or the same one again. |
| The context | The system prompt, every message of every turn, and the next prompt. All of it is the agent's to change; the seed calls it the agent's working memory. Messages pile up until the agent deletes them, and Ollama silently drops the oldest text when the window (`FIVE_CONTEXT_TOKENS`) is full. |
| Self block | Sent after the messages with every model call — last, so that Ollama reuses its work on the unchanged system prompt and messages — rebuilt each time and not part of the context the agent edits (nine's self-model, made small): who it is, the turn and step, its goal's first line, how full its working memory is, its note and tool counts, its inbox, and its own self note, `memory/self.md` (at most 1500 characters). The Workspace page's Context tab shows it. |
| Inbox | `message_person(subject, text)` puts a message, with a subject of at most 120 characters, in the person's inbox, at most once a turn, and returns at once: the loop never waits. What the person writes back on the Inbox page is put before the prompt of the next turn. |
| Supervisor | `src/agent/supervisor.ts`: every way five steps into the loop — the guards, folding turns, the self block, the limits on the agent's tools — with one set of settings, tunable on the Config page while the loop runs. A change applies from the next time it is checked (most at the next turn) and is kept in the state; the environment variables below give the defaults. |
| Guards | Five keeps out of the context but for these. When the last model call used more than `FIVE_CONTEXT_WARN` percent of the window, the turn's prompt starts with a warning to save to memory and delete messages, naming the one `delete_messages` call that drops every earlier turn. Above `FIVE_CONTEXT_TRIM` percent, the model can no longer make that call, so five drops the oldest messages itself, down to about half the window, and the turn's prompt says so. A turn that does no work — no tool call beyond `read_context`, `memory_read`, `message_person`, `set_next_prompt`, `end_turn` and writing the self note — makes the next prompt start with a note to get back to work, or to set a new goal if the old one is done; `FIVE_IDLE_TURNS` such turns in a row pause the loop. When `staleTurns` turns in a row (3) start with the same prompt, the next one's prompt starts with a note that it may ask for work already done. `set_next_prompt` and `end_turn` refuse a next prompt that repeats the turn's own, opens by reporting what is done ("Turn 22 complete…"), or waits for a user ("Awaiting user request…", "standby"): no one answers a prompt, and `message_person` is the way to ask. |
| Context tools | `read_context`, `set_system_prompt`, `edit_system_prompt`, `edit_message`, `insert_message`, `delete_messages`, `set_next_prompt`, `end_turn`, and `message_person`. A change applies from the next model call. `end_turn(summary, next)` keeps the context in one call: the summary replaces every message of the turn, and `next` sets the next prompt. |
| Memory | `memory_write` and `memory_read`: notes the agent saves as `<workspace>/memory/<name>.md` and reads back in later turns — what outlives the context. The seed teaches it to start each turn with `memory_read` and save results as it goes. |
| seven's tools | `run_js`, `define_tool`, `read_tool`, `delete_tool`, `tool_health`, `disable_tool`, `enable_tool`, `start_tool`, `run_status`, `wait_run`, `kill_run`, `list_runs`, `sql` — and every tool the agent builds. A result of a run longer than `FIVE_RESULT_CHARS` is kept whole in `<workspace>/results/`, and the context gets its start and the file's path. Each run is its own Node.js child process with all of Node and npm, and **no permission model**. In a run, `five.llm.chat`, `five.db` and `five.tools.<name>` reach back into five. |
| Images and PDFs | `view_image(path)` shrinks a workspace image to fit the Config setting "Images shrunk to" (1024 px a side by default), keeps it as a JPEG in `results/images/`, and shows it to the model — qwen3.5 sees — in a user message after the step's results; the call sends its bytes, the context keeps only its path, and `end_turn`'s summary drops it with the turn. `read_pdf(path, first?, last?)` gives a PDF's text page by page (pdf.js, through `unpdf`); a page without text, a scan or a drawing, is rendered as a PNG in `results/images/` for `view_image`. The Workspace shows images and PDFs; the Context tab and Activity show the images the model was shown. |
| Libraries | Code the agent's tools share. `define_library(name, description, code, deps?, test_code?)` saves a module with revisions; a tool or `run_js` imports it as `import { f } from "lib:name"`. A library is bundled (esbuild) into a tool when the tool is defined, so the tool keeps that revision until `rebuild_tool(name, test_args?)` builds it on the current one: changing a library never changes a tool by itself. Each tool records the libraries it was built on and their revisions — the tags: `define_library` answers with the tools left on an older revision, `read_tool` and `read_library` show both sides, `delete_library` is refused while anything uses the library, and `test_code` tries a new revision before it is saved. The Workspace has a Libraries tab, and a tool's page lists its libraries, current or behind. |
| The seed | A new or reset context starts from `src/agent/prompt.ts`: a system prompt that says who the agent is (five, a program that runs on its own, not an assistant in a chat), a goal (a 12-chapter novella, one chapter a turn), its context as working memory and its notes as long-term memory, its self note, the person and the inbox, an end-of-turn routine (save to memory, write lessons, maybe message the person, `end_turn` with a summary and the next prompt), and empty `## State` and `## Lessons` sections. Edit it there, or edit the live system prompt in the UI. |
| The model | Ollama, `qwen3.5:9b` by default. Tool calls a small model writes as text are recovered. `FIVE_THINK=on` lets a thinking model think; the UI shows its thinking. |
| State | `<workspace>/.five/five.db`: the context, the event log, the inbox, built tools, background runs, and whether the loop was running. A restart resumes the context, and resumes the loop if it was running; a turn cut off by the restart ends as `stopped`. |

## Web UI

Preact, with seven's and nine's design tokens, polling the API once a second.

| Page | Shows |
|---|---|
| Activity | The loop as it runs. While a step runs, a pulsing row at the end of its turn says what it is doing — reading its context, thinking, writing, or running a tool — for how long, with the model's thinking and reply as they stream in. A top bar with Start / Pause / Step / Stop turn, and ‹ last N turns › to choose how many turns show (kept in the browser); a gauge of how full the context window is, which opens the Context tab; model, turn and step; every turn live — its prompt, each model step (thinking, reply, tool calls with arguments and results), context changes, how it ended and the next prompt. |
| Workspace | Three tabs. **Files**: the workspace's files, to read and edit (after nine's Data section): a directory as a grid of cards, searched by name, filtered to folders, files or databases, sorted by name, date or size; a file opens across the whole width. A text file up to 2 MB opens in an editor (⌘S saves); any file downloads; New file takes a path such as `notes/today.md`; Upload puts files in the directory shown; Delete removes a file, or a directory once empty. A SQLite database opens its tables: rows 100 at a time, Add row, Edit to change or delete one by rowid, and a SQL view that runs one statement. A file the agent changed since you opened it is not overwritten. `.five/` is not reachable. **Context**: the next prompt, the system prompt, the self block (read-only) and every message, each editable, and messages deletable, while the loop is paused and no turn runs. **Start over** resets to the seed; its checkbox (on by default) also deletes the built tools and the workspace files. **Tools**: the tools the agent built, as a grid like Files (with the libraries each is built on, and a badge when one is behind) — searched by name and description, filtered to enabled or disabled, sorted by name, last change or revisions — each opening to its libraries, parameters and source. **Libraries**: the same grid for libraries — in use or unused, and how many tools are behind — each opening to the tools built on it and at which revision, the libraries that import it, and its source. |
| Inbox | The agent's messages and yours, newest first, with a box to write to it (⌘↩ sends). A message you send is read before the next turn; the nav shows a dot while the agent has written something you have not seen. |
| Config | The supervisor's settings: every one, grouped — working memory, turn endings, idle turns, next prompt, self and inbox, results — each with what it does and its default; Apply changes them while the loop runs, Reset puts them all back. Also what it counts now: idle turns in a row, and turns with an unchanged next prompt. |
| Monitor | What five has running; more will come here. For now its processes: every child process since five started — each `run_js`, each call of a tool the agent built (from a turn or from inside another run), each `define_tool` trial, each background run — newest first, with its turn and step, state and duration. One shows its error or result, its output (followed live), its arguments and its code; a live one can be killed. Kept in memory, the last 200 finished. |

## Running

| How | Commands | UI |
|---|---|---|
| Docker, Ollama on the host | `make up` · `make logs` · `make down` | `http://<host>:5555` |
| Host, Node ≥ 24 | `npm ci && npm ci --prefix web && make start-host` | `http://127.0.0.1:5555` |
| Working on the UI, beside either | `make ui-host`: the UI from source, reloading as you edit; its API calls go to five on :5555 | `http://<host>:5173` |

Under Docker all data lives in `./workspace`. Configuration is environment
only, but for the supervisor's settings, which the variables marked *supervisor*
only give defaults to; `.env.example` lists every variable:

| Variable | Default | Meaning |
|---|---|---|
| `FIVE_OLLAMA_MODEL` | `qwen3.5:9b` | a pulled model with the tools capability |
| `FIVE_OLLAMA_ENDPOINT` | `http://localhost:11434` (Docker: `host.docker.internal`) | Ollama |
| `FIVE_CONTEXT_TOKENS` | `32768` | the window Ollama loads the model with |
| `FIVE_THINK` | `off` | let a thinking model think |
| `FIVE_MAX_STEPS` | `30` | model calls per turn |
| `FIVE_TURN_DELAY_MS` | `1000` | pause between turns |
| `FIVE_AUTOSTART` | `off` | start looping at startup even if it was paused |
| `FIVE_CONTEXT_WARN` | `60` | *supervisor:* percent of the window above which a turn's prompt starts with a warning; `0` off |
| `FIVE_FOLD_REPLIES` | `on` | *supervisor:* fold a turn that ends with a reply into that reply if it did work, drop it if not |
| `FIVE_CONTEXT_TRIM` | `85` | *supervisor:* percent of the window above which five drops the oldest messages before a turn; `0` off |
| `FIVE_IDLE_TURNS` | `3` | *supervisor:* turns in a row that do no work that pause the loop; `0` turns the guard and its note off |
| `FIVE_RESULT_CHARS` | `3000` | *supervisor:* a run's result longer than this goes to a file, its start to the context; `0` never |
| `FIVE_RUN_TIMEOUT_MS`, `FIVE_RUN_MEMORY_MB` | `60000`, `1024` | limits of one code run |
| `FIVE_API_ADDR` | `127.0.0.1:5555` (Docker: `0.0.0.0:5555`) | where the API and UI listen |
| `FIVE_PUBLISH` | `0.0.0.0` | Docker: host interface port 5555 is published on |
| `FIVE_WORKSPACE` | current directory (Docker: `/workspace`) | where everything lives |
| `FIVE_LOG_LEVEL`, `FIVE_LOG_FILE` | `info`, `.five/five.log` | JSON-lines log, also on stderr |

## API

JSON over HTTP; writes need `content-type: application/json`.

| Method | Path | Does |
|---|---|---|
| GET | `/api/v1/status` | model, limits, loop state (with `live`: the step in progress, its phase, start, and the model's thinking and reply so far), token use, message and tool counts, last event seq, the id of five's latest inbox message |
| POST | `/api/v1/loop/start`, `/pause`, `/stop`, `/step` | control the loop; `stop` also ends the turn; `step` runs one turn while paused |
| GET | `/api/v1/context` | system prompt, self block, next prompt, turn, messages |
| GET, PUT, DELETE | `/api/v1/supervisor` | the supervisor's settings, their defaults, which changed, each field's label, help and bounds, and its counts; change some `{key: value}` (all or none: a bad one is a `400`); back to the defaults |
| GET, POST | `/api/v1/inbox` | the inbox, newest first; send five `{text}` (at most 4000 characters), read before the next turn |
| PUT | `/api/v1/context/system`, `/api/v1/context/next` | `{text}` |
| PUT, DELETE | `/api/v1/context/messages/:i` | edit `{content}`, or delete |
| POST | `/api/v1/context/reset` | seed context, turn 0, events and inbox cleared; `{"clean": true}` also deletes built tools and workspace files |
| GET | `/api/v1/events?after=<seq>` · `?turns=<n>` | the event log: after a seq, or the last n turns |
| GET | `/api/v1/turns/:n` | one turn's events |
| GET | `/api/v1/tools`, `/api/v1/tools/:name` | built tools, each with the libraries it was built on (`libs`: revision, and the library's `current`) |
| GET | `/api/v1/libraries`, `/api/v1/libraries/:name` | libraries, the tools built on each and at which revision; one with its source, npm ranges and the libraries that import it |
| GET | `/api/v1/processes`, `/api/v1/processes/:id` | the child processes since five started, newest first; one with its code, arguments, output (the last 2000 lines) and result |
| POST | `/api/v1/processes/:id/kill` | kill a live one, and anything it spawned |
| GET | `/api/v1/workspace/files?path=` | one directory of the workspace, directories first |
| GET, PUT, DELETE | `/api/v1/workspace/file?path=` | a file's bytes (up to 32 MB, as `application/octet-stream` with a sandbox CSP — an image as its own type, still sandboxed, and a PDF as `application/pdf` without the sandbox, which a browser's viewer refuses; `&download=true` for an attachment); write one from an `application/octet-stream` body; delete a file or an empty directory. Its version is the `ETag`; with `If-Match`, a write or delete of a file changed since is `409`, and `If-Match: ""` creates only |
| GET | `/api/v1/workspace/db/tables?path=` | a database file's tables and views: columns, row counts, whether rows have a rowid |
| GET, POST, PUT, DELETE | `/api/v1/workspace/db/rows?path=` | a page of a table's rows (`&table=&offset=&limit=`, at most 500); insert `{table, values}`; change `{table, rowid, values}`; delete `&table=&rowid=` |
| POST | `/api/v1/workspace/db/sql?path=` | `{sql, args?}`: one statement; a read returns up to 1000 rows, a write `changes` and `lastInsertRowid`. `ATTACH` and `VACUUM INTO` are refused |

Context changes are refused (409) during a turn. Workspace paths are relative to the workspace; `..`, a link out of it, and `.five/` are refused.

## Layout

| Path | Holds |
|---|---|
| `src/agent/loop.ts` | the loop: turns, model calls, tool calls, events, the inbox |
| `src/agent/supervisor.ts` | the supervisor: guards, folding, the self block, tool limits, and their settings |
| `src/agent/processes.ts` | the record of every child process, around seven's runner |
| `src/agent/context.ts` | the context tools |
| `src/agent/media.ts` | `view_image` and `read_pdf` |
| `src/tools/libs.ts`, `src/agent/builtins/libs.ts` | libraries: the store and bundling, and their built-ins |
| `src/agent/prompt.ts` | the seed system prompt and first prompt |
| `src/agent/builtins/`, `src/runner/`, `src/tools/` | seven's tools, runner and tool store, copied |
| `src/llm/` | the Ollama client and text tool-call recovery, from seven |
| `src/state.ts` | the SQLite state, the inbox included |
| `src/api/` | the HTTP API, its shared types, and the workspace's files and databases (`workspace.ts`) |
| `web/` | the web UI |
| `test/` | `node:test` against a scripted model |
| `docs/` | the architecture diagram |

## Development

`make ci` (in the dev container) or `make ci-host`: typecheck, Biome, the tests,
and the web UI's typecheck. Nothing in the tests calls a model.

## Limits

- **No sign-in.** Docker publishes port 5555 on every interface: anyone who
  reaches it can drive the agent, and the agent runs arbitrary code.
  `FIVE_PUBLISH=127.0.0.1` keeps it local.
- **No context management by five.** Overflow is the agent's to prevent; five
  only warns it to save to memory and delete messages, and the UI shows the last call's prompt tokens against the
  window.
- **A clean reset refuses a workspace that is a git repository**, so running
  from the repo cannot delete it; it then deletes nothing.
- One five per workspace; nothing prevents a second.
