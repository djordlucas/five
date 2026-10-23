// SQLite databases for agents: any file in the workspace except five's own.

import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Builtin } from "./shared.ts";

/** Rows returned to the model at most; the rest are counted. */
const MAX_ROWS = 200;

export function sqlBuiltins(): Builtin[] {
  return [
    {
      name: "sql",
      description:
        "Run SQL against a SQLite database file in the workspace, creating it if needed. Each database is its own " +
        "file, so use as many as you like (e.g. data/notes.db). A query returning rows gives the rows; any other " +
        "statement gives changes and lastInsertRowid. Without params or named, several statements separated by ; may " +
        "be run at once, and each one's result is returned.",
      parameters: {
        type: "object",
        properties: {
          db: { type: "string", description: "Path of the database file, relative to the workspace." },
          query: { type: "string" },
          params: { type: "array", description: "Values for ? placeholders, in order." },
          named: { type: "object", description: 'Values for :name placeholders, e.g. {"name": "x"} for :name.' },
        },
        required: ["db", "query"],
      },
      async run(a, ctx) {
        const file = resolveDb(ctx.workspace, ctx.stateDb, String(a.db));
        if (file.startsWith("error:")) return file;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const db = new DatabaseSync(file);
        const started = performance.now();
        const fields = () => ({
          db: path.relative(ctx.workspace, file),
          duration_ms: Math.round(performance.now() - started),
        });
        try {
          const out = run(db, String(a.query), a.params, a.named);
          ctx.log.info("sql", { ...fields(), statement: String(a.query).trim().split(/\s+/)[0]?.toUpperCase() });
          return out;
        } catch (err) {
          ctx.log.warn("sql failed", { ...fields(), error: err instanceof Error ? err.message : String(err) });
          return `error: ${err instanceof Error ? err.message : String(err)}`;
        } finally {
          db.close();
        }
      },
    },
  ];
}

/** A workspace-relative database path, or an `error:` string for a path outside the workspace or five's own. */
export function resolveDb(workspace: string, stateDb: string, p: string): string {
  const file = path.resolve(workspace, p);
  const rel = path.relative(workspace, file);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return `error: "${p}" is outside the workspace; databases live in the workspace`;
  }
  if (sameFile(file, stateDb)) return `error: "${p}" is five's own database; use another file`;
  return file;
}

/** Whether two paths name the same file, through symlinks. */
function sameFile(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

function run(db: DatabaseSync, query: string, params: unknown, named: unknown): string {
  if (params === undefined && named === undefined) {
    const statements = splitStatements(query);
    if (statements.length > 1) return runEach(db, statements);
  }
  return runOne(db, query, params, named);
}

/**
 * Several statements, one after another in a transaction, with each one's
 * result: a model that batches an INSERT and two SELECTs needs every result,
 * not the first. Statements that cannot be split apart (a trigger body has
 * its own semicolons) run as one script instead, returning "ok".
 */
function runEach(db: DatabaseSync, statements: string[]): string {
  let prepared: ReturnType<DatabaseSync["prepare"]>[];
  try {
    prepared = statements.map((s) => db.prepare(s));
  } catch (err) {
    // A later statement may depend on an earlier one (INSERT into a table the
    // CREATE before it makes), so preparing up front can fail; run them in turn.
    if (!/no such (table|column)/.test(String(err))) {
      db.exec(statements.join(";\n"));
      return "ok";
    }
    prepared = [];
  }
  const out: string[] = [];
  // SQL that manages its own transactions runs as written.
  const own = statements.some((s) => /^(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(s));
  if (!own) db.exec("BEGIN");
  try {
    statements.forEach((s, i) => {
      const result = runOne(db, s, undefined, undefined, prepared[i]);
      out.push(`[${i + 1}] ${s.replace(/\s+/g, " ").slice(0, 60)}${s.length > 60 ? "…" : ""}\n${result}`);
    });
    if (!own) db.exec("COMMIT");
  } catch (err) {
    if (!own) db.exec("ROLLBACK");
    if (/incomplete input/.test(String(err))) {
      db.exec(statements.join(";\n"));
      return "ok";
    }
    throw new Error(
      `statement ${out.length + 1} of ${statements.length} failed${own ? "" : ", and none were applied"}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return out.join("\n\n");
}

/** The placeholders in one statement, outside strings and comments: how many `?`, and the `:name`s. */
function placeholders(sql: string): { positional: number; named: string[] } {
  const code = sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?\*\//g, " ");
  const numbered = [...code.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
  const positional = numbered.length ? Math.max(...numbered) : (code.match(/\?/g) ?? []).length;
  const named = [...new Set([...code.matchAll(/(?<![:\w])[:@$]([A-Za-z_]\w*)/g)].map((m) => m[1] as string))];
  return { positional, named };
}

/** Split SQL on the semicolons outside strings, quoted names and comments. */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i] as string;
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      const end = sql.indexOf(close, i + 1);
      const stop = end < 0 ? sql.length : end + 1;
      cur += sql.slice(i, stop);
      i = stop - 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end;
      cur += "\n";
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 1;
    } else if (c === ";") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function runOne(
  db: DatabaseSync,
  query: string,
  params: unknown,
  named: unknown,
  prepared?: ReturnType<DatabaseSync["prepare"]>,
): string {
  const stmt = prepared ?? db.prepare(query);
  const positional = Array.isArray(params) ? (params as SQLInputValue[]) : [];
  const byName =
    named && typeof named === "object" && !Array.isArray(named) ? [named as Record<string, SQLInputValue>] : [];
  // SQLite binds NULL to a placeholder without a value; a model that forgot
  // params would write NULL rows without noticing.
  const wanted = placeholders(query);
  if (wanted.positional > positional.length) {
    throw new Error(
      `the query has ${wanted.positional} ? placeholder${wanted.positional === 1 ? "" : "s"} but ${positional.length} value${positional.length === 1 ? "" : "s"} in params; pass one value per ?, e.g. "params": ["text"]`,
    );
  }
  const given = new Set(Object.keys(byName[0] ?? {}).map((k) => k.replace(/^[:@$]/, "")));
  const unbound = wanted.named.filter((n) => !given.has(n));
  if (unbound.length > 0) {
    throw new Error(
      `no value for ${unbound.map((n) => `:${n}`).join(", ")}; pass them in named, e.g. {"${unbound[0]}": …}`,
    );
  }
  const bind = [...byName, ...positional] as SQLInputValue[];

  if (stmt.columns().length > 0) {
    const rows = stmt.all(...bind);
    const shown = rows.slice(0, MAX_ROWS);
    const more = rows.length > MAX_ROWS ? `\n… ${rows.length - MAX_ROWS} more rows` : "";
    return `${JSON.stringify(shown, jsonSafe, 2)}${more}`;
  }
  if (params === undefined && named === undefined && /;\s*\S/.test(query)) {
    db.exec(query);
    return "ok";
  }
  const r = stmt.run(...bind);
  return JSON.stringify({ changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) });
}

function jsonSafe(_key: string, v: unknown): unknown {
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Uint8Array) return { base64: Buffer.from(v).toString("base64") };
  return v;
}
