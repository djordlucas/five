// The workspace as the web UI reads and edits it: its files, and the SQLite
// databases among them. Every path is relative to the workspace and stays in
// it, links included; five's own data, .five/, is reachable by none.

import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { DbColumn, DbResult, DbRows, DbTable, WorkspaceDir, WorkspaceEntry } from "./types.ts";

/** The largest file read or written whole. */
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
/** Rows one page of a table holds at most. */
const MAX_PAGE = 500;
/** Rows a read statement returns at most. */
const MAX_RESULT_ROWS = 1000;
/** Five's own data in the workspace. */
const PRIVATE = ".five";
const SQLITE_HEADER = "SQLite format 3\0";

/** A refusal, with the HTTP status it maps to. */
export class WorkspaceError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class Workspace {
  private readonly root: string;

  constructor(root: string) {
    this.root = fs.realpathSync(root);
  }

  /** One directory, directories first; "" is the root. */
  list(rel: string): WorkspaceDir {
    const { abs, rel: dir } = this.resolve(rel, { root: true });
    const stat = statOf(abs);
    if (!stat) throw new WorkspaceError(404, `no directory ${dir || "/"}`);
    if (!stat.isDirectory()) throw new WorkspaceError(400, `${dir} is a file`);
    const entries: WorkspaceEntry[] = [];
    for (const name of fs.readdirSync(abs)) {
      if (dir === "" && name === PRIVATE) continue;
      const p = dir ? `${dir}/${name}` : name;
      const s = statOf(path.join(abs, name));
      if (!s || !(s.isFile() || s.isDirectory())) continue;
      entries.push(this.entry(p, s));
    }
    entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    return { path: dir, entries };
  }

  /** A file's bytes and what it is. */
  read(rel: string): { entry: WorkspaceEntry; bytes: Buffer } {
    const { abs, rel: p } = this.resolve(rel);
    const stat = statOf(abs);
    if (!stat?.isFile()) throw new WorkspaceError(404, `no file ${p}`);
    if (stat.size > MAX_FILE_BYTES) throw new WorkspaceError(413, `${p} is over ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    return { entry: this.entry(p, stat), bytes: fs.readFileSync(abs) };
  }

  /**
   * Write a file, making its directories. With ifVersion, refuse (409) when the
   * file changed since that version was read; "" means it must not exist yet.
   */
  write(rel: string, bytes: Buffer, ifVersion?: string): WorkspaceEntry {
    const { abs, rel: p } = this.resolve(rel);
    const stat = statOf(abs);
    if (stat?.isDirectory()) throw new WorkspaceError(400, `${p} is a directory`);
    this.checkVersion(p, stat, ifVersion);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    // The directories just made are in the workspace, but recheck for links.
    this.resolve(p);
    fs.writeFileSync(abs, bytes);
    return this.entry(p, fs.statSync(abs));
  }

  /** Delete a file, or a directory once it is empty. */
  remove(rel: string, ifVersion?: string): void {
    const { abs, rel: p } = this.resolve(rel);
    const stat = statOf(abs);
    if (!stat) throw new WorkspaceError(404, `no file ${p}`);
    if (stat.isDirectory()) {
      if (fs.readdirSync(abs).length > 0) throw new WorkspaceError(409, `${p} is not empty`);
      fs.rmdirSync(abs);
      return;
    }
    this.checkVersion(p, stat, ifVersion);
    fs.rmSync(abs);
  }

  /** The tables and views of a database file. */
  tables(rel: string): DbTable[] {
    return this.withDb(rel, true, (db) => listTables(db));
  }

  /** A page of a table's rows, in rowid order when it has one. */
  rows(rel: string, table: string, offset: number, limit: number): DbRows {
    return this.withDb(rel, true, (db) => {
      const t = findTable(db, table);
      const name = ident(t.name);
      const n = Math.min(Math.max(1, limit), MAX_PAGE);
      const stmt = db.prepare(
        t.rowid
          ? `SELECT rowid, * FROM ${name} ORDER BY rowid LIMIT ? OFFSET ?`
          : `SELECT * FROM ${name} LIMIT ? OFFSET ?`,
      );
      const { columns, rows } = arrays(stmt, [n, Math.max(0, offset)]);
      const total = Number((db.prepare(`SELECT count(*) AS n FROM ${name}`).get() as { n: number }).n);
      if (!t.rowid) return { columns, rows, total };
      return {
        columns: columns.slice(1),
        rows: rows.map((r) => r.slice(1)),
        rowids: rows.map((r) => Number(r[0])),
        total,
      };
    });
  }

  /** Insert a row; columns left out take their defaults. */
  insert(rel: string, table: string, values: Record<string, unknown>): DbResult {
    return this.withDb(rel, false, (db) => {
      const t = findTable(db, table, true);
      const cols = checkColumns(t, values);
      const sql = cols.length
        ? `INSERT INTO ${ident(t.name)} (${cols.map(ident).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`
        : `INSERT INTO ${ident(t.name)} DEFAULT VALUES`;
      return written(db.prepare(sql).run(...cols.map((c) => bind(values[c]))));
    });
  }

  /** Change the columns given of the row with this rowid. */
  update(rel: string, table: string, rowid: number, values: Record<string, unknown>): DbResult {
    return this.withDb(rel, false, (db) => {
      const t = findTable(db, table, true);
      const cols = checkColumns(t, values);
      if (cols.length === 0) throw new WorkspaceError(400, "no column to change");
      const sets = cols.map((c) => `${ident(c)} = ?`).join(", ");
      const r = db
        .prepare(`UPDATE ${ident(t.name)} SET ${sets} WHERE rowid = ?`)
        .run(...cols.map((c) => bind(values[c])), rowid);
      if (Number(r.changes) === 0) throw new WorkspaceError(404, `no row ${rowid} in ${t.name}`);
      return written(r);
    });
  }

  /** Delete the row with this rowid. */
  deleteRow(rel: string, table: string, rowid: number): DbResult {
    return this.withDb(rel, false, (db) => {
      const t = findTable(db, table, true);
      const r = db.prepare(`DELETE FROM ${ident(t.name)} WHERE rowid = ?`).run(rowid);
      if (Number(r.changes) === 0) throw new WorkspaceError(404, `no row ${rowid} in ${t.name}`);
      return written(r);
    });
  }

  /** Run one statement: a read returns its rows, a write what it changed. */
  sql(rel: string, sql: string, args: unknown[] = []): DbResult {
    // ATTACH and VACUUM INTO would reach files outside the workspace.
    if (/\battach\b|\bvacuum\s+into\b|\bload_extension\b/i.test(sql)) {
      throw new WorkspaceError(400, "ATTACH, VACUUM INTO and load_extension are refused here");
    }
    return this.withDb(rel, false, (db) => {
      const stmt = db.prepare(sql);
      if (stmt.columns().length === 0) return written(stmt.run(...args.map(bind)));
      const { columns, rows, truncated } = arrays(stmt, args.map(bind), MAX_RESULT_ROWS);
      return { write: false, columns, rows, truncated, changes: 0, lastInsertRowid: null };
    });
  }

  private withDb<T>(rel: string, readOnly: boolean, fn: (db: DatabaseSync) => T): T {
    const { abs, rel: p } = this.resolve(rel);
    const stat = statOf(abs);
    if (!stat?.isFile()) throw new WorkspaceError(404, `no file ${p}`);
    if (!isSqlite(abs, stat)) throw new WorkspaceError(400, `${p} is not a SQLite database`);
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(abs, { readOnly });
    } catch (err) {
      throw new WorkspaceError(400, `${p}: ${message(err)}`);
    }
    try {
      // The agent may be writing the same database.
      db.exec("PRAGMA busy_timeout = 3000");
      return fn(db);
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      throw new WorkspaceError(400, message(err));
    } finally {
      db.close();
    }
  }

  private entry(p: string, s: fs.Stats): WorkspaceEntry {
    const dir = s.isDirectory();
    return {
      name: p.slice(p.lastIndexOf("/") + 1),
      path: p,
      dir,
      bytes: dir ? 0 : s.size,
      modified: s.mtime.toISOString(),
      ...(!dir && { version: versionOf(s) }),
      ...(!dir && isSqlite(path.join(this.root, p), s) && { sqlite: true }),
    };
  }

  private checkVersion(p: string, stat: fs.Stats | undefined, ifVersion: string | undefined): void {
    if (ifVersion === undefined) return;
    const now = stat ? versionOf(stat) : "";
    if (now !== ifVersion) {
      throw new WorkspaceError(409, ifVersion === "" ? `${p} already exists` : `${p} changed since it was read`);
    }
  }

  /**
   * A workspace path as an absolute one, refused when it leaves the workspace —
   * by .., by a link, or into .five.
   */
  private resolve(rel: string, opts: { root?: boolean } = {}): { abs: string; rel: string } {
    if (rel.includes("\0")) throw new WorkspaceError(400, "bad path");
    if (rel.split(/[\\/]/).includes("..")) throw new WorkspaceError(400, `${rel}: .. is not allowed in a path`);
    const clean = path.posix
      .normalize(`/${rel.replace(/\\/g, "/")}`)
      .slice(1)
      .replace(/\/$/, "");
    if (clean === "" && !opts.root) throw new WorkspaceError(400, "a path is needed");
    if (clean === PRIVATE || clean.startsWith(`${PRIVATE}/`)) {
      throw new WorkspaceError(403, `${PRIVATE}/ is five's own data, not reachable here`);
    }
    const abs = path.join(this.root, clean);
    // Follow links in the part that exists: it must still be in the workspace.
    let existing = abs;
    while (!fs.existsSync(existing)) existing = path.dirname(existing);
    const real = path.join(fs.realpathSync(existing), path.relative(existing, abs));
    const inside = path.relative(this.root, real);
    if (inside.startsWith("..") || path.isAbsolute(inside))
      throw new WorkspaceError(403, `${rel} leads outside the workspace`);
    if (inside === PRIVATE || inside.startsWith(`${PRIVATE}${path.sep}`)) {
      throw new WorkspaceError(403, `${PRIVATE}/ is five's own data, not reachable here`);
    }
    return { abs: real, rel: clean };
  }
}

function listTables(db: DatabaseSync): DbTable[] {
  const rows = db
    .prepare(
      "SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string; type: "table" | "view" }[];
  return rows.map(({ name, type }) => {
    const columns = (db.prepare(`PRAGMA table_info(${ident(name)})`).all() as Record<string, unknown>[]).map(
      (c): DbColumn => ({
        name: String(c.name),
        type: String(c.type ?? ""),
        notNull: c.notnull === 1,
        default: c.dflt_value === null || c.dflt_value === undefined ? null : String(c.dflt_value),
        pk: Number(c.pk) > 0,
      }),
    );
    let count = 0;
    try {
      count = Number((db.prepare(`SELECT count(*) AS n FROM ${ident(name)}`).get() as { n: number }).n);
    } catch {
      // A view over a missing table, or a virtual table without its module.
    }
    let rowid = false;
    if (type === "table") {
      try {
        db.prepare(`SELECT rowid FROM ${ident(name)} LIMIT 0`);
        rowid = true;
      } catch {
        // WITHOUT ROWID
      }
    }
    return { name, kind: type, columns, rows: count, rowid };
  });
}

function findTable(db: DatabaseSync, name: string, writable = false): DbTable {
  const t = listTables(db).find((x) => x.name === name);
  if (!t) throw new WorkspaceError(404, `no table ${name}`);
  if (writable && (t.kind !== "table" || !t.rowid)) {
    throw new WorkspaceError(
      400,
      `${name} is a ${t.kind === "view" ? "view" : "table without rowid"}: change it with SQL`,
    );
  }
  return t;
}

function checkColumns(t: DbTable, values: Record<string, unknown>): string[] {
  const known = new Set(t.columns.map((c) => c.name));
  const cols = Object.keys(values);
  const bad = cols.find((c) => !known.has(c));
  if (bad) throw new WorkspaceError(400, `${t.name} has no column ${bad}`);
  return cols;
}

/** A statement's rows as arrays, values made JSON-safe; at most `max`. */
function arrays(
  stmt: StatementSync,
  args: unknown[],
  max = Number.POSITIVE_INFINITY,
): { columns: string[]; rows: unknown[][]; truncated: boolean } {
  const columns = stmt.columns().map((c) => c.name);
  stmt.setReturnArrays(true);
  const rows: unknown[][] = [];
  let truncated = false;
  for (const r of stmt.iterate(...(args as never[])) as Iterable<unknown[]>) {
    if (rows.length >= max) {
      truncated = true;
      break;
    }
    rows.push(r.map(jsonValue));
  }
  return { columns, rows, truncated };
}

function written(r: { changes: number | bigint; lastInsertRowid: number | bigint }): DbResult {
  return {
    write: true,
    columns: [],
    rows: [],
    truncated: false,
    changes: Number(r.changes),
    lastInsertRowid: Number(r.lastInsertRowid) || null,
  };
}

/** A value from the UI as SQLite takes it. */
function bind(v: unknown): never {
  if (v === null || v === undefined) return null as never;
  if (typeof v === "number" || typeof v === "string" || typeof v === "bigint") return v as never;
  if (typeof v === "boolean") return (v ? 1 : 0) as never;
  return JSON.stringify(v) as never;
}

/** A value from SQLite as JSON carries it: a blob as a note of its size. */
function jsonValue(v: unknown): unknown {
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Uint8Array) return `<blob, ${v.byteLength} bytes>`;
  return v;
}

function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function statOf(abs: string): fs.Stats | undefined {
  try {
    return fs.statSync(abs);
  } catch {
    return undefined;
  }
}

/** A file's version: it changes whenever the file is written. */
function versionOf(s: fs.Stats): string {
  return `${Math.round(s.mtimeMs * 1000).toString(36)}-${s.size.toString(36)}`;
}

/** A SQLite database by its header, or an empty file named as one: a database not yet written. */
function isSqlite(abs: string, s: fs.Stats): boolean {
  if (s.size === 0) return /\.(db|db3|sqlite|sqlite3)$/i.test(abs);
  if (s.size < 100) return false;
  try {
    const fd = fs.openSync(abs, "r");
    try {
      const head = Buffer.alloc(16);
      fs.readSync(fd, head, 0, 16, 0);
      return head.toString("latin1") === SQLITE_HEADER;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
