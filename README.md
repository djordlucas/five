# five

An experimental self-modifying agent that never stops — now as a team of small
models rather than one bigger one. A main loop in code runs the workers: a
**lead** that plans, a **chat** that talks with the person, and **task
workers** — code the lead writes — that do one task each, several at once, on
one small model served by Ollama. Line seven/nine's sibling, and the most
minimal of them: one process, one SQLite file, Ollama.

![Architecture of five, as one agent: drawn before the workers, to be redrawn](docs/architecture.png)

`docs/architecture.svg` is the source; `docs/architecture.png` is it rendered at
2×. It shows five before the workers: one agent and its context.

## How it works

| Part | What it does |
|---|---|
| The main loop | `src/workers/scheduler.ts`, code and no model. Once a second, and whenever a run ends, it starts what there is room for: the lead when the board has fewer open tasks than `minOpenTasks` (at most every 30 s), when `leadEverySeconds` have passed, or soon after a chat, a goal change or an inbox message; then a task worker for each open task, oldest first, up to `taskRuns` at once. Paused, it starts neither; Stop also ends the lead and task runs in progress. The chat runs either way. |
| Runs | One worker at work: the lead planning, the chat talking, a task worker on one task. Runs are numbered across restarts; every event carries its run's number. A task whose run is cut off by a restart goes back on the board. |
| Model slots | Every model call goes through `src/workers/pool.ts`, which sends at most `slots` at once (match Ollama's `OLLAMA_NUM_PARALLEL`) and queues the rest — the chat's first. On a 16 GB M4, `qwen3.5:4b` keeps about 25 tokens/s per call with 4 at once, but a context not yet in a slot is read one at a time, at about 340 tokens/s for the whole machine: which is why contexts are kept small. |
| Contexts | An agent — the lead, the chat's answer, a task worker's `llm.agent` — starts from a context five builds, only grows by appending (so each call finds the earlier part already in its slot and reads only what is new), and is dropped when the agent is done. What lasts is in the workspace and on the board. Each agent gets only the tools it needs. Near `runTokens` (12000 by default) five tells it to finish; past it, it ends. A long tool result is kept whole in `results/`, and the agent gets its start and the path. |
| The board | Tasks: a worker's name, a title, an input, and when done a short result naming the files where the work is. The lead posts them, as can the chat, a task worker (`five.board.post`) and the person (Board page). |
| The lead | Fixed, five's own (`src/workers/lead.ts`). Each run's prompt is built fresh: the goal, the board (open, running, the latest results), the task workers with their counts, its notes (`memory/lead.md`), the person's unread inbox messages and the latest chat. It posts and cancels tasks, writes task workers, sets the goal, keeps its notes and messages the person (one a run); its own tools are the board's, the workers', the files', `define_library`, `read_library` and `run_js`. |
| Task workers | Code the lead writes with `define_worker`: an ES module whose default export gets `{ task }` and returns the result, run in a child process of its own. It reaches five through `five.llm.ask(prompt, { system, schema })` — one model call, its reply parsed when a JSON schema constrains it — `five.llm.agent({ prompt, tools, maxSteps })`, `five.web.text / feed / search`, and `five.board.post`; Node's `fs` works in the workspace. Code does what code can, the model what needs judgment. A revision of a worker must pass a trial run (`test_input`) before it replaces the one that works. The lead and the chat cannot be replaced. Libraries (`lib:name`) are bundled in, as for a tool. |
| Seeds | A new five starts with two task workers, the lead's to revise like its own: `research` (a small agent with search, pages and files) and `feeds` (news feeds into today's digest: code fetches, parses and remembers what it has seen; the model picks what matters, in batches of 15, with a schema). And a goal: a news desk that never closes. |
| The chat | Fixed (`src/workers/chat.ts`). The person's first message opens a chat run with a snapshot of five — the goal, what runs, the board — and its messages are kept while the chat is open. It answers from the files, the board and the web, and changes course when asked (`set_goal`, `post_task`). After an answer it waits `chatWaitSeconds` for the person; then, or when they leave, its transcript goes to `chats/` and the lead reads it at its next run. |
| Inbox | The lead's messages to the person (`message_person`, with a subject), and the person's to five, which the lead reads at its next run — soon after. |
| Settings | `src/workers/settings.ts`: slots, task runs, when the lead runs, steps and context budget of an agent, result size, image size, chat wait. Changed live on the Config page, kept in the state; the environment gives the defaults. |
| seven's tools | `run_js`, `define_tool`, `start_tool` and the rest, and the tools the agents build, are there for any agent given them by name; `view_image` and `read_pdf` too. Five adds small tools of its own: `read_file`, `write_file`, `append_file`, `list_files`, `fetch_url` (a page as text, a feed as its items) and `search_web` (DuckDuckGo). |
| The model | Ollama, `qwen3.5:4b` by default, 16k tokens a slot. Tool calls a small model writes as text are recovered. |
| State | `<workspace>/.five/five.db`: the event log, the board, the task workers, the goal, the settings, the inbox, tools, libraries, background runs, and whether five was running. |

## Ollama with several slots

Ollama serves several calls at once from one loaded model when
`OLLAMA_NUM_PARALLEL` is set; each slot gets its own context window. The macOS
app does not pass that variable to its server, so run the server yourself:

```sh
OLLAMA_NUM_PARALLEL=4 OLLAMA_HOST=0.0.0.0 OLLAMA_KEEP_ALIVE=30m ollama serve
```

With one slot five still works: the calls wait their turn in Ollama.

## Web UI

Preact, with seven's and nine's design tokens, polling the API once a second.
A top bar with the sections; each page's contents in one centered column; on a
phone, a bottom tab bar.

| Page | Shows |
|---|---|
| Activity | Five at work. A top bar: what runs, the model's slots as squares (filled while a call runs) and how many calls wait, the board's counts, a filter (all runs, the lead's, tasks, the chat), ‹ last N runs ›, Start / Pause / Stop runs, and the goal. Then every run where it began, newest at the bottom: its worker, task, calls, how it ended. A running run is open, with a pulsing row saying what it does — waiting for a slot, writing, running a tool or its own code — and the model's reply as it streams; a finished one folds to its result, and opens to its prompt, each call with its tool calls and results, and what `llm.ask` asked. Board, goal, worker and inbox events show as lines. At the bottom, the chat: Enter sends, your messages and five's answers show as bubbles, with how long five still waits for you, and **Leave chat** ends it. |
| Board | Every task, newest first: status, worker, title, who posted it, how long it took, and its result or error; opened, its input and whole result. Search, filters by status and worker, **Post a task** for a task worker (its description shown), and Cancel on an open one. |
| Workspace | Four tabs. **Files**: the workspace's files to read and edit, as a grid of cards, searched, filtered and sorted; a SQLite database opens its tables, rows and a SQL view; images and PDFs show. **Workers**: the lead and the chat (five's own, opening to their instructions) and the task workers (revision, tasks done and failed, opening to their code and libraries). **Tools** and **Libraries**: what the agents built, as grids, each opening to its source. |
| Inbox | The lead's messages and yours, newest first, with a box to write to five (⌘↩ sends): the lead reads it at its next run. The nav shows a dot while five has written something you have not seen. |
| Config | The goal, to read and change, and the settings, grouped — model, workers, runs, chat — each with what it does and its default; Apply changes them while five runs, Reset puts them all back. |
| Monitor | Every child process since five started — each `run_js`, tool call, `define_tool` trial, background run and task worker — newest first, with its run and call, state and duration. One shows its error or result, its output (followed live), its arguments and its code; a live one can be killed. |

## Running

| How | Commands | UI |
|---|---|---|
| Docker, Ollama on the host | `make up` · `make logs` · `make down` | `http://<host>:5555` |
| Host, Node ≥ 24 | `npm ci && npm ci --prefix web && make start-host` | `http://127.0.0.1:5555` |
| Working on the UI, beside either | `make ui-host`: the UI from source, reloading as you edit; its API calls go to five on :5555 | `http://<host>:5173` |

Under Docker all data lives in `./workspace`. Configuration is environment
only, but for the settings, which the variables marked *setting* only give
defaults to; `.env.example` lists every variable:

| Variable | Default | Meaning |
|---|---|---|
| `FIVE_OLLAMA_MODEL` | `qwen3.5:4b` | a pulled model with the tools capability |
| `FIVE_OLLAMA_ENDPOINT` | `http://localhost:11434` (Docker: `host.docker.internal`) | Ollama |
| `FIVE_CONTEXT_TOKENS` | `16384` | the window of each of the model's slots |
| `FIVE_THINK` | `off` | let a thinking model think |
| `FIVE_SLOTS` | `4` | *setting:* model calls at once; match `OLLAMA_NUM_PARALLEL` |
| `FIVE_TASK_RUNS` | `4` | *setting:* task runs at once |
| `FIVE_MAX_STEPS` | `12` | *setting:* model calls in one agent |
| `FIVE_RUN_TOKENS` | `12000` | *setting:* the context budget of one agent |
| `FIVE_TICK_MS` | `1000` | how often five looks for work |
| `FIVE_AUTOSTART` | `off` | start the workers at startup even if five was paused |
| `FIVE_RUN_TIMEOUT_MS`, `FIVE_RUN_MEMORY_MB` | `60000`, `1024` | limits of one code run (a task worker's: the `taskTimeoutSeconds` setting) |
| `FIVE_API_ADDR` | `127.0.0.1:5555` (Docker: `0.0.0.0:5555`) | where the API and UI listen |
| `FIVE_PUBLISH` | `0.0.0.0` | Docker: host interface port 5555 is published on |
| `FIVE_WORKSPACE` | current directory (Docker: `/workspace`) | where everything lives |
| `FIVE_LOG_LEVEL`, `FIVE_LOG_FILE` | `info`, `.five/five.log` | JSON-lines log, also on stderr |

## API

JSON over HTTP; writes need `content-type: application/json`.

| Method | Path | Does |
|---|---|---|
| GET | `/api/v1/status` | model, slots and calls waiting, whether five runs, the runs in progress (each with its worker, task, calls, context size and `live`: what it does now, and the model's reply so far), the chat, the board's counts, the goal, counts of tools, libraries and workers, the last event seq, five's latest inbox message |
| POST | `/api/v1/loop/start`, `/pause`, `/stop` | start or pause the lead and task runs; `stop` also ends those in progress (the chat goes on) |
| GET, PUT | `/api/v1/goal` | the goal; set it `{goal}` |
| GET, POST | `/api/v1/board` | tasks, newest first (`?status=&limit=`), with the counts; post one `{worker, title, input?}` |
| GET, DELETE | `/api/v1/board/:id` | one task; cancel an open one (`409` otherwise) |
| GET | `/api/v1/workers`, `/api/v1/workers/:name` | the workers — lead and chat (fixed), task workers (revision, libraries, tasks done and failed); one with its code, or a fixed one's instructions |
| GET, PUT, DELETE | `/api/v1/settings` | the settings, their defaults, which changed, each field's label, help and bounds; change some `{key: value}` (all or none: a bad one is a `400`); back to the defaults |
| GET, POST | `/api/v1/inbox` | the inbox, newest first; send five `{text}` (at most 4000 characters): the lead reads it next |
| POST | `/api/v1/chat`, `/api/v1/chat/leave` | say `{text}` in the chat, opening it if needed; leave it (`409` when none is open). `status.chat` shows it |
| POST | `/api/v1/reset` | start over: no events, tasks, inbox, or task workers but the seeds, and the first goal; `{"clean": true}` also deletes the tools, libraries and workspace files. `409` while runs are in progress |
| GET | `/api/v1/events?after=<seq>` · `?runs=<n>` | the event log: after a seq, or the last n runs (with the events of no run since) |
| GET | `/api/v1/runs/:n` | one run's events |
| GET | `/api/v1/tools`, `/api/v1/tools/:name` | the tools the agents built, each with the libraries it was built on (`libs`: revision, and the library's `current`) |
| GET | `/api/v1/libraries`, `/api/v1/libraries/:name` | libraries, the tools built on each and at which revision; one with its source, npm ranges and the libraries that import it |
| GET | `/api/v1/processes`, `/api/v1/processes/:id` | the child processes since five started, newest first; one with its code, arguments, output (the last 2000 lines) and result |
| POST | `/api/v1/processes/:id/kill` | kill a live one, and anything it spawned |
| GET | `/api/v1/workspace/files?path=` | one directory of the workspace, directories first |
| GET, PUT, DELETE | `/api/v1/workspace/file?path=` | a file's bytes (up to 32 MB, as `application/octet-stream` with a sandbox CSP — an image as its own type, still sandboxed, and a PDF as `application/pdf` without the sandbox, which a browser's viewer refuses; `&download=true` for an attachment); write one from an `application/octet-stream` body; delete a file or an empty directory. Its version is the `ETag`; with `If-Match`, a write or delete of a file changed since is `409`, and `If-Match: ""` creates only |
| GET | `/api/v1/workspace/db/tables?path=` | a database file's tables and views: columns, row counts, whether rows have a rowid |
| GET, POST, PUT, DELETE | `/api/v1/workspace/db/rows?path=` | a page of a table's rows (`&table=&offset=&limit=`, at most 500); insert `{table, values}`; change `{table, rowid, values}`; delete `&table=&rowid=` |
| POST | `/api/v1/workspace/db/sql?path=` | `{sql, args?}`: one statement; a read returns up to 1000 rows, a write `changes` and `lastInsertRowid`. `ATTACH` and `VACUUM INTO` are refused |


Workspace paths are relative to the workspace; `..`, a link out of it, and `.five/` are refused.

## Layout

| Path | Holds |
|---|---|
| `src/workers/scheduler.ts` | the main loop: starting runs, following them to their end, the chat, status |
| `src/workers/agent.ts` | an agent: model calls through the slots, tool calls, the context budget |
| `src/workers/lead.ts`, `chat.ts`, `task.ts` | the lead, the chat, and running a task worker with its host functions |
| `src/workers/board.ts`, `store.ts`, `seeds.ts` | the board, the task workers' store, the seed workers and goal |
| `src/workers/pool.ts`, `settings.ts`, `run.ts` | the model's slots, the live settings, a run and what runs share |
| `src/workers/tools.ts`, `web.ts` | the tools agents get, and the web as text, feeds and search |
| `src/agent/` | seven's built-ins, `view_image` and `read_pdf`, the process record, argument checks |
| `src/runner/`, `src/tools/` | seven's runner and tool store, copied; libraries |
| `src/llm/` | the Ollama client and text tool-call recovery, from seven |
| `src/state.ts` | the SQLite state |
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
