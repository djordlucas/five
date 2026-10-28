// Five's own state, in one SQLite file: <workspace>/.five/five.db.
//
// The event log the web UI follows, the board of tasks, the task workers, the
// inbox between five and the person, generated tools and libraries with their
// run history, and background runs all live here, so a restart resumes where
// the last process stopped. The tool and run tables are seven's.

import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Event, EventBody, InboxMessage } from "./api/types.ts";

export type { Event, EventBody, RunEnd } from "./api/types.ts";

export interface RunRow {
  id: string;
  agent: string;
  tool: string;
  status: "running" | "done" | "lost";
  ok: boolean | null;
  value: unknown;
  error: string | null;
  logs: string[];
  durationMs: number | null;
  startedAt: string;
  checked: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- turn: the run an event belongs to (the column predates workers).
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  turn INTEGER NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_turn ON events (turn, seq);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  worker TEXT NOT NULL,
  title TEXT NOT NULL,
  input TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'running', 'done', 'failed', 'cancelled')),
  result TEXT,
  error TEXT,
  posted_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  run INTEGER
);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks (status, id);
CREATE TABLE IF NOT EXISTS workers (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  deps TEXT NOT NULL,
  timeout_ms INTEGER,
  revision INTEGER NOT NULL,
  source TEXT NOT NULL,
  bundle TEXT,
  libs TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tools (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  parameters TEXT NOT NULL,
  deps TEXT NOT NULL,
  packages TEXT NOT NULL,
  timeout_ms INTEGER,
  disabled_at TEXT,
  disabled_reason TEXT,
  revision INTEGER NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_runs (
  id INTEGER PRIMARY KEY,
  tool TEXT NOT NULL,
  revision INTEGER NOT NULL,
  agent TEXT NOT NULL,
  mode TEXT NOT NULL,
  ok INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  error TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_runs_tool ON tool_runs (tool, id);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  tool TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'lost')),
  ok INTEGER,
  value TEXT,
  error TEXT,
  logs TEXT,
  duration_ms INTEGER,
  started_at TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS libs (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  deps TEXT NOT NULL,
  source TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  turn INTEGER NOT NULL,
  sender TEXT NOT NULL CHECK (sender IN ('five', 'person')),
  text TEXT NOT NULL,
  delivered_turn INTEGER,
  subject TEXT
);
INSERT OR IGNORE INTO meta (key, value) VALUES ('run_seq', '0');
`;

const now = () => new Date().toISOString();

export class State {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(file: string) {
    this.path = path.resolve(file);
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    // A database from before these columns: add them.
    this.addColumn("inbox", "subject", "TEXT");
    this.addColumn("inbox", "as_prompt", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("tools", "libs", "TEXT");
    this.addColumn("tools", "bundle", "TEXT");
  }

  private addColumn(table: string, column: string, type: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  get isOpen(): boolean {
    return this.db.isOpen;
  }

  // ── meta ──────────────────────────────────────────────────────────────────

  /** A small saved setting, or undefined when never set. */
  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  // ── events ────────────────────────────────────────────────────────────────

  /** An event of a run, or of none (0). */
  addEvent(run: number, body: EventBody): Event {
    const at = now();
    const r = this.db
      .prepare("INSERT INTO events (at, turn, body) VALUES (?, ?, ?)")
      .run(at, run, JSON.stringify(body));
    return { ...body, seq: Number(r.lastInsertRowid), at, run };
  }

  /** The next run's number: runs are numbered from 1, across restarts. */
  nextRun(): number {
    const n = (Number(this.getMeta("runs")) || 0) + 1;
    this.setMeta("runs", String(n));
    return n;
  }

  /** Events after `seq`, oldest first, at most `limit`. */
  eventsAfter(seq: number, limit: number): Event[] {
    return this.db.prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?").all(seq, limit).map(toEvent);
  }

  /**
   * The events of the last `runs` runs, oldest first, with the events of no
   * run since the first of them began.
   */
  recentEvents(runs: number): Event[] {
    return this.db
      .prepare(
        `WITH recent AS (SELECT COALESCE(MAX(turn), 0) - ? AS after FROM events),
              since AS (SELECT COALESCE(MIN(seq), 0) AS seq FROM events, recent WHERE turn > recent.after)
         SELECT * FROM events, recent, since
         WHERE turn > recent.after OR (turn = 0 AND events.seq >= since.seq)
         ORDER BY events.seq`,
      )
      .all(runs)
      .map(toEvent);
  }

  /** The events of one run, oldest first. */
  runEvents(run: number): Event[] {
    return this.db.prepare("SELECT * FROM events WHERE turn = ? ORDER BY seq").all(run).map(toEvent);
  }

  lastSeq(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as { seq: number };
    return Number(row.seq);
  }

  clearEvents(): void {
    this.db.exec("DELETE FROM events");
  }

  // ── inbox ─────────────────────────────────────────────────────────────────

  /** run: the run five sent it from; 0 for the person's. */
  addInbox(run: number, from: InboxMessage["from"], text: string, opts: { subject?: string } = {}): InboxMessage {
    const at = now();
    const r = this.db
      .prepare("INSERT INTO inbox (at, turn, sender, text, subject) VALUES (?, ?, ?, ?, ?)")
      .run(at, run, from, text, opts.subject ?? null);
    return {
      id: Number(r.lastInsertRowid),
      at,
      turn: run,
      from,
      text,
      ...(opts.subject !== undefined && { subject: opts.subject }),
    };
  }

  /** Newest first. */
  listInbox(limit = 200): InboxMessage[] {
    return this.db.prepare("SELECT * FROM inbox ORDER BY id DESC LIMIT ?").all(limit).map(toInbox);
  }

  /** The person's messages the lead has not read yet, oldest first. */
  undelivered(): InboxMessage[] {
    return this.db
      .prepare("SELECT * FROM inbox WHERE sender = 'person' AND delivered_turn IS NULL ORDER BY id")
      .all()
      .map(toInbox);
  }

  /** Mark messages read by a run. */
  markDelivered(ids: number[], run: number): void {
    const stmt = this.db.prepare("UPDATE inbox SET delivered_turn = ? WHERE id = ?");
    for (const id of ids) stmt.run(run, id);
  }

  /** When five last sent the person a message; undefined when never. */
  lastSentAt(): string | undefined {
    const row = this.db.prepare("SELECT MAX(at) AS at FROM inbox WHERE sender = 'five'").get() as {
      at: string | null;
    };
    return row.at ?? undefined;
  }

  /** The id of five's latest message; 0 when none. */
  lastFromFive(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM inbox WHERE sender = 'five'").get() as {
      id: number;
    };
    return Number(row.id);
  }

  clearInbox(): void {
    this.db.exec("DELETE FROM inbox");
  }

  // ── background runs (seven's) ─────────────────────────────────────────────

  insertRun(agent: string, tool: string): string {
    const row = this.db
      .prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'run_seq' RETURNING value")
      .get() as { value: number | string };
    const id = `r${Number(row.value)}`;
    this.db
      .prepare("INSERT INTO runs (id, agent, tool, status, started_at) VALUES (?, ?, ?, 'running', ?)")
      .run(id, agent, tool, now());
    return id;
  }

  finishRun(id: string, r: { ok: boolean; value?: unknown; error?: string; logs: string[]; durationMs: number }): void {
    this.db
      .prepare("UPDATE runs SET status = 'done', ok = ?, value = ?, error = ?, logs = ?, duration_ms = ? WHERE id = ?")
      .run(
        r.ok ? 1 : 0,
        r.value === undefined ? null : JSON.stringify(r.value),
        r.error ?? null,
        JSON.stringify(r.logs),
        r.durationMs,
        id,
      );
  }

  markRunChecked(id: string): void {
    this.db.prepare("UPDATE runs SET checked = 1 WHERE id = ?").run(id);
  }

  getRun(id: string): RunRow | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
    return row ? toRun(row) : undefined;
  }

  listRuns(agent: string, limit = 50): RunRow[] {
    return this.db
      .prepare(
        "SELECT * FROM (SELECT rowid AS seq, * FROM runs WHERE agent = ? ORDER BY rowid DESC LIMIT ?) ORDER BY seq",
      )
      .all(agent, limit)
      .map(toRun);
  }

  /** Runs recorded as running belong to a process that is gone; their output is lost. */
  markLostRuns(): number {
    const r = this.db
      .prepare(
        "UPDATE runs SET status = 'lost', ok = 0, error = 'lost: five restarted while it ran' WHERE status = 'running'",
      )
      .run();
    return Number(r.changes);
  }
}

type Row = Record<string, SQLInputValue>;

function toEvent(r: unknown): Event {
  const x = r as Row;
  return { ...(JSON.parse(String(x.body)) as EventBody), seq: Number(x.seq), at: String(x.at), run: Number(x.turn) };
}

function toInbox(r: unknown): InboxMessage {
  const x = r as Row;
  return {
    id: Number(x.id),
    at: String(x.at),
    turn: Number(x.turn),
    from: x.sender as InboxMessage["from"],
    text: String(x.text),
    ...(x.subject !== null && x.subject !== undefined && { subject: String(x.subject) }),
    ...(x.delivered_turn !== null && { deliveredTurn: Number(x.delivered_turn) }),
  };
}

function toRun(r: unknown): RunRow {
  const x = r as Row;
  return {
    id: String(x.id),
    agent: String(x.agent),
    tool: String(x.tool),
    status: x.status as RunRow["status"],
    ok: x.ok === null ? null : Boolean(x.ok),
    value: x.value === null ? undefined : JSON.parse(String(x.value)),
    error: x.error === null ? null : String(x.error),
    logs: x.logs === null ? [] : (JSON.parse(String(x.logs)) as string[]),
    durationMs: x.duration_ms === null ? null : Number(x.duration_ms),
    startedAt: String(x.started_at),
    checked: Boolean(x.checked),
  };
}
