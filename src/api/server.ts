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
import type { ContextView, ErrorBody, EventsPage, Status, ToolDetail, ToolInfo } from "./types.ts";
import { MAX_FILE_BYTES, Workspace, WorkspaceError } from "./workspace.ts";

const MAX_BODY = 1024 * 1024;
/** Events in one page. */
const PAGE = 500;
/** Turns whose events a first request gets. */
const TURNS = 20;

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
  const { five, cfg } = opts;
  const { loop, state, store } = five;
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
  /** Runs a change the loop may refuse during a turn; a refusal is a 409. */
  const guarded = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      throw new HttpError(409, err instanceof Error ? err.message : String(err));
    }
    return contextView();
  };
  const text = (body: Record<string, unknown>, key: string): string => {
    const v = body[key];
    if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `${key} must be a non-empty string`);
    return v;
  };
  const index = (params: Record<string, string>): number => {
    const i = Number(params.i);
    if (!Number.isInteger(i) || !loop.ctx.messages[i]) throw new HttpError(404, `no message at index ${params.i}`);
    return i;
  };
  const contextView = (): ContextView => {
    const { system, next, turn, messages } = loop.ctx;
    return { system, next, turn, messages };
  };

  route(
    "GET",
    "/api/v1/status",
    (): Status => ({
      model: cfg.model,
      endpoint: cfg.endpoint,
      contextTokens: cfg.contextTokens,
      think: cfg.think,
      maxSteps: cfg.maxSteps,
      workspace: cfg.workspace,
      loop: loop.status(),
      messages: loop.ctx.messages.length,
      tools: store.list().length,
      lastSeq: state.lastSeq(),
    }),
  );

  // ── the loop ────────────────────────────────────────────────────────────
  const control = (fn: () => void) => () => {
    fn();
    return loop.status();
  };
  route(
    "POST",
    "/api/v1/loop/start",
    control(() => loop.start()),
  );
  route(
    "POST",
    "/api/v1/loop/pause",
    control(() => loop.pause()),
  );
  route(
    "POST",
    "/api/v1/loop/stop",
    control(() => loop.stop()),
  );
  route("POST", "/api/v1/loop/step", () => {
    guarded(() => loop.stepOnce());
    return loop.status();
  });

  // ── the context ─────────────────────────────────────────────────────────
  route("GET", "/api/v1/context", contextView);
  route("PUT", "/api/v1/context/system", ({ body }) => {
    const t = text(body, "text");
    return guarded(() => loop.edit("system prompt replaced", (c) => (c.system = t)));
  });
  route("PUT", "/api/v1/context/next", ({ body }) => {
    const t = text(body, "text");
    return guarded(() => loop.edit("next prompt set", (c) => (c.next = t)));
  });
  route("PUT", "/api/v1/context/messages/:i", ({ params, body }) => {
    const i = index(params);
    if (typeof body.content !== "string") throw new HttpError(400, "content must be a string");
    const content = body.content;
    return guarded(() =>
      loop.edit(`message ${i} edited`, (c) => {
        (c.messages[i] as { content: string | null }).content = content;
      }),
    );
  });
  route("DELETE", "/api/v1/context/messages/:i", ({ params }) => {
    const i = index(params);
    return guarded(() => loop.edit(`message ${i} deleted`, (c) => c.messages.splice(i, 1)));
  });
  route("POST", "/api/v1/context/reset", ({ body }) =>
    guarded(() =>
      loop.reset({
        ...(typeof body.system === "string" && { system: body.system }),
        ...(typeof body.next === "string" && { next: body.next }),
        clean: body.clean === true,
      }),
    ),
  );

  // ── events ──────────────────────────────────────────────────────────────
  route("GET", "/api/v1/events", ({ query }): EventsPage => {
    const after = query.get("after");
    const events =
      after === null
        ? state.recentEvents(positive(query.get("turns"), TURNS))
        : state.eventsAfter(Number(after) || 0, PAGE);
    return { events, last: state.lastSeq() };
  });
  route("GET", "/api/v1/turns/:n", ({ params }): EventsPage => {
    return { events: state.turnEvents(Number(params.n) || 0), last: state.lastSeq() };
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
      parameters: meta.parameters,
      source: t.source,
    };
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
    return new Raw(
      {
        // Bytes a browser does not run: an HTML file the agent wrote cannot act on the UI's origin.
        "content-type": "application/octet-stream",
        "content-security-policy": "sandbox",
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
