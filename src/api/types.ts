// The API's response and request shapes, shared by the server and the web UI.
// It imports nothing, so the browser build can compile it.

export type Message =
  | {
      role: "system" | "user";
      content: string;
      /** Workspace paths of images shown with this message (view_image); a model call sends their bytes. */
      images?: string[];
    }
  | { role: "assistant"; content: string | null; thinking?: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** How a run ended: its work done, failed, stopped, out of its context budget, or out of steps. */
export type RunEnd = "done" | "failed" | "stopped" | "budget" | "max_steps";

/** Why a chat ended: the person left it, or did not answer in time. */
export type ChatEnd = "left" | "timeout";

/**
 * A worker: the lead (plans, posts tasks, writes task workers), the chat
 * (talks with the person) — both fixed, five's own code — or a task worker,
 * code the lead wrote, run for one task at a time.
 */
export type WorkerKind = "lead" | "chat" | "task";

export type EventBody =
  | {
      type: "run_started";
      worker: string;
      kind: WorkerKind;
      task?: { id: number; title: string };
      /** What the run's model sees first, when it has a model context: its prompt. */
      prompt?: string;
    }
  | {
      type: "model";
      step: number;
      content: string | null;
      thinking?: string;
      calls: { id: string; name: string; arguments: string }[];
      /** Calls recovered from the reply's text rather than sent as tool calls. */
      fromText?: boolean;
      /** A reply to the person, in the chat. */
      chat?: boolean;
      promptTokens?: number;
      completionTokens?: number;
      durationMs: number;
      /** How long the call waited for a free model slot first. */
      waitedMs?: number;
      /** For a one-shot call from a task worker's code (five.llm.ask): what it asked. */
      prompt?: string;
    }
  | {
      type: "tool";
      step: number;
      id: string;
      name: string;
      arguments: string;
      result: string;
      ok: boolean;
      durationMs: number;
    }
  | { type: "run_ended"; outcome: RunEnd; result?: string; error?: string; durationMs: number }
  | {
      type: "task";
      action: "posted" | "cancelled" | "done" | "failed";
      id: number;
      worker: string;
      title: string;
      /** Who posted it: lead, chat, or the person. */
      by?: string;
    }
  /** The person's chat message, as the chat takes it. */
  | { type: "chat"; text: string }
  | { type: "chat_ended"; reason: ChatEnd; saved?: string }
  /** A message in the inbox: five's to the person, or the person's to five. */
  | { type: "inbox"; from: InboxMessage["from"]; subject?: string; text: string }
  | { type: "goal"; text: string; by: string }
  | { type: "worker"; action: "defined" | "deleted"; name: string; revision?: number }
  | { type: "loop"; state: "started" | "paused" | "stopped"; reason?: string }
  /** The settings changed, from the API. */
  | { type: "settings"; change: string };

/** An event: `run` is the run it belongs to, 0 for none. */
export type Event = EventBody & { seq: number; at: string; run: number };

/** The step a run is on, for the UI to show it as it happens. */
export interface LiveWork {
  step: number;
  /**
   * "queued": waiting for a model slot; "model": the model is writing; "tool": one of its calls runs;
   * "code": a task worker's own code runs.
   */
  phase: "queued" | "model" | "tool" | "code";
  /** When this phase began. */
  startedAt: string;
  /** The tool running, in the "tool" phase. */
  tool?: string;
  /** The model's thinking and text so far (their ends, when long), in the "model" phase. */
  thinking?: string;
  content?: string;
}

/** A run in progress. */
export interface ActiveRun {
  run: number;
  worker: string;
  kind: WorkerKind;
  task?: { id: number; title: string };
  startedAt: string;
  /** Model calls so far. */
  step: number;
  /** The size of its context at its last call. */
  promptTokens?: number;
  live?: LiveWork;
}

/** The chat with the person: one run, open until they leave or stop answering. */
export interface ChatStatus {
  /** The chat's run. */
  run: number;
  /** Five is answering. */
  busy: boolean;
  /** Five answered and waits for the person, until then. */
  waitingUntil?: string;
  /** The person's messages not yet taken: they follow once five has answered. */
  queued: string[];
}

export interface BoardCounts {
  open: number;
  running: number;
  done: number;
  failed: number;
}

export interface Status {
  model: string;
  endpoint: string;
  /** The context window of one model slot, in tokens. */
  contextTokens: number;
  think: boolean;
  workspace: string;
  /** Five schedules runs: the lead, and task workers for open tasks. Paused, only the chat runs. */
  running: boolean;
  active: ActiveRun[];
  /** Model calls at once, and how many wait for one. */
  slots: number;
  queued: number;
  board: BoardCounts;
  chat?: ChatStatus;
  goal: string;
  tools: number;
  libraries: number;
  workers: number;
  /** The last event's seq: a client that has it is up to date. */
  lastSeq: number;
  /** The id of five's latest message to the person; 0 when none. */
  inboxLast: number;
}

/** A message between five and the person who follows it. */
export interface InboxMessage {
  id: number;
  at: string;
  /** The run it was sent from; 0 for the person's. */
  turn: number;
  from: "five" | "person";
  /** What it is about, in a few words: five's always have one. */
  subject?: string;
  text: string;
  /** For the person's: the lead run that read it, once read. */
  deliveredTurn?: number;
}

export interface InboxPage {
  /** Newest first. */
  messages: InboxMessage[];
}

export interface EventsPage {
  events: Event[];
  last: number;
}

/** A task on the board: one worker's job, posted by the lead, the chat, or the person. */
export interface Task {
  id: number;
  worker: string;
  title: string;
  /** What the worker gets: text, or JSON as text. */
  input: string;
  status: "open" | "running" | "done" | "failed" | "cancelled";
  /** The worker's result (its start when long: the whole is in the file it names). */
  result?: string;
  error?: string;
  postedBy: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  /** The run that took it. */
  run?: number;
}

export interface BoardPage {
  /** Newest first. */
  tasks: Task[];
  counts: BoardCounts;
}

export interface WorkerInfo {
  name: string;
  kind: WorkerKind;
  description: string;
  /** Fixed workers are five's own; task workers are code with revisions, the lead's to change. */
  fixed: boolean;
  revision?: number;
  updatedAt?: string;
  libs?: { name: string; revision: number; current?: number }[];
  /** Tasks it did, and failed. */
  done: number;
  failed: number;
}

export interface WorkerDetail extends WorkerInfo {
  source: string;
}

export interface ToolInfo {
  name: string;
  description: string;
  revision: number;
  updatedAt: string;
  disabled?: { at: string; reason: string };
  /** The libraries bundled into it: the revision it was built on, and the library's now (absent when deleted). */
  libs?: { name: string; revision: number; current?: number }[];
}

export interface ToolDetail extends ToolInfo {
  parameters: Record<string, unknown>;
  source: string;
}

/** A library: shared code tools and workers import as "lib:<name>". */
export interface LibraryInfo {
  name: string;
  description: string;
  revision: number;
  updatedAt: string;
  /** The tools and task workers built on it, each at the revision bundled into it. */
  usedBy: { tool: string; revision: number }[];
}

export interface LibraryDetail extends LibraryInfo {
  source: string;
  /** npm version ranges it asks for. */
  deps: Record<string, string>;
  /** Libraries that import it. */
  importedBy: string[];
}

export interface ErrorBody {
  error: { message: string };
}

/** A file or directory in the workspace. */
export interface WorkspaceEntry {
  name: string;
  /** Relative to the workspace, with / between its parts. */
  path: string;
  dir: boolean;
  bytes: number;
  modified: string;
  /** A file's version: what If-Match sends back to write it only if unchanged. */
  version?: string;
  /** The file is a SQLite database. */
  sqlite?: boolean;
}

export interface WorkspaceDir {
  /** "" for the workspace itself. */
  path: string;
  /** Directories first. Five's own .five/ is not listed. */
  entries: WorkspaceEntry[];
}

export interface DbColumn {
  name: string;
  type: string;
  notNull: boolean;
  default: string | null;
  pk: boolean;
}

export interface DbTable {
  name: string;
  kind: "table" | "view";
  columns: DbColumn[];
  rows: number;
  /** Rows have a rowid, so one can be changed or deleted by it. */
  rowid: boolean;
}

export interface DbRows {
  columns: string[];
  rows: unknown[][];
  /** Each row's rowid, when the table has them. */
  rowids?: number[];
  total: number;
}

export interface DbResult {
  /** The statement wrote: changes and lastInsertRowid say what. Otherwise columns and rows hold what it read. */
  write: boolean;
  columns: string[];
  rows: unknown[][];
  /** More rows than the 1000 returned. */
  truncated: boolean;
  changes: number;
  lastInsertRowid: number | null;
}

/** A child process five started: one run of code or of a tool. */
export interface ProcessInfo {
  /** The runner's run id. */
  id: string;
  /** run_js code, a tool the agent built (also when called from inside a run), a define_tool trial, or a task worker. */
  kind: "code" | "tool" | "trial" | "worker";
  /** run_js, the tool's name, or "define_tool <name>". */
  label: string;
  /** The run that started it, and its step then; 0 when none did. */
  run: number;
  step: number;
  startedAt: string;
  state: "installing" | "running" | "ok" | "failed" | "killed";
  /** How long it ran, or has run so far. */
  durationMs: number;
  /** Output lines so far. */
  lines: number;
  error?: string;
  /** Its background run's id, when started with start_tool. */
  runId?: string;
}

export interface ProcessDetail extends ProcessInfo {
  /** The code it runs. */
  source: string;
  args: unknown;
  /** Its output, the last 2000 lines: stdout, and stderr prefixed [stderr]. */
  logs: string[];
  /** Its result, once it finished well. */
  value?: unknown;
}

/** How five schedules its workers: see src/workers/settings.ts. */
export interface Settings {
  slots: number;
  taskRuns: number;
  leadEverySeconds: number;
  minOpenTasks: number;
  maxWorkers: number;
  maxSteps: number;
  runTokens: number;
  resultChars: number;
  chatWaitSeconds: number;
  taskTimeoutSeconds: number;
  imageSide: number;
}

/** One setting, as the web UI shows it: a whole number. */
export interface SettingField {
  key: keyof Settings;
  group: string;
  label: string;
  help: string;
  unit?: string;
  min?: number;
  max?: number;
}

export interface SettingsView {
  settings: Settings;
  /** The settings the environment gives; a reset goes back to them. */
  defaults: Settings;
  /** The settings changed from their defaults. */
  changed: (keyof Settings)[];
  fields: SettingField[];
}
