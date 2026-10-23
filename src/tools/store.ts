// Generated tools: the part of five that five writes.
//
// A tool's definition, source and run history are rows in the state database.
// The runner needs a file to import, so each revision's source is also written
// to <home>/tools/<name>/r<revision>.ts; the database is the record and the
// file is derived from it. The store is read every model step, so a tool
// defined mid-turn is callable on the next step — by any agent.

import * as fs from "node:fs";
import * as path from "node:path";
import type { SQLInputValue } from "node:sqlite";
import type { State } from "../state.ts";

export interface ToolMeta {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
  /** Version ranges as requested. */
  deps: Record<string, string>;
  /** Packages the source imports, with the version installed when it was saved. */
  packages: { name: string; version: string }[];
  createdAt: string;
  updatedAt: string;
  /** Increments on every redefinition. */
  revision: number;
  /** Run limit for this tool, overriding the runner's default. */
  timeoutMs?: number;
  /** Set while the tool is disabled: it is not offered to the model and calls to it are refused. */
  disabled?: { at: string; reason: string };
}

export interface StoredTool {
  meta: ToolMeta;
  source: string;
  /** Absolute path of this revision's source file, for the runner. */
  file: string;
}

/** One recorded run of a generated tool. */
export interface RunRecord {
  at: string;
  revision: number;
  /** The agent that called it. */
  agent: string;
  mode: "sync" | "async";
  ok: boolean;
  durationMs: number;
  /** First line of the error, for a failed run. */
  error?: string;
}

export const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** Run records kept per tool; older ones are deleted as new ones arrive. */
const KEEP_RUNS = 100;

export class ToolStore {
  private readonly state: State;
  /** Where source files are written: <home>/tools. */
  readonly dir: string;

  constructor(state: State, dir: string) {
    this.state = state;
    this.dir = dir;
  }

  /** False once the state database is closed; late run records are dropped then. */
  get isOpen(): boolean {
    return this.state.isOpen;
  }

  list(): ToolMeta[] {
    return this.state.db
      .prepare("SELECT * FROM tools ORDER BY name")
      .all()
      .map((r) => toMeta(r as Row));
  }

  get(name: string): StoredTool | undefined {
    if (!TOOL_NAME.test(name)) return undefined;
    const row = this.state.db.prepare("SELECT * FROM tools WHERE name = ?").get(name) as Row | undefined;
    if (!row) return undefined;
    const meta = toMeta(row);
    const source = String(row.source);
    return { meta, source, file: this.materialize(name, meta.revision, source) };
  }

  /**
   * Create or replace a tool. Redefining keeps the run history and clears
   * `disabled`: a new revision is the fix for whatever disabled the old one.
   */
  save(tool: { meta: Omit<ToolMeta, "createdAt" | "updatedAt" | "revision" | "disabled">; source: string }): ToolMeta {
    const { name } = tool.meta;
    if (!TOOL_NAME.test(name)) throw new Error(`invalid tool name "${name}": must match ${TOOL_NAME}`);
    const now = new Date().toISOString();
    const m = tool.meta;
    this.state.db
      .prepare(
        `INSERT INTO tools (name, description, parameters, deps, packages, timeout_ms, revision, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET
           description = excluded.description, parameters = excluded.parameters, deps = excluded.deps,
           packages = excluded.packages, timeout_ms = excluded.timeout_ms, source = excluded.source,
           revision = tools.revision + 1, updated_at = excluded.updated_at,
           disabled_at = NULL, disabled_reason = NULL`,
      )
      .run(
        name,
        m.description,
        JSON.stringify(m.parameters),
        JSON.stringify(m.deps),
        JSON.stringify(m.packages),
        m.timeoutMs ?? null,
        tool.source,
        now,
        now,
      );
    const saved = this.get(name);
    if (!saved) throw new Error(`tool ${name} vanished while saving`);
    return saved.meta;
  }

  /** Disable a tool with a reason, or re-enable it with `null`. Returns false for an unknown tool. */
  setDisabled(name: string, reason: string | null): boolean {
    const r = this.state.db
      .prepare("UPDATE tools SET disabled_at = ?, disabled_reason = ? WHERE name = ?")
      .run(reason === null ? null : new Date().toISOString(), reason, name);
    return r.changes > 0;
  }

  recordRun(name: string, record: RunRecord): void {
    const db = this.state.db;
    if (!db.prepare("SELECT 1 FROM tools WHERE name = ?").get(name)) return; // deleted while it ran
    db.prepare(
      "INSERT INTO tool_runs (tool, revision, agent, mode, ok, duration_ms, error, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      name,
      record.revision,
      record.agent,
      record.mode,
      record.ok ? 1 : 0,
      record.durationMs,
      record.error ?? null,
      record.at,
    );
    db.prepare(
      "DELETE FROM tool_runs WHERE tool = ? AND id NOT IN (SELECT id FROM tool_runs WHERE tool = ? ORDER BY id DESC LIMIT ?)",
    ).run(name, name, KEEP_RUNS);
  }

  /** The most recent `n` runs of a tool, oldest first. */
  history(name: string, n = KEEP_RUNS): RunRecord[] {
    return this.state.db
      .prepare("SELECT * FROM (SELECT * FROM tool_runs WHERE tool = ? ORDER BY id DESC LIMIT ?) ORDER BY id")
      .all(name, n)
      .map((r) => {
        const x = r as Row;
        return {
          at: String(x.at),
          revision: Number(x.revision),
          agent: String(x.agent),
          mode: x.mode as RunRecord["mode"],
          ok: Boolean(x.ok),
          durationMs: Number(x.duration_ms),
          ...(x.error !== null && { error: String(x.error) }),
        };
      });
  }

  remove(name: string): boolean {
    if (!TOOL_NAME.test(name)) return false;
    const r = this.state.db.prepare("DELETE FROM tools WHERE name = ?").run(name);
    this.state.db.prepare("DELETE FROM tool_runs WHERE tool = ?").run(name);
    fs.rmSync(path.join(this.dir, name), { recursive: true, force: true });
    return r.changes > 0;
  }

  /** Write a revision's source file if it is not there yet, and return its path. */
  private materialize(name: string, revision: number, source: string): string {
    const file = path.join(this.dir, name, `r${revision}.ts`);
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== source) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, source);
      fs.renameSync(tmp, file);
    }
    return file;
  }
}

type Row = Record<string, SQLInputValue>;

function toMeta(x: Row): ToolMeta {
  return {
    name: String(x.name),
    description: String(x.description),
    parameters: JSON.parse(String(x.parameters)),
    deps: JSON.parse(String(x.deps)),
    packages: JSON.parse(String(x.packages)),
    createdAt: String(x.created_at),
    updatedAt: String(x.updated_at),
    revision: Number(x.revision),
    ...(x.timeout_ms !== null && { timeoutMs: Number(x.timeout_ms) }),
    ...(x.disabled_at !== null && { disabled: { at: String(x.disabled_at), reason: String(x.disabled_reason) } }),
  };
}
