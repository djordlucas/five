// Task workers: code the lead writes, one module per worker, with revisions,
// kept in the state database like the agent's tools. A worker's default export
// takes `{ task }` and returns the task's result; it runs in its own child
// process, and reaches five — the model, the board, the web — through
// `five.llm`, `five.board` and `five.web` (see task.ts). Its libraries are
// bundled in when it is saved, as for a tool.

import type { SQLInputValue } from "node:sqlite";
import type { State } from "../state.ts";
import type { LibraryUse } from "../tools/libs.ts";

export const WORKER_NAME = /^[a-z][a-z0-9_]{0,39}$/;

/** The fixed workers: five's own, never the lead's to replace. */
export const FIXED = new Set(["lead", "chat"]);

export interface WorkerMeta {
  name: string;
  /** What it does and what its task's input should be: the lead reads this to post tasks for it. */
  description: string;
  deps: Record<string, string>;
  timeoutMs?: number;
  revision: number;
  libs?: LibraryUse[];
  createdAt: string;
  updatedAt: string;
}

export interface StoredWorker {
  meta: WorkerMeta;
  source: string;
  /** The source with its libraries inlined, when it imports any. */
  bundle?: string;
}

export class WorkerStore {
  private readonly state: State;

  constructor(state: State) {
    this.state = state;
  }

  list(): WorkerMeta[] {
    return this.state.db
      .prepare("SELECT * FROM workers ORDER BY name")
      .all()
      .map((r) => toMeta(r as Row));
  }

  get(name: string): StoredWorker | undefined {
    if (!WORKER_NAME.test(name)) return undefined;
    const row = this.state.db.prepare("SELECT * FROM workers WHERE name = ?").get(name) as Row | undefined;
    if (!row) return undefined;
    return {
      meta: toMeta(row),
      source: String(row.source),
      ...(row.bundle !== null && row.bundle !== undefined && { bundle: String(row.bundle) }),
    };
  }

  /** Create a worker or save a new revision of it. */
  save(w: {
    name: string;
    description: string;
    deps: Record<string, string>;
    timeoutMs?: number;
    source: string;
    bundle?: string;
    libs?: LibraryUse[];
  }): WorkerMeta {
    if (!WORKER_NAME.test(w.name)) throw new Error(`invalid worker name "${w.name}": must match ${WORKER_NAME}`);
    if (FIXED.has(w.name)) throw new Error(`"${w.name}" is one of five's own workers and cannot be replaced`);
    const now = new Date().toISOString();
    this.state.db
      .prepare(
        `INSERT INTO workers (name, description, deps, timeout_ms, revision, source, bundle, libs, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET
           description = excluded.description, deps = excluded.deps, timeout_ms = excluded.timeout_ms,
           source = excluded.source, bundle = excluded.bundle, libs = excluded.libs,
           revision = workers.revision + 1, updated_at = excluded.updated_at`,
      )
      .run(
        w.name,
        w.description,
        JSON.stringify(w.deps),
        w.timeoutMs ?? null,
        w.source,
        w.bundle ?? null,
        w.libs?.length ? JSON.stringify(w.libs) : null,
        now,
        now,
      );
    return (this.get(w.name) as StoredWorker).meta;
  }

  remove(name: string): boolean {
    return this.state.db.prepare("DELETE FROM workers WHERE name = ?").run(name).changes > 0;
  }

  clear(): void {
    this.state.db.exec("DELETE FROM workers");
  }
}

type Row = Record<string, SQLInputValue>;

function toMeta(x: Row): WorkerMeta {
  return {
    name: String(x.name),
    description: String(x.description),
    deps: JSON.parse(String(x.deps)),
    ...(x.timeout_ms !== null && { timeoutMs: Number(x.timeout_ms) }),
    revision: Number(x.revision),
    ...(x.libs !== null && x.libs !== undefined && { libs: JSON.parse(String(x.libs)) as LibraryUse[] }),
    createdAt: String(x.created_at),
    updatedAt: String(x.updated_at),
  };
}
