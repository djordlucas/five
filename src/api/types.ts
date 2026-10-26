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

/** Why a turn ended: the model replied without a call, called end_turn, ran out of steps, was stopped, or failed. */
export type TurnEnd = "replied" | "end_turn" | "max_steps" | "stopped" | "error";

export type EventBody =
  | {
      type: "turn_started";
      prompt: string;
      /** Five's warning put before the prompt: the context is near full. */
      warning?: string;
    }
  | {
      type: "model";
      step: number;
      content: string | null;
      thinking?: string;
      calls: { id: string; name: string; arguments: string }[];
      /** Calls recovered from the reply's text rather than sent as tool calls. */
      fromText?: boolean;
      promptTokens?: number;
      completionTokens?: number;
      durationMs: number;
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
  | { type: "turn_ended"; reason: TurnEnd; next: string; error?: string }
  | { type: "context"; by: "model" | "user" | "five"; change: string }
  /** A message in the inbox: five's to the person, or the person's to five. */
  | { type: "inbox"; from: InboxMessage["from"]; subject?: string; text: string; asPrompt?: boolean }
  | { type: "loop"; state: "started" | "paused"; reason?: string }
  /** The supervisor's settings changed, from the API. */
  | { type: "supervisor"; change: string };

export type Event = EventBody & { seq: number; at: string; turn: number };

export interface LoopStatus {
  /** Turns follow one another until paused. */
  running: boolean;
  /** A turn is in progress. */
  busy: boolean;
  turn: number;
  /** The model call the current turn is on; 0 between turns. */
  step: number;
  promptTokens: number | null;
  /** When the loop waits after a failed turn, until when. */
  retryAt: string | null;
  /** What the turn is doing right now: the model writing its reply, or a tool running. */
  live?: LiveWork;
}

/** The step in progress, for the UI to show it as it happens. */
export interface LiveWork {
  step: number;
  /** "model": the model is writing; "tool": one of its calls runs. */
  phase: "model" | "tool";
  /** When this phase began. */
  startedAt: string;
  /** The tool running, in the "tool" phase. */
  tool?: string;
  /** The model's thinking and text so far (their ends, when long), in the "model" phase. */
  thinking?: string;
  content?: string;
}

export interface Status {
  model: string;
  endpoint: string;
  contextTokens: number;
  think: boolean;
  maxSteps: number;
  workspace: string;
  loop: LoopStatus;
  /** Messages in the context. */
  messages: number;
  /** Tools the agent built. */
  tools: number;
  /** Libraries the agent wrote. */
  libraries: number;
  /** The last event's seq: a client that has it is up to date. */
  lastSeq: number;
  /** The id of five's latest message to the person; 0 when none. */
  inboxLast: number;
}

/** A message between five and the person who follows it. */
export interface InboxMessage {
  id: number;
  at: string;
  /** The turn it was sent in; for the person's, the turn running or last ended then. */
  turn: number;
  from: "five" | "person";
  /** What it is about, in a few words: five's always have one. */
  subject?: string;
  text: string;
  /** For the person's: the turn it was put before, once delivered. */
  deliveredTurn?: number;
  /** A person's message sent as the next turn's prompt, in place of the one the agent set. */
  asPrompt?: boolean;
}

export interface InboxPage {
  /** Newest first. */
  messages: InboxMessage[];
}

export interface ContextView {
  system: string;
  /** Five's self block, rebuilt for every model call and sent after the messages. */
  self: string;
  next: string;
  turn: number;
  messages: Message[];
}

export interface EventsPage {
  events: Event[];
  last: number;
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

/** A library: shared code tools import as "lib:<name>". */
export interface LibraryInfo {
  name: string;
  description: string;
  revision: number;
  updatedAt: string;
  /** The tools built on it, each at the revision bundled into it. */
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
  /** run_js code, a tool the agent built (also when called from inside a run), or a define_tool trial. */
  kind: "code" | "tool" | "trial";
  /** run_js, the tool's name, or "define_tool <name>". */
  label: string;
  /** The loop's turn and step when it started. */
  turn: number;
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

/** How the supervisor steps into the loop: see src/agent/supervisor.ts. Shares are percent of the window. */
export interface SupervisorSettings {
  contextWarn: number;
  contextTrim: number;
  trimTo: number;
  foldReplies: boolean;
  replySummaryChars: number;
  dropIdle: boolean;
  idleTurns: number;
  staleTurns: number;
  refuseRepeat: boolean;
  refuseDone: boolean;
  refuseWaiting: boolean;
  selfBlock: boolean;
  selfNoteChars: number;
  messagesPerTurn: number;
  resultChars: number;
  imageSide: number;
}

/** One setting, as the web UI shows it: a flag when its value is a boolean, else a whole number. */
export interface SupervisorField {
  key: keyof SupervisorSettings;
  group: string;
  label: string;
  help: string;
  unit?: string;
  min?: number;
  max?: number;
}

export interface SupervisorView {
  settings: SupervisorSettings;
  /** The settings the environment gives; a reset goes back to them. */
  defaults: SupervisorSettings;
  /** The settings changed from their defaults. */
  changed: (keyof SupervisorSettings)[];
  fields: SupervisorField[];
  /** What the supervisor counts now. */
  state: { idle: number; stale: number };
}
