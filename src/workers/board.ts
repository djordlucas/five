// The board: the tasks five's workers share. The lead posts them, as can the
// chat and the person; five gives each open task to a run of the worker it
// names, oldest first, and the run's result goes back on the task. A task is
// how workers hand work to each other — its result is short, and points to the
// files in the workspace where the work itself is.

import type { SQLInputValue } from "node:sqlite";
import type { BoardCounts, Task } from "../api/types.ts";
import type { State } from "../state.ts";

/** The longest title, and input, a task takes. */
export const MAX_TITLE = 200;
export const MAX_INPUT = 8000;
/** A task done this recently still counts as the same work, for a new one like it. */
const SAME_WORK_MS = 30 * 60_000;
/** Words that say how, not what: two tasks sharing only these are not alike. */
const HOW = new Set(
  "the and for with from into about what that this its their new latest news story stories update updates follow track monitor investigate research find check report reports breaking ongoing developments development".split(
    " ",
  ),
);

export class Board {
  private readonly state: State;

  constructor(state: State) {
    this.state = state;
    // A task that was running when five stopped is open again: its run is gone.
    this.state.db.exec("UPDATE tasks SET status = 'open', started_at = NULL, run = NULL WHERE status = 'running'");
  }

  post(t: { worker: string; title: string; input: string; by: string }): Task {
    const r = this.state.db
      .prepare("INSERT INTO tasks (worker, title, input, status, posted_by, created_at) VALUES (?, ?, ?, 'open', ?, ?)")
      .run(t.worker, t.title, t.input, t.by, new Date().toISOString());
    return this.get(Number(r.lastInsertRowid)) as Task;
  }

  get(id: number): Task | undefined {
    const row = this.state.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return row ? toTask(row as Row) : undefined;
  }

  /** Newest first; with `status`, only those. */
  list(limit = 200, status?: Task["status"]): Task[] {
    const rows = status
      ? this.state.db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY id DESC LIMIT ?").all(status, limit)
      : this.state.db.prepare("SELECT * FROM tasks ORDER BY id DESC LIMIT ?").all(limit);
    return rows.map((r) => toTask(r as Row));
  }

  /** The oldest open task, now running in the run `run` numbers; undefined when none is open. */
  claim(run: () => number): Task | undefined {
    const row = this.state.db.prepare("SELECT id FROM tasks WHERE status = 'open' ORDER BY id LIMIT 1").get() as
      | { id: number }
      | undefined;
    if (!row) return undefined;
    this.state.db
      .prepare("UPDATE tasks SET status = 'running', started_at = ?, run = ? WHERE id = ?")
      .run(new Date().toISOString(), run(), row.id);
    return this.get(Number(row.id));
  }

  /** The task's run ended: done with a result, or failed with an error. */
  finish(id: number, r: { ok: boolean; result?: string; error?: string }): Task | undefined {
    this.state.db
      .prepare("UPDATE tasks SET status = ?, result = ?, error = ?, ended_at = ? WHERE id = ? AND status = 'running'")
      .run(r.ok ? "done" : "failed", r.result ?? null, r.error ?? null, new Date().toISOString(), id);
    return this.get(id);
  }

  /** Put a running task back on the board, for another run. */
  reopen(id: number): void {
    this.state.db
      .prepare("UPDATE tasks SET status = 'open', started_at = NULL, run = NULL WHERE id = ? AND status = 'running'")
      .run(id);
  }

  /** Cancel an open task; false when it is not open. */
  cancel(id: number): boolean {
    const r = this.state.db
      .prepare("UPDATE tasks SET status = 'cancelled', ended_at = ? WHERE id = ? AND status = 'open'")
      .run(new Date().toISOString(), id);
    return r.changes > 0;
  }

  counts(): BoardCounts {
    const row = this.state.db
      .prepare(
        "SELECT COUNT(*) FILTER (WHERE status = 'open') AS open, COUNT(*) FILTER (WHERE status = 'running') AS running, " +
          "COUNT(*) FILTER (WHERE status = 'done') AS done, COUNT(*) FILTER (WHERE status = 'failed') AS failed FROM tasks",
      )
      .get() as Record<string, number>;
    return {
      open: Number(row.open),
      running: Number(row.running),
      done: Number(row.done),
      failed: Number(row.failed),
    };
  }

  /**
   * A task like this one, already open, running or just done: the same
   * worker, the same story, or a title saying much the same. Small models post
   * the same task again and again.
   */
  alike(t: { worker: string; title: string; input: string }): Task | undefined {
    const since = new Date(Date.now() - SAME_WORK_MS).toISOString();
    const rows = this.state.db
      .prepare(
        "SELECT * FROM tasks WHERE worker = ? AND (status IN ('open', 'running') OR (status = 'done' AND ended_at >= ?)) ORDER BY id DESC",
      )
      .all(t.worker, since)
      .map((r) => toTask(r as Row));
    const story = storyOf(t.input);
    const words = keyWords(t.title);
    return rows.find((o) => {
      if (story && storyOf(o.input) === story) return true;
      if (o.title.trim().toLowerCase() === t.title.trim().toLowerCase()) return true;
      const theirs = keyWords(o.title);
      const shared = [...words].filter((w) => theirs.has(w)).length;
      const fewer = Math.min(words.size, theirs.size);
      return fewer > 0 && (shared === fewer || (shared >= 2 && shared / fewer >= 0.6));
    });
  }

  /** A worker's newest task. */
  latest(worker: string): Task | undefined {
    const row = this.state.db.prepare("SELECT * FROM tasks WHERE worker = ? ORDER BY id DESC LIMIT 1").get(worker);
    return row ? toTask(row as Row) : undefined;
  }

  /** How many of a worker's latest finished tasks failed. */
  recentFailures(worker: string, latest = 5): number {
    const row = this.state.db
      .prepare(
        "SELECT COUNT(*) FILTER (WHERE status = 'failed') AS failed FROM (SELECT status FROM tasks WHERE worker = ? AND status IN ('done', 'failed') ORDER BY id DESC LIMIT ?)",
      )
      .get(worker, latest) as Record<string, number>;
    return Number(row.failed);
  }

  tally(worker: string): { done: number; failed: number } {
    const row = this.state.db
      .prepare(
        "SELECT COUNT(*) FILTER (WHERE status = 'done') AS done, COUNT(*) FILTER (WHERE status = 'failed') AS failed FROM tasks WHERE worker = ?",
      )
      .get(worker) as Record<string, number>;
    return { done: Number(row.done), failed: Number(row.failed) };
  }

  clear(): void {
    this.state.db.exec("DELETE FROM tasks");
  }

  /**
   * The board as a model reads it: open and running tasks, then the latest
   * that ended with the start of their result — at most `ended` of them.
   */
  summary(ended = 8, resultChars = 300): string {
    const live = this.state.db
      .prepare("SELECT * FROM tasks WHERE status IN ('open', 'running') ORDER BY id")
      .all()
      .map((r) => toTask(r as Row));
    const last = this.state.db
      .prepare("SELECT * FROM tasks WHERE status IN ('done', 'failed') ORDER BY ended_at DESC, id DESC LIMIT ?")
      .all(ended)
      .map((r) => toTask(r as Row))
      .reverse();
    const lines: string[] = [];
    lines.push(live.length ? "Open and running:" : "Nothing open or running.");
    for (const t of live) lines.push(`- #${t.id} [${t.status}] ${t.worker}: ${t.title}`);
    if (last.length) {
      lines.push("", "Latest ended:");
      for (const t of last) {
        const out = t.status === "done" ? (t.result ?? "") : `FAILED: ${t.error ?? ""}`;
        lines.push(`- #${t.id} ${t.worker}: ${t.title} → ${clip(oneLine(out), resultChars)}`);
      }
    }
    return lines.join("\n");
  }
}

type Row = Record<string, SQLInputValue>;

function toTask(x: Row): Task {
  const opt = (k: string) => (x[k] === null || x[k] === undefined ? undefined : String(x[k]));
  const result = opt("result");
  const error = opt("error");
  const startedAt = opt("started_at");
  const endedAt = opt("ended_at");
  return {
    id: Number(x.id),
    worker: String(x.worker),
    title: String(x.title),
    input: String(x.input),
    status: x.status as Task["status"],
    ...(result !== undefined && { result }),
    ...(error !== undefined && { error }),
    postedBy: String(x.posted_by),
    createdAt: String(x.created_at),
    ...(startedAt !== undefined && { startedAt }),
    ...(endedAt !== undefined && { endedAt }),
    ...(x.run !== null && x.run !== undefined && { run: Number(x.run) }),
  };
}

/** The story a task names in its input, `story: <slug>`. */
function storyOf(input: string): string | undefined {
  return /\bstory:\s*([\w-]+)/i.exec(input)?.[1]?.toLowerCase();
}

/** A title's words that say what it is about. */
function keyWords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !HOW.has(w))
      .map((w) => w.replace(/s$/, "")),
  );
}

export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
