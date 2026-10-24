// The API's response and request shapes, shared by the server and the web UI.
// It imports nothing, so the browser build can compile it.

export type Message =
  | { role: "system" | "user"; content: string }
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
  | { type: "context"; by: "model" | "user"; change: string }
  | { type: "loop"; state: "started" | "paused"; reason?: string };

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
  /** The last event's seq: a client that has it is up to date. */
  lastSeq: number;
}

export interface ContextView {
  system: string;
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
}

export interface ToolDetail extends ToolInfo {
  parameters: Record<string, unknown>;
  source: string;
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
