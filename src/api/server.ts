// five's HTTP API, and the web UI's files beside it. Plain node:http and JSON;
// the UI polls it.
//
// There is no sign-in: whoever reaches the API can drive the agent, and the
// agent runs any code. On the host five listens on loopback by default; in
// Docker it is published on every interface for remote access. What the server
// does refuse is a request another website makes through the browser: a Host
// that is not this server's when it listens on loopback (DNS rebinding), and a
// write from another Origin or without a JSON body (which a cross-site form
// cannot send).

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type { Five } from "../app.ts";
import type { Config } from "../config.ts";
import type { Logger } from "../log.ts";
import { type LibraryStore, type LibraryUse, usersOf } from "../tools/libs.ts";
import { CHAT_SYSTEM } from "../workers/chat.ts";
import { LEAD_SYSTEM } from "../workers/lead.ts";
import type {
  BoardPage,
  ErrorBody,
  EventsPage,
  FileHistory,
  InboxMessage,
  InboxPage,
  LibraryDetail,
  LibraryInfo,
  SettingsView,
  Status,
  Task,
  ToolDetail,
  ToolInfo,
  WorkerDetail,
  WorkerInfo,
} from "./types.ts";
import { MAX_FILE_BYTES, Workspace, WorkspaceError } from "./workspace.ts";

/** The longest message the person can send: it goes into a prompt. */
const MAX_MESSAGE_CHARS = 4000;

const MAX_BODY = 1024 * 1024;
/** Events in one page. */
const PAGE = 500;
/** Runs whose events a first request gets. */
const RUNS = 30;

export interface ApiOptions {
  five: Five;
  cfg: Config;
  log: Logger;
  /** The built web UI (index.html and assets); none served when missing. */
  webDir?: string;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Ctx {
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  /** The body as bytes, for a route that takes them. */
  bytes: Buffer;
  headers: http.IncomingHttpHeaders;
}

type Handler = (ctx: Ctx) => unknown;

/** A response a handler makes itself: bytes rather than JSON. */
class Raw {
  readonly headers: Record<string, string>;
  readonly body: Buffer;
  constructor(headers: Record<string, string>, body: Buffer) {
    this.headers = headers;
    this.body = body;
  }
}

export function createApi(opts: ApiOptions): http.Server {
  const { five: app, cfg } = opts;
  const { five, state, store } = app;
  const libsOf = (used: LibraryUse[]) => libsOfWith(app.libs, used);
  const log = opts.log.child({ component: "api" });
  const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler; bytes?: boolean }[] = [];
  const route = (method: string, p: string, handler: Handler, opts: { bytes?: boolean } = {}) => {
    const keys: string[] = [];
    const pattern = new RegExp(
      `^${p.replace(/:(\w+)/g, (_, k: string) => {
        keys.push(k);
        return "([^/]+)";
      })}$`,
    );
    routes.push({ method, pattern, keys, handler, ...opts });
  };
  /** Runs a change five may refuse; a refusal is a 409. */
  const guarded = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      throw new HttpError(409, err instanceof Error ? err.message : String(err));
    }
  };
  const text = (body: Record<string, unknown>, key: string): string => {
    const v = body[key];
    if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `${key} must be a non-empty string`);
    return v;
  };
  const message = (body: Record<string, unknown>): string => {
    const t = text(body, "text").trim();
    if (t.length > MAX_MESSAGE_CHARS) throw new HttpError(400, `a message is at most ${MAX_MESSAGE_CHARS} characters`);
    return t;
  };
  const status = (): Status => {
    const s = five.status();
    return {
      model: cfg.model,
      ...(cfg.leadModel && { leadModel: cfg.leadModel }),
      endpoint: cfg.endpoint,
      contextTokens: cfg.contextTokens,
      think: cfg.think,
      workspace: cfg.workspace,
      running: s.running,
      active: s.active,
      slots: five.settings.current.slots,
      queued: s.queued,
      board: five.board.counts(),
      ...(s.chat && { chat: s.chat }),
      goal: five.d.goal(),
      tools: store.list().length,
      libraries: app.libs.list().length,
      workers: five.workers.list().length,
      lastSeq: state.lastSeq(),
      inboxLast: state.lastFromFive(),
    };
  };

  route("GET", "/api/v1/status", status);

  // ── the main loop ───────────────────────────────────────────────────────
  const control = (fn: () => void) => () => {
    fn();
    return status();
  };
  route(
    "POST",
    "/api/v1/loop/start",
    control(() => five.start()),
  );
  route(
    "POST",
    "/api/v1/loop/pause",
    control(() => five.pause()),
  );
  route(
    "POST",
    "/api/v1/loop/stop",
    control(() => five.stop()),
  );
  route("POST", "/api/v1/reset", ({ body }) => {
    guarded(() => app.reset({ clean: body.clean === true }));
    return status();
  });
  route("GET", "/api/v1/goal", () => ({ goal: five.d.goal() }));
  route("PUT", "/api/v1/goal", ({ body }) => {
    five.d.setGoal(text(body, "goal").trim(), "person");
    return { goal: five.d.goal() };
  });

  // ── the board ───────────────────────────────────────────────────────────
  route("GET", "/api/v1/board", ({ query }): BoardPage => {
    const s = query.get("status");
    const statuses = ["open", "running", "done", "failed", "cancelled"];
    if (s && !statuses.includes(s)) throw new HttpError(400, `status is one of ${statuses.join(", ")}`);
    return {
      tasks: five.board.list(positive(query.get("limit"), 200), (s || undefined) as Task["status"] | undefined),
      counts: five.board.counts(),
    };
  });
  route("GET", "/api/v1/board/:id", ({ params }): Task => {
    const t = five.board.get(Number(params.id));
    if (!t) throw new HttpError(404, `no task #${params.id}`);
    return t;
  });
  route("POST", "/api/v1/board", ({ body }): Task => {
    const input = body.input === undefined ? "" : body.input;
    if (typeof input !== "string") throw new HttpError(400, "input must be a string");
    const worker = text(body, "worker");
    if (!five.workers.get(worker)) throw new HttpError(400, `no task worker named "${worker}"`);
    return five.post({ worker, title: text(body, "title").trim(), input });
  });
  route("DELETE", "/api/v1/board/:id", ({ params }) => {
    guarded(() => five.cancel(Number(params.id)));
    return five.board.get(Number(params.id));
  });

  // ── workers ─────────────────────────────────────────────────────────────
  const fixedWorker = (name: "lead" | "chat", description: string, source: string): WorkerDetail => ({
    name,
    kind: name,
    description,
    fixed: true,
    done: 0,
    failed: 0,
    source,
  });
  const fixed = () => [
    fixedWorker(
      "lead",
      "Plans: reads the board's results, posts tasks, writes and revises task workers, keeps its notes. Five's own; runs when the board runs low, on a timer, and after a chat.",
      LEAD_SYSTEM,
    ),
    fixedWorker(
      "chat",
      "Talks with the person, live: answers from the files, the board and the web, and changes course when asked. Five's own.",
      CHAT_SYSTEM,
    ),
  ];
  const workerInfo = (name: string): WorkerDetail | undefined => {
    const fix = fixed().find((w) => w.name === name);
    if (fix) return fix;
    const w = five.workers.get(name);
    if (!w) return undefined;
    const { meta } = w;
    return {
      name: meta.name,
      kind: "task",
      description: meta.description,
      fixed: false,
      revision: meta.revision,
      updatedAt: meta.updatedAt,
      ...(meta.libs && { libs: libsOf(meta.libs) }),
      ...five.board.tally(meta.name),
      source: w.source,
    };
  };
  route("GET", "/api/v1/workers", () => ({
    workers: [...fixed(), ...five.workers.list().flatMap((w) => workerInfo(w.name) ?? [])].map(
      ({ source, ...info }): WorkerInfo => info,
    ),
  }));
  route("GET", "/api/v1/workers/:name", ({ params }): WorkerDetail => {
    const w = workerInfo(params.name ?? "");
    if (!w) throw new HttpError(404, `no worker "${params.name}"`);
    return w;
  });

  // ── settings ────────────────────────────────────────────────────────────
  route("GET", "/api/v1/settings", (): SettingsView => five.settings.view());
  route("PUT", "/api/v1/settings", ({ body }): SettingsView => {
    try {
      five.settings.update(body);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
    return five.settings.view();
  });
  route("DELETE", "/api/v1/settings", (): SettingsView => {
    five.settings.reset();
    return five.settings.view();
  });

  // ── the inbox ───────────────────────────────────────────────────────────
  route("GET", "/api/v1/inbox", (): InboxPage => ({ messages: state.listInbox() }));
  route("POST", "/api/v1/inbox", ({ body }): InboxMessage => five.receive(message(body)));

  // ── the chat ────────────────────────────────────────────────────────────
  route("POST", "/api/v1/chat", ({ body }): Status => {
    five.say(message(body));
    return status();
  });
  route("POST", "/api/v1/chat/leave", (): Status => {
    guarded(() => five.leaveChat());
    return status();
  });

  // ── events ──────────────────────────────────────────────────────────────
  route("GET", "/api/v1/events", ({ query }): EventsPage => {
    const after = query.get("after");
    const events =
      after === null
        ? state.recentEvents(positive(query.get("runs"), RUNS))
        : state.eventsAfter(Number(after) || 0, PAGE);
    return { events, last: state.lastSeq() };
  });
  route("GET", "/api/v1/runs/:n", ({ params }): EventsPage => {
    return { events: state.runEvents(Number(params.n) || 0), last: state.lastSeq() };
  });

  // ── tools ───────────────────────────────────────────────────────────────
  route("GET", "/api/v1/tools", () => ({
    tools: store.list().map(
      (t): ToolInfo => ({
        name: t.name,
        description: t.description,
        revision: t.revision,
        updatedAt: t.updatedAt,
        ...(t.disabled && { disabled: t.disabled }),
        ...(t.libs && { libs: libsOf(t.libs) }),
      }),
    ),
  }));
  route("GET", "/api/v1/tools/:name", ({ params }): ToolDetail => {
    const t = store.get(params.name ?? "");
    if (!t) throw new HttpError(404, `no tool "${params.name}"`);
    const { meta } = t;
    return {
      name: meta.name,
      description: meta.description,
      revision: meta.revision,
      updatedAt: meta.updatedAt,
      ...(meta.disabled && { disabled: meta.disabled }),
      ...(meta.libs && { libs: libsOf(meta.libs) }),
      parameters: meta.parameters,
      source: t.source,
    };
  });

  // ── libraries ───────────────────────────────────────────────────────────
  const libraryInfo = (name: string): LibraryInfo | undefined => {
    const lib = app.libs.get(name);
    if (!lib) return undefined;
    const { meta } = lib;
    return {
      name: meta.name,
      description: meta.description,
      revision: meta.revision,
      updatedAt: meta.updatedAt,
      usedBy: [
        ...usersOf(meta.name, store, app.libs).tools.map((t) => ({ tool: t.name, revision: t.revision })),
        ...five.workers
          .list()
          .flatMap((w) =>
            (w.libs ?? [])
              .filter((l) => l.name === meta.name)
              .map((l) => ({ tool: `worker ${w.name}`, revision: l.revision })),
          ),
      ],
    };
  };
  route("GET", "/api/v1/libraries", () => ({
    libraries: app.libs.list().flatMap((l) => libraryInfo(l.name) ?? []),
  }));
  route("GET", "/api/v1/libraries/:name", ({ params }): LibraryDetail => {
    const name = params.name ?? "";
    const info = libraryInfo(name);
    const lib = app.libs.get(name);
    if (!info || !lib) throw new HttpError(404, `no library "${name}"`);
    return { ...info, source: lib.source, deps: lib.meta.deps, importedBy: usersOf(name, store, app.libs).libs };
  });

  // ── child processes ─────────────────────────────────────────────────────
  route("GET", "/api/v1/processes", () => ({ processes: app.processes.list() }));
  route("GET", "/api/v1/processes/:id", ({ params }) => {
    const p = app.processes.get(params.id ?? "");
    if (!p) throw new HttpError(404, `no process ${params.id}`);
    return p;
  });
  route("POST", "/api/v1/processes/:id/kill", ({ params }) => {
    const id = params.id ?? "";
    if (!app.processes.kill(id)) {
      throw new HttpError(
        app.processes.get(id) ? 409 : 404,
        app.processes.get(id) ? `${id} has ended` : `no process ${id}`,
      );
    }
    return app.processes.get(id);
  });

  // ── the workspace ───────────────────────────────────────────────────────
  const workspace = new Workspace(cfg.workspace);
  const wsPath = (query: URLSearchParams) => query.get("path") ?? "";
  const ifMatch = (headers: http.IncomingHttpHeaders) => {
    const v = headers["if-match"];
    return typeof v === "string" ? v.replace(/^W\//, "").replace(/^"|"$/g, "") : undefined;
  };
  const tableArg = (v: unknown) => {
    if (typeof v !== "string" || !v) throw new HttpError(400, "table must be a non-empty string");
    return v;
  };
  const rowidArg = (v: unknown) => {
    const n = Number(v);
    if (!Number.isInteger(n)) throw new HttpError(400, "rowid must be an integer");
    return n;
  };
  const valuesArg = (v: unknown) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "values must be an object");
    return v as Record<string, unknown>;
  };
  route("GET", "/api/v1/workspace/files", ({ query }) => workspace.list(wsPath(query)));
  route("GET", "/api/v1/workspace/file", ({ query }) => {
    const { entry, bytes } = workspace.read(wsPath(query));
    const shown = SHOWN[path.extname(entry.name).toLowerCase()];
    return new Raw(
      {
        // Bytes a browser does not run: an HTML file the agent wrote cannot act on the UI's origin. An
        // image or a PDF has its own type, to show in the UI; the sandbox stays but on a PDF, which a
        // browser's viewer refuses to open sandboxed.
        "content-type": shown ?? "application/octet-stream",
        ...(shown !== "application/pdf" && { "content-security-policy": "sandbox" }),
        etag: `"${entry.version}"`,
        "last-modified": new Date(entry.modified).toUTCString(),
        ...(query.get("download") === "true" && {
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
        }),
      },
      bytes,
    );
  });
  route(
    "PUT",
    "/api/v1/workspace/file",
    ({ query, bytes, headers }) => workspace.write(wsPath(query), bytes, ifMatch(headers)),
    { bytes: true },
  );
  route("DELETE", "/api/v1/workspace/file", ({ query, headers }) => {
    workspace.remove(wsPath(query), ifMatch(headers));
    return { deleted: wsPath(query) };
  });
  // A file's history: what it was before each run that changed it.
  const history = () => {
    const h = app.five.d.history;
    if (!h) throw new HttpError(404, "five keeps no history");
    return h;
  };
  const versionId = (v: unknown) => {
    if (typeof v !== "string" || !/^(run|person)-\d+$/.test(v))
      throw new HttpError(400, "id is run-<n> or person-<ms>");
    return v;
  };
  const kept = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(404, err instanceof Error ? err.message : String(err));
    }
  };
  route(
    "GET",
    "/api/v1/workspace/history",
    ({ query }): FileHistory => ({
      path: wsPath(query),
      versions: kept(() => history().versions(wsPath(query))),
    }),
  );
  route("GET", "/api/v1/workspace/history/file", ({ query }) => {
    const bytes = kept(() => history().read(wsPath(query), versionId(query.get("id"))));
    const shown = SHOWN[path.extname(wsPath(query)).toLowerCase()];
    return new Raw(
      {
        "content-type": shown ?? "application/octet-stream",
        ...(shown !== "application/pdf" && { "content-security-policy": "sandbox" }),
      },
      bytes,
    );
  });
  route("POST", "/api/v1/workspace/history/restore", ({ body }) => {
    const file = typeof body.path === "string" ? body.path : "";
    kept(() => history().restore(file, versionId(body.id)));
    return { restored: file, id: body.id };
  });
  route("GET", "/api/v1/workspace/db/tables", ({ query }) => ({ tables: workspace.tables(wsPath(query)) }));
  route("GET", "/api/v1/workspace/db/rows", ({ query }) =>
    workspace.rows(
      wsPath(query),
      tableArg(query.get("table")),
      Number(query.get("offset")) || 0,
      positive(query.get("limit"), 100),
    ),
  );
  route("POST", "/api/v1/workspace/db/rows", ({ query, body }) =>
    workspace.insert(wsPath(query), tableArg(body.table), valuesArg(body.values)),
  );
  route("PUT", "/api/v1/workspace/db/rows", ({ query, body }) =>
    workspace.update(wsPath(query), tableArg(body.table), rowidArg(body.rowid), valuesArg(body.values)),
  );
  route("DELETE", "/api/v1/workspace/db/rows", ({ query }) =>
    workspace.deleteRow(wsPath(query), tableArg(query.get("table")), rowidArg(query.get("rowid"))),
  );
  route("POST", "/api/v1/workspace/db/sql", ({ query, body }) => {
    if (typeof body.sql !== "string" || !body.sql.trim()) throw new HttpError(400, "sql must be a non-empty string");
    if (body.args !== undefined && !Array.isArray(body.args)) throw new HttpError(400, "args must be an array");
    return workspace.sql(wsPath(query), body.sql, (body.args as unknown[] | undefined) ?? []);
  });

  const allowedHosts = hostsFor(cfg.apiAddr);

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    try {
      const host = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
      if (allowedHosts && !allowedHosts.has(host)) throw new HttpError(403, `host "${host}" is not this server`);
      if (!url.pathname.startsWith("/api/")) return serveWeb(opts.webDir, url.pathname, res);

      const found = routes.find((r) => r.method === method && r.pattern.test(url.pathname));
      if (!found) {
        const other = routes.some((r) => r.pattern.test(url.pathname));
        throw new HttpError(other ? 405 : 404, other ? `${method} not allowed here` : "no such endpoint");
      }
      let body: Record<string, unknown> = {};
      let bytes: Buffer = Buffer.alloc(0);
      if (method !== "GET") {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, "cross-origin write refused");
        // Neither type is one a cross-site form can send.
        const want = found.bytes ? "application/octet-stream" : "application/json";
        if (!(req.headers["content-type"] ?? "").startsWith(want)) {
          throw new HttpError(415, `send the body as ${want}`);
        }
        bytes = await readBytes(req, found.bytes ? MAX_FILE_BYTES : MAX_BODY);
        if (!found.bytes) body = parseObject(bytes);
      }
      const m = found.pattern.exec(url.pathname) as RegExpExecArray;
      const params = Object.fromEntries(found.keys.map((k, i) => [k, decodeURIComponent(m[i + 1] ?? "")]));
      const out = await found.handler({ params, query: url.searchParams, body, bytes, headers: req.headers });
      if (out instanceof Raw) {
        res.writeHead(200, { ...out.headers, "cache-control": "no-store", "x-content-type-options": "nosniff" });
        res.end(out.body);
        return;
      }
      send(res, 200, out ?? null);
    } catch (err) {
      const status = err instanceof HttpError || err instanceof WorkspaceError ? err.status : 500;
      if (status >= 500) log.error("request failed", { method, path: url.pathname, error: err });
      send(res, status, { error: { message: err instanceof Error ? err.message : String(err) } } satisfies ErrorBody);
    }
  });
}

/** The Host names a request may carry: the listen address's, or any when it listens on every interface. */
function hostsFor(addr: string): Set<string> | undefined {
  const host = addr.slice(0, addr.lastIndexOf(":")).replace(/^\[|\]$/g, "");
  if (host === "0.0.0.0" || host === "::" || host === "") return undefined;
  return new Set([host, "localhost", "127.0.0.1", "::1"]);
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

function readBytes(req: http.IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new HttpError(413, "body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseObject(bytes: Buffer): Record<string, unknown> {
  const raw = bytes.toString("utf8");
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "the body must be a JSON object");
  }
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

/** A file of the built UI, or index.html for any other path (the UI routes in the browser). */
/** A tool's libraries, with each library's revision now. */
function libsOfWith(libs: LibraryStore, used: LibraryUse[]): NonNullable<ToolInfo["libs"]> {
  return used.map((l) => {
    const now = libs.get(l.name)?.meta.revision;
    return { ...l, ...(now !== undefined && { current: now }) };
  });
}

/** Workspace files served as what they are, to show in the UI; SVG is not one, as it can hold script. */
const SHOWN: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
};

function serveWeb(dir: string | undefined, pathname: string, res: http.ServerResponse): void {
  if (!dir || !fs.existsSync(path.join(dir, "index.html"))) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("The web UI is not built: run `make web` (or `npm --prefix web run build`).\n");
    return;
  }
  const rel = path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  let file = path.join(dir, rel);
  if (!file.startsWith(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(dir, "index.html");
  const immutable = file.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "content-security-policy":
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
  });
  fs.createReadStream(file).pipe(res);
}

function positive(v: string | null, fallback: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
